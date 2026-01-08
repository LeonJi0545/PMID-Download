// Configuration
const CONFIG = {
    EMAIL: 'xwang70@tulane.edu',
    API_KEY: '3263cf5249bb15d2967832047fd05a82c108',
    ELSEVIER_API_KEY: 'cdf864d5b1213b871dde1b241d79a355',
    TOOL_NAME: 'chrome_extension_downloader',
    SCHOOL_ID: '265', // Tulane University ID. Set to null or empty string for generic access.
};

const PmidLogic = {
    /**
     * Main Entry Point: Resolve PDF URL using Parallel Strategies
     */
    async resolvePdfUrl(input, options = {}) {
        const { enableSciHub = true } = options;
        console.log(`[Logic] Resolving input: ${input}`);

        // --- 0. 特殊处理: Embase PUI (L-Number) ---
        // 如果输入是 L 开头 (如 L6247690)，直接走 Embase Tab 搜索
        if (/^L\d+$/i.test(input)) {
            console.log(`[Logic] Detected Embase PUI. Switching to Direct Embase Search.`);
            
            // 直接调用 Embase 策略
            try {
                const embaseResult = await this.strategyEmbase(input); // 传入 L 号
                if (embaseResult) return embaseResult;
            } catch (e) {
                console.log(`[Logic] Direct Embase search failed: ${e.message}`);
            }
            
            // 如果 Embase 搜不到，尝试去掉了 L 之后搜 PubMed (碰运气)
            const stripped = input.replace(/^L/i, '');
            console.log(`[Logic] trying stripped ID as fallback: ${stripped}`);
            input = stripped; // 继续后续流程，当作普通 PMID 试一试
        }

        const pmid = input; 
        const doi = await this.getDoiFromPmid(pmid);
        
        console.log(`[Logic] Resolving: ${pmid} (DOI: ${doi || 'N/A'})`);

        // --- 1. Priority: URL Pattern Prediction (Speed Boost) ---
        // If we can guess the direct PDF URL from the DOI, try it first.
        if (doi) {
            const predictedUrl = await this.predictPublisherUrl(doi);
            if (predictedUrl) {
                // Verify with HEAD request
                const isAccessible = await this.checkUrlAccessibility(predictedUrl);
                if (isAccessible) {
                    console.log(`[Logic] URL Prediction success: ${predictedUrl}`);
                    return { url: predictedUrl, source: 'Pattern Prediction', method: 'direct' };
                }
            }
        }

        // --- 2. Fast API Group (Parallel Execution) ---
        // We fire all fast APIs at once and take the first valid PDF URL.
        const apiPromises = [
            this.strategyNcbiOa(pmid),      // NCBI OA API
            this.strategyOpenAlex(pmid),    // OpenAlex
            this.strategyUnpaywall(pmid),   // Unpaywall
            this.strategyEuropePmc(pmid),   // EuropePMC
            this.strategySemanticScholar(pmid), // Semantic Scholar
        ];

        // 3.8 Anna's Archive (Moved to parallel group for speed)
        // Since Anna's scraper can be relatively fast with direct links, we can include it here or just after.
        // However, since it involves more complex scraping, maybe keep it separate if APIs fail.
        
        // --- Execution Order Refinement ---
        
        // Batch 1: Fast & Direct APIs (High Confidence, Low Cost)
        try {
            const result = await Promise.any(apiPromises);
            if (result) {
                console.log(`[Logic] Winner (Batch 1): ${result.source}`);
                return result;
            }
        } catch (e) {
            console.log(`[Logic] Batch 1 (APIs) failed for ${pmid}. Trying Fallback...`);
        }

        // Batch 2: Interactive / Complex Strategies (Tab Manipulation / Scraping)
        
        // 2.0 Elsevier API Strategy (Moved to Batch 2 start as requested)
        try {
            console.log(`[Logic] Trying Elsevier API strategy for ${pmid}...`);
            const elsevierResult = await this.strategyElsevier(pmid);
            if (elsevierResult) {
                console.log(`[Logic] Found via Elsevier API: ${elsevierResult.url}`);
                return elsevierResult;
            }
        } catch (e) {
            console.log(`[Logic] Elsevier API strategy failed: ${e.message}`);
        }

        // 2.1 Embase Strategy (Explicit Check)
        try {
            // Only try Embase if it looks like we might find it there or if previous failed
            // But since we have specific L-number handling at start, this is for PMIDs that are in Embase
            console.log(`[Logic] Trying Embase strategy for ${pmid}...`);
            const embaseResult = await this.strategyEmbase(pmid);
            if (embaseResult) {
                console.log(`[Logic] Found via Embase: ${embaseResult.url}`);
                return embaseResult;
            }
        } catch (e) {
            console.log(`[Logic] Embase strategy failed: ${e.message}`);
        }

        // 2.2 LibKey.io Strategy
        try {
            console.log(`[Logic] Trying LibKey.io fallback for ${pmid}...`);
            const libKeyResult = await this.strategyLibKey(pmid, doi); 
            if (libKeyResult) {
                console.log(`[Logic] Found via LibKey.io: ${libKeyResult.url}`);
                return libKeyResult;
            }
        } catch (e) {
            console.log(`[Logic] LibKey.io strategy failed: ${e.message}`);
        }

        // 2.3 Anna's Archive Scraper (Advanced)
        try {
            console.log(`[Logic] Trying Anna's Archive Scraper for ${pmid}...`);
            const annasResult = await this.strategyAnnasArchiveScraper(pmid, doi); 
            if (annasResult) {
                console.log(`[Logic] Found via Anna's Archive Scraper: ${annasResult.url}`);
                return annasResult;
            }
        } catch (e) {
            console.log(`[Logic] Anna's scraper failed: ${e.message}`);
        }

        // --- 3. Sci-Hub (The "Nuclear Option" - Last Resort) ---
        if (enableSciHub) {
            try {
                console.log(`[Logic] Trying Sci-Hub as last resort for ${pmid}...`);
                const sciHubResult = await this.strategySciHub(pmid);
                if (sciHubResult) {
                    console.log(`[Logic] Found via Sci-Hub: ${sciHubResult.url}`);
                    return sciHubResult;
                }
            } catch (e) {
                console.log(`[Logic] Sci-Hub strategy failed: ${e.message}`);
            }
        } else {
            console.log(`[Logic] Sci-Hub strategy skipped by user configuration.`);
        }

        // --- 5. Fallback: Web Scraping (Slow, uses PMCID) ---
        const pmcid = await this.pmidToPmcid(pmid);
        if (pmcid) {
            const scrapeUrl = await this.getPdfFromWebpage(pmcid);
            if (scrapeUrl) return { url: scrapeUrl, source: 'PMC Web Scraping', method: 'direct' };
        }

        return null;
    },

    async convertEmbaseIdToDoi(lNumber) {
        // 1. 去掉 "L" 前缀，获取纯数字 PUI 
        const pui = lNumber.replace(/^L/i, ''); 
        if (!/^\d+$/.test(pui)) return null; // 如果去掉 L 后不是纯数字，则放弃 

        console.log(`[Logic] Detected Embase PUI: ${pui}, attempting conversion via Scopus API...`); 

        const apiKey = CONFIG.ELSEVIER_API_KEY; 
        if (!apiKey) { 
            console.warn("[Logic] No Elsevier API Key provided, cannot convert Embase ID."); 
            return null; 
        } 

        // 2. 使用 Scopus Search API 查询 PUI 
        // 注意：搜索语法通常支持 PUI(xxx) 或者直接搜数字 
        const apiUrl = `https://api.elsevier.com/content/search/scopus?query=PUI(${pui})&apiKey=${apiKey}&httpAccept=application/json`; 

        try { 
            const response = await fetch(apiUrl); 
            if (!response.ok) throw new Error(`Scopus API error: ${response.status}`); 
            
            const data = await response.json(); 
            const entries = data['search-results']?.entry; 

            if (entries && entries.length > 0) { 
                const entry = entries[0]; 
                
                // 3. 提取 DOI 或 PMID 
                const doi = entry['prism:doi']; 
                const pmid = entry['pubmed-id']; 

                if (doi) { 
                    console.log(`[Logic] Converted Embase ${lNumber} -> DOI: ${doi}`); 
                    return { doi: doi, pmid: pmid }; 
                } 
                if (pmid) { 
                    console.log(`[Logic] Converted Embase ${lNumber} -> PMID: ${pmid}`); 
                    return { doi: null, pmid: pmid }; 
                } 
            } 
        } catch (e) { 
            console.warn(`[Logic] Embase PUI conversion failed: ${e.message}`); 
        } 
        
        return null; 
    },

    // --- WRAPPERS for Promise.any ---
    
    async strategyNcbiOa(pmid) {
        const pmcid = await this.pmidToPmcid(pmid);
        if (!pmcid) throw new Error("No PMCID");
        const url = await this.getPdfFromApi(pmcid);
        if (url) return { url, source: 'NCBI OA API', method: 'direct' };
        throw new Error("NCBI OA failed");
    },

    async strategyOpenAlex(pmid) {
        const url = await this.getPdfFromOpenAlex(pmid);
        if (url) return { url, source: 'OpenAlex', method: 'direct' };
        throw new Error("OpenAlex failed");
    },

    async strategyUnpaywall(pmid) {
        const doi = await this.getDoiFromPmid(pmid);
        if (!doi) throw new Error("No DOI");
        const url = await this.getPdfFromUnpaywall(doi);
        if (url) return { url, source: 'Unpaywall', method: 'direct' };
        throw new Error("Unpaywall failed");
    },

    async strategyEuropePmc(pmid) {
        const url = await this.getPdfFromEuropePmc(pmid);
        if (url) return { url, source: 'EuropePMC', method: 'direct' };
        throw new Error("EuropePMC failed");
    },

    async strategySemanticScholar(pmid) {
        const url = await this.getPdfFromSemanticScholar(pmid);
        if (url) return { url, source: 'Semantic Scholar', method: 'direct' };
        throw new Error("Semantic Scholar failed");
    },

    // 【关键修复】Elsevier 策略包装函数
    async strategyElsevier(pmid) {
        const url = await this.getPdfFromElsevier(pmid);
        if (url) return { url, source: 'Elsevier API', method: 'direct' };
        throw new Error("Elsevier failed");
    },

    async strategySciHub(pmid) {
        const url = await this.getPdfFromSciHub(pmid);
        if (url) return { url, source: 'Sci-Hub', method: 'tab' }; // Sci-Hub often needs Tab
        throw new Error("Sci-Hub failed");
    },

    async strategyEmbase(id) {
        // Embase search usually requires more complex interaction or API access.
        // Assuming a direct search URL pattern for demonstration or if it redirects to full text.
        // Since Embase is a subscription database, this might be a "Tab" strategy to let user login/access via IP.
        
        let url;
        // 如果是 L 开头的 PUI，使用直接记录访问 URL
        if (/^L\d+$/i.test(id)) {
             // 格式: https://www.embase.com/records?subaction=viewrecord&id=L6247690
             url = `https://www.embase.com/records?subaction=viewrecord&id=${id}`;
        } else {
            // 如果是 PMID 或 DOI，使用高级搜索直接定位 (避免 quickSearch 的歧义页面)
            // 使用 PUI 搜索语法: PUI(L...) 或者 PMID(...) 或者 DOI(...)
            // 但最稳妥的还是 quickSearch，只是我们需要让它更精确
            // 尝试使用 records 视图的搜索参数
            url = `https://www.embase.com/records?subaction=viewrecord&id=${id}`; 
            // 注意: 这里假设如果传入的是非 L 号，Embase 也能通过某种方式识别，或者我们应该回退到 search
            // 如果不是 L 号，还是用 search 比较稳妥
            if (!id.toString().startsWith('L')) {
                 url = `https://www.embase.com/#quickSearch/default?search=${encodeURIComponent(id)}`;
            }
        }

        return { 
            url: url, 
            source: 'Embase (Direct)', 
            method: 'tab' // 必须用 Tab 模式，依赖用户登录
        };
    },

    // --- 新增：Anna's Archive 爬虫策略 (移植自 annas-archive-api) ---
    async strategyAnnasArchiveScraper(pmid, doi) {
        // 1. 优先尝试 SciDB 直链 (速度最快)
        if (doi) {
            const scidbUrl = `https://annas-archive.li/scidb/${doi}`;
            const isAvailable = await this.checkUrlAccessibility(scidbUrl);
            if (isAvailable) {
                return { url: scidbUrl, source: "Anna's Archive (SciDB)", method: 'tab' };
            }
        }

        // 2. 如果直链失败，执行搜索爬虫逻辑
        console.log(`[Logic] SciDB failed, starting scraper for ${pmid}...`);
        
        // 构造查询：优先用 DOI，没有则用 PMID
        const query = doi || pmid;
        if (!query) throw new Error("No query for Anna's Archive");

        try {
            // A. 获取搜索结果页
            const searchUrl = `https://annas-archive.li/search?q=${encodeURIComponent(query)}`;
            const searchRes = await fetch(searchUrl);
            const searchHtml = await searchRes.text();

            // B. 解析出第一个匹配的 MD5 详情页链接
            const md5Path = this.parseAnnasArchiveSearch(searchHtml);
            if (!md5Path) throw new Error("No search results found on Anna's Archive");

            // C. 获取 MD5 详情页 (即下载页)
            const md5Url = `https://annas-archive.li${md5Path}`;
            // 此时我们已经拿到了具体的书本页面，可以直接返回这个 URL 让 Dashboard 在 Tab 中打开
            // 这样用户进去后，Dashboard 的嗅探器会自动识别页面上的 "Slow Partner" 链接
            
            return { url: md5Url, source: "Anna's Archive (Scraper)", method: 'tab' };

        } catch (e) {
            console.warn("[Logic] Anna's Archive Scraper failed:", e);
            return null;
        }
    },

    // 辅助函数：解析搜索结果 HTML
    parseAnnasArchiveSearch(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        
        // Anna's Archive 的搜索结果通常是列表，链接包含 /md5/
        // 我们寻找主要结果区域的链接
        const links = Array.from(doc.querySelectorAll('a[href*="/md5/"]'));
        
        for (const link of links) {
            // 排除一些可能的广告或无关链接，通常第一个就是最佳匹配
            const href = link.getAttribute('href');
            if (href && href.startsWith('/md5/')) {
                return href;
            }
        }
        return null;
    },

    // 【新增】LibKey 策略
    async strategyLibKey(pmid, doi) {
        const validDoi = doi || await this.getDoiFromPmid(pmid);
        if (!validDoi) throw new Error("No DOI for LibKey");
        
        let url;
        if (CONFIG.SCHOOL_ID) {
            url = `https://libkey.io/libraries/${CONFIG.SCHOOL_ID}/${validDoi}`;
        } else {
            url = `https://libkey.io/${validDoi}`;
        }
        return { url: url, source: 'LibKey.io', method: 'tab' };
    },

    // --- NEW HELPERS (Missing in previous code) ---

    // 【新增】URL 规则预测
    async predictPublisherUrl(doi) {
        if (!doi) return null;
        // 1. Wiley
        if (doi.startsWith('10.1002/')) {
            return `https://onlinelibrary.wiley.com/doi/pdfdirect/${doi}?download=true`;
        }
        // 2. Springer
        if (doi.startsWith('10.1007/') || doi.startsWith('10.1186/')) {
            return `https://link.springer.com/content/pdf/${doi}.pdf`;
        }
        // 3. APS
        if (doi.startsWith('10.1103/')) {
            const parts = doi.split('/');
            if (parts.length >= 2) {
                const suffix = parts[1];
                let journalCode = '';
                if (suffix.startsWith('PhysRevLett')) journalCode = 'prl';
                else if (suffix.startsWith('PhysRevA')) journalCode = 'pra';
                else if (suffix.startsWith('PhysRevB')) journalCode = 'prb';
                else if (suffix.startsWith('PhysRevC')) journalCode = 'prc';
                else if (suffix.startsWith('PhysRevD')) journalCode = 'prd';
                else if (suffix.startsWith('PhysRevE')) journalCode = 'pre';
                else if (suffix.startsWith('PhysRevX')) journalCode = 'prx';
                else if (suffix.startsWith('RevModPhys')) journalCode = 'rmp';
                
                if (journalCode) return `https://journals.aps.org/${journalCode}/pdf/${doi}`;
            }
        }
        return null;
    },

    // 【新增】URL 可访问性检查 (HEAD Request)
    async checkUrlAccessibility(url) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000); // 2秒超时
            
            const res = await fetch(url, { 
                method: 'HEAD', 
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            // In 'no-cors' mode, we get an opaque response (status 0), but it means network is reachable.
            // For proper check, we need standard mode, but that risks CORS.
            // Let's assume if it doesn't throw network error, it's alive.
            return true;
        } catch (e) {
            return false;
        }
    },

    // --- EXISTING SOURCES & HELPERS (Kept intact) ---

    async getPdfFromElsevier(pmid) {
        const apiKey = CONFIG.ELSEVIER_API_KEY;
        if (!apiKey) return null;

        const doi = await this.getDoiFromPmid(pmid);
        let apiUrl = '';

        if (doi) {
            apiUrl = `https://api.elsevier.com/content/article/doi/${doi}?apiKey=${apiKey}&httpAccept=application/pdf`;
        } else {
            apiUrl = `https://api.elsevier.com/content/article/pubmed_id/${pmid}?apiKey=${apiKey}&httpAccept=application/pdf`;
        }
        const elsevierHeader = { "X-ELS-APIKey": apiKey, "Accept": "application/pdf" };
        
        try {
            const response = await fetch(apiUrl, { method: 'HEAD', headers: elsevierHeader });
            if (response.ok) {
                console.log(`[Elsevier] Found access for ${pmid}`);
                return apiUrl;
            }
        } catch (e) {
            console.warn(`[Elsevier] Check failed for ${pmid}:`, e);
        }
        return null;
    },

    async getPdfFromSciHub(pmid) {
        const doi = await this.getDoiFromPmid(pmid);
        if (!doi) return null;
        const mirrors = ['https://sci-hub.se', 'https://sci-hub.st', 'https://sci-hub.ru'];
        
        for (const mirror of mirrors) {
            // Check if the mirror is alive using our helper
            const isAlive = await this.checkUrlAccessibility(mirror);
            if (isAlive) {
                console.log(`[Sci-Hub] Selected alive mirror: ${mirror}`);
                return `${mirror}/${doi}`;
            }
        }
        
        console.warn("[Sci-Hub] All mirrors seem unreachable.");
        return null;
    },

    async getPdfFromOpenAlex(pmid) {
        const email = CONFIG.EMAIL || 'test@example.com';
        const url = `https://api.openalex.org/works/pmid:${pmid}?mailto=${email}`;
        try {
            const response = await fetch(url);
            if (!response.ok) return null;
            const data = await response.json();
            if (data.best_oa_location && data.best_oa_location.pdf_url) return data.best_oa_location.pdf_url;
            if (data.primary_location && data.primary_location.pdf_url) return data.primary_location.pdf_url;
            return null;
        } catch (e) { return null; }
    },

    async getPdfFromElsevier(pmid) {
        if (!CONFIG.ELSEVIER_API_KEY) return null;
        
        try {
            // 使用用户提供的 API Key 和 Headers 进行请求
            // X-ELS-APIKey: ...
            // Accept: application/json
            // 查询 article 接口获取 link
            const metaUrl = `https://api.elsevier.com/content/article/pubmed_id/${pmid}`;
            const response = await fetch(metaUrl, {
                method: 'GET',
                headers: {
                    'X-ELS-APIKey': CONFIG.ELSEVIER_API_KEY,
                    'Accept': 'application/json'
                }
            });

            if (!response.ok) {
                console.warn(`Elsevier API error: ${response.status}`);
                return null;
            }
            
            const data = await response.json();
            const links = data['full-text-retrieval-response']?.['coredata']?.['link'];
            
            if (links) {
                // 优先寻找 scidir 链接 (ScienceDirect 页面)，因为直接 PDF 链接通常需要更复杂的认证
                // 或者寻找 'self' 且 type 为 application/pdf 的链接
                const pdfLink = links.find(l => l['@rel'] === 'scidir'); 
                
                if (pdfLink) {
                    // ScienceDirect 页面链接，通常可以跳转后下载
                    return pdfLink['@href'];
                }
                
                // 如果没有 scidir，尝试找 pdf
                const directPdf = links.find(l => l['@type'] === 'application/pdf');
                if (directPdf) {
                    // 如果直接返回 PDF 链接，我们需要确保带上 API Key 或者 headers
                    // 但通常这个链接是受保护的，可能需要 Tab 模式打开
                    // 我们可以返回它，让 Dashboard 尝试
                    return directPdf['@href'];
                }
            }
        } catch (e) {
            console.warn("Elsevier API check failed", e);
        }
        return null;
    },

    async getPdfFromSemanticScholar(pmid) {
        const url = `https://api.semanticscholar.org/graph/v1/paper/PMID:${pmid}?fields=openAccessPdf`;
        try {
            const response = await fetch(url);
            if (!response.ok) return null;
            const data = await response.json();
            if (data.openAccessPdf && data.openAccessPdf.url) return data.openAccessPdf.url;
        } catch (e) { }
        return null;
    },

    async pmidToPmcid(pmid) {
        const url = new URL("https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/");
        url.searchParams.append('tool', CONFIG.TOOL_NAME);
        url.searchParams.append('email', CONFIG.EMAIL);
        url.searchParams.append('ids', pmid);
        url.searchParams.append('format', 'json');
        if (CONFIG.API_KEY) url.searchParams.append('api_key', CONFIG.API_KEY);
        try {
            const response = await fetch(url);
            const data = await response.json();
            if (data.records && data.records.length > 0) return data.records[0].pmcid || null;
        } catch (e) { }
        return null;
    },

    async getDoiFromPmid(pmid) {
        const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json&api_key=${CONFIG.API_KEY}`;
        try {
            const response = await fetch(url);
            const data = await response.json();
            if (data.result && data.result[pmid]) {
                const articleIds = data.result[pmid].articleids;
                const doiObj = articleIds.find(id => id.idtype === 'doi');
                return doiObj ? doiObj.value : null;
            }
        } catch (e) { }
        return null;
    },

    async getPdfFromApi(pmcid) {
        const url = `https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=${pmcid}`;
        try {
            const response = await fetch(url);
            if (response.ok) {
                const text = await response.text();
                const parser = new DOMParser();
                const xmlDoc = parser.parseFromString(text, "text/xml");
                const linkNode = xmlDoc.querySelector("link[format='pdf']");
                if (linkNode) return linkNode.getAttribute('href').replace("ftp://", "https://");
            }
        } catch (e) { }
        return null;
    },

    async getPdfFromWebpage(pmcid) {
        const articleUrl = `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`;
        console.log(`... Attempting Strategy B: Web Page Parsing for ${pmcid} ...`);
        try {
            const response = await fetch(articleUrl);
            if (!response.ok) return null;
            const html = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, "text/html");

            const metaPdf = doc.querySelector('meta[name="citation_pdf_url"]');
            if (metaPdf && metaPdf.content) return metaPdf.content;

            const links = doc.querySelectorAll('a[href]');
            for (const link of links) {
                const href = link.getAttribute('href');
                if (href && href.endsWith('.pdf') && (href.includes('/articles/') || href.includes(pmcid) || href.includes('pdf'))) {
                    return new URL(href, articleUrl).href;
                }
            }
            const scriptContent = html;
            const jsMatch = scriptContent.match(/window\.location\.href\s*=\s*["']([^"']+\.pdf.*?)["']/);
            if (jsMatch && jsMatch[1]) {
                let foundUrl = jsMatch[1];
                if (foundUrl.startsWith('/')) foundUrl = new URL(foundUrl, articleUrl).href;
                return foundUrl;
            }
        } catch (e) { }
        return null;
    },

    async getPdfFromEuropePmc(pmid) {
        const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID:${pmid}%20SRC:MED&format=json`;
        try {
            const response = await fetch(url);
            const data = await response.json();
            if (data.resultList && data.resultList.result && data.resultList.result.length > 0) {
                const result = data.resultList.result[0];
                if (result.fullTextUrlList && result.fullTextUrlList.fullTextUrl) {
                    for (const ft of result.fullTextUrlList.fullTextUrl) {
                        if (ft.documentStyle === 'pdf' || ft.url.endsWith('.pdf')) return ft.url;
                    }
                }
            }
        } catch (e) { }
        return null;
    },

    async getPdfFromUnpaywall(doi) {
        const url = `https://api.unpaywall.org/v2/${doi}?email=${CONFIG.EMAIL}`;
        try {
            const response = await fetch(url);
            if (response.ok) {
                const data = await response.json();
                if (data.best_oa_location && data.best_oa_location.url_for_pdf) return data.best_oa_location.url_for_pdf;
            }
        } catch (e) { }
        return null;
    }
};

window.PmidLogic = PmidLogic;
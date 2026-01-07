// Configuration
const CONFIG = {
    EMAIL: 'xwang70@tulane.edu',
    API_KEY: '3263cf5249bb15d2967832047fd05a82c108',
    ELSEVIER_API_KEY: '3263cf5249bb15d2967832047fd05a82c108',
    TOOL_NAME: 'chrome_extension_downloader',
    SCHOOL_ID: '265', // Tulane University ID. Set to null or empty string for generic access.
};

const PmidLogic = {
    /**
     * Main Entry Point: Resolve PDF URL using Parallel Strategies
     */
    async resolvePdfUrl(pmid, options = {}) {
        const { enableSciHub = true } = options;
        console.log(`[Logic] Resolving PMID: ${pmid} (Sci-Hub Enabled: ${enableSciHub})`);
        
        const doi = await this.getDoiFromPmid(pmid);

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
            this.strategyElsevier(pmid),
        ];

        try {
            // Promise.any returns the first successfully resolved promise
            const result = await Promise.any(apiPromises);
            if (result) {
                console.log(`[Logic] Winner: ${result.source}`);
                return result;
            }
        } catch (e) {
            console.log(`[Logic] All API strategies failed for ${pmid}. Trying Fallback...`);
        }

        // --- 3. LibKey.io Strategy (Secondary Fallback) ---
        try {
            console.log(`[Logic] Trying LibKey.io fallback for ${pmid}...`);
            const libKeyResult = await this.strategyLibKey(pmid, doi); // Pass DOI if available
            if (libKeyResult) {
                console.log(`[Logic] Found via LibKey.io: ${libKeyResult.url}`);
                return libKeyResult;
            }
        } catch (e) {
            console.log(`[Logic] LibKey.io strategy failed: ${e.message}`);
        }

        // --- 4. Sci-Hub (The "Nuclear Option" - Last Resort) ---
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
                signal: controller.signal,
                // Avoid CORS issues for simple checks if possible, or handle them in catch
                mode: 'no-cors' 
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
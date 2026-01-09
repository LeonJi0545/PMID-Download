// sniffer.js - Dedicated PDF Sniffing & Tab Automation Logic

const Sniffer = {
    /**
     * Attempts to find and download a PDF from a given URL using a background Tab.
     * Handles redirects, specific site automation (Embase, PubMed, LibKey), and deep link scanning.
     * 
     * @param {string} url - The target URL to open.
     * @returns {Promise<Blob>} - Resolves with the PDF Blob if found, rejects on failure.
     */
    async fetchBlobViaTab(url) {
        return new Promise((resolve, reject) => {
            // Create a tab in the background (inactive)
            chrome.tabs.create({ url: url, active: false }, (tab) => {
                if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
                const tabId = tab.id;
                
                // Timeout Protection (120s)
                const timeout = setTimeout(() => {
                    chrome.tabs.remove(tabId).catch(() => {});
                    reject(new Error("Tab operation timeout (120s)"));
                }, 120000);

                let attempts = 0;
                // Polling Interval (2s)
                const interval = setInterval(() => {
                    attempts++;
                    // Max attempts: 60 * 2s = 120s
                    // Note: 'attempts' might be reset by CAPTCHA logic to wait longer
                    if (attempts > 60) { 
                        clearInterval(interval);
                        return; 
                    }

                    chrome.scripting.executeScript({
                        target: { tabId: tabId },
                        func: this._injectedSnifferLogic
                    }, (results) => {
                        this._handleSnifferResult(results, tabId, interval, timeout, attempts, resolve, reject);
                    });
                }, 2000); // Poll every 2 seconds
            });
        });
    },

    /**
     * The core logic injected into the target page.
     * MUST be self-contained (no external references).
     */
    _injectedSnifferLogic() {
        try {
            const host = window.location.hostname;
            const href = window.location.href;

            // Helper function to resolve relative URLs
            const resolveUrl = (url) => {
                if (!url) return null;
                try {
                    return new URL(url, window.location.href).href;
                } catch (e) {
                    return url;
                }
            };

            // ===============================================
            // 🟢 1. Ultimate Direct Detection
            // ===============================================
            // 1.1 URL is already a PDF
            if (href.match(/\.pdf($|\?|#)/i) || document.contentType === 'application/pdf') {
                return { status: 'FOUND', url: href };
            }
            
            // 1.2 Embedded PDF (Chrome Default Viewer)
            const embed = document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]');
            if (embed && embed.src) return { status: 'FOUND', url: embed.src };

            // ===============================================
            // 🟢 2. Site-Specific Automation
            // ===============================================
            
            // --- XsCntpj ---
            if (host.includes('xs.cntpj.com')) {
                // Look for "Quick Download" or "Publisher" links
                const targetBtn = Array.from(document.querySelectorAll('a, button, span')).find(el => {
                    const txt = (el.textContent || "").toLowerCase().trim();
                    // Matches "quick download" or "publisher" (source)
                    return (txt.includes('quick download') || txt.includes('source') || txt.includes('publisher')) && el.offsetParent !== null;
                });

                if (targetBtn) {
                     const link = targetBtn.tagName === 'A' ? targetBtn : targetBtn.closest('a');
                     if (link && link.href) {
                         const targetUrl = resolveUrl(link.href);
                         if (!window.location.href.includes(targetUrl)) {
                             window.location.href = targetUrl;
                             return { status: 'WAITING', msg: 'XsCntpj: Jumping to Publisher/Download...' };
                         }
                     } else {
                         // Click fallback
                         targetBtn.click();
                         return { status: 'WAITING', msg: 'XsCntpj: Clicked Download button...' };
                     }
                }
                return { status: 'WAITING', msg: 'XsCntpj: Looking for download links...' };
            }

            // --- Embase ---
            if (host.includes('embase.com')) {
                const fullTextBtn = Array.from(document.querySelectorAll('a, button, span')).find(el => {
                    const txt = (el.textContent || "").toLowerCase().trim();
                    const title = (el.title || "").toLowerCase();
                    const isMatch = (txt === 'full text' || txt === 'publisher full text' || txt.includes('view at publisher') || title.includes('full text')|| title.includes('full-text article'));
                    return isMatch && el.offsetParent !== null;
                });

                if (fullTextBtn && !fullTextBtn.dataset.extClicked) {
                    const link = fullTextBtn.tagName === 'A' ? fullTextBtn : fullTextBtn.closest('a');
                    if (link && link.href && !window.location.href.includes(link.href)) {
                        window.location.href = link.href;
                        return { status: 'WAITING', msg: 'Embase: Jumping to Publisher...' };
                    } else {
                        // Fallback: Click the button (e.g. if it's a script action)
                        fullTextBtn.click();
                        fullTextBtn.dataset.extClicked = "true";
                        return { status: 'WAITING', msg: 'Embase: Clicked Full Text button...' };
                    }
                }
                return { status: 'WAITING', msg: 'Embase: Looking for Full Text button...' };
            }

            // --- PubMed ---
            if (host.includes('pubmed.ncbi.nlm.nih.gov')) {
                const linkContainer = document.querySelector('.full-text-links-list');
                if (linkContainer) {
                    const link = linkContainer.querySelector('a.link-item');
                    if (link && link.href) {
                        if (!window.location.href.includes(link.href)) {
                            window.location.href = link.href;
                            return { status: 'WAITING', msg: 'PubMed: Jumping to Publisher...' };
                        }
                    }
                }
                return { status: 'WAITING', msg: 'PubMed: Looking for Full Text Links...' };
            }

            // --- PMC (PubMed Central) ---
            if (host.includes('pmc.ncbi.nlm.nih.gov') || host.includes('ncbi.nlm.nih.gov/pmc')) {
                // 1. Target the specific "PDF" button structure provided by user
                // <a href="pdf/..." class="usa-button..." ...> ... PDF ... </a>
                const pmcPdfBtn = Array.from(document.querySelectorAll('a')).find(el => {
                     const href = (el.getAttribute('href') || "").toLowerCase();
                     const txt = (el.textContent || "").trim().toLowerCase();
                     const cls = (el.className || "").toLowerCase();
                     
                     // Check for PDF link pattern or specific class/text combination
                     const isPdfLink = href.endsWith('.pdf') || href.includes('/pdf/');
                     const isPmcButton = cls.includes('usa-button') || txt.includes('pdf');
                     
                     return isPdfLink && isPmcButton && el.offsetParent !== null;
                });

                if (pmcPdfBtn && pmcPdfBtn.href) {
                    return { status: 'FOUND', url: resolveUrl(pmcPdfBtn.href) };
                }
                
                // Fallback: Generic PDF search within PMC context
                const genericPdf = document.querySelector('.pmc-sidebar__formats a.pdf-link') || 
                                   document.querySelector('.format-menu a[href*=".pdf"]');
                if (genericPdf && genericPdf.href) {
                     return { status: 'FOUND', url: resolveUrl(genericPdf.href) };
                }
            }

            // --- LibKey ---
            if (host.includes('libkey.io')) {
                // ... (LibKey logic omitted for brevity, keeping existing)
                // A. Priority: Check for direct PDF link (LibKey Nomad style)
                const pdfBtn = Array.from(document.querySelectorAll('a, button, div, span')).find(el => {
                    const txt = (el.textContent || "").toLowerCase().trim();
                    const href = (el.tagName === 'A' ? el.href : "").toLowerCase();
                    const cls = (el.className || "").toLowerCase();
                    // Check for "download pdf" text, .pdf extension, or specific LibKey classes
                    return (txt.includes('download pdf') || href.includes('.pdf') || cls.includes('libkey-link')) && el.offsetParent !== null;
                });

                if (pdfBtn) {
                    const link = pdfBtn.tagName === 'A' ? pdfBtn : pdfBtn.closest('a');
                    if (link && link.href) {
                        return { status: 'FOUND', url: resolveUrl(link.href) };
                    }
                }

                // B. Fallback: Check for Article Web Link
                const libkeyBtn = Array.from(document.querySelectorAll('a, button, div, span')).find(el => {
                    const txt = (el.textContent || "").toLowerCase().trim();
                    return (txt.includes('article web link') || txt.includes('view article') || txt.includes('article link')) && el.offsetParent !== null;
                });

                if (libkeyBtn) {
                    const link = libkeyBtn.tagName === 'A' ? libkeyBtn : libkeyBtn.closest('a');
                    if (link && link.href) {
                         const resolvedLink = resolveUrl(link.href);
                         if (!window.location.href.includes(resolvedLink)) {
                             window.location.href = resolvedLink;
                             return { status: 'WAITING', msg: 'LibKey: Jumping to Article Link...' };
                         }
                    } else {
                         libkeyBtn.click();
                         return { status: 'WAITING', msg: 'LibKey: Clicked Article Link...' };
                    }
                }
                return { status: 'WAITING', msg: 'LibKey: Looking for Article Link or PDF...' };
            }

            // --- Sci-Hub ---
            if (host.includes('sci-hub')) {
                // Specific structure: <div class="download"><a href="..."></a></div>
                const downloadDiv = document.querySelector('div.download');
                if (downloadDiv) {
                    const link = downloadDiv.querySelector('a');
                    if (link && link.href) {
                        return { status: 'FOUND', url: resolveUrl(link.href) };
                    }
                }
                
                // Fallback: Check for <embed> or <iframe> showing PDF
                const embed = document.querySelector('embed[type="application/pdf"], iframe[src*=".pdf"]');
                if (embed && embed.src) return { status: 'FOUND', url: resolveUrl(embed.src) };

                return { status: 'WAITING', msg: 'Sci-Hub: Looking for PDF link...' };
            }

            // --- Wiley Online Library ---
            if (host.includes('onlinelibrary.wiley.com')) {
                // Structure: <div class="coolBar__section coolBar--download PdfLink cloned"><a href="/doi/epdf/..." ...>PDF</a></div>
                // 1. Look for the "PDF" link in the coolBar
                const wileyPdfLink = document.querySelector('.coolBar__section.PdfLink a') || 
                                     document.querySelector('a.pdf-download') ||
                                     Array.from(document.querySelectorAll('a')).find(a => a.href && a.href.includes('/doi/epdf/'));

                if (wileyPdfLink && wileyPdfLink.href) {
                    let pdfUrl = wileyPdfLink.href;
                    
                    // Wiley "epdf" is an interactive reader. "pdfdirect" is the actual file.
                    // Convert: /doi/epdf/10.1111/ajco.14009 -> /doi/pdfdirect/10.1111/ajco.14009?download=true
                    if (pdfUrl.includes('/epdf/')) {
                        pdfUrl = pdfUrl.replace('/epdf/', '/pdfdirect/') + '?download=true';
                        return { status: 'FOUND', url: resolveUrl(pdfUrl) };
                    }
                    
                    // If it's already a pdf link (rare on Wiley, usually it's epdf or pdfdirect)
                    if (pdfUrl.includes('/pdfdirect/') || pdfUrl.endsWith('.pdf')) {
                         return { status: 'FOUND', url: resolveUrl(pdfUrl) };
                    }
                }
            }

            // --- LWW (Wolters Kluwer Health) ---
            if (host.includes('journals.lww.com') || host.includes('lww.com')) {
                // Strategy: Extract URL from data-config JSON in the "PDF" button
                // Look for the "PDF" button inside the article tools dropdown
                const lwwPdfBtn = Array.from(document.querySelectorAll('button.js-ejp-login-btn')).find(b => {
                     const txt = b.textContent.trim().toLowerCase();
                     return txt === 'pdf' || b.querySelector('.icon-pdf');
                });

                if (lwwPdfBtn && lwwPdfBtn.dataset.config) {
                    try {
                        const config = JSON.parse(lwwPdfBtn.dataset.config);
                        if (config.eventDetail && config.eventDetail.url) {
                            let pdfUrl = config.eventDetail.url.trim();
                            // Fix protocol-relative URLs (force HTTPS)
                            if (pdfUrl.startsWith('//')) {
                                pdfUrl = 'https:' + pdfUrl;
                            }
                            // Ensure absolute URL
                            if (pdfUrl) {
                                pdfUrl = resolveUrl(pdfUrl);
                                return { status: 'FOUND', url: pdfUrl };
                            }
                        }
                    } catch (e) {
                        // ignore parse error
                    }
                }
                
                // Fallback: If button exists but config parsing failed, maybe try clicking "Download" to reveal?
                // But usually the buttons are present in DOM.
                const downloadToggle = document.querySelector('.ejp-article-tools__list-button');
                if (downloadToggle && !lwwPdfBtn) {
                     // Try clicking to expand dropdown (might trigger lazy load?)
                     downloadToggle.click();
                     return { status: 'WAITING', msg: 'LWW: Clicked Download to reveal options...' };
                }
            }

            // ===============================================
            // 🟢 3. Metadata Detection (High Confidence)
            // ===============================================
            const metaPdf = document.querySelector('meta[name="citation_pdf_url"]') || 
                          document.querySelector('meta[name="wkhealth_pdf_url"]') || // Wolters Kluwer
                          document.querySelector('meta[name="bepress_citation_pdf_url"]') || // BePress
                          document.querySelector('meta[name="prism.url"]') || // PRISM
                          document.querySelector('meta[property="og:url"][content*=".pdf"]');

            if (metaPdf && metaPdf.content) {
                return { status: 'FOUND', url: resolveUrl(metaPdf.content) };
            }

            // ===============================================
            // 🔵 4. Deep Link Scoring System
            // ===============================================
            
            // A. Collect all potential candidates
            const candidates = [
                ...Array.from(document.querySelectorAll('a[href]')),
                ...Array.from(document.querySelectorAll('iframe[src], frame[src]')),
                ...Array.from(document.querySelectorAll('div[role="button"], button'))
            ];
            
            let bestLink = null;
            let maxScore = 0;

            for (const el of candidates) {
                // Skip hidden elements (simple check)
                if (el.offsetParent === null) continue;

                let score = 0;
                let url = '';
                
                // Extract URL based on element type
                if (el.tagName === 'A') url = el.href;
                else if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') url = el.src;
                else if (el.dataset.pdfUrl) url = el.dataset.pdfUrl; // Custom data attribute
                
                // Ensure absolute URL using the helper
                if (url && !url.startsWith('http') && !url.startsWith('javascript') && !url.startsWith('data')) {
                    url = resolveUrl(url);
                }

                const h = (url || "").toLowerCase();
                const txt = (el.textContent || el.innerText || "").trim().toLowerCase();
                const title = (el.title || "").toLowerCase();
                const ariaLabel = (el.getAttribute('aria-label') || "").toLowerCase();
                const className = (el.className || "").toString().toLowerCase();
                const onclick = (el.getAttribute('onclick') || "").toLowerCase();

                // Basic validity check
                if (!h && !onclick) continue;
                if (h && (h === '#' || h.startsWith('javascript') || h.startsWith('mailto'))) continue;

                // --- Scoring Rules ---

                // 1. Extension / Path (High Weight)
                if (h.includes('.pdf')) score += 100;
                if (h.includes('/pdf/')) score += 80;
                if (h.includes('article/pdf')) score += 80;
                if (h.includes('download') && h.includes('pdf')) score += 90;

                // 2. Text / Title Matches
                if (txt === 'pdf' || txt === 'download pdf' || txt === 'full text pdf') score += 60;
                if (txt.includes('download') && txt.includes('pdf')) score += 40;
                if (title.includes('download pdf') || title === 'pdf') score += 40;
                if (ariaLabel.includes('pdf')) score += 30;

                // 3. Visual / Class Hints
                if (className.includes('pdf') || className.includes('download')) score += 20;
                if (el.querySelector('.icon-pdf') || el.querySelector('img[src*="pdf"]')) score += 30;

                // 4. Site Specific Boosts
                if (host.includes('annas-archive') && (txt.includes('slow partner') || txt.includes('libgen'))) score += 90;
                if (host.includes('sciencedirect') && h.includes('/download/pdf')) score += 90;

                // 5. Negative Filtering
                if (txt.includes('instruction') || txt.includes('manual') || txt.includes('policy') || txt.includes('terms') || txt.includes('supplement')) score -= 50;

                // 6. Iframe Boost (High confidence if it's a PDF iframe)
                if ((el.tagName === 'IFRAME' || el.tagName === 'FRAME') && h.includes('.pdf')) score += 150;

                // Update Best Candidate
                if (score > maxScore) {
                    maxScore = score;
                    bestLink = { element: el, href: h || 'javascript:void(0)', score: score };
                }
            }

            if (bestLink && maxScore >= 60) {
                // FORCE SAME TAB: If it's an anchor, remove target="_blank" to prevent losing the tab context
                if (bestLink.element.tagName === 'A') {
                    bestLink.element.target = "_self";
                }
                
                // If it's a clickable button without href, we might need to click it (future enhancement)
                // For now, we only return if we have a valid URL
                if (bestLink.href && !bestLink.href.startsWith('javascript')) {
                    return { status: 'FOUND', url: resolveUrl(bestLink.href), score: maxScore };
                } else {
                    bestLink.element.click();
                    return { status: 'WAITING', msg: `Clicked best candidate (Score: ${maxScore})` };
                }
            }

            // ===============================================
            // 🔴 6. CAPTCHA & Bot Detection
            // ===============================================
            const pageTitle = document.title.toLowerCase();
            const bodyText = document.body.innerText.toLowerCase();
            
            const isCloudflare = pageTitle.includes('cloudflare') || 
                                 pageTitle.includes('just a moment') ||
                                 pageTitle.includes('attention required') ||
                                 bodyText.includes('verify you are human') ||
                                 document.querySelector('#challenge-running');

            if (isCloudflare) {
                const cfCheckbox = document.querySelector('input[type="checkbox"]');
                if (cfCheckbox) cfCheckbox.click();
                return { status: 'CAPTCHA' };
            }

            return { status: 'WAITING', msg: `Scanning... Best score: ${maxScore}` };

        } catch (e) {
            return { status: 'ERROR', msg: e.message };
        }
    },

    /**
     * Handles the result returned from the injected script.
     */
    _handleSnifferResult(results, tabId, interval, timeout, attempts, resolve, reject) {
        if (chrome.runtime.lastError) return;
        if (!results || !results[0] || !results[0].result) return;
        
        const res = results[0].result;
        if (res.msg) console.log(res.msg);

        if (res.status === 'CAPTCHA') {
            console.warn("[Sniffer] Cloudflare detected! Waiting for user or auto-pass...");
            chrome.tabs.update(tabId, { active: true }).catch(() => {});
            
            // Reset attempts to wait indefinitely (with a cap to prevent deadlocks)
            if (attempts > 10) attempts = 10; 
        } 
        else if (res.status === 'FOUND') {
            clearInterval(interval);
            clearTimeout(timeout);
            console.log(`[Sniffer] PDF Link Found (Score: ${res.score}): ${res.url}`);

            this._downloadFromTab(tabId, res.url, resolve, reject);
        }
    },

    /**
     * Executes the download fetch inside the Tab context.
     */
    _downloadFromTab(tabId, url, resolve, reject) {
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: async (u) => {
                try {
                    const r = await fetch(u);
                    const type = (r.headers.get('Content-Type') || '').toLowerCase();
                    if (!r.ok) return { success: false, error: `HTTP ${r.status}` };
                    if (type.includes('text/html')) return { success: false, error: 'Received HTML instead of PDF' };

                    const b = await r.blob();
                    if (b.size < 1000) return { success: false, error: `Blob too small (${b.size} bytes)` };

                    return new Promise(rs => {
                        const reader = new FileReader();
                        reader.onload = () => rs({success:true, data:reader.result});
                        reader.readAsDataURL(b);
                    });
                } catch(e) { return { success: false, error: e.message }; }
            },
            args: [url]
        }, (data) => {
            chrome.tabs.remove(tabId).catch(() => {});
            if (data && data[0] && data[0].result && data[0].result.success) {
                // Reconstruct Blob from Data URL
                fetch(data[0].result.data).then(r=>r.blob()).then(b=>resolve(b));
            } else {
                // Fallback: Main Thread Fetch
                if (url && url.startsWith('http')) {
                     console.warn("Tab internal fetch failed, trying main thread fetch fallback...");
                     fetch(url).then(r => {
                         if (!r.ok) throw new Error("Main thread fallback failed");
                         return r.blob();
                     }).then(b => resolve(b)).catch(e => reject(new Error("Failed to fetch data inside Tab and Main Thread: " + (data?.[0]?.result?.error || e.message))));
                } else {
                     reject(new Error("Failed to fetch data inside Tab: " + (data?.[0]?.result?.error || "Unknown")));
                }
            }
        });
    }
};

window.Sniffer = Sniffer;
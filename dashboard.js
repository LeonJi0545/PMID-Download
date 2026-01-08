// dashboard.js - 修复版

let dirHandle = null;
let failedPmids = []; // 明确初始化
let failedErrors = []; // 详细错误记录

// --- 1. 文件夹选择逻辑 ---
document.getElementById('selectDirBtn').addEventListener('click', async () => {
    try {
        dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        const hasPermission = await verifyPermission(dirHandle, true);
        
        if (hasPermission) {
            document.getElementById('folderStatus').textContent = `✅ Selected: ${dirHandle.name}`;
            document.getElementById('startBtn').disabled = false;
            log(`Folder selected: ${dirHandle.name}`, 'success');
        } else {
            log('Error: Write permission denied.', 'error');
        }
    } catch (e) {
        log(`Selection cancelled or failed: ${e.message}`, 'warn');
    }
});

async function verifyPermission(fileHandle, readWrite) {
    const options = {};
    if (readWrite) options.mode = 'readwrite';
    if ((await fileHandle.queryPermission(options)) === 'granted') return true;
    if ((await fileHandle.requestPermission(options)) === 'granted') return true;
    return false;
}

// --- 2. 启动按钮逻辑 ---
document.getElementById('startBtn').addEventListener('click', async () => {
    const rawInput = document.getElementById('pmidInput').value.trim();
    if (!rawInput) return alert('Please enter PMIDs!');
    
    const pmids = rawInput.split(/[\s,]+/).filter(id => /^(L)?\d+$/i.test(id));
    if (pmids.length === 0) return alert('No valid IDs found (PMID or Embase L-Number)!');
    
    processBatch(pmids);
});

// --- 3. 核心批量处理流程 ---
async function processBatch(pmids) {
    const startBtn = document.getElementById('startBtn');
    startBtn.disabled = true;
    
    // 获取配置
    const enableSciHub = document.getElementById('enableSciHub') ? document.getElementById('enableSciHub').checked : true;
    
    // 开启 Header 伪装
    await chrome.runtime.sendMessage({ action: 'enableSpoofing' });
    // Give SW some time to propagate rules
    await new Promise(r => setTimeout(r, 500));
    
    // 清理界面
    const logContainer = document.getElementById('logArea');
    const resultContainer = document.getElementById('resultArea');
    const errorContainer = document.getElementById('errorArea');
    if(logContainer) logContainer.innerHTML = '';
    if(resultContainer) resultContainer.innerHTML = '';
    if(errorContainer) errorContainer.innerHTML = '';
    
    failedPmids = [];
    failedErrors = [];
    let success = 0, fail = 0;

    // --- 并发控制 (Concurrency Control) ---
    const CONCURRENCY = 3; // 同时处理 3 个任务
    const queue = [...pmids];
    
    // 单个任务处理函数
    const processSinglePmid = async (pmid) => {
        log(`[${pmid}] Analyzing...`);
        chrome.runtime.sendMessage({ action: 'ping' }); // Keep SW alive
        
        try {
            // A. 解析链接
            const result = await window.PmidLogic.resolvePdfUrl(pmid, { enableSciHub });
            
            if (!result || !result.url) throw new Error("Link not found");
            
            log(`[${pmid}] Strategy: ${result.source}`, 'blue');
            // Debug Log
            log(`[${pmid}] URL: ${result.url}`, 'info');

            let blob = null;

            // B. 尝试直连下载 (如果是 OA 或 API)
            if (result.method === 'direct') {
                try {
                    const res = await fetchWithRetry(result.url);
                    log(`[${pmid}] Direct fetch HTTP ${res.status}`);
                    blob = await res.blob();
                    
                    const isValid = await validatePdfMagicBytes(blob);
                    if (!isValid) {
                        log(`[${pmid}] Direct blob invalid (Size: ${blob.size})`, 'warn');
                        throw new Error("Not a PDF file");
                    }
                } catch (e) {
                    log(`[${pmid}] Direct fetch failed (${e.message}), switching to Tab mode...`, 'warn');
                    blob = null; // 确保进入 Tab 模式
                }
            }

            // C. Tab 模式 (应对 Publisher DOI / Sci-Hub / 直连失败)
            if (!blob) {
                log(`[${pmid}] Entering Tab Mode...`);
                // 依赖浏览器 Cookie 自动跳转
                blob = await fetchBlobViaTab(result.url);
                log(`[${pmid}] Tab Mode Result: ${blob ? blob.size + ' bytes' : 'null'}`);
            }

            // D. 保存文件
            if (blob) {
                const isValid = await validatePdfMagicBytes(blob);
                if (isValid) {
                    const fileHandle = await dirHandle.getFileHandle(`${pmid}.pdf`, { create: true });
                    const writable = await fileHandle.createWritable();
                    await writable.write(blob);
                    await writable.close();
                    
                    log(`[${pmid}] ✅ Saved successfully`, 'success');
                    addResult(pmid);
                    success++;
                } else {
                    log(`[${pmid}] Final Blob Invalid! Size: ${blob.size}`, 'error');
                    // Inspect first few bytes
                    if (blob.size > 0) {
                         const arr = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
                         const hex = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join(' ');
                         log(`[${pmid}] Header Bytes: ${hex}`, 'error');
                    }
                    throw new Error(`Failed to get valid PDF content (Invalid Header)`);
                }
            } else {
                throw new Error(`Failed to get valid PDF content (Blob is null)`);
            }

        } catch (e) {
            fail++;
            log(`[${pmid}] ❌ Failed: ${e.message}`, 'error');
            addError(pmid, 'N/A', e.message);
        }
        
        // 礼貌延时 (每个 Worker 处理完一个后休息一下)
        await new Promise(r => setTimeout(r, 1000));
    };

    // 启动 Worker (并发处理)
    const workers = [];
    for (let i = 0; i < Math.min(pmids.length, CONCURRENCY); i++) {
        workers.push((async () => {
            while (queue.length > 0) {
                const pmid = queue.shift();
                await processSinglePmid(pmid);
            }
        })());
    }
    
    await Promise.all(workers);

    await chrome.runtime.sendMessage({ action: 'disableSpoofing' });
    log(`🏁 Batch completed. Success: ${success}, Failed: ${fail}`, success > 0 ? 'success' : 'warn');
    startBtn.disabled = false;
}

// --- 4. 核心 Tab 嗅探器 (最终融合版: Embase 跳转 + Sage/通用增强) ---
async function fetchBlobViaTab(url) {
    return new Promise((resolve, reject) => {
        // 后台静默打开标签页
        chrome.tabs.create({ url: url, active: false }, (tab) => {
            if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
            const tabId = tab.id;
            
            // 超时保护 (60秒)
            const timeout = setTimeout(() => {
                chrome.tabs.remove(tabId).catch(() => {});
                reject(new Error("Tab operation timeout"));
            }, 60000);

            let attempts = 0;
            // 轮询检查 (每 1.5 秒一次)
            const interval = setInterval(() => {
                attempts++;
                if (attempts > 40) { // 约 60 秒
                    clearInterval(interval);
                    return; 
                }

                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    func: () => {
                        // --- 内部注入脚本开始 ---
                        try {
                            const host = window.location.hostname;
                            const href = window.location.href;

                            // ===============================================
                            // 🟢 1. 全局优先: 直接 PDF 检测
                            // ===============================================
                            if (href.match(/\.pdf($|\?|#)/i) || document.contentType === 'application/pdf') {
                                return { status: 'FOUND', url: href };
                            }
                            const embed1 = document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]');
                            if (embed1 && embed1.src) {
                                return { status: 'FOUND', url: embed1.src };
                            }


                            // ===============================================
                            // 🟢 2. Embase 专用跳转逻辑 (优先级高于通用嗅探)
                            // ===============================================
                            // 如果还在 Embase，必须先跳出去，否则不可能找到 PDF
                            if (host.includes('embase.com')) {
                                // 寻找 "Full Text" 或 "View at Publisher" 按钮
                                const fullTextBtn = Array.from(document.querySelectorAll('a, button, span')).find(el => {
                                    const txt = (el.textContent || "").toLowerCase().trim();
                                    const title = (el.title || "").toLowerCase();
                                    
                                    // 匹配 Embase 的特定按钮文本
                                    const isMatch = (txt === 'full text' || 
                                                     txt === 'publisher full text' || 
                                                     txt.includes('view at publisher') ||
                                                     title.includes('full text'));
                                    
                                    // 必须是可见的
                                    return isMatch && el.offsetParent !== null;
                                });

                                if (fullTextBtn) {
                                    // 获取真正的链接元素 (如果是 span 包在 a 里)
                                    const link = fullTextBtn.tagName === 'A' ? fullTextBtn : fullTextBtn.closest('a');
                                    
                                    if (link && link.href) {
                                        // 关键: 强制在当前 Tab 跳转，保持 TabID 不变
                                        if (!window.location.href.includes(link.href)) {
                                            window.location.href = link.href;
                                            return { status: 'WAITING', msg: 'Embase: Jumping to Publisher...' };
                                        }
                                    }
                                }
                                // 如果没找到按钮，说明页面还没加载完，继续 WAITING
                                return { status: 'WAITING', msg: 'Embase: Looking for Full Text button...' };
                            }


                            // ===============================================
                            // 🔵 策略 B: 通用 PDF 嗅探 (适用于出版商页面 / Anna's Archive / 直接 PDF)
                            // ===============================================
                            
                            // 1. 如果当前 URL 已经是 PDF
                            if (href.match(/\.pdf($|\?|#)/i) || document.contentType === 'application/pdf') {
                                return { status: 'FOUND', url: href };
                            }
                            
                            // 2. 检查嵌入的 PDF (Embed/Object/Iframe)
                            const embed = document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]');
                            if (embed && embed.src) return { status: 'FOUND', url: embed.src };

                            // 3. 检查 Sage 期刊等特殊结构
                            const sageStyleLink = document.querySelector('a[data-item-name="download-pdf-url"]');
                            if (sageStyleLink) return { status: 'FOUND', url: sageStyleLink.href };

                            // C. 暴力搜索 "Download PDF" 按钮
                            const links = Array.from(document.querySelectorAll('a, button'));
                            const pdfLink = links.find(el => {
                                const h = (el.href || "").toLowerCase();
                                const txt = (el.textContent || el.innerText || "").trim().toLowerCase();
                                const title = (el.title || "").toLowerCase();
                                const ariaLabel = (el.getAttribute('aria-label') || "").toLowerCase();

                                if (!h || h === '#' || h.startsWith('javascript')) return false;

                                // 扩展名匹配
                                if (h.includes('.pdf')) return true;

                                // 关键词匹配
                                const isPdfText = txt === 'pdf' || 
                                                  txt === 'download pdf' || 
                                                  txt === 'download article' || 
                                                  txt.includes('full text pdf') ||
                                                  title.includes('download pdf') ||
                                                  title.includes('download article') ||
                                                  ariaLabel.includes('pdf');
                                
                                // Anna's Archive 特例
                                const isAnna = host.includes('annas-archive') && (txt.includes('slow partner') || txt.includes('libgen'));

                                return isPdfText || isAnna;
                            });

                            if (pdfLink) return { status: 'FOUND', url: pdfLink.href };

                            // 验证码检测
                            if (document.title.includes('Cloudflare') || document.title.includes('Verify')) {
                                return { status: 'CAPTCHA' };
                            }

                            return { status: 'WAITING' };

                        } catch (e) {
                            return { status: 'ERROR', msg: e.message };
                        }
                        // --- 内部注入脚本结束 ---
                    }
                }, (results) => {
                    if (chrome.runtime.lastError) return;
                    if (!results || !results[0] || !results[0].result) return;
                    
                    const res = results[0].result;
                    if (res.msg) console.log(res.msg);

                    if (res.status === 'CAPTCHA') {
                        chrome.tabs.update(tabId, { active: true }).catch(() => {});
                    } 
                    else if (res.status === 'FOUND') {
                        clearInterval(interval);
                        clearTimeout(timeout);
                        console.log(`[Sniffer] PDF Link Found: ${res.url}`);

                        // 在 Tab 上下文中下载
                        chrome.scripting.executeScript({
                            target: { tabId: tabId },
                            func: async (u) => {
                                try {
                                    const r = await fetch(u);
                                    
                                    // 宽松检查：只要不是明确的 HTML 页面，且状态码 200，就尝试作为 Blob 读取
                                    // 因为有些 PDF 链接可能 Content-Type 不规范，或者 fetch 时 header 被修改
                                    const type = (r.headers.get('Content-Type') || '').toLowerCase();
                                    if (!r.ok) return { success: false, error: `HTTP ${r.status}` };
                                    if (type.includes('text/html')) return { success: false, error: 'Received HTML instead of PDF' };

                                    const b = await r.blob();
                                    // 简单的长度检查，防止下载到空文件或错误页
                                    if (b.size < 1000) return { success: false, error: `Blob too small (${b.size} bytes)` };

                                    return new Promise(rs => {
                                        const reader = new FileReader();
                                        reader.onload = () => rs({success:true, data:reader.result});
                                        reader.readAsDataURL(b);
                                    });
                                } catch(e) { return { success: false, error: e.message }; }
                            },
                            args: [res.url]
                        }, (data) => {
                            chrome.tabs.remove(tabId).catch(() => {});
                            if (data && data[0] && data[0].result && data[0].result.success) {
                                fetch(data[0].result.data).then(r=>r.blob()).then(b=>resolve(b));
                            } else {
                                // 如果 Tab 内下载失败，尝试将链接传回主线程再试一次 (兜底)
                                // 这种情况常发生在 Tab 内 fetch 受到严格 CSP 限制时
                                if (res.url && res.url.startsWith('http')) {
                                     console.warn("Tab internal fetch failed, trying main thread fetch fallback...");
                                     fetch(res.url).then(r => {
                                         if (!r.ok) throw new Error("Main thread fallback failed");
                                         return r.blob();
                                     }).then(b => resolve(b)).catch(e => reject(new Error("Failed to fetch data inside Tab and Main Thread: " + (data?.[0]?.result?.error || e.message))));
                                } else {
                                     reject(new Error("Failed to fetch data inside Tab: " + (data?.[0]?.result?.error || "Unknown")));
                                }
                            }
                        });
                    }
                });
            }, 1500); // 1.5秒轮询
        });
    });
}
function startSniffing(tabId, resolve, reject, timeout) {
    // Legacy function placeholder
}

// --- 5. 缺失的辅助函数 (已补全) ---

// 日志函数
function log(msg, type = 'info') {
    const container = document.getElementById('logArea');
    if (!container) return console.log(msg);
    const div = document.createElement('div');
    div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    div.className = `log-entry ${type}`;
    // 简单样式注入
    if (type === 'error') div.style.color = 'red';
    if (type === 'success') div.style.color = 'green';
    if (type === 'blue') div.style.color = 'blue';
    if (type === 'warn') div.style.color = 'orange';
    
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

// 结果列表 UI
function addResult(pmid) {
    const container = document.getElementById('resultArea');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'result-entry';
    div.textContent = `✅ ${pmid}.pdf`;
    div.style.color = 'green';
    container.appendChild(div);
}

// 错误列表 UI
function addError(pmid, url, reason) {
    failedPmids.push(pmid);
    failedErrors.push({ pmid, reason });
    const container = document.getElementById('errorArea');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'result-entry error';
    div.style.color = 'red';
    div.textContent = `❌ ${pmid} : ${reason}`;
    container.appendChild(div);
}

// Fetch 重试机制
async function fetchWithRetry(url, retries = 2) {
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res;
        } catch (err) {
            if (i === retries) throw err;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

// PDF 文件头校验
async function validatePdfMagicBytes(blob) {
    if (blob.size < 4) return false;
    const arr = new Uint8Array(await blob.slice(0, 1024).arrayBuffer()); // Read 1KB
    
    // 1. Strict Check: Starts with %PDF
    if (arr[0] === 0x25 && arr[1] === 0x50 && arr[2] === 0x44 && arr[3] === 0x46) return true;

    // 2. Loose Check: Contains %PDF within first 1KB (some files have whitespace or garbage at start)
    // Convert to string and search (inefficient for large files, but 1KB is fine)
    const headerStr = new TextDecoder().decode(arr);
    if (headerStr.includes('%PDF-')) return true;

    return false;
}

// --- 6. 复制按钮逻辑 ---

document.getElementById('copyErrorsBtn').addEventListener('click', () => {
    if (!failedPmids || failedPmids.length === 0) {
        alert('No failed PMIDs to copy.');
        return;
    }
    navigator.clipboard.writeText(failedPmids.join('\n')).then(() => {
        const btn = document.getElementById('copyErrorsBtn');
        const originalText = btn.innerHTML;
        btn.innerHTML = '✅ Copied!';
        setTimeout(() => btn.innerHTML = originalText, 2000);
    }).catch(err => {
        console.error('Failed to copy:', err);
        alert('Failed to copy to clipboard');
    });
});

document.getElementById('copyErrorListBtn').addEventListener('click', () => {
    if (!failedErrors || failedErrors.length === 0) {
        alert('No error logs to copy.');
        return;
    }
    // Format: PMID - Reason
    const text = failedErrors.map(e => `${e.pmid} : ${e.reason}`).join('\n');
    
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('copyErrorListBtn');
        const originalText = btn.innerHTML;
        btn.innerHTML = '✅ Copied!';
        setTimeout(() => btn.innerHTML = originalText, 2000);
    }).catch(err => {
        console.error('Failed to copy:', err);
        alert('Failed to copy to clipboard');
    });
});
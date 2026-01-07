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
    
    const pmids = rawInput.split(/[\s,]+/).filter(id => /^\d+$/.test(id));
    if (pmids.length === 0) return alert('No valid PMIDs found!');
    
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
            // log(`[${pmid}] URL: ${result.url}`, 'info');

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

// --- 4. 核心 Tab 嗅探器 (修复版) ---
async function fetchBlobViaTab(url) {
    return new Promise((resolve, reject) => {
        chrome.tabs.create({ url: url, active: false }, (tab) => {
            if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
            const tabId = tab.id;
            
            // 总超时 60s
            const timeout = setTimeout(() => {
                chrome.tabs.remove(tabId).catch(() => {});
                reject(new Error("Tab operation timeout"));
            }, 60000);

            let attempts = 0;
            const interval = setInterval(() => {
                attempts++;
                if (attempts > 30) { // 30次 * 2秒 = 60秒
                    clearInterval(interval);
                    return; 
                }

                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    func: () => {
                        try {
                            // 1. 检查当前 URL 是否是 PDF
                            if (window.location.href.match(/\.pdf($|\?)/i) || document.contentType === 'application/pdf') {
                                return { status: 'FOUND', url: window.location.href };
                            }
                            // 2. 检查 Chrome 内置 Viewer
                            if (document.querySelector('embed[type="application/pdf"]')) {
                                return { status: 'FOUND', url: document.querySelector('embed').src };
                            }
                            // 3. 检查常见学术 Meta 标签
                            const metaPdf = document.querySelector('meta[name="citation_pdf_url"]');
                            if (metaPdf && metaPdf.content) return { status: 'FOUND', url: metaPdf.content };
                            
                            // 4. 暴力搜索 "Download PDF" 按钮
                            const links = Array.from(document.querySelectorAll('a'));
                            const pdfLink = links.find(a => {
                                const txt = a.textContent.toLowerCase();
                                const href = a.href.toLowerCase();
                                if (href.startsWith('javascript') || href === '#' || !href) return false;
                                return (txt.includes('download') && txt.includes('pdf')) ||
                                       (txt.includes('view') && txt.includes('pdf')) ||
                                       (a.title && a.title.toLowerCase().includes('download pdf'));
                            });
                            if (pdfLink) return { status: 'FOUND', url: pdfLink.href };

                            // 5. Sci-Hub 特殊处理
                            if (window.location.hostname.includes('sci-hub')) {
                                const embed = document.querySelector('embed');
                                if (embed && embed.src) return { status: 'FOUND', url: embed.src };
                            }

                            // 6. 验证码检测
                            if (document.title.includes('Cloudflare') || document.title.includes('Verify')) {
                                return { status: 'CAPTCHA' };
                            }

                            return { status: 'WAITING' };
                        } catch (e) {
                            return { status: 'ERROR', msg: e.message };
                        }
                    }
                }, (results) => {
                    // Handle potential injection errors (e.g. tab closed, error page)
                    if (chrome.runtime.lastError) {
                        // console.warn("Injection failed:", chrome.runtime.lastError.message);
                        return;
                    }

                    if (!results || !results[0]) return;
                    const res = results[0].result;
                    if (!res) return; // Safety check

                    if (res.status === 'CAPTCHA') {
                        chrome.tabs.update(tabId, { active: true }).catch(() => {}); // 遇到验证码弹窗，忽略可能的错误
                    } 
                    else if (res.status === 'FOUND') {
                        clearInterval(interval);
                        clearTimeout(timeout);
                        
                        // 在 Tab 上下文中下载数据 (继承 Cookie)
                        chrome.scripting.executeScript({
                            target: { tabId: tabId },
                            func: async (u) => {
                                try {
                                    const r = await fetch(u);
                                    if(!r.ok) return null;
                                    const b = await r.blob();
                                    return new Promise(rs => {
                                        const reader = new FileReader();
                                        reader.onload = () => rs({success:true, data:reader.result});
                                        reader.readAsDataURL(b);
                                    });
                                } catch(e) { return null; }
                            },
                            args: [res.url]
                        }, (data) => {
                            chrome.tabs.remove(tabId).catch(() => {});
                            if (data && data[0] && data[0].result && data[0].result.success) {
                                fetch(data[0].result.data).then(r=>r.blob()).then(b=>resolve(b));
                            } else {
                                reject(new Error("Failed to fetch data inside Tab"));
                            }
                        });
                    }
                });
            }, 2000); // 每2秒轮询
        });
    });
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
    const arr = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    // %PDF (Hex: 25 50 44 46)
    return arr[0] === 0x25 && arr[1] === 0x50 && arr[2] === 0x44 && arr[3] === 0x46;
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
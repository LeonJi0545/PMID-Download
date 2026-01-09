// dashboard.js - 修复版

let dirHandle = null;
let failedPmids = []; // 明确初始化
let failedErrors = []; // 详细错误记录
let successPmids = []; // 成功列表

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

    const queue = [...pmids];
    
    // 单个任务处理函数
    const processSinglePmid = async (pmid) => {
        log(`[${pmid}] Analyzing...`);
        chrome.runtime.sendMessage({ action: 'ping' }); // Keep SW alive
        
        let lastError = null;

        // Validation Callback (Passed to Logic)
        // This function attempts to download and save the PDF.
        // Returns true if successful (stopping the strategy loop), false otherwise.
        const validateStrategy = async (result) => {
            if (!result || !result.url) return false;
            
            log(`[${pmid}] Trying Strategy: ${result.source}`, 'blue');
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
                        blob = null; // Trigger fallback
                    }
                } catch (e) {
                    log(`[${pmid}] Direct fetch failed (${e.message}), switching to Tab mode...`, 'warn');
                    blob = null;
                }
            }

            // C. Tab 模式 (应对 Publisher DOI / Sci-Hub / 直连失败)
            if (!blob) {
                log(`[${pmid}] Entering Tab Mode...`);
                try {
                    // Use the extracted Sniffer class
                    blob = await window.Sniffer.fetchBlobViaTab(result.url);
                    log(`[${pmid}] Tab Mode Result: ${blob ? blob.size + ' bytes' : 'null'}`);
                } catch (e) {
                    log(`[${pmid}] Tab Mode failed: ${e.message}`, 'warn');
                    blob = null;
                }
            }

            // D. 保存文件
            if (blob) {
                const isValid = await validatePdfMagicBytes(blob);
                if (isValid) {
                    try {
                        const fileHandle = await dirHandle.getFileHandle(`${pmid}.pdf`, { create: true });
                        const writable = await fileHandle.createWritable();
                        await writable.write(blob);
                        await writable.close();
                        
                        log(`[${pmid}] ✅ Saved successfully (${result.source})`, 'success');
                        addResult(pmid);
                        success++;
                        return true; // SUCCESS: Stop strategy loop
                    } catch (e) {
                        log(`[${pmid}] Save failed: ${e.message}`, 'error');
                        lastError = `Save error: ${e.message}`;
                        return false;
                    }
                } else {
                    log(`[${pmid}] Final Blob Invalid! Size: ${blob.size}`, 'error');
                    // Inspect first few bytes
                    if (blob.size > 0) {
                         const arr = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
                         const hex = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join(' ');
                         log(`[${pmid}] Header Bytes: ${hex}`, 'error');
                    }
                    lastError = "Invalid PDF Header";
                    return false;
                }
            } else {
                lastError = "Download failed (Blob is null)";
                return false;
            }
        };

        try {
            // Start the resolution process with validation
            // resolvePdfUrl will now iterate until validateStrategy returns true
            const finalResult = await window.PmidLogic.resolvePdfUrl(pmid, { 
                enableSciHub, 
                validateStrategy 
            });
            
            if (!finalResult) {
                 throw new Error(lastError || "All strategies failed");
            }

        } catch (e) {
            fail++;
            log(`[${pmid}] ❌ Failed: ${e.message}`, 'error');
            addError(pmid, 'N/A', e.message);
        }
        
        // 礼貌延时 (每个 Worker 处理完一个后休息一下)
        await new Promise(r => setTimeout(r, 1000));
    };
    // 并发数量
    const BATCH_NUM = 3;
    // 启动 Worker (并发处理)
    const workers = [];
    for (let i = 0; i < Math.min(pmids.length, BATCH_NUM); i++) {
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

// --- 4. 核心 Tab 嗅探器 ---
// 已提取到 sniffer.js (window.Sniffer)

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
    successPmids.push(pmid);
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

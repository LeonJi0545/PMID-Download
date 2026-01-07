// background.js - Traffic Spoofing Center

// Listen for switch commands from dashboard
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'enableSpoofing') {
        applySpoofingRules();
        sendResponse({ status: 'Spoofing Enabled' });
    } else if (message.action === 'disableSpoofing') {
        clearSpoofingRules();
        sendResponse({ status: 'Spoofing Disabled' });
    } else if (message.action === 'ping') {
        sendResponse({ status: 'pong' });
    }
});

const RULE_ID_SPOOF = 1;
const RULE_ID_CSP = 2;

async function applySpoofingRules() {
    // Remove old rules, add new rules
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [RULE_ID_SPOOF, RULE_ID_CSP],
        addRules: [
            // Rule 1: Request Headers Spoofing (Anti-Bot)
            {
                "id": RULE_ID_SPOOF,
                "priority": 1,
                "action": {
                    "type": "modifyHeaders",
                    "requestHeaders": [
                        // Spoof Referer to bypass publisher anti-bot checks
                        { "header": "Referer", "operation": "set", "value": "https://scholar.google.com/" },
                        // Remove headers that might expose the extension identity
                        { "header": "Sec-Fetch-Site", "operation": "remove" }
                    ]
                },
                "condition": {
                    // Only apply to academic domains
                    "urlFilter": "*",
                    "initiatorDomains": ["wiley.com", "onlinelibrary.wiley.com", "springer.com", "link.springer.com", "sciencedirect.com", "sci-hub.se", "sci-hub.st", "sci-hub.ru", "embase.com", "annas-archive.li"],
                    // STRICTLY LIMIT spoofing to document requests and API calls. 
                    // NEVER spoof scripts/styles/images, as it breaks CORS/CSP.
                    "resourceTypes": ["main_frame", "sub_frame", "xmlhttprequest"] 
                }
            },
            // Rule 2: Response Headers Stripping (Fix CSP Errors)
            {
                "id": RULE_ID_CSP,
                "priority": 9999,
                "action": {
                    "type": "modifyHeaders",
                    "responseHeaders": [
                        { "header": "Content-Security-Policy", "operation": "remove" },
                        { "header": "Content-Security-Policy-Report-Only", "operation": "remove" },
                        { "header": "X-Frame-Options", "operation": "remove" } // Also allow framing if needed
                    ]
                },
                "condition": {
                    // Aggressive: Remove CSP from EVERYTHING to prevent script blocking
                    "urlFilter": "*",
                    // Removed initiatorDomains restriction to ensure it hits all possible iframes/scripts
                    "resourceTypes": ["main_frame", "sub_frame", "xmlhttprequest", "script", "stylesheet", "font", "image", "other"]
                }
            }
        ]
    });
    console.log("✅ Anti-Bot Rules & CSP Stripping Applied");
}

async function clearSpoofingRules() {
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [RULE_ID_SPOOF, RULE_ID_CSP]
    });
    console.log("🚫 Rules Cleared");
}

// Listen for commands from dashboard
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'startSniffing') {
        // Save target Tab ID to storage so it persists through SW restarts
        chrome.storage.local.set({ targetTabId: msg.tabId });

        console.log(`[Background] Started sniffing PDF traffic for Tab ${msg.tabId}`);
        sendResponse({status: 'ok'});
    }
});

// Listen for HTTP response headers
chrome.webRequest.onHeadersReceived.addListener(
    async (details) => { // 注意: 这里变成了 async
        
        // Retrieve target Tab ID from storage
        const result = await chrome.storage.local.get('targetTabId');
        const targetTabId = result.targetTabId;

        // Filter by tab ID
        if (details.tabId !== targetTabId) return;

        // Check if Content-Type is PDF
        const contentTypeHeader = details.responseHeaders.find(
            h => h.name.toLowerCase() === 'content-type'
        );

        if (contentTypeHeader) {
            const type = contentTypeHeader.value.toLowerCase();
            if (type.includes('application/pdf') || type.includes('binary/octet-stream')) {
                // Exclude tiny files (might be icons or errors)
                // Can send message to dashboard here
                console.log(`[Sniffer] Captured PDF stream: ${details.url}`);
                
                chrome.runtime.sendMessage({
                    action: 'pdfFound',
                    url: details.url,
                    tabId: details.tabId
                });
            }
        }
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
);
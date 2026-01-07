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

const RULE_ID = 1;

async function applySpoofingRules() {
    // Remove old rules, add new rules
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [RULE_ID],
        addRules: [
            {
                "id": RULE_ID,
                "priority": 1,
                "action": {
                    "type": "modifyHeaders",
                    "requestHeaders": [
                        // Spoof Referer to bypass publisher anti-bot checks
                        { "header": "Referer", "operation": "set", "value": "https://scholar.google.com/" },
                        // Note: We avoid setting 'Origin' globally as it breaks CSP for many sites
                        // Remove headers that might expose the extension identity
                        { "header": "Sec-Fetch-Site", "operation": "remove" }
                    ]
                },
                "condition": {
                    // Only apply to academic domains to avoid breaking other websites
                    "urlFilter": "*",
                    "initiatorDomains": ["wiley.com", "springer.com", "sciencedirect.com", "sci-hub.se", "sci-hub.st", "sci-hub.ru"],
                    // Do not interfere with static assets like scripts and fonts (fixes CSP errors)
                    "excludedResourceTypes": ["script", "stylesheet", "font", "image"]
                }
            }
        ]
    });
    console.log("✅ Anti-Bot Rules Applied: Referer set to Google Scholar");
}

async function clearSpoofingRules() {
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [RULE_ID]
    });
    console.log("🚫 Anti-Bot Rules Cleared");
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
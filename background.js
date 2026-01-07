// background.js - Traffic Spoofing Center

// Listen for switch commands from dashboard
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'enableSpoofing') {
        applySpoofingRules();
        sendResponse({ status: 'Spoofing Enabled' });
    } else if (message.action === 'disableSpoofing') {
        clearSpoofingRules();
        sendResponse({ status: 'Spoofing Disabled' });
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
                        // Spoof Referer to make Wiley think you are coming from Google Scholar
                        { "header": "Referer", "operation": "set", "value": "https://scholar.google.com/" },
                        { "header": "Origin", "operation": "set", "value": "https://scholar.google.com/" },
                        // Remove headers that might expose the extension identity
                        { "header": "Sec-Fetch-Site", "operation": "remove" }
                    ]
                },
                "condition": {
                    // Apply to all requests, or restrict to specific academic domains
                    "resourceTypes": ["xmlhttprequest", "main_frame", "sub_frame"],
                    "urlFilter": "*" 
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
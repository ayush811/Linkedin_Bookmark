chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("[lib] side panel behaviour", err));
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg && msg.type === "OPEN_PANEL" && sender.tab) {
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
    respond({ ok: true });
  }
  return false;
});

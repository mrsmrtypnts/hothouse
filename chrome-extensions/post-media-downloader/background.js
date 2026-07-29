// background.js — Post Media Downloader  v1.5
// Service worker: handles ping and individual file downloads.

'use strict';

// ─── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.action === 'ping') {
    sendResponse({ ok: true });
    return false;
  }

  // ── Individual file download ───────────────────────────────────────────────
  if (msg.action === 'download') {
    chrome.downloads.download(
      { url: msg.url, filename: msg.filename, conflictAction: 'uniquify' },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, downloadId });
        }
      }
    );
    return true;
  }

});

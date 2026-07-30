const NATIVE_HOST = 'com.imagedl.host';

// Chrome can kill MV3 service workers after ~30 s of apparent inactivity even
// during a long native-messaging call.  Firing an alarm every 20 s prevents
// that while a download is in flight.
let activeDownloads = 0;
chrome.alarms.onAlarm.addListener(() => { /* heartbeat — just wakes the worker */ });

function startKeepAlive() {
  if (activeDownloads++ === 0) {
    chrome.alarms.create('swKeepAlive', { periodInMinutes: 1 / 3 }); // every 20 s
  }
}
function stopKeepAlive() {
  if (--activeDownloads <= 0) {
    activeDownloads = 0;
    chrome.alarms.clear('swKeepAlive');
  }
}

function nativeMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

async function getTargetDir() {
  return new Promise((resolve) => {
    chrome.storage.local.get('targetDir', (data) => resolve(data.targetDir || null));
  });
}

async function pickAndSaveFolder() {
  const response = await nativeMessage({ action: 'pick_folder' });
  if (!response?.path) throw new Error('No folder selected');
  await chrome.storage.local.set({ targetDir: response.path });
  return response.path;
}

function setLastStatus(entry) {
  chrome.storage.local.set({ lastDownloadStatus: { ...entry, ts: new Date().toLocaleTimeString() } });
}

// The native host runs as a separate OS process with no access to Chrome's
// cookie jar, so a request to a local server that gates access behind a
// cookie (e.g. breeder's `breeder_token`) gets a bare 401/403. Those servers
// also accept the same token via a `?token=` query param, so fetch the
// cookie here and fold it into the URL before handing it off.
async function withAuthToken(src) {
  let url;
  try {
    url = new URL(src);
  } catch {
    return src;
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return src;
  let cookie;
  try {
    cookie = await chrome.cookies.get({ url: src, name: 'breeder_token' });
  } catch {
    return src;
  }
  if (!cookie?.value) return src;
  url.searchParams.set('token', cookie.value);
  return url.toString();
}

async function handleDownload(src, allowDupe) {
  let targetDir = await getTargetDir();
  if (!targetDir) {
    targetDir = await pickAndSaveFolder();
  }
  const downloadUrl = await withAuthToken(src);
  console.log('[img-dl] downloading', src, '→', targetDir);
  startKeepAlive();
  let response;
  try {
    response = await nativeMessage({ action: 'download_url', url: downloadUrl, to_dir: targetDir, allow_dupe: allowDupe });
  } catch (e) {
    console.error('[img-dl] native messaging error:', e.message);
    setLastStatus({ ok: false, error: e.message, src });
    throw e;
  } finally {
    stopKeepAlive();
  }
  if (response?.dupe) {
    return { dupe: true };
  }
  if (!response?.success) {
    let errorMsg = response?.error || 'Download failed';
    if (errorMsg.startsWith('__INVALID_TARGET__')) {
      await chrome.storage.local.remove('targetDir');
      errorMsg = errorMsg.slice('__INVALID_TARGET__'.length);
    }
    console.error('[img-dl] native host error:', errorMsg);
    setLastStatus({ ok: false, error: errorMsg, src });
    throw new Error(errorMsg);
  }
  console.log('[img-dl] saved to', response.dest_path);
  setLastStatus({ ok: true, dest: response.dest_path, src });
  return { destPath: response.dest_path };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'download_image') {
    handleDownload(msg.src, msg.allowDupe)
      .then((result) => {
        if (result?.dupe) {
          sendResponse({ success: false, dupe: true });
        } else {
          sendResponse({ success: true, destPath: result?.destPath });
        }
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === 'pick_folder') {
    pickAndSaveFolder()
      .then((path) => sendResponse({ success: true, path }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === 'get_target_dir') {
    getTargetDir().then((dir) => sendResponse({ dir }));
    return true;
  }
});

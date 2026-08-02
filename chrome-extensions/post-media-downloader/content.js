// content.js — Post Media Downloader  v1.6
// Injected on target site post pages.

'use strict';

// ─── Magic-byte extension correction ─────────────────────────────────────────
// The target site sometimes serves MP4 video under a .webm URL.  We detect this by
// checking the file's magic bytes and fix the extension when they disagree.
//
//   Real WebM/MKV : starts with EBML marker  1A 45 DF A3
//   MP4/MOV       : has 'ftyp' box at offset 4–7  (66 74 79 70)

function correctExtension(filename, first8bytes) {
  if (!filename.toLowerCase().endsWith('.webm')) return filename;
  const b = first8bytes;
  // Real WebM/MKV always starts with the EBML marker — keep the name.
  const isRealWebM = b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3;
  if (isRealWebM) return filename;
  // Anything else under a .webm URL on this site is MP4 (ftyp box may land at
  // different offsets in fragmented/progressive variants, so we don't require
  // a positive ftyp check — absence of EBML is sufficient).
  return filename.slice(0, -4) + 'mp4';
}

/** For the individual-download path: fetch just 8 bytes to sniff the format. */
async function sniffAndFixFilename(url, filename) {
  if (!filename.toLowerCase().endsWith('.webm')) return filename;
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-7' } });
    const buf = new Uint8Array(await res.arrayBuffer());
    return correctExtension(filename, buf);
  } catch (e) {
    return filename; // on any error, keep the original name
  }
}

const HOST_ID = 'pmd-host';
const CDN_HOST_RE = /image\.civitai\.red/;  // target CDN pattern

// ─── URL / filename helpers ───────────────────────────────────────────────────

function extractFilename(url) {
  try {
    let target = url;
    const u = new URL(url);
    if (u.pathname.startsWith('/_next/image')) {
      const inner = u.searchParams.get('url');
      if (inner) target = decodeURIComponent(inner);
    }
    const path = new URL(target).pathname
      .replace(/\/(?:width|height|quality|original)=[^/]+/g, '');
    const last = path.split('/').filter(Boolean).pop() || 'media';
    return last.split('?')[0] || 'media';
  } catch { return 'media'; }
}

function toOriginalUrl(url) {
  try {
    const u = new URL(url);
    if (u.pathname.startsWith('/_next/image')) {
      const inner = u.searchParams.get('url');
      if (inner) return decodeURIComponent(inner);
    }
    if (CDN_HOST_RE.test(u.hostname)) {
      // Keep the width already in the URL (edge-cached, fast) but bump it to
      // the largest standard variant so we don't download a thumbnail.
      // Requesting /original=true/ works but is not edge-cached — very high TTFB.
      return `${u.origin}${u.pathname.replace(/\/(?:width)=\d+/g, '/width=1920').replace(/\/(?:height|quality|original)=[^/]+/g, '')}`;
    }
    return url;
  } catch { return url; }
}

function isUsableUrl(url) {
  return !!(url && !url.startsWith('data:') && !url.startsWith('blob:') && url.startsWith('http'));
}

// Filenames used for video placeholders / thumbnails — not real media
const IGNORED_FILENAMES = new Set(['media.webp', 'media', 'media.jpg', 'media.png']);

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_');
}

function buildFilename(prefix, index, total, origName) {
  const pad = Math.max(2, String(total).length);
  return sanitize(prefix) + String(index).padStart(pad, '0') + '-' + sanitize(origName);
}

// ─── Media discovery ──────────────────────────────────────────────────────────

const SKIP_TAGS  = new Set(['HEADER', 'NAV', 'FOOTER', 'ASIDE', 'DIALOG']);
const SKIP_ROLES = new Set(['banner', 'navigation', 'complementary', 'contentinfo']);
const AD_RE      = /\b(?:advert(?:isement)?|banner-ad|sponsor(?:ed)?|promo(?:tion)?)\b/i;

function isInChrome(el) {
  let node = el.parentElement;
  while (node && node !== document.body) {
    if (SKIP_TAGS.has(node.tagName)) return true;
    const role = node.getAttribute('role') || '';
    if (SKIP_ROLES.has(role)) return true;
    const tok = (typeof node.className === 'string' ? node.className : '') + ' ' + (node.id || '');
    if (AD_RE.test(tok)) return true;
    node = node.parentElement;
  }
  return false;
}

function findMediaItems() {
  const items = [];
  const seen  = new Set();

  function add(rawUrl, type) {
    if (!isUsableUrl(rawUrl)) return;
    const url      = type === 'image' ? toOriginalUrl(rawUrl) : rawUrl;
    const filename = extractFilename(rawUrl);
    if (seen.has(url)) return;
    // Skip known placeholder/thumbnail filenames
    if (IGNORED_FILENAMES.has(filename.toLowerCase())) return;
    seen.add(url);
    items.push({ type, url, filename });
  }

  // Videos
  document.querySelectorAll('video').forEach(v => {
    const src = v.currentSrc || v.getAttribute('src');
    if (src) {
      add(src, 'video');
    } else {
      v.querySelectorAll('source').forEach(s => add(s.src || s.getAttribute('src'), 'video'));
    }
  });
  document.querySelectorAll('source').forEach(s => {
    if (!s.closest('video')) add(s.src || s.getAttribute('src'), 'video');
  });

  // Images — target CDN only, ≥ 200×200 display px, not banner-shaped, not chrome
  document.querySelectorAll('img').forEach(img => {
    const src = img.currentSrc || img.src;
    if (!isUsableUrl(src)) return;

    const isCDN       = CDN_HOST_RE.test(src);
    const isNextProxy = src.includes('/_next/image') && CDN_HOST_RE.test(src);
    if (!isCDN && !isNextProxy) return;

    if (isInChrome(img)) return;

    const ariaHidden = img.getAttribute('aria-hidden');
    const role       = img.getAttribute('role') || '';
    if (ariaHidden === 'true' || /^(?:presentation|none)$/.test(role)) return;

    const rect = img.getBoundingClientRect();
    if (rect.width < 200 || rect.height < 200) return;
    if (rect.width / rect.height > 3.5) return;

    add(src, 'image');
  });

  return items;
}

// ─── Shadow-DOM panel ─────────────────────────────────────────────────────────

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  #fab {
    background: #1971c2; color: #fff; border: none; border-radius: 10px;
    padding: 10px 16px; cursor: pointer; font: 700 14px/1 system-ui,sans-serif;
    box-shadow: 0 4px 16px rgba(0,0,0,.5); transition: background .15s; display: block;
  }
  #fab:hover { background: #1864ab; }
  #panel {
    display: none; flex-direction: column; width: 360px;
    background: #1a1b1e; border: 1px solid #373a40; border-radius: 12px;
    box-shadow: 0 10px 40px rgba(0,0,0,.6); overflow: hidden;
    font: 13px/1.5 system-ui,sans-serif; color: #c1c2c5;
  }
  #panel.open { display: flex; }
  .hdr {
    background: #141517; padding: 11px 14px;
    display: flex; align-items: center; justify-content: space-between;
    border-bottom: 1px solid #373a40; flex-shrink: 0;
  }
  .hdr-title { font-weight: 700; font-size: 13px; color: #4dabf7; }
  .hdr-title em { color: #868e96; font-style: normal; font-weight: 400; font-size: 11px; margin-left: 6px; }
  .x-btn { background: none; border: none; color: #868e96; cursor: pointer; font-size: 17px; line-height: 1; }
  .x-btn:hover { color: #c1c2c5; }
  .body { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .lbl { font-size: 11px; color: #868e96; font-weight: 600; text-transform: uppercase; letter-spacing: .4px; }
  input[type=text] {
    background: #25262b; border: 1px solid #373a40; border-radius: 6px;
    padding: 7px 10px; color: #c1c2c5; font: 13px system-ui,sans-serif;
    outline: none; width: 100%;
  }
  input[type=text]:focus { border-color: #4dabf7; }
  .hint { font-size: 11px; color: #5c5f66; }
  .row { display: flex; gap: 8px; }
  .btn {
    flex: 1; padding: 8px 0; border-radius: 6px; border: none;
    cursor: pointer; font: 600 13px system-ui,sans-serif; transition: background .15s;
  }
  .btn.sec { background: #2c2e33; color: #c1c2c5; }
  .btn.sec:hover { background: #373a40; }
  .btn.pri { background: #1971c2; color: #fff; }
  .btn.pri:hover { background: #1864ab; }
  .btn.grn { background: #2f9e44; color: #fff; }
  .btn.grn:hover { background: #2b8a3e; }
  .btn:disabled { opacity: .35; cursor: not-allowed; }
  #list { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
  .item {
    display: flex; align-items: center; gap: 7px;
    background: #25262b; border-radius: 6px; padding: 6px 8px; font-size: 12px;
  }
  .item input[type=checkbox] { flex-shrink: 0; accent-color: #4dabf7; cursor: pointer; }
  .badge { flex-shrink: 0; font-size: 10px; font-weight: 700; padding: 2px 5px; border-radius: 4px; text-transform: uppercase; }
  .badge.video { background: #c92a2a; color: #fff; }
  .badge.image { background: #2f9e44; color: #fff; }
  .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st { flex-shrink: 0; font-size: 13px; }
  .st.ok   { color: #51cf66; }
  .st.err  { color: #ff6b6b; }
  .st.busy { color: #fab005; }
  .empty { text-align: center; color: #5c5f66; padding: 18px 0; font-size: 12px; line-height: 1.7; }
  #status { text-align: center; font-size: 11px; color: #868e96; min-height: 14px; padding-top: 2px; }
  #status.err  { color: #ff6b6b; }
  #status.warn { color: #fab005; }
  .prog-wrap { height: 3px; background: #25262b; border-radius: 2px; overflow: hidden; }
  .prog-bar  { height: 100%; background: #4dabf7; border-radius: 2px; transition: width .3s; width: 0; }
`;

function buildHost() {
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText =
    'position:fixed;bottom:22px;right:22px;z-index:2147483647;' +
    'display:flex;flex-direction:column;align-items:flex-end;gap:10px;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>${CSS}</style>
    <div id="panel">
      <div class="hdr">
        <span class="hdr-title">⬇ Media Downloader <em>v1.6</em></span>
        <button class="x-btn" id="x">✕</button>
      </div>
      <div class="body">

        <div class="field">
          <span class="lbl">Tag</span>
          <input type="text" id="tag" placeholder='e.g.  my-post' autocomplete="off">
          <span class="hint">Used as filename prefix and (for ⬇ Files) as the Downloads subfolder. Press Enter to save.</span>
        </div>

        <div class="row">
          <button class="btn grn" id="save">📁 Save</button>
          <button class="btn pri" id="dl" >⬇ Files</button>
        </div>

        <div class="prog-wrap" id="prog-wrap" style="display:none">
          <div class="prog-bar" id="prog-bar"></div>
        </div>

        <div id="list">
          <div class="empty">
            Click <strong>Save</strong> or <strong>⬇ Files</strong> to download.<br>
            Scroll through the post first so all items load.
          </div>
        </div>

        <div id="status"></div>
      </div>
    </div>
    <button id="fab">⬇ Media DL</button>
  `;
  return host;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(function init() {
  if (document.getElementById(HOST_ID)) return;

  const host   = buildHost();
  document.body.appendChild(host);
  const shadow = host.shadowRoot;

  const panel    = shadow.getElementById('panel');
  const fab      = shadow.getElementById('fab');
  const xBtn     = shadow.getElementById('x');
  const dlBtn    = shadow.getElementById('dl');
  const saveBtn  = shadow.getElementById('save');
  const tagIn    = shadow.getElementById('tag');
  const list     = shadow.getElementById('list');
  const statusEl = shadow.getElementById('status');
  const progWrap = shadow.getElementById('prog-wrap');
  const progBar  = shadow.getElementById('prog-bar');

  let mediaItems = [];
  let busy = false;

  // ── Open / close ────────────────────────────────────────────────────────
  fab.addEventListener('click', () => {
    panel.classList.add('open');
    fab.style.display = 'none';
    checkConnection();
  });
  xBtn.addEventListener('click', () => {
    panel.classList.remove('open');
    fab.style.display = '';
  });
  tagIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveBtn.click();
    }
  });

  function checkConnection() {
    chrome.runtime.sendMessage({ action: 'ping' }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        setStatus('⚠ Connection lost — please refresh this page (Cmd+R).', 'warn');
        dlBtn.disabled   = true;
        saveBtn.disabled = true;
      }
    });
  }

  // ── Individual file downloads ────────────────────────────────────────────
  dlBtn.addEventListener('click', async () => {
    if (busy) return;
    const tag = tagIn.value.trim() || 'media';

    if (!mediaItems.length) {
      mediaItems = findMediaItems();
      renderList(mediaItems);
      if (!mediaItems.length) {
        setStatus('Nothing found — scroll through the post and try again.');
        return;
      }
    }

    const sel = selectedItems();
    if (!sel.length) { setStatus('No items checked.'); return; }

    setBusy(true);
    let done = 0;
    let firstErr = null;

    for (let i = 0; i < sel.length; i++) {
      const { item, origIdx } = sel[i];
      // Both prefix and folder use the same tag value
      const fname    = buildFilename(tag, origIdx, mediaItems.length, item.filename);
      const fullPath = `${sanitize(tag)}/${fname}`;
      const stEl     = shadow.getElementById(`st-${origIdx - 1}`);

      mark(stEl, 'busy', '⏳');
      setStatus(`Downloading ${i + 1} / ${sel.length} …`);
      setProgress((i + 1) / sel.length * 100, true);

      try {
        const fixedPath = await sniffAndFixFilename(item.url, fullPath);
        await sendDownload(item.url, fixedPath);
        mark(stEl, 'ok', '✓');
        done++;
      } catch (err) {
        mark(stEl, 'err', '✗');
        firstErr = firstErr || err.message;
        console.warn('[PMD]', err.message, item.url);
      }
    }

    if (done === 0 && firstErr) {
      if (/context invalidated|extension context/i.test(firstErr)) {
        setStatus('⚠ Extension was updated — refresh this page (Cmd+R).', 'warn');
      } else if (/connection|receiving end/i.test(firstErr)) {
        setStatus('⚠ Lost connection — refresh this page (Cmd+R).', 'warn');
      } else {
        setStatus(`Error: ${firstErr}`, 'err');
      }
    } else if (done < sel.length) {
      setStatus(`Done — ${done} of ${sel.length} downloaded (${sel.length - done} failed).`);
    } else {
      setStatus(`Done — ${done} file${done !== 1 ? 's' : ''} saved to Downloads/${sanitize(tag)}/`);
    }

    setBusy(false);
  });

  // ── Direct-to-folder download (no zip) ────────────────────────────────────
  saveBtn.addEventListener('click', async () => {
    if (busy) return;
    const tag = tagIn.value.trim() || 'media';

    // Auto-scan so Save works in one click without a prior Scan.
    mediaItems = findMediaItems();
    renderList(mediaItems);
    dlBtn.disabled = !mediaItems.length;
    if (!mediaItems.length) {
      setStatus('Nothing found — scroll through the post and try again.');
      return;
    }

    const sel = selectedItems();
    if (!sel.length) { setStatus('No items checked.'); return; }

    const items = sel.map(({ item, origIdx }) => ({
      url:      item.url,
      filename: buildFilename(tag, origIdx, mediaItems.length, item.filename),
    }));

    // Open the native folder picker FIRST, while we still have a user
    // gesture.  showDirectoryPicker() natively remembers the last directory
    // the user chose, solving the "always back to ~/Downloads" problem —
    // and files land already unzipped, so there's nothing to extract after.
    let dirHandle;
    try {
      dirHandle = await showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
      if (e.name !== 'AbortError') setStatus(`Error: ${e.message}`, 'err');
      return; // user cancelled — do nothing
    }

    setBusy(true);
    setStatus('Starting…');
    setProgress(0, true);

    // Content scripts with host_permissions can fetch cross-origin URLs
    // directly, bypassing CORS, so each file is fetched and written to the
    // chosen folder one at a time here in the content script.
    try {
      let done = 0;
      for (const item of items) {
        setStatus(`Saving ${done + 1}/${items.length}…`);
        const data = await fetchViaBackground(item.url);
        const name = correctExtension(item.filename, data);
        const fileHandle = await dirHandle.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(data);
        await writable.close();
        done++;
        setProgress(done / items.length * 100, true);
      }
      setStatus(`Done — saved ${items.length} file${items.length !== 1 ? 's' : ''}.`);
    } catch (e) {
      setStatus(`Error: ${e.message}`, 'err');
      setProgress(0, false);
    }
    setTimeout(() => setBusy(false), 800);
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  function selectedItems() {
    return mediaItems
      .map((item, i) => ({ item, origIdx: i + 1 }))
      .filter(({ origIdx }) => {
        const cb = shadow.getElementById(`cb-${origIdx - 1}`);
        return cb && cb.checked;
      });
  }

  function renderList(items) {
    if (!items.length) {
      list.innerHTML = '<div class="empty">No media found.<br>Scroll through the post and scan again.</div>';
      return;
    }
    list.innerHTML = items.map((item, i) => `
      <div class="item">
        <input type="checkbox" id="cb-${i}" checked>
        <span class="badge ${item.type}">${item.type === 'video' ? '▶' : '▣'}</span>
        <span class="name" title="${esc(item.url)}">${esc(item.filename)}</span>
        <span class="st" id="st-${i}"></span>
      </div>
    `).join('');
  }

  function esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function setStatus(msg, cls = '') {
    statusEl.textContent = msg;
    statusEl.className   = cls;
  }

  function setProgress(pct, show) {
    progWrap.style.display = show ? '' : 'none';
    progBar.style.width    = pct + '%';
  }

  function setBusy(b) {
    busy = b;
    dlBtn.disabled   = b;
    saveBtn.disabled = b;
  }

  function mark(el, cls, txt) {
    if (!el) return;
    el.className   = 'st ' + cls;
    el.textContent = txt;
  }

  function sendDownload(url, filename) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'download', url, filename }, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (res?.success) {
          resolve(res.downloadId);
        } else {
          reject(new Error(res?.error || 'Unknown error'));
        }
      });
    });
  }

  // Content scripts with host_permissions can fetch cross-origin URLs directly,
  // bypassing CORS — no need to round-trip through the service worker (which
  // risks being suspended mid-fetch in MV3, causing the Promise to hang).
  async function fetchViaBackground(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

})();

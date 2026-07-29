(async function () {
  // Domain allow-list — SHA-256 hashes of hostname (www. stripped).
  // To add a domain: echo -n 'example.com' | shasum -a 256
  const ALLOWED_HASHES = new Set([
    '91dcc18fc7d646eb1537a364d7f7991e1254c63d9d3ccb75b1c388cd528526b2',
    '12ca17b49af2289436f303e0166030a21e525d266e209267433801a8fd4071a0',
    '49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d9763',
  ]);

  try {
    const host = window.location.hostname.replace(/^www\./, '');
    const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(host));
    const hex  = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    if (!ALLOWED_HASHES.has(hex)) return;
  } catch {
    return;
  }

  const MIN_AREA = 8000;

  let overlay    = null;
  let currentImg = null;
  let hideTimer  = null;
  let cachedTargetDir = null;
  let dupeState  = null; // { src, expires } — armed after first click on a dupe
  const imgState = new WeakMap(); // img -> current button symbol ('…', '✓', '✗')
  const badges   = new Map();     // img -> lingering badge element (shown while not hovered)

  // Returns false if the extension was reloaded and this content script is orphaned.
  function runtimeAlive() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  function sendMsg(msg, cb) {
    if (!runtimeAlive()) return;
    try { chrome.runtime.sendMessage(msg, cb); } catch { /* orphaned */ }
  }

  function refreshTargetDir() {
    sendMsg({ action: 'get_target_dir' }, (response) => {
      if (response?.dir) cachedTargetDir = response.dir;
    });
  }
  refreshTargetDir();

  function truncatePath(path, maxLen = 48) {
    if (!path || path.length <= maxLen) return path;
    const parts = path.replace(/\/$/, '').split('/').filter(Boolean);
    const filename = parts[parts.length - 1];
    const dir      = parts.length > 1 ? parts[parts.length - 2] : null;
    // Always show at least dir/filename even if that alone exceeds maxLen
    let suffix = dir ? dir + '/' + filename : filename;
    // Prepend additional ancestors while they fit
    for (let i = parts.length - 3; i >= 0; i--) {
      const candidate = parts[i] + '/' + suffix;
      if (candidate.length > maxLen - 2) break;
      suffix = candidate;
    }
    return '…/' + suffix;
  }

  function btnTitle() {
    const base = cachedTargetDir
      ? `Download to ${truncatePath(cachedTargetDir)}`
      : 'Download image (no folder set — click extension icon to choose)';
    return `${base} (or press d)`;
  }

  function createOverlay() {
    const div = document.createElement('div');
    div.id = '__img_dl_overlay__';
    div.innerHTML = `<div class="img-dl-btn" title="${btnTitle()}">⬇</div>`;
    document.body.appendChild(div);

    const btn = div.querySelector('.img-dl-btn');

    btn.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    btn.addEventListener('mouseleave', scheduleHide);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const img = currentImg;
      if (!img || !document.body.contains(img)) {
        currentImg = null;
        div.style.display = 'none';
        return;
      }
      performDownload(img);
    });

    return div;
  }

  // Shared by the hover-button click and the 'd' keyboard shortcut. Not tied
  // to hover state — setImgState/syncBadge already route the indicator to
  // whichever of the shared button or a per-image badge applies.
  function performDownload(img) {
    if (!runtimeAlive()) {
      showToast(img, '✗ Extension was reloaded — please refresh this page');
      return;
    }

    const src = img.currentSrc || img.src;
    if (!src || src.startsWith('data:')) {
      showToast(img, '✗ No downloadable URL found');
      return;
    }

    const btn = getOverlay().querySelector('.img-dl-btn');

    // Second attempt within the dupe window → open the file picker
    const allowDupe = !!(dupeState && dupeState.src === src && Date.now() < dupeState.expires);
    if (allowDupe) dupeState = null;

    setImgState(btn, img, '…', false);
    const resetTimer = setTimeout(() => {
      showToast(img, '✗ Timed out — see last error in the extension popup');
      setImgState(btn, img, '✗', true);
    }, 70000);

    sendMsg({ action: 'download_image', src, allowDupe }, (response) => {
      clearTimeout(resetTimer);
      const lastErr = runtimeAlive() ? chrome.runtime.lastError : null;

      if (response?.dupe) {
        // First encounter with a dupe — arm the second-attempt window
        dupeState = { src, expires: Date.now() + 5000 };
        showToast(img, '⚠ Already exists — repeat to choose a location');
        clearImgState(btn, img);
      } else if (lastErr || !response?.success) {
        const err = response?.error || lastErr?.message || 'Download failed';
        showToast(img, `✗ ${err}`);
        setImgState(btn, img, '✗', true);
      } else {
        const savedTo = response.destPath;
        showToast(img, savedTo ? `✓ Saved to ${truncatePath(savedTo)}` : '✓ Saved');
        setImgState(btn, img, '✓', true);
      }
      img.focus({ preventScroll: true });
    });
  }

  // Per-image button state, so a delayed result for one image never paints
  // onto the shared button while the user is hovering a different image.
  function setImgState(btn, img, symbol, autoReset) {
    imgState.set(img, symbol);
    if (currentImg === img) btn.textContent = symbol;
    else syncBadge(img);
    if (autoReset) {
      setTimeout(() => {
        if (imgState.get(img) === symbol) imgState.delete(img);
        if (currentImg === img) btn.textContent = '⬇';
        else syncBadge(img);
      }, 1800);
    }
  }

  function clearImgState(btn, img) {
    imgState.delete(img);
    if (currentImg === img) btn.textContent = '⬇';
    else syncBadge(img);
  }

  // A badge is the same indicator as the hover button, but pinned over an
  // image that isn't currently hovered — so progress/result stay visible
  // even after the mouse moves away.
  function positionBadge(img, div) {
    const rect = img.getBoundingClientRect();
    div.style.left = `${rect.right  + window.scrollX - 44}px`;
    div.style.top  = `${rect.bottom + window.scrollY - 44}px`;
  }

  function removeBadge(img) {
    const div = badges.get(img);
    if (div) { div.remove(); badges.delete(img); }
  }

  function syncBadge(img) {
    const state = imgState.get(img);
    // No active state, or the hover button already shows it — no badge needed.
    if (!state || currentImg === img) {
      removeBadge(img);
      return;
    }
    let div = badges.get(img);
    if (!div) {
      div = document.createElement('div');
      div.className = 'img-dl-btn img-dl-badge';
      document.body.appendChild(div);
      badges.set(img, div);
    }
    div.textContent = state;
    positionBadge(img, div);
  }

  let toast      = null;
  let toastTimer = null;

  function getToast() {
    if (!toast || !document.body.contains(toast)) {
      toast = document.createElement('div');
      toast.id = '__img_dl_toast__';
      document.body.appendChild(toast);
    }
    return toast;
  }

  function showToast(img, message) {
    const t = getToast();
    const rect = img.getBoundingClientRect();
    t.style.left      = `${rect.left + window.scrollX + rect.width  / 2}px`;
    t.style.top       = `${rect.top  + window.scrollY + rect.height / 2}px`;
    t.style.transform = 'translate(-50%, -50%)';
    t.textContent = message;
    t.style.opacity = '1';
    t.style.display = 'flex';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => { t.style.display = 'none'; }, 260);
    }, 3000);
  }

  function getOverlay() {
    if (!overlay || !document.body.contains(overlay)) {
      overlay = createOverlay();
    }
    return overlay;
  }

  function positionOverlay(img) {
    const rect = img.getBoundingClientRect();
    const ov = getOverlay();
    ov.style.left = `${rect.right  + window.scrollX - 44}px`;
    ov.style.top  = `${rect.bottom + window.scrollY - 44}px`;
    const btn = ov.querySelector('.img-dl-btn');
    btn.title = btnTitle();
    btn.textContent = imgState.get(img) || '⬇';
    ov.style.display = 'block';
  }

  function scheduleHide() {
    hideTimer = setTimeout(() => {
      if (overlay) overlay.style.display = 'none';
      const prev = currentImg;
      currentImg = null;
      if (prev) syncBadge(prev);
    }, 220);
  }

  function isLargeEnough(img) {
    const w = img.naturalWidth  || img.getBoundingClientRect().width;
    const h = img.naturalHeight || img.getBoundingClientRect().height;
    return w * h >= MIN_AREA;
  }

  function findBiggestImage() {
    // Compare rendered on-screen size, not natural file resolution — pages
    // like a lightbox often reuse the same full-res file for both a small
    // grid thumbnail and the large foreground view, so natural size ties
    // and can't tell them apart. Rendered size can't.
    let best = null;
    let bestArea = 0;
    for (const img of document.images) {
      const rect = img.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = img;
      }
    }
    return bestArea >= MIN_AREA ? best : null;
  }

  // Single-key shortcut: 'd' downloads the biggest image on the page (e.g.
  // the current image in a lightbox), no hover required.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'd' || e.repeat) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return;
    const t = e.target;
    if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.tagName === 'SELECT' || t?.isContentEditable) return;
    if (!runtimeAlive()) return;
    const img = findBiggestImage();
    if (!img) return;
    e.preventDefault();
    performDownload(img);
  });

  document.addEventListener('mouseover', (e) => {
    let img = e.target.closest('img');
    if (!img) {
      const under = document.elementsFromPoint(e.clientX, e.clientY);
      img = under.find(el => el.tagName === 'IMG') || null;
    }
    if (!img || !isLargeEnough(img)) return;
    clearTimeout(hideTimer);
    const prev = currentImg;
    currentImg = img;
    positionOverlay(img);
    syncBadge(img); // hover button now covers this image's state
    if (prev && prev !== img) syncBadge(prev); // may need a badge now that it's unhovered
  });

  document.addEventListener('mouseout', (e) => {
    if (e.target === currentImg) scheduleHide();
  });

  // Some pages swap out the hovered <img> element via JS (e.g. a lightbox's
  // next/prev button) without the mouse actually moving, so no mouseover
  // fires for the replacement. Detect that the tracked image left the DOM
  // and drop it, so a stale/detached node is never used for a click or
  // badge (getBoundingClientRect() on a detached node is all zeros, which
  // otherwise pins the toast/badge at the top-left corner).
  const domObserver = new MutationObserver(() => {
    if (currentImg && !document.body.contains(currentImg)) {
      clearTimeout(hideTimer);
      if (overlay) overlay.style.display = 'none';
      currentImg = null;
    }
    for (const img of badges.keys()) {
      if (!document.body.contains(img)) removeBadge(img);
    }
  });
  domObserver.observe(document.body, { childList: true, subtree: true });

  window.addEventListener('scroll', () => {
    if (currentImg && overlay?.style.display !== 'none') {
      positionOverlay(currentImg);
    }
    for (const [img, div] of badges) positionBadge(img, div);
  }, { passive: true });
})();

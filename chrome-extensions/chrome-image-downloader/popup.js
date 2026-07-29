document.addEventListener('DOMContentLoaded', () => {
  const dirPath  = document.getElementById('dirPath');
  const changeBtn = document.getElementById('changeBtn');
  const status   = document.getElementById('status');
  const version  = document.getElementById('version');

  version.textContent = `v${chrome.runtime.getManifest().version}`;

  chrome.storage.local.get('lastDownloadStatus', ({ lastDownloadStatus: s }) => {
    if (!s) return;
    const wrap = document.getElementById('lastDlWrap');
    const el   = document.getElementById('lastDl');
    wrap.style.display = 'block';
    if (s.ok) {
      el.textContent = `✓ ${s.ts}  ${s.dest}`;
      el.className = 'last-dl';
    } else {
      el.textContent = `✗ ${s.ts}  ${s.error}\n${s.src}`;
      el.className = 'last-dl err';
    }
  });

  chrome.runtime.sendMessage({ action: 'get_target_dir' }, (response) => {
    if (response?.dir) {
      dirPath.textContent = response.dir;
      dirPath.classList.remove('unset');
    }
  });

  changeBtn.addEventListener('click', () => {
    changeBtn.disabled = true;
    changeBtn.textContent = 'Waiting for folder picker…';
    status.textContent = '';

    chrome.runtime.sendMessage({ action: 'pick_folder' }, (response) => {
      changeBtn.disabled = false;
      changeBtn.textContent = 'Choose Folder…';
      if (response?.success) {
        dirPath.textContent = response.path;
        dirPath.classList.remove('unset');
      } else {
        status.textContent = response?.error || 'No folder selected.';
      }
    });
  });
});

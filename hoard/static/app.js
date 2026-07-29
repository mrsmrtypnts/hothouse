const grid = document.getElementById("grid");
const searchFields = {
  prompt: document.getElementById("search-prompt"),
  negative_prompt: document.getElementById("search-negative"),
  filename: document.getElementById("search-filename"),
};
const aspectCheckboxes = Array.from(document.querySelectorAll("#aspect-row input[type=checkbox]"));
const aspectCustom = document.getElementById("search-aspect-custom");
const countEl = document.getElementById("count-bar");
const loadMoreBtn = document.getElementById("load-more");
const layout = document.getElementById("layout");
const resizer = document.getElementById("resizer");
const detailPane = document.getElementById("detail-pane");
const detailImg = document.getElementById("detail-img");
const detailOpenBtn = document.querySelector("#detail-img-wrap .open-overlay");

const PAGE_SIZE = 200;
const MIN_PANE_WIDTH = 240;
let debounceTimer = null;
let searchGeneration = 0;
let loadedCount = 0;
let totalCount = 0;
let selectedCell = null;
let selectedId = null;
let paneVisible = false;

function getAspectValue() {
  const vals = aspectCheckboxes.filter((cb) => cb.checked).map((cb) => cb.value);
  if (aspectCustom.value.trim()) vals.push(aspectCustom.value.trim());
  return vals.join(", ");
}

function currentCriteria() {
  const c = {};
  for (const [key, input] of Object.entries(searchFields)) {
    if (input.value) c[key] = input.value;
  }
  const aspect = getAspectValue();
  if (aspect) c.aspect = aspect;
  return c;
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  for (const [key, input] of Object.entries(searchFields)) {
    const v = params.get(key);
    if (v) input.value = v;
  }
  const aspectParam = params.get("aspect");
  if (aspectParam) {
    const knownValues = new Set(aspectCheckboxes.map((cb) => cb.value));
    const leftover = [];
    for (const raw of aspectParam.split(",")) {
      const token = raw.trim().toLowerCase();
      if (!token) continue;
      if (knownValues.has(token)) {
        aspectCheckboxes.find((cb) => cb.value === token).checked = true;
      } else {
        leftover.push(token);
      }
    }
    if (leftover.length) aspectCustom.value = leftover.join(", ");
  }
}

function syncUrl() {
  const params = new URLSearchParams(currentCriteria());
  // Keep the access token in the URL (if it was there) so a copied/bookmarked/
  // reopened link still works in a browser context that has no session cookie —
  // not just in this tab, where the cookie carries auth regardless.
  const existingToken = new URLSearchParams(location.search).get("token");
  if (existingToken) params.set("token", existingToken);
  const qs = params.toString();
  const newUrl = qs ? `${location.pathname}?${qs}` : location.pathname;
  history.replaceState(null, "", newUrl);
}

function runSearch() {
  searchGeneration++;
  loadedCount = 0;
  grid.innerHTML = "";
  syncUrl();
  fetchPage();
}

function fetchPage() {
  const myGeneration = searchGeneration;
  const params = new URLSearchParams(currentCriteria());
  params.set("offset", loadedCount);
  params.set("limit", PAGE_SIZE);
  fetch(`/api/search?${params.toString()}`)
    .then((r) => r.json())
    .then((data) => {
      // A newer search may have started (and reset grid/loadedCount) while
      // this request was in flight — a stale response arriving late would
      // otherwise double-append on top of the current results.
      if (myGeneration !== searchGeneration) return;
      totalCount = data.total;
      loadedCount += data.items.length;
      appendGrid(data.items);
      updateCount();
      loadMoreBtn.classList.toggle("hidden", loadedCount >= totalCount);
    });
}

function updateCount() {
  countEl.textContent = totalCount === 0
    ? "No results"
    : `Showing ${loadedCount.toLocaleString()} of ${totalCount.toLocaleString()} results`;
}

function openImage(id) {
  fetch(`/api/open/${id}`, { method: "POST" });
}

function appendGrid(items) {
  for (const item of items) {
    const cell = document.createElement("div");
    cell.className = "thumb";
    cell.dataset.id = item.id;

    const img = document.createElement("img");
    img.src = `/thumb/${item.id}`;
    img.loading = "lazy";
    img.alt = item.positive_prompt || "";
    cell.appendChild(img);

    const openBtn = document.createElement("button");
    openBtn.className = "open-overlay";
    openBtn.title = "Open in default app";
    openBtn.innerHTML = "&#8599;";
    openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openImage(item.id);
    });
    cell.appendChild(openBtn);

    cell.addEventListener("click", () => selectImage(item.id, cell));
    grid.appendChild(cell);
  }
}

function showPane() {
  if (paneVisible) return;
  paneVisible = true;
  detailPane.classList.remove("hidden");
  resizer.classList.remove("hidden");
  detailPane.style.width = `${layout.getBoundingClientRect().width * 0.5}px`;
}

function selectImage(id, cell) {
  if (selectedCell) selectedCell.classList.remove("selected");
  selectedCell = cell;
  selectedId = id;
  cell.classList.add("selected");
  showPane();

  fetch(`/api/image/${id}`)
    .then((r) => r.json())
    .then((detail) => {
      detailImg.src = `/full/${id}`;
      document.getElementById("meta-filename").textContent = detail.filename || "";
      document.getElementById("meta-positive").textContent = detail.positive_prompt || "(none)";
      document.getElementById("meta-negative").textContent = detail.negative_prompt || "(none)";
      const params = [];
      if (detail.model) params.push(`Model: ${detail.model}`);
      if (detail.sampler) params.push(`Sampler: ${detail.sampler}`);
      if (detail.seed) params.push(`Seed: ${detail.seed}`);
      if (detail.steps) params.push(`Steps: ${detail.steps}`);
      if (detail.cfg_scale) params.push(`CFG scale: ${detail.cfg_scale}`);
      if (detail.width && detail.height) params.push(`Size: ${detail.width}x${detail.height}`);
      document.getElementById("meta-params").textContent = params.join("\n") || "(none)";
      document.getElementById("meta-path").textContent = detail.path;
    });
}

function onResizerDrag(e) {
  const layoutRect = layout.getBoundingClientRect();
  const maxWidth = layoutRect.width - MIN_PANE_WIDTH;
  let newWidth = layoutRect.right - e.clientX;
  newWidth = Math.max(MIN_PANE_WIDTH, Math.min(maxWidth, newWidth));
  detailPane.style.width = `${newWidth}px`;
}

function stopResizerDrag() {
  document.removeEventListener("mousemove", onResizerDrag);
  document.removeEventListener("mouseup", stopResizerDrag);
}

resizer.addEventListener("mousedown", (e) => {
  e.preventDefault();
  document.addEventListener("mousemove", onResizerDrag);
  document.addEventListener("mouseup", stopResizerDrag);
});

detailOpenBtn.addEventListener("click", () => {
  if (selectedId != null) openImage(selectedId);
});

function gridColumnCount() {
  const cells = Array.from(grid.children);
  if (cells.length < 2) return 1;
  const firstTop = cells[0].offsetTop;
  let count = 1;
  for (let i = 1; i < cells.length; i++) {
    if (cells[i].offsetTop !== firstTop) break;
    count++;
  }
  return count;
}

const ARROW_STEP = {
  ArrowLeft: () => -1,
  ArrowRight: () => 1,
  ArrowUp: () => -gridColumnCount(),
  ArrowDown: () => gridColumnCount(),
};

document.addEventListener("keydown", (e) => {
  if (!selectedCell) return;
  const stepFn = ARROW_STEP[e.key];
  if (!stepFn) return;
  const activeTag = document.activeElement && document.activeElement.tagName;
  if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;

  const cells = Array.from(grid.children);
  const currentIndex = cells.indexOf(selectedCell);
  if (currentIndex === -1) return;
  const nextIndex = currentIndex + stepFn();
  if (nextIndex < 0 || nextIndex >= cells.length) return;

  e.preventDefault();
  const nextCell = cells[nextIndex];
  selectImage(parseInt(nextCell.dataset.id, 10), nextCell);
  nextCell.scrollIntoView({ block: "nearest" });
});

function debouncedSearch() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runSearch, 250);
}

for (const input of Object.values(searchFields)) {
  input.addEventListener("input", debouncedSearch);
}
for (const cb of aspectCheckboxes) {
  cb.addEventListener("change", runSearch);
}
aspectCustom.addEventListener("input", debouncedSearch);

loadMoreBtn.addEventListener("click", fetchPage);

restoreFromUrl();
runSearch();

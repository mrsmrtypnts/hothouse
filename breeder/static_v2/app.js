const root = document.getElementById("app");

const api = {
  get: (path) => fetch(path).then((r) => r.json()),
  post: (path, body) =>
    fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then((r) => r.json()),
  del: (path) => fetch(path, { method: "DELETE" }).then((r) => r.json()),
};

// duplicated from mutate.py's SAMPLERS -- breeder has no /api/samplers endpoint,
// this is just a suggestion list (the sampler field accepts free text)
const SAMPLERS = ["DPM++ 2M SDE", "Euler a", "Euler", "DPM++ 2M", "DPM++ 2M Karras", "DPM++ SDE Karras", "UniPC"];
const SIZE_OPTIONS = [
  { width: 800, height: 1200 },
  { width: 1200, height: 800 },
];

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.appendChild(c);
  return node;
}

function currentNodeId() {
  return new URLSearchParams(location.search).get("n");
}

function navigate(id) {
  const url = id ? `?n=${id}` : location.pathname;
  history.pushState({}, "", url);
  render();
}
window.addEventListener("popstate", () => render());

let pollTimer = null;
function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

// updated at the top of every render() so the arrow-key handler below can
// navigate through the same order the thumbnail grid is actually showing
let lastAllNodes = [];

function gridColumnCount(cards) {
  if (!cards.length) return 1;
  const firstTop = cards[0].getBoundingClientRect().top;
  let count = 0;
  for (const c of cards) {
    if (Math.abs(c.getBoundingClientRect().top - firstTop) < 2) count++;
    else break;
  }
  return count || 1;
}

document.addEventListener("keydown", (e) => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
  const active = document.activeElement;
  if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;
  if (!lastAllNodes.length) return;

  const idx = lastAllNodes.findIndex((n) => n.id === currentNodeId());
  if (idx === -1) return;

  const cards = Array.from(document.querySelectorAll(".thumb-card"));
  const cols = gridColumnCount(cards);
  let nextIdx = idx;
  if (e.key === "ArrowRight") nextIdx = idx + 1;
  else if (e.key === "ArrowLeft") nextIdx = idx - 1;
  else if (e.key === "ArrowDown") nextIdx = idx + cols;
  else if (e.key === "ArrowUp") nextIdx = idx - cols;
  nextIdx = Math.max(0, Math.min(lastAllNodes.length - 1, nextIdx));

  if (nextIdx !== idx) {
    e.preventDefault();
    navigate(lastAllNodes[nextIdx].id);
  }
});

// 560px fits exactly 4 thumbnails across by default, given .thumb-grid's
// minmax(110px, 1fr) columns, a 10px gap, and 20px panel padding on each side
const DEFAULT_BROWSER_WIDTH = 560;
const MIN_BROWSER_WIDTH = 240;
const MAX_BROWSER_WIDTH = 1000;

function getBrowserWidth() {
  const stored = parseInt(sessionStorage.getItem("breederV2BrowserWidth"), 10);
  return isNaN(stored) ? DEFAULT_BROWSER_WIDTH : stored;
}
function setBrowserWidth(px) {
  sessionStorage.setItem("breederV2BrowserWidth", String(px));
}

// true while a splitter drag is active -- render() must not tear down the DOM
// mid-drag (see buildSplitter): that would detach the panel/splitter the drag
// is holding onto while document-level mousemove/mouseup listeners stay bound
// to now-orphaned elements, producing exactly the "weird things" that follow
let isDraggingSplitter = false;

function buildSplitter(browserPanel) {
  const splitter = el("div", { class: "splitter" });
  splitter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    isDraggingSplitter = true;
    const startX = e.clientX;
    const startWidth = browserPanel.getBoundingClientRect().width;
    splitter.classList.add("dragging");

    function onMove(moveEvent) {
      const next = Math.min(
        MAX_BROWSER_WIDTH,
        Math.max(MIN_BROWSER_WIDTH, startWidth + (moveEvent.clientX - startX))
      );
      browserPanel.style.width = `${next}px`;
    }
    function onUp() {
      isDraggingSplitter = false;
      splitter.classList.remove("dragging");
      setBrowserWidth(browserPanel.getBoundingClientRect().width);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  return splitter;
}

// the currently-edited spec and which focused node it belongs to -- edits are
// ephemeral (only ever sent on the next Breed call), so this is reset from the
// node's stored spec only when focus actually changes, never on a poll re-render
let formSpec = null;
let formFocusId = null;

// whether the prompt/negative-prompt diff-vs-parent overlay has been
// dismissed (by editing) for the current focus -- reset alongside formSpec
// whenever focus actually changes, same lifecycle
let promptDiffDismissed = false;
let negPromptDiffDismissed = false;

function getMode() {
  return sessionStorage.getItem("breederV2Mode") || "txt2img";
}
function setMode(mode) {
  sessionStorage.setItem("breederV2Mode", mode);
}
function getDenoise() {
  return parseFloat(sessionStorage.getItem("denoisingStrength") || "0.75");
}
function setDenoise(v) {
  sessionStorage.setItem("denoisingStrength", String(v));
}

let hoverEl = null;

function hideHoverPreview() {
  if (hoverEl) {
    hoverEl.remove();
    hoverEl = null;
  }
}

function positionHoverPanel(panel, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  let left = rect.right + 12;
  if (left + panelRect.width > window.innerWidth - 8) {
    left = rect.left - panelRect.width - 12;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - panelRect.width - 8));
  let top = rect.top;
  top = Math.max(8, Math.min(top, window.innerHeight - panelRect.height - 8));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function showHoverPreview(node, anchorEl, caption, showImage = true) {
  hideHoverPreview();
  const panel = el("div", { class: "hover-preview" });
  if (showImage && node.status === "done" && node.image_file) {
    const img = el("img", { src: `/images/${node.image_file}`, alt: node.spec.prompt || node.id });
    img.addEventListener("load", () => {
      if (hoverEl === panel) positionHoverPanel(panel, anchorEl);
    });
    panel.appendChild(img);
  } else if (node.status === "error") {
    panel.appendChild(el("div", {
      class: "hover-error",
      text: node.error || "(no error message)",
    }));
  }
  const text = caption ?? node.label;
  if (text) {
    panel.appendChild(el("div", { class: "hover-caption", text }));
  }
  if (!panel.hasChildNodes()) return;
  document.body.appendChild(panel);
  hoverEl = panel;

  positionHoverPanel(panel, anchorEl);
}

// which node ids have ever been focused -- persisted in localStorage (not
// sessionStorage) since "have I looked at this before" should survive across
// tabs/sessions, like read/unread in an email client
function getViewedNodeIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem("breederV2ViewedNodes") || "[]"));
  } catch {
    return new Set();
  }
}
function markNodeViewed(id) {
  const viewed = getViewedNodeIds();
  if (viewed.has(id)) return;
  viewed.add(id);
  localStorage.setItem("breederV2ViewedNodes", JSON.stringify([...viewed]));
}

function thumbCard(node, selected, viewedIds) {
  const card = el("div", { class: `thumb-card${selected ? " selected" : ""}` });

  if (!viewedIds.has(node.id)) {
    card.appendChild(el("div", { class: "unread-dot" }));
  }

  if (node.status !== "pending") {
    const delBtn = el("button", { class: "delete-x", text: "×" });
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("forget this generation?")) return;
      await api.del(`/api/nodes/${node.id}`);
      render();
    });
    card.appendChild(delBtn);
  }

  if (node.status === "done") {
    const img = el("img", { src: `/images/${node.image_file}`, alt: node.spec.prompt || node.id });
    // no enlarged preview on hover here (that's what the focused-node view is
    // for) -- just the mutation caption, if this node has one
    img.addEventListener("mouseenter", () => showHoverPreview(node, img, undefined, false));
    img.addEventListener("mouseleave", hideHoverPreview);
    card.appendChild(img);
  } else if (node.status === "error") {
    card.appendChild(el("div", { class: "thumb-status thumb-error", text: "failed" }));
    const retryBtn = el("button", { class: "retry-x", text: "↻" });
    retryBtn.title = "retry";
    retryBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      retryBtn.disabled = true;
      await api.post(`/api/nodes/${node.id}/retry`, {});
      render();
    });
    card.appendChild(retryBtn);
    card.addEventListener("mouseenter", () => showHoverPreview(node, card));
    card.addEventListener("mouseleave", hideHoverPreview);
  } else {
    card.appendChild(el("div", { class: "thumb-status" }, [el("div", { class: "spinner" })]));
  }
  card.addEventListener("click", () => navigate(node.id));
  return card;
}

function getKeywordFilter() {
  return sessionStorage.getItem("breederV2FilterKeyword") || "";
}
function setKeywordFilter(v) {
  sessionStorage.setItem("breederV2FilterKeyword", v);
}
function getMinDescendantDepth() {
  const stored = parseInt(sessionStorage.getItem("breederV2FilterMinDepth"), 10);
  return isNaN(stored) ? 0 : stored;
}
function setMinDescendantDepth(v) {
  sessionStorage.setItem("breederV2FilterMinDepth", String(v));
}

// depth 0 = no children (never bred further), 1 = has a child but no
// grandchild, 2 = has a grandchild but no great-grandchild, and so on --
// the longest chain of descendants below this node
function computeDescendantDepths(allNodes) {
  const childrenOf = new Map();
  for (const n of allNodes) {
    if (!n.parent_id) continue;
    if (!childrenOf.has(n.parent_id)) childrenOf.set(n.parent_id, []);
    childrenOf.get(n.parent_id).push(n);
  }
  const cache = new Map();
  function depth(id) {
    if (cache.has(id)) return cache.get(id);
    const kids = childrenOf.get(id) || [];
    const d = kids.length === 0 ? 0 : 1 + Math.max(...kids.map((k) => depth(k.id)));
    cache.set(id, d);
    return d;
  }
  const result = new Map();
  for (const n of allNodes) result.set(n.id, depth(n.id));
  return result;
}

function nodeMatchesKeyword(node, keyword) {
  if (!keyword) return true;
  const k = keyword.toLowerCase();
  const prompt = (node.spec.prompt || "").toLowerCase();
  const neg = (node.spec.negative_prompt || "").toLowerCase();
  return prompt.includes(k) || neg.includes(k);
}

function buildBrowserPanel(allNodes, focusId) {
  const panel = el("div", { class: "browser-panel" });
  panel.appendChild(el("h2", { text: "Breeder Studio" }));

  const depths = computeDescendantDepths(allNodes);
  const viewedIds = getViewedNodeIds();
  const grid = el("div", { class: "thumb-grid" });

  function renderGrid() {
    const keyword = keywordInput.value;
    const minDepth = parseInt(depthSelect.value, 10) || 0;
    grid.replaceChildren();
    for (const node of allNodes) {
      if (minDepth > 0 && (depths.get(node.id) || 0) < minDepth) continue;
      if (!nodeMatchesKeyword(node, keyword)) continue;
      grid.appendChild(thumbCard(node, node.id === focusId, viewedIds));
    }
  }

  // filtering only ever touches `grid`'s own children -- never triggers a
  // full render(), which would tear down these very inputs mid-keystroke
  // (see the render() gotcha noted elsewhere in this file)
  const filterBar = el("div", { class: "filter-bar" });
  const keywordInput = el("input", { type: "text", placeholder: "filter by keyword..." });
  keywordInput.value = getKeywordFilter();
  keywordInput.addEventListener("input", () => {
    setKeywordFilter(keywordInput.value);
    renderGrid();
  });

  const depthSelect = el("select");
  depthSelect.appendChild(el("option", { value: "0", text: "any depth" }));
  for (let i = 1; i <= 5; i++) {
    depthSelect.appendChild(el("option", { value: String(i), text: `${i}+ descendants deep` }));
  }
  depthSelect.value = String(getMinDescendantDepth());
  depthSelect.addEventListener("change", () => {
    setMinDescendantDepth(parseInt(depthSelect.value, 10) || 0);
    renderGrid();
  });

  filterBar.appendChild(keywordInput);
  filterBar.appendChild(depthSelect);
  panel.appendChild(filterBar);

  renderGrid();
  panel.appendChild(grid);
  return panel;
}

function breadcrumbs(ancestors) {
  const bar = el("div", { class: "crumbs" });
  for (const a of ancestors) {
    const caption = a.label || "original";
    let crumbEl;
    if (a.status === "done") {
      crumbEl = el("img", { class: "crumb-thumb", src: `/images/${a.image_file}`, alt: caption });
    } else {
      crumbEl = el("span", { class: "crumb-pending", text: a.status === "error" ? "✗" : "…" });
    }
    crumbEl.addEventListener("click", () => navigate(a.id));
    crumbEl.addEventListener("mouseenter", () => showHoverPreview(a, crumbEl, caption));
    crumbEl.addEventListener("mouseleave", hideHoverPreview);
    bar.appendChild(crumbEl);
    bar.appendChild(el("span", { class: "crumb-sep", text: "›" }));
  }
  return bar;
}

function fieldRow(labelText, inputEl) {
  const row = el("label", { class: "field-row" });
  row.appendChild(el("span", { class: "field-label", text: labelText }));
  row.appendChild(inputEl);
  return row;
}

function numField(form, label, key, opts = {}) {
  const input = el("input", { type: "number", ...opts });
  input.value = formSpec[key] ?? "";
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    formSpec[key] = isNaN(v) ? formSpec[key] : v;
  });
  form.appendChild(fieldRow(label, input));
  return input;
}

function buildSeedField(form) {
  const input = el("input", { type: "number", step: "1" });
  input.value = formSpec.seed ?? "";
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    formSpec.seed = isNaN(v) ? formSpec.seed : v;
  });

  const resetBtn = el("button", { type: "button", class: "seed-reset", text: "↺" });
  resetBtn.title = "reset to -1 (randomize each generation)";
  resetBtn.addEventListener("click", () => {
    input.value = "-1";
    formSpec.seed = -1;
  });

  const row = el("div", { class: "seed-row" });
  row.appendChild(input);
  row.appendChild(resetBtn);
  form.appendChild(fieldRow("Seed", row));
}

function buildSizeField(form) {
  const currentKey = `${formSpec.width}x${formSpec.height}`;
  const select = el("select");
  let seen = false;
  for (const opt of SIZE_OPTIONS) {
    const key = `${opt.width}x${opt.height}`;
    if (key === currentKey) seen = true;
    select.appendChild(el("option", { value: key, text: `${opt.width} x ${opt.height}` }));
  }
  if (!seen) {
    // preserve an existing node's size even if it predates these two presets
    select.appendChild(el("option", { value: currentKey, text: `${formSpec.width} x ${formSpec.height}` }));
  }
  select.value = currentKey;
  select.addEventListener("change", () => {
    const [w, h] = select.value.split("x").map(Number);
    formSpec.width = w;
    formSpec.height = h;
  });
  form.appendChild(fieldRow("Size", select));
}

function buildModelField(form, models) {
  const currentName = formSpec.model_name || "";
  const currentHash = formSpec.model_hash || "";
  const currentKey = `${currentName}|${currentHash}`;

  const select = el("select");
  const seen = new Set();
  for (const m of models) {
    const key = `${m.model_name}|${m.model_hash}`;
    seen.add(key);
    const label = m.model_hash ? `${m.model_name} [${m.model_hash}]` : m.model_name;
    select.appendChild(el("option", { value: key, text: label }));
  }
  if (currentName && !seen.has(currentKey)) {
    const label = currentHash ? `${currentName} [${currentHash}]` : currentName;
    select.appendChild(el("option", { value: currentKey, text: label }));
  }
  select.appendChild(el("option", { value: "__custom__", text: "custom..." }));
  select.value = currentName ? currentKey : "__custom__";

  const customInput = el("input", { type: "text", placeholder: "model name" });
  customInput.value = currentName;
  customInput.style.display = select.value === "__custom__" ? "" : "none";

  select.addEventListener("change", () => {
    if (select.value === "__custom__") {
      customInput.style.display = "";
      customInput.focus();
      formSpec.model_name = customInput.value;
      formSpec.model_hash = "";
    } else {
      customInput.style.display = "none";
      const [name, modelHash] = select.value.split("|");
      formSpec.model_name = name;
      formSpec.model_hash = modelHash;
    }
  });
  customInput.addEventListener("input", () => {
    formSpec.model_name = customInput.value;
    formSpec.model_hash = "";
  });

  const wrap = el("div", { class: "field-row" });
  wrap.appendChild(el("span", { class: "field-label", text: "Model" }));
  wrap.appendChild(select);
  wrap.appendChild(customInput);
  form.appendChild(wrap);
}

function buildForm(spec, knownModels, parentSpec) {
  formSpec = { ...spec };
  const form = el("div", { class: "detail-form" });

  const promptInput = el("textarea", { class: "field-prompt field-prompt-main" });
  promptInput.value = formSpec.prompt || "";
  promptInput.addEventListener("input", () => { formSpec.prompt = promptInput.value; });
  form.appendChild(fieldRow("Prompt", wrapFieldWithDiff(
    promptInput, parentSpec && parentSpec.prompt, formSpec.prompt,
    () => promptDiffDismissed, () => { promptDiffDismissed = true; }
  )));

  const negInput = el("textarea", { class: "field-prompt" });
  negInput.value = formSpec.negative_prompt || "";
  negInput.addEventListener("input", () => { formSpec.negative_prompt = negInput.value; });
  form.appendChild(fieldRow("Negative prompt", wrapFieldWithDiff(
    negInput, parentSpec && parentSpec.negative_prompt, formSpec.negative_prompt,
    () => negPromptDiffDismissed, () => { negPromptDiffDismissed = true; }
  )));

  buildModelField(form, knownModels);

  const samplerInput = el("input", { type: "text", list: "sampler-options" });
  samplerInput.value = formSpec.sampler_name || "";
  samplerInput.addEventListener("input", () => { formSpec.sampler_name = samplerInput.value; });
  const datalist = el("datalist", { id: "sampler-options" });
  for (const s of SAMPLERS) datalist.appendChild(el("option", { value: s }));
  form.appendChild(datalist);
  form.appendChild(fieldRow("Sampler", samplerInput));

  buildSizeField(form);
  buildSeedField(form);

  const numRow = el("div", { class: "field-grid" });
  form.appendChild(numRow);
  numField(numRow, "Steps", "steps", { min: "1", max: "150" });
  numField(numRow, "CFG scale", "cfg_scale", { min: "1", max: "30", step: "0.5" });
  numField(numRow, "Clip skip", "clip_skip", { min: "1", max: "12" });

  return form;
}

function getRerollPct() {
  const stored = parseInt(sessionStorage.getItem("breederV2Reroll"), 10);
  return isNaN(stored) ? 50 : stored;
}
function setRerollPct(pct) {
  sessionStorage.setItem("breederV2Reroll", String(pct));
}
function getMutationStrength() {
  const stored = parseFloat(sessionStorage.getItem("breederV2MutationStrength"));
  return isNaN(stored) ? 3 : stored;
}
function setMutationStrength(v) {
  sessionStorage.setItem("breederV2MutationStrength", String(v));
}

function buildRerollField() {
  const wrap = el("div", { class: "field-row" });
  wrap.appendChild(el("span", { class: "field-label", text: "Reroll probability" }));
  const row = el("div", { class: "reroll-row" });
  const initial = getRerollPct();
  const slider = el("input", { type: "range", min: "0", max: "100", step: "10" });
  slider.value = String(initial);
  const readout = el("span", { class: "reroll-readout", text: `${initial}%` });
  slider.addEventListener("input", () => {
    readout.textContent = `${slider.value}%`;
    setRerollPct(parseInt(slider.value, 10));
  });
  row.appendChild(slider);
  row.appendChild(readout);
  wrap.appendChild(row);
  return { wrap, slider };
}

function buildMutationStrengthField() {
  const input = el("input", { type: "number", min: "0", step: "0.5" });
  input.value = String(getMutationStrength());
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    if (!isNaN(v)) setMutationStrength(v);
  });
  return { wrap: fieldRow("Mutation strength", input), input };
}

function buildDenoiseField() {
  const wrap = el("div", { class: "field-row" });
  wrap.appendChild(el("span", { class: "field-label", text: "Denoising strength" }));
  const row = el("div", { class: "reroll-row" });
  const initial = getDenoise();
  const slider = el("input", { type: "range", min: "0", max: "1", step: "0.05" });
  slider.value = String(initial);
  const readout = el("span", { class: "reroll-readout", text: initial.toFixed(2) });
  slider.addEventListener("input", () => {
    const v = parseFloat(slider.value);
    readout.textContent = v.toFixed(2);
    setDenoise(v);
  });
  row.appendChild(slider);
  row.appendChild(readout);
  wrap.appendChild(row);
  return { wrap, slider };
}

function buildBreedControls(node) {
  const box = el("div", { class: "breed-controls" });

  const countInput = el("input", { type: "number", min: "1", max: "30" });
  countInput.value = "4";

  const reroll = buildRerollField();
  const strength = buildMutationStrengthField();

  let mode = getMode();
  const modeToggle = el("div", { class: "mode-toggle" });
  const txt2imgBtn = el("button", { type: "button", text: "txt2img" });
  const img2imgBtn = el("button", { type: "button", text: "img2img" });
  const denoise = buildDenoiseField();

  function updateModeUI() {
    txt2imgBtn.classList.toggle("active", mode === "txt2img");
    img2imgBtn.classList.toggle("active", mode === "img2img");
    denoise.wrap.style.display = mode === "img2img" ? "" : "none";
  }
  txt2imgBtn.addEventListener("click", () => { mode = "txt2img"; setMode(mode); updateModeUI(); });
  img2imgBtn.addEventListener("click", () => { mode = "img2img"; setMode(mode); updateModeUI(); });
  updateModeUI();
  modeToggle.appendChild(txt2imgBtn);
  modeToggle.appendChild(img2imgBtn);

  const breedBtn = el("button", { class: "btn-breed", text: "Breed" });
  breedBtn.addEventListener("click", async () => {
    if (mode === "img2img" && node.status !== "done") {
      alert("img2img requires this node to have a completed render first");
      return;
    }
    breedBtn.disabled = true;
    breedBtn.textContent = "Breeding...";
    const body = {
      count: parseInt(countInput.value, 10) || 1,
      mode,
      reroll_probability: parseFloat(reroll.slider.value) / 100,
      mutator_intensity: parseFloat(strength.input.value) || 0,
      spec: formSpec,
    };
    if (mode === "img2img") {
      body.denoising_strength = parseFloat(denoise.slider.value) || 0.75;
    }
    await api.post(`/api/nodes/${node.id}/variations`, body);
    breedBtn.disabled = false;
    breedBtn.textContent = "Breed";
    render();
  });

  box.appendChild(fieldRow("Count", countInput));
  box.appendChild(reroll.wrap);
  box.appendChild(strength.wrap);
  box.appendChild(modeToggle);
  box.appendChild(denoise.wrap);
  box.appendChild(breedBtn);
  return box;
}

function buildFreshBreedControls() {
  const box = el("div", { class: "breed-controls" });

  const countInput = el("input", { type: "number", min: "1", max: "30" });
  countInput.value = "4";

  const reroll = buildRerollField();
  const strength = buildMutationStrengthField();

  const breedBtn = el("button", { class: "btn-breed", text: "Breed" });
  breedBtn.addEventListener("click", async () => {
    breedBtn.disabled = true;
    breedBtn.textContent = "Breeding...";
    const body = {
      count: parseInt(countInput.value, 10) || 1,
      reroll_probability: parseFloat(reroll.slider.value) / 100,
      mutator_intensity: parseFloat(strength.input.value) || 0,
      spec: formSpec,
    };
    const nodes = await api.post("/api/root/breed", body);
    navigate(nodes[0].id);
  });

  box.appendChild(fieldRow("Count", countInput));
  box.appendChild(reroll.wrap);
  box.appendChild(strength.wrap);
  box.appendChild(breedBtn);
  return box;
}

function newRootLink() {
  const link = el("button", { class: "new-root-link", text: "+ New" });
  link.addEventListener("click", () => navigate("new"));
  return link;
}

async function uploadRootImage(file) {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch("/api/root/from-image", { method: "POST", body: formData });
  if (!res.ok) {
    throw new Error((await res.text()) || `upload failed (${res.status})`);
  }
  return res.json();
}

function importRootLink() {
  const wrap = el("span", {});
  const input = el("input", { type: "file", accept: "image/png" });
  input.style.display = "none";
  const link = el("button", { class: "new-root-link", text: "Import..." });
  link.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    link.disabled = true;
    link.textContent = "Importing...";
    try {
      const node = await uploadRootImage(file);
      navigate(node.id);
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    } finally {
      link.disabled = false;
      link.textContent = "Import...";
    }
  });
  wrap.appendChild(link);
  wrap.appendChild(input);
  return wrap;
}

// mirrors promptsyntax.py's KEYWORD_WEIGHT_RE/LORA_RE and mutate.py's weight
// bounds/step, so cmd-option-up/down nudges by the same amount the server's
// own mutators would
const KEYWORD_WEIGHT_RE = /^\(([^():]+):([0-9.]+)\)$/;
const LORA_RE = /^<lora:([^:>]+):([0-9.]+)>$/;
const KEYWORD_WEIGHT_BOUNDS = [0.3, 2.0];
const LORA_WEIGHT_BOUNDS = [0.0, 1.5];
const WEIGHT_STEP = 0.1;

function clampWeight(value, [lo, hi]) {
  return Math.round(Math.min(hi, Math.max(lo, value)) * 100) / 100;
}

// Parses a single (already-trimmed) comma-segment as a LoRA tag / weighted
// keyword / plain keyword -- mirrors promptsyntax.py's parse_segment.
function parseSegment(seg) {
  let m = LORA_RE.exec(seg);
  if (m) return { name: m[1].trim(), weight: parseFloat(m[2]), kind: "lora", bounds: LORA_WEIGHT_BOUNDS };
  m = KEYWORD_WEIGHT_RE.exec(seg);
  if (m) return { name: m[1].trim(), weight: parseFloat(m[2]), kind: "weighted", bounds: KEYWORD_WEIGHT_BOUNDS };
  return { name: seg, weight: 1.0, kind: "plain", bounds: KEYWORD_WEIGHT_BOUNDS };
}

function buildSegmentText(seg) {
  if (seg.kind === "lora") return `<lora:${seg.name}:${seg.weight}>`;
  if (seg.kind === "weighted") return `(${seg.name}:${seg.weight})`;
  return seg.name;
}

// Finds the comma-delimited segment the cursor is in, parses it as a LoRA
// tag / weighted keyword / plain keyword, nudges the weight by `delta`
// (introducing explicit (name:weight) syntax if it wasn't there yet), and
// splices the result back in -- e.g. "foo" -> "(foo:1.1)".
function nudgeWeightAtCursor(textarea, delta) {
  const text = textarea.value;
  const pos = textarea.selectionStart;

  const start = text.lastIndexOf(",", pos - 1) + 1;
  let end = text.indexOf(",", pos);
  if (end === -1) end = text.length;

  const raw = text.slice(start, end);
  const seg = raw.trim();
  if (!seg) return false;
  const segStart = start + (raw.length - raw.trimStart().length);
  const segEnd = end - (raw.length - raw.trimEnd().length);

  const parsed = parseSegment(seg);
  const replacement = buildSegmentText({ ...parsed, weight: clampWeight(parsed.weight + delta, parsed.bounds) });
  textarea.value = text.slice(0, segStart) + replacement + text.slice(segEnd);
  textarea.setSelectionRange(segStart, segStart + replacement.length);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

function splitSegments(text) {
  return (text || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// like splitSegments, but also returns the actual separator text between
// each pair of segments (comma plus whatever whitespace/newlines followed
// it) so the diff overlay can reproduce real line breaks instead of
// flattening everything to ", "
function splitSegmentsPreservingSeparators(text) {
  const parts = (text || "").split(/(,\s*)/);
  const segs = [];
  const seps = [];
  let pendingSep = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      pendingSep = parts[i];
      continue;
    }
    const trimmed = parts[i].trim();
    if (!trimmed) continue;
    if (segs.length > 0) seps.push(pendingSep || ", ");
    segs.push(trimmed);
    pendingSep = "";
  }
  return { segs, seps };
}

// classic LCS-based diff over segment names, so removed/added segments show
// up in a sensible relative order rather than just "removed stuff at the end"
function diffSegmentOps(parentNames, currentNames) {
  const n = parentNames.length, m = currentNames.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = parentNames[i] === currentNames[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (parentNames[i] === currentNames[j]) {
      ops.push({ type: "same", pIdx: i, cIdx: j });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "remove", pIdx: i });
      i++;
    } else {
      ops.push({ type: "add", cIdx: j });
      j++;
    }
  }
  while (i < n) { ops.push({ type: "remove", pIdx: i }); i++; }
  while (j < m) { ops.push({ type: "add", cIdx: j }); j++; }
  return ops;
}

// Builds {text, cls, sepBefore} spans diffing currentText against parentText:
// unchanged segments in the default color, added segments green, removed
// segments a faded/struck-through "ghost" (they're not actually in
// currentText), and same-name segments whose weight changed colored by
// direction. sepBefore reproduces currentText's real separators (including
// any newlines) for real segments; ghosts have no real anchor, so they just
// get a plain ", ".
function buildPromptDiffSpans(parentText, currentText) {
  const parentSegs = splitSegments(parentText).map(parseSegment);
  const { segs: currentNames, seps: currentSeps } = splitSegmentsPreservingSeparators(currentText);
  const currentSegs = currentNames.map(parseSegment);
  const ops = diffSegmentOps(parentSegs.map((s) => s.name), currentSegs.map((s) => s.name));

  return ops.map((op, i) => {
    const sepBefore = i === 0 ? "" : (op.type !== "remove" && op.cIdx > 0 ? currentSeps[op.cIdx - 1] : ", ");
    if (op.type === "remove") {
      return { text: buildSegmentText(parentSegs[op.pIdx]), cls: "diff-removed", sepBefore };
    }
    if (op.type === "add") {
      return { text: buildSegmentText(currentSegs[op.cIdx]), cls: "diff-added", sepBefore };
    }
    const p = parentSegs[op.pIdx], c = currentSegs[op.cIdx];
    let cls = "diff-unchanged";
    if (p.weight !== c.weight) cls = p.weight < c.weight ? "diff-increased" : "diff-decreased";
    return { text: buildSegmentText(c), cls, sepBefore };
  });
}

function buildDiffOverlay(spans) {
  const overlay = el("div", { class: "field-diff-overlay" });
  spans.forEach((s) => {
    if (s.sepBefore) overlay.appendChild(document.createTextNode(s.sepBefore));
    overlay.appendChild(el("span", { class: s.cls, text: s.text }));
  });
  return overlay;
}

// Wraps a prompt/negative-prompt textarea with a diff overlay (shown until
// the field is actually edited or clicked, per the field's own
// dismissed-flag). The overlay is itself directly clickable -- it dismisses
// and focuses the real textarea on mousedown -- rather than trying to be
// invisible-to-clicks via pointer-events, which makes the whole prompt box
// unusable if that ever fails to hold up in some browser/environment.
function wrapFieldWithDiff(inputEl, parentText, currentText, isDismissed, dismiss) {
  const wrap = el("div", { class: "field-prompt-wrap" });
  wrap.appendChild(inputEl);
  if (parentText != null && !isDismissed()) {
    const overlay = buildDiffOverlay(buildPromptDiffSpans(parentText || "", currentText || ""));
    const dismissOverlay = () => {
      dismiss();
      overlay.remove();
      inputEl.focus();
    };
    overlay.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dismissOverlay();
    });
    wrap.appendChild(overlay);
    inputEl.addEventListener("input", dismissOverlay, { once: true });
  }
  return wrap;
}

function wireFieldPromptShortcuts(panel) {
  panel.addEventListener("keydown", (e) => {
    // cmd/ctrl+enter breeds from anywhere in the panel, not just the prompt
    // fields -- e.g. focus in the seed field or model dropdown still works
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      const btn = panel.querySelector(".btn-breed");
      if (btn && !btn.disabled) btn.click();
      return;
    }
    if (!e.target.classList.contains("field-prompt")) return;
    if ((e.metaKey || e.ctrlKey) && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const delta = e.key === "ArrowUp" ? WEIGHT_STEP : -WEIGHT_STEP;
      if (nudgeWeightAtCursor(e.target, delta)) {
        e.preventDefault();
      }
    }
  });
}

async function buildDetailPanel(focusId, knownModels) {
  const panel = el("div", { class: "detail-panel" });

  if (focusId === "new") {
    const rebuildForm = formFocusId !== "new";
    if (rebuildForm) formFocusId = "new";
    const seedSpec = rebuildForm ? await api.get("/api/defaults") : formSpec;

    const main = el("div", { class: "detail-main" });
    main.appendChild(el("div", { class: "placeholder", text: "not generated yet" }));
    main.appendChild(buildForm(seedSpec, knownModels));
    panel.appendChild(main);
    panel.appendChild(buildFreshBreedControls());
    wireFieldPromptShortcuts(panel);
    return panel;
  }

  const [node, ancestors] = await Promise.all([
    api.get(`/api/nodes/${focusId}`),
    api.get(`/api/nodes/${focusId}/ancestors`),
  ]);

  const crumbBar = breadcrumbs(ancestors.slice(0, -1));
  const crumbActions = el("div", { class: "crumb-actions" });
  crumbActions.appendChild(newRootLink());
  crumbActions.appendChild(importRootLink());
  crumbBar.appendChild(crumbActions);
  panel.appendChild(crumbBar);

  if (node.label) {
    panel.appendChild(el("div", { class: "mutation-label", text: node.label }));
  }

  const main = el("div", { class: "detail-main" });
  const imageBox = el("div", { class: "detail-image" });
  if (node.status === "done") {
    imageBox.appendChild(el("img", { src: `/images/${node.image_file}`, alt: "focused" }));
  } else if (node.status === "error") {
    const errBox = el("div", { class: "placeholder error-placeholder" });
    errBox.appendChild(el("div", { class: "error-text", text: node.error || "(no error message)" }));
    const retryBtn = el("button", { class: "retry-btn", text: "Retry" });
    retryBtn.addEventListener("click", async () => {
      retryBtn.disabled = true;
      retryBtn.textContent = "Retrying...";
      await api.post(`/api/nodes/${node.id}/retry`, {});
      render();
    });
    errBox.appendChild(retryBtn);
    imageBox.appendChild(errBox);
  } else {
    imageBox.appendChild(el("div", { class: "placeholder" }, [el("div", { class: "spinner" })]));
  }
  main.appendChild(imageBox);

  const rebuildForm = focusId !== formFocusId;
  if (rebuildForm) {
    formFocusId = focusId;
    promptDiffDismissed = false;
    negPromptDiffDismissed = false;
  }
  const parentNode = ancestors.length >= 2 ? ancestors[ancestors.length - 2] : null;
  main.appendChild(buildForm(rebuildForm ? node.spec : formSpec, knownModels, parentNode && parentNode.spec));
  panel.appendChild(main);

  panel.appendChild(buildBreedControls(node));
  wireFieldPromptShortcuts(panel);

  return panel;
}

// true while focus is anywhere a poll-triggered rebuild would yank it out
// from under the user -- the detail form fields, but also the browser
// panel's filter inputs (same failure mode, see the render() gotcha below)
function isEditingUI() {
  const active = document.activeElement;
  return !!(active && active.closest && (active.closest(".detail-panel") || active.closest(".browser-panel")));
}

async function render(isPoll = false) {
  if (isDraggingSplitter) {
    // never rebuild mid-drag, regardless of why render() was called -- retry
    // shortly rather than on the full poll cadence, since drags are brief
    setTimeout(() => render(isPoll), 100);
    return;
  }
  if (isPoll && isEditingUI()) {
    // a poll tick fired while the user has an active edit in the form --
    // rebuilding the DOM now would yank focus out from under them (this is
    // what made the prompt box "keep losing focus" while anything was
    // pending). Just check back again shortly instead of rendering now.
    pollTimer = setTimeout(() => render(true), 1500);
    return;
  }

  stopPolling();
  const [allNodes, knownModels] = await Promise.all([
    api.get("/api/nodes"),
    api.get("/api/models"),
  ]);
  lastAllNodes = allNodes;
  let focusId = currentNodeId();
  if (focusId !== "new" && (!focusId || !allNodes.some((n) => n.id === focusId))) {
    focusId = allNodes.length ? allNodes[0].id : "new";
  }
  if (focusId !== "new") {
    // pending means there's nothing to look at yet -- don't mark "read"
    // until the generation actually finishes (or fails)
    const focusedNode = allNodes.find((n) => n.id === focusId);
    if (focusedNode && focusedNode.status !== "pending") markNodeViewed(focusId);
  }

  const wrap = el("div", { class: "studio" });
  const browserPanel = buildBrowserPanel(allNodes, focusId);
  browserPanel.style.width = `${getBrowserWidth()}px`;
  wrap.appendChild(browserPanel);
  wrap.appendChild(buildSplitter(browserPanel));
  wrap.appendChild(await buildDetailPanel(focusId, knownModels));
  root.replaceChildren(wrap);

  // keep the selected thumbnail in view, e.g. when arrow-key navigation moves
  // focus off the bottom/top of the currently-scrolled grid -- "nearest" is a
  // no-op if it's already visible, so this doesn't fight normal scrolling
  const selectedCard = browserPanel.querySelector(".thumb-card.selected");
  if (selectedCard) selectedCard.scrollIntoView({ block: "nearest" });

  if (allNodes.some((n) => n.status === "pending")) {
    pollTimer = setTimeout(() => render(true), 1500);
  }
}

render();

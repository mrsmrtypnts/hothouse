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

// duplicated from mutate.py's SAMPLERS -- breeder has no /api/samplers
// endpoint, so this is the known-good list buildSamplerField offers as
// <select> options (plus a "custom..." escape hatch for anything else)
const SAMPLERS = ["DPM++ 2M SDE", "Euler a", "Euler", "DPM++ 2M", "DPM++ 2M Karras", "DPM++ SDE Karras", "UniPC"];
const SIZE_OPTIONS = [
  { width: 800, height: 1200 },
  { width: 1200, height: 800 },
  { width: 512, height: 768 },
  { width: 768, height: 512 },
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

// same shape as favicon.svg (kept identical -- both mounted UIs share the
// same mark), inlined here rather than <img src="favicon.svg"> so the fill
// can track the --accent custom property and stay in sync automatically if
// the accent color is ever changed again
const LOGO_SVG_MARKUP = `<svg viewBox="0 0 32 32" class="studio-logo" aria-hidden="true">
  <g fill="var(--accent)" transform="rotate(45 16 16)">
    <path d="M0,0 C-7,9 -7,9 -7,13.5 C-7,17.7 -3.9,20 0,20 C3.9,20 7,17.7 7,13.5 C7,9 7,9 0,0 Z" transform="translate(16,16) rotate(0) scale(0.55)"/>
    <path d="M0,0 C-7,9 -7,9 -7,13.5 C-7,17.7 -3.9,20 0,20 C3.9,20 7,17.7 7,13.5 C7,9 7,9 0,0 Z" transform="translate(16,16) rotate(90) scale(0.55)"/>
    <path d="M0,0 C-7,9 -7,9 -7,13.5 C-7,17.7 -3.9,20 0,20 C3.9,20 7,17.7 7,13.5 C7,9 7,9 0,0 Z" transform="translate(16,16) rotate(180) scale(0.55)"/>
    <path d="M0,0 C-7,9 -7,9 -7,13.5 C-7,17.7 -3.9,20 0,20 C3.9,20 7,17.7 7,13.5 C7,9 7,9 0,0 Z" transform="translate(16,16) rotate(270) scale(0.55)"/>
  </g>
</svg>`;

function currentNodeId() {
  return new URLSearchParams(location.search).get("n");
}

function navigate(id) {
  const url = id ? `?n=${id}` : location.pathname;
  history.pushState({}, "", url);
  expandedCrumbsFor = null;
  render();
}
window.addEventListener("popstate", () => render());

let pollTimer = null;
function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

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

// set right before navigate() from arrow-key nav specifically, and consumed
// by the next render() -- so only a keyboard-driven jump scrolls the grid,
// not every render (a poll tick firing every 1.5s while something's
// generating must never fight the user's own scrolling)
let scrollSelectedIntoView = false;

// which node's detail panel was rendered last -- lets render() tell a poll
// tick re-rendering the *same* node (preserve scroll, e.g. so a poll firing
// while you're scrolling down toward the Breed button can't snap you back to
// the top mid-scroll) apart from actually navigating to a *different* node
// (reset scroll to the top, since it's all new content)
let lastDetailFocusId = null;

// Reads ids straight from the currently-rendered .thumb-card elements
// (which already reflect any active keyword/depth filter), rather than the
// full unfiltered node list -- otherwise arrow-key navigation would jump to
// nodes that aren't even visible in a filtered view.
document.addEventListener("keydown", (e) => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
  const active = document.activeElement;
  if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return;

  const cards = Array.from(document.querySelectorAll(".thumb-card"));
  if (!cards.length) return;
  const ids = cards.map((c) => new URLSearchParams(c.getAttribute("href").slice(1)).get("n"));
  const idx = ids.indexOf(currentNodeId());
  if (idx === -1) return;

  const cols = gridColumnCount(cards);
  let nextIdx = idx;
  if (e.key === "ArrowRight") nextIdx = idx + 1;
  else if (e.key === "ArrowLeft") nextIdx = idx - 1;
  else if (e.key === "ArrowDown") nextIdx = idx + cols;
  else if (e.key === "ArrowUp") nextIdx = idx - cols;
  nextIdx = Math.max(0, Math.min(ids.length - 1, nextIdx));

  if (nextIdx !== idx) {
    e.preventDefault();
    scrollSelectedIntoView = true;
    navigate(ids[nextIdx]);
  }
});

// document-wide, not scoped to the detail panel, so it works regardless of
// what currently has focus (a form field, the browser panel's filter inputs,
// or nothing at all) -- there's only ever one .btn-breed on screen at a time
document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter") return;
  const btn = document.querySelector(".btn-breed");
  if (btn && !btn.disabled) {
    e.preventDefault();
    btn.click();
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

// refreshed every render() alongside allNodes/knownModels -- read by the
// corpus panel and by the lora-mutations warning in the breed controls
let corpusSummary = null;

// set right when the user clicks "rescan now", cleared once a render()
// actually observes corpusSummary.scanning -- covers the gap between firing
// the scan request and the backend flag flipping true, which otherwise the
// poll-scheduling check below would miss entirely (it only fires again when
// *already* scheduled) and the progress bar would never appear for a
// manually-triggered scan, only for one that happened to already be running
// when the page loaded
let expectScanSoon = false;
// safety valve: if a scan is tiny enough (or the request fails) to finish
// before any poll ever catches scanning=true, expectScanSoon would otherwise
// never get cleared and we'd poll forever -- give up waiting after this long
let expectScanSoonSince = 0;
const EXPECT_SCAN_TIMEOUT_MS = 10000;

// whether the prompt/negative-prompt diff-vs-parent overlay has been
// dismissed (by editing) for the current focus -- reset alongside formSpec
// whenever focus actually changes, same lifecycle
let promptDiffDismissed = false;
let negPromptDiffDismissed = false;

// in-progress edits (diff-dismissed state) and every breed-controls setting
// (mode, denoising strength, reroll probability, the three mutation-
// intensity sliders, count) for any focus *other than the current one*,
// keyed by focus id ("new" is a valid key too) -- so switching to a
// different thumbnail and back doesn't forget what you were typing or had
// dialed in. These used to be sessionStorage values shared across the whole
// tab, which meant e.g. breeding img2img from node A and then visiting node
// B would leave B (and everywhere else) stuck in img2img too, or cranking
// Lora mutations up for one experimental node would silently carry that
// setting into every other node you looked at afterward -- these are all
// properties of "what was I about to do to this specific node", not a
// tab-wide setting. Cleared on a full page reload by design; this is meant
// to survive navigating around within the same tab, not persist indefinitely.
const savedFormSpecs = new Map();
const savedPromptDismissed = new Map();
const savedNegPromptDismissed = new Map();
const savedMode = new Map();
const savedDenoise = new Map();
const savedRerollPct = new Map();
const savedKeywordIntensity = new Map();
const savedLoraIntensity = new Map();
const savedOtherIntensity = new Map();
const savedCount = new Map();

// current focus's breed-controls settings -- mirror formSpec's lifecycle
// (see switchFormFocus), read/written directly by the breed-controls
// builders instead of a per-tab getter/setter
let currentMode = "txt2img";
let currentDenoise = 0.75;
let currentRerollPct = 50;
let currentKeywordIntensity = 2.5;
let currentLoraIntensity = 2.5;
let currentOtherIntensity = 0.5;
let currentCount = 4;

// Call whenever the effective focus is about to change to `newFocusId`.
// Stashes the outgoing focus's in-progress state (if any) and restores
// whatever was previously saved for the incoming one. Returns true if focus
// actually changed (i.e. the form needs rebuilding from some seed spec).
//
// `defaultMode`/`defaultDenoise` are this node's own render_mode/
// denoising_strength -- the very first time a node is focused (nothing in
// savedMode/savedDenoise yet), its breed controls should start from how it
// was itself generated, not a hardcoded txt2img/0.75: a node born via
// img2img should start life expecting to breed the same way, and a node
// bred at denoising_strength 0.4 should offer 0.4 as the starting point,
// not always reset to 0.75. Reroll/intensities/count have no equivalent
// "how was I generated" signal to inherit, so their first-visit default is
// just the same static default as before. Once you've actually touched a
// control for a given node in this tab, that sticks (the saved* Maps above)
// and wins over these defaults on every future visit.
function switchFormFocus(newFocusId, defaultMode = "txt2img", defaultDenoise = 0.75) {
  const changed = formFocusId !== newFocusId;
  if (changed) {
    if (formFocusId != null) {
      savedFormSpecs.set(formFocusId, formSpec);
      savedPromptDismissed.set(formFocusId, promptDiffDismissed);
      savedNegPromptDismissed.set(formFocusId, negPromptDiffDismissed);
      savedMode.set(formFocusId, currentMode);
      savedDenoise.set(formFocusId, currentDenoise);
      savedRerollPct.set(formFocusId, currentRerollPct);
      savedKeywordIntensity.set(formFocusId, currentKeywordIntensity);
      savedLoraIntensity.set(formFocusId, currentLoraIntensity);
      savedOtherIntensity.set(formFocusId, currentOtherIntensity);
      savedCount.set(formFocusId, currentCount);
    }
    formFocusId = newFocusId;
    promptDiffDismissed = savedPromptDismissed.get(newFocusId) || false;
    negPromptDiffDismissed = savedNegPromptDismissed.get(newFocusId) || false;
    currentMode = savedMode.has(newFocusId) ? savedMode.get(newFocusId) : defaultMode;
    currentDenoise = savedDenoise.has(newFocusId) ? savedDenoise.get(newFocusId) : defaultDenoise;
    currentRerollPct = savedRerollPct.has(newFocusId) ? savedRerollPct.get(newFocusId) : 50;
    currentKeywordIntensity = savedKeywordIntensity.has(newFocusId) ? savedKeywordIntensity.get(newFocusId) : 2.5;
    currentLoraIntensity = savedLoraIntensity.has(newFocusId) ? savedLoraIntensity.get(newFocusId) : 2.5;
    currentOtherIntensity = savedOtherIntensity.has(newFocusId) ? savedOtherIntensity.get(newFocusId) : 0.5;
    currentCount = savedCount.has(newFocusId) ? savedCount.get(newFocusId) : 4;
  }
  return changed;
}

// Call right after creating one or more new nodes (breeding, whether from
// an existing node or the "+ New" screen) with the CURRENT (parent's, or
// the fresh-screen's) breed-controls values still in currentRerollPct etc.
// Pre-seeds each new child's saved* entry so switchFormFocus finds it on
// first visit instead of falling back to the static default -- children
// start life with the same dials their parent had, same idea as
// wireImageOnlyDrop pre-seeding savedMode for an imported img2img root.
function inheritBreedControlsForChildren(newNodes) {
  for (const n of newNodes) {
    savedRerollPct.set(n.id, currentRerollPct);
    savedKeywordIntensity.set(n.id, currentKeywordIntensity);
    savedLoraIntensity.set(n.id, currentLoraIntensity);
    savedOtherIntensity.set(n.id, currentOtherIntensity);
    savedCount.set(n.id, currentCount);
  }
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

// grid-thumbnail hover: error message only. The mutation-caption hover this
// used to also show for both done and error thumbnails was removed -- rarely
// used, and cluttered every hover in the grid. (The equivalent, much more
// useful version lives on breadcrumb thumbnails now -- see
// showMutationHoverPreview -- where you're actually comparing to the parent.)
function showErrorHoverPreview(node, anchorEl) {
  hideHoverPreview();
  if (node.status !== "error") return;
  const panel = el("div", { class: "hover-preview" });
  panel.appendChild(el("div", { class: "hover-error", text: node.error || "(no error message)" }));
  document.body.appendChild(panel);
  hoverEl = panel;
  positionHoverPanel(panel, anchorEl);
}

// Splits one prompt/negative-prompt field's diff-vs-parent into changed-only
// lines (no "unchanged" -- this view is deliberately concise), bucketed by
// kind since keywords and loras are two separate categories in the hover
// panel even though they share one text field. `prefix` distinguishes
// negative-prompt lines (there's no separate "negative keywords" category,
// just a "neg: " tag on the line, keeping the category list exactly the
// eight the panel groups by).
function _promptDiffLines(spec, parentSpec, field, prefix) {
  const parentSegs = splitSegments(parentSpec[field] || "").map(parseSegment);
  const { segs: currentNames } = splitSegmentsPreservingSeparators(spec[field] || "");
  const currentSegs = currentNames.map(parseSegment);
  const ops = diffSegmentOps(parentSegs.map((s) => s.name), currentSegs.map((s) => s.name));

  const keywordLines = [], loraLines = [];
  for (const op of ops) {
    let seg, cls, sign;
    if (op.type === "remove") {
      seg = parentSegs[op.pIdx]; cls = "diff-removed"; sign = "−";
    } else if (op.type === "add") {
      seg = currentSegs[op.cIdx]; cls = "diff-added"; sign = "+";
    } else {
      const p = parentSegs[op.pIdx], c = currentSegs[op.cIdx];
      if (p.weight === c.weight) continue;
      seg = c; cls = p.weight < c.weight ? "diff-increased" : "diff-decreased"; sign = "";
    }
    const line = { text: `${prefix}${sign}${buildSegmentText(seg)}`, cls };
    (seg.kind === "lora" ? loraLines : keywordLines).push(line);
  }
  return { keywordLines, loraLines };
}

function _scalarDiffLine(label, parentVal, currentVal, mode, formatValue) {
  const cls = fieldDiffClass(parentVal, currentVal, mode);
  if (!cls) return null;
  return { text: `${label}: ${formatValue ? formatValue(currentVal) : currentVal}`, cls };
}

// Concise, categorized, color-coded diff of `spec` vs `parentSpec` -- same
// underlying diff logic and colors as the spec form's field highlighting
// (buildPromptDiffSpans / fieldDiffClass), just compact: only fields that
// actually changed, grouped into categories in the same order they appear
// in the form (Prompt/Negative prompt -> keywords/loras, then Model,
// Sampler, Size, Seed, Steps, CFG scale). Returns an array of non-empty
// category line-arrays, or [] if nothing changed (e.g. no parentSpec).
function buildMutationDiffCategories(spec, parentSpec) {
  if (!parentSpec) return [];
  const pos = _promptDiffLines(spec, parentSpec, "prompt", "");
  const neg = _promptDiffLines(spec, parentSpec, "negative_prompt", "neg: ");
  const modelLine = _scalarDiffLine(
    "Model",
    `${parentSpec.model_name || ""}|${parentSpec.model_hash || ""}`,
    `${spec.model_name || ""}|${spec.model_hash || ""}`,
    "categorical",
    () => (spec.model_hash ? `${spec.model_name} [${spec.model_hash}]` : spec.model_name)
  );
  const samplerLine = _scalarDiffLine("Sampler", parentSpec.sampler_name, spec.sampler_name, "categorical");
  const sizeLine = _scalarDiffLine(
    "Size", `${parentSpec.width}x${parentSpec.height}`, `${spec.width}x${spec.height}`,
    "categorical", () => `${spec.width} x ${spec.height}`
  );
  const seedLine = _scalarDiffLine("Seed", parentSpec.seed, spec.seed, "categorical");
  const stepsLine = _scalarDiffLine("Steps", parentSpec.steps, spec.steps, "numeric");
  const cfgLine = _scalarDiffLine("CFG", parentSpec.cfg_scale, spec.cfg_scale, "numeric");

  return [
    [...pos.keywordLines, ...neg.keywordLines],
    [...pos.loraLines, ...neg.loraLines],
    [modelLine].filter(Boolean),
    [samplerLine].filter(Boolean),
    [sizeLine].filter(Boolean),
    [seedLine].filter(Boolean),
    [stepsLine].filter(Boolean),
    [cfgLine].filter(Boolean),
  ].filter((cat) => cat.length > 0);
}

// Breadcrumb-thumbnail hover: image (if any) on the left, the concise
// category-grouped diff-vs-parent on the right -- deliberately a different
// layout from showErrorHoverPreview's, see the block comment there.
function showMutationHoverPreview(node, parentSpec, anchorEl) {
  hideHoverPreview();
  const panel = el("div", { class: "hover-preview hover-mutation-panel" });
  if (node.status === "done" && node.image_file) {
    const img = el("img", { src: `/images/${node.image_file}`, alt: node.spec.prompt || node.id });
    img.addEventListener("load", () => {
      if (hoverEl === panel) positionHoverPanel(panel, anchorEl);
    });
    panel.appendChild(img);
  } else if (node.status === "error") {
    panel.appendChild(el("div", { class: "hover-error", text: node.error || "(no error message)" }));
  }
  const categories = buildMutationDiffCategories(node.spec, parentSpec);
  if (categories.length) {
    const textBlock = el("div", { class: "hover-mutations" });
    for (const cat of categories) {
      const catEl = el("div", { class: "mutation-category" });
      for (const line of cat) catEl.appendChild(el("div", { class: line.cls, text: line.text }));
      textBlock.appendChild(catEl);
    }
    panel.appendChild(textBlock);
  }
  if (!panel.hasChildNodes()) return;
  document.body.appendChild(panel);
  hoverEl = panel;
  positionHoverPanel(panel, anchorEl);
}

// "have I looked at this before" lives server-side on the node itself
// (node.viewed, see store.py) rather than in localStorage -- localStorage is
// scoped per browser origin, which includes the port, and breeder's port can
// drift across restarts (see run.sh's port-picker), silently resetting every
// thumbnail back to unread each time. Retrying a node resets viewed back to
// false server-side too (store.mark_pending) -- looking at the old (failed)
// result shouldn't count as having seen the new one, so there's no separate
// "mark unviewed" call needed here.
function markNodeViewed(id) {
  api.post(`/api/nodes/${id}/viewed`, {});
}

// Wires an element as a real navigable link to node `id` -- gives right-click
// "open link in new tab", cmd/ctrl/middle-click "open in new tab", etc. for
// free, while a plain left-click still does an in-page SPA navigation.
// `el` must be an <a> with its href already set to match.
function wireNavClick(el, id) {
  el.addEventListener("click", (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(id);
  });
}

function thumbCard(node, selected) {
  const card = el("a", { class: `thumb-card${selected ? " selected" : ""}`, href: `?n=${node.id}` });

  if (!node.viewed) {
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
    card.addEventListener("mouseenter", () => showErrorHoverPreview(node, card));
    card.addEventListener("mouseleave", hideHoverPreview);
  } else {
    card.appendChild(el("div", { class: "thumb-status" }, [el("div", { class: "spinner" })]));
  }
  wireNavClick(card, node.id);
  return card;
}

function getKeywordFilter() {
  return sessionStorage.getItem("breederV2FilterKeyword") || "";
}
function setKeywordFilter(v) {
  sessionStorage.setItem("breederV2FilterKeyword", v);
}
function getMinDescendantCount() {
  const stored = parseInt(sessionStorage.getItem("breederV2FilterMinDescendants"), 10);
  return isNaN(stored) ? 0 : stored;
}
function setMinDescendantCount(v) {
  sessionStorage.setItem("breederV2FilterMinDescendants", String(v));
}
function getCorpusPanelOpen() {
  return sessionStorage.getItem("breederV2CorpusPanelOpen") === "1";
}
function setCorpusPanelOpen(v) {
  sessionStorage.setItem("breederV2CorpusPanelOpen", v ? "1" : "0");
}

// total size of the subtree below this node -- children, grandchildren, and
// so on, all counted (not just the longest chain, unlike the old depth
// filter this replaces: two shallow-but-wide branches can easily have more
// total descendants than one long thin one)
function computeDescendantCounts(allNodes) {
  const childrenOf = new Map();
  for (const n of allNodes) {
    if (!n.parent_id) continue;
    if (!childrenOf.has(n.parent_id)) childrenOf.set(n.parent_id, []);
    childrenOf.get(n.parent_id).push(n);
  }
  const cache = new Map();
  function count(id) {
    if (cache.has(id)) return cache.get(id);
    const kids = childrenOf.get(id) || [];
    const c = kids.reduce((sum, k) => sum + 1 + count(k.id), 0);
    cache.set(id, c);
    return c;
  }
  const result = new Map();
  for (const n of allNodes) result.set(n.id, count(n.id));
  return result;
}

function buildCorpusPanel() {
  const wrap = el("div", { class: "corpus-panel" });
  wrap.style.display = getCorpusPanelOpen() ? "" : "none";
  const s = corpusSummary;

  const status = el("div", { class: "corpus-status" });
  if (!s || !s.scanned_at) {
    status.textContent = "never scanned -- \"add\" lora/keyword mutations won't do anything until this runs";
  } else {
    const when = new Date(s.scanned_at).toLocaleString();
    status.textContent = `${s.file_count} images, scanned ${when}`;
  }
  wrap.appendChild(status);

  if (s && s.paths && s.paths.length) {
    wrap.appendChild(el("div", { class: "corpus-paths", text: s.paths.join(", ") }));
  }

  if (s && s.scanning) {
    // a scan (startup or periodic) is running in the background -- the
    // "still scanning" case in render()'s own single poll-scheduling check
    // below keeps checking back until it finishes, same mechanism as the
    // pending-node case, rather than this panel scheduling its own
    // independent timer (see the render() gotcha note there for why that
    // was a real bug: an untracked, self-multiplying setTimeout chain that
    // could pile up into a page-freezing request storm).
    const progress = s.scan_progress;
    if (progress && progress.total > 0) {
      const pct = Math.round((progress.done / progress.total) * 100);
      wrap.appendChild(el("div", {
        class: "corpus-scanning",
        text: `scanning... ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()} (${pct}%)`,
      }));
      const track = el("div", { class: "corpus-progress-track" });
      const fill = el("div", { class: "corpus-progress-fill" });
      fill.style.width = `${pct}%`;
      track.appendChild(fill);
      wrap.appendChild(track);
    } else {
      // scan just started -- still walking directories to build the file
      // list (see corpus.scan), so there's no total to show a bar against yet
      wrap.appendChild(el("div", { class: "corpus-scanning", text: "scanning... finding files" }));
    }
  }

  const rescanBtn = el("button", { type: "button", class: "corpus-rescan-btn", text: "rescan now" });
  rescanBtn.disabled = !!(s && s.scanning);
  rescanBtn.addEventListener("click", () => {
    rescanBtn.disabled = true;
    rescanBtn.textContent = "scanning...";
    expectScanSoon = true;
    expectScanSoonSince = Date.now();
    // fire-and-forget: the endpoint doesn't resolve until the scan is fully
    // done, so awaiting it here would block this render() from firing again
    // until completion -- exactly the "no live progress" bug this is fixing.
    // The poll loop (see render()'s scheduling check) picks up progress from
    // here instead.
    api.post("/api/corpus/scan", {});
    render();
  });
  wrap.appendChild(rescanBtn);
  return wrap;
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
  const headerRow = el("div", { class: "browser-header" });
  const titleGroup = el("div", { class: "browser-title" });
  titleGroup.innerHTML = LOGO_SVG_MARKUP;
  titleGroup.appendChild(el("h2", { text: "Breeder Studio" }));
  headerRow.appendChild(titleGroup);
  const corpusToggle = el("button", { type: "button", class: "corpus-toggle-btn", text: "corpus" });
  headerRow.appendChild(corpusToggle);
  panel.appendChild(headerRow);

  const corpusPanel = buildCorpusPanel();
  corpusToggle.addEventListener("click", () => {
    const open = corpusPanel.style.display === "none";
    corpusPanel.style.display = open ? "" : "none";
    setCorpusPanelOpen(open);
  });
  panel.appendChild(corpusPanel);

  const descendantCounts = computeDescendantCounts(allNodes);
  const grid = el("div", { class: "thumb-grid" });

  function renderGrid() {
    const keyword = keywordInput.value;
    const minDescendants = parseInt(minDescendantsSelect.value, 10) || 0;
    grid.replaceChildren();
    for (const node of allNodes) {
      if (minDescendants > 0 && (descendantCounts.get(node.id) || 0) < minDescendants) continue;
      if (!nodeMatchesKeyword(node, keyword)) continue;
      grid.appendChild(thumbCard(node, node.id === focusId));
    }
  }

  // filtering only ever touches `grid`'s own children -- never triggers a
  // full render(), which would tear down these very inputs mid-keystroke
  // (see the render() gotcha noted elsewhere in this file)
  const filterBar = el("div", { class: "filter-bar" });
  const keywordWrap = el("div", { class: "keyword-filter-wrap" });
  const keywordInput = el("input", { type: "text", placeholder: "filter by keyword..." });
  keywordInput.value = getKeywordFilter();
  const keywordClear = el("button", { type: "button", class: "keyword-filter-clear", text: "×" });
  keywordClear.title = "clear filter";
  function updateKeywordClearVisibility() {
    keywordClear.style.display = keywordInput.value ? "" : "none";
  }
  keywordInput.addEventListener("input", () => {
    setKeywordFilter(keywordInput.value);
    updateKeywordClearVisibility();
    renderGrid();
  });
  keywordClear.addEventListener("click", () => {
    keywordInput.value = "";
    setKeywordFilter("");
    updateKeywordClearVisibility();
    renderGrid();
    keywordInput.focus();
  });
  updateKeywordClearVisibility();
  keywordWrap.appendChild(keywordInput);
  keywordWrap.appendChild(keywordClear);

  // preset buckets, not a free-typed number: a plain number input had no
  // affordance to jump back to 0 and no way to jump straight to a large
  // threshold (just the native spinner's +/-1, useless once you're past a
  // handful) -- "N+" buckets fix both, and 0+ doubles as the reset state,
  // so there's no separate reset control needed
  const DESCENDANT_THRESHOLDS = [0, 1, 2, 5, 10, 20, 50, 100];
  const descendantsWrap = el("div", { class: "descendants-filter-wrap" });
  descendantsWrap.appendChild(el("span", { class: "filter-label", text: "Descendants" }));
  const minDescendantsSelect = el("select");
  for (const n of DESCENDANT_THRESHOLDS) {
    minDescendantsSelect.appendChild(el("option", { value: String(n), text: `${n}+` }));
  }
  // a stored value from before this was a fixed set of buckets (or any
  // other stray value) -- fall back to the largest bucket at or below it
  const stored = getMinDescendantCount();
  const initial = [...DESCENDANT_THRESHOLDS].reverse().find((n) => n <= stored) ?? 0;
  minDescendantsSelect.value = String(initial);
  minDescendantsSelect.title = "only show items with at least this many total descendants (children, grandchildren, etc.)";
  minDescendantsSelect.addEventListener("change", () => {
    setMinDescendantCount(parseInt(minDescendantsSelect.value, 10) || 0);
    renderGrid();
  });
  descendantsWrap.appendChild(minDescendantsSelect);

  filterBar.appendChild(keywordWrap);
  filterBar.appendChild(descendantsWrap);
  panel.appendChild(filterBar);

  renderGrid();
  panel.appendChild(grid);
  return panel;
}

// Elides the middle of a long ancestor trail (keeping a few at each end) so
// a deep lineage doesn't push the "+ New"/"Import..." buttons off-screen.
const CRUMB_MIN_HEAD = 2;
const CRUMB_MIN_TAIL = 2;
// which node's breadcrumb trail the user clicked "…" to fully expand -- reset
// on every navigate() so each node starts collapsed; survives poll-triggered
// render() rebuilds in the meantime since it's plain module state, not DOM.
let expandedCrumbsFor = null;

function sliceWithEllipsis(ancestors, head, tail) {
  if (head + tail >= ancestors.length) return ancestors;
  return [...ancestors.slice(0, head), null, ...ancestors.slice(ancestors.length - tail)];
}

function renderCrumbItems(itemsWrap, items, nodeId, byId) {
  itemsWrap.textContent = "";
  for (const a of items) {
    if (a === null) {
      const ellipsis = el("span", { class: "crumb-ellipsis", text: "…" });
      ellipsis.title = "show full trail";
      ellipsis.addEventListener("click", () => {
        expandedCrumbsFor = nodeId;
        render();
      });
      itemsWrap.appendChild(ellipsis);
      itemsWrap.appendChild(el("span", { class: "crumb-sep", text: "›" }));
      continue;
    }
    const caption = a.label || "original";
    let crumbEl;
    if (a.status === "done") {
      crumbEl = el("img", { class: "crumb-thumb", src: `/images/${a.image_file}`, alt: caption });
    } else {
      crumbEl = el("span", { class: "crumb-pending", text: a.status === "error" ? "✗" : "…" });
    }
    // the true parent, not just the previous item in `items` -- an elided
    // trail (see sliceWithEllipsis) can have gaps, so array-adjacency isn't
    // the same as the actual parent_id relationship
    const parent = a.parent_id ? byId.get(a.parent_id) : null;
    crumbEl.addEventListener("mouseenter", () => showMutationHoverPreview(a, parent && parent.spec, crumbEl));
    crumbEl.addEventListener("mouseleave", hideHoverPreview);
    const link = el("a", { href: `?n=${a.id}`, class: "crumb-link" });
    link.appendChild(crumbEl);
    wireNavClick(link, a.id);
    itemsWrap.appendChild(link);
    itemsWrap.appendChild(el("span", { class: "crumb-sep", text: "›" }));
  }
}

// Grows head/tail from the minimum until adding one more would overflow the
// available width, instead of always eliding down to a fixed count -- a wide
// window should show as much of the trail as actually fits. Measures against
// `bar` (which also contains the "+ New"/"Import..." actions) but only ever
// rebuilds `itemsWrap`'s contents, so those actions are never destroyed.
function fitCrumbBar(bar, itemsWrap, ancestors, nodeId, byId) {
  const container = bar.parentElement;
  if (!container) return;
  const maxWidth = container.clientWidth;
  let head = CRUMB_MIN_HEAD;
  let tail = CRUMB_MIN_TAIL;
  while (head + tail < ancestors.length && bar.scrollWidth <= maxWidth) {
    const prevHead = head, prevTail = tail;
    head++;
    if (head + tail < ancestors.length) tail++;
    renderCrumbItems(itemsWrap, sliceWithEllipsis(ancestors, head, tail), nodeId, byId);
    if (bar.scrollWidth > maxWidth) {
      head = prevHead;
      tail = prevTail;
      renderCrumbItems(itemsWrap, sliceWithEllipsis(ancestors, head, tail), nodeId, byId);
      break;
    }
  }
}

function breadcrumbs(ancestors, nodeId) {
  const bar = el("div", { class: "crumbs" });
  const itemsWrap = el("div", { class: "crumb-items" });
  bar.appendChild(itemsWrap);
  const byId = new Map(ancestors.map((a) => [a.id, a]));
  if (expandedCrumbsFor === nodeId) {
    bar.classList.add("expanded");
    renderCrumbItems(itemsWrap, ancestors, nodeId, byId);
    return bar;
  }
  if (ancestors.length <= CRUMB_MIN_HEAD + CRUMB_MIN_TAIL + 1) {
    renderCrumbItems(itemsWrap, ancestors, nodeId, byId);
    return bar;
  }
  // starts minimally abbreviated; grown to fit once actually laid out (can't
  // measure width before the bar is attached to the document)
  renderCrumbItems(itemsWrap, sliceWithEllipsis(ancestors, CRUMB_MIN_HEAD, CRUMB_MIN_TAIL), nodeId, byId);
  requestAnimationFrame(() => fitCrumbBar(bar, itemsWrap, ancestors, nodeId, byId));
  return bar;
}

function fieldRow(labelText, inputEl) {
  const row = el("label", { class: "field-row" });
  row.appendChild(el("span", { class: "field-label", text: labelText }));
  row.appendChild(inputEl);
  return row;
}

function numField(form, label, key, opts = {}, parentSpec) {
  const input = el("input", { type: "number", ...opts });
  input.value = formSpec[key] ?? "";
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    formSpec[key] = isNaN(v) ? formSpec[key] : v;
  });
  form.appendChild(fieldRow(label, input));
  wireFieldDiff([input], parentSpec && parentSpec[key], formSpec[key], "numeric");
  return input;
}

function buildSeedField(form, parentSpec) {
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
  // seed has no "increase/decrease" that means anything -- just flag that
  // it was rerolled from the parent's
  wireFieldDiff([input], parentSpec && parentSpec.seed, formSpec.seed, "categorical");
}

function buildSizeField(form, parentSpec) {
  const currentKey = `${formSpec.width}x${formSpec.height}`;
  const select = el("select");
  let seen = false;
  for (const opt of SIZE_OPTIONS) {
    const key = `${opt.width}x${opt.height}`;
    if (key === currentKey) seen = true;
    select.appendChild(el("option", { value: key, text: `${opt.width} x ${opt.height}` }));
  }
  if (!seen) {
    // preserve an existing node's size even if it isn't one of these presets
    select.appendChild(el("option", { value: currentKey, text: `${formSpec.width} x ${formSpec.height}` }));
  }
  select.value = currentKey;
  select.addEventListener("change", () => {
    const [w, h] = select.value.split("x").map(Number);
    formSpec.width = w;
    formSpec.height = h;
  });
  form.appendChild(fieldRow("Size", select));
  const parentKey = parentSpec ? `${parentSpec.width}x${parentSpec.height}` : null;
  wireFieldDiff([select], parentKey, currentKey, "categorical");
}

function buildModelField(form, models, parentSpec) {
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

  const parentKey = parentSpec ? `${parentSpec.model_name || ""}|${parentSpec.model_hash || ""}` : null;
  wireFieldDiff([select, customInput], parentKey, currentKey, "categorical");
}

// Mirrors buildModelField's select+"custom..." pattern exactly, rather than
// the old free-text-with-datalist input -- the two fields looked like
// different kinds of control for no good reason, and a real <select> means
// the browser's native dropdown always shows the full suggestion list
// (datalist suggestions are filtered against whatever's already typed,
// which was hiding options -- see the sampler-datalist fix this replaces).
// Sampler names aren't a hard-constrained enum from the API's point of view,
// so "custom..." still exists as the escape hatch for anything not listed.
function buildSamplerField(form, parentSpec) {
  const currentName = formSpec.sampler_name || "";

  const select = el("select");
  const seen = new Set();
  for (const s of SAMPLERS) {
    seen.add(s);
    select.appendChild(el("option", { value: s, text: s }));
  }
  if (currentName && !seen.has(currentName)) {
    select.appendChild(el("option", { value: currentName, text: currentName }));
  }
  select.appendChild(el("option", { value: "__custom__", text: "custom..." }));
  select.value = currentName || "__custom__";

  const customInput = el("input", { type: "text", placeholder: "sampler name" });
  customInput.value = currentName;
  customInput.style.display = select.value === "__custom__" ? "" : "none";

  select.addEventListener("change", () => {
    if (select.value === "__custom__") {
      customInput.style.display = "";
      customInput.focus();
      formSpec.sampler_name = customInput.value;
    } else {
      customInput.style.display = "none";
      formSpec.sampler_name = select.value;
    }
  });
  customInput.addEventListener("input", () => { formSpec.sampler_name = customInput.value; });

  const wrap = el("div", { class: "field-row" });
  wrap.appendChild(el("span", { class: "field-label", text: "Sampler" }));
  wrap.appendChild(select);
  wrap.appendChild(customInput);
  form.appendChild(wrap);

  wireFieldDiff([select, customInput], parentSpec && parentSpec.sampler_name, currentName, "categorical");
}

function buildForm(spec, knownModels, parentSpec) {
  formSpec = { ...spec };
  const form = el("div", { class: "detail-form" });

  const promptInput = el("textarea", { class: "field-prompt field-prompt-main" });
  promptInput.value = formSpec.prompt || "";
  promptInput.addEventListener("input", () => { formSpec.prompt = promptInput.value; });
  // prompt is normalized (pony tags first, loras last, one per line) once
  // you're done editing -- not live on every keystroke, so it doesn't fight
  // you mid-edit. The server normalizes again on save regardless, so this is
  // just a live preview of what will actually get stored.
  promptInput.addEventListener("blur", () => {
    const normalized = normalizePromptText(promptInput.value);
    if (normalized !== promptInput.value) {
      promptInput.value = normalized;
      formSpec.prompt = normalized;
    }
  });
  form.appendChild(fieldRow("Prompt", wrapFieldWithDiff(
    promptInput, parentSpec && parentSpec.prompt, formSpec.prompt,
    () => promptDiffDismissed, () => { promptDiffDismissed = true; }
  )));

  const negInput = el("textarea", { class: "field-prompt field-prompt-neg" });
  negInput.value = formSpec.negative_prompt || "";
  negInput.addEventListener("input", () => { formSpec.negative_prompt = negInput.value; });
  form.appendChild(fieldRow("Negative prompt", wrapFieldWithDiff(
    negInput, parentSpec && parentSpec.negative_prompt, formSpec.negative_prompt,
    () => negPromptDiffDismissed, () => { negPromptDiffDismissed = true; }
  )));

  buildModelField(form, knownModels, parentSpec);
  buildSamplerField(form, parentSpec);
  buildSizeField(form, parentSpec);
  buildSeedField(form, parentSpec);

  const numRow = el("div", { class: "field-grid" });
  form.appendChild(numRow);
  numField(numRow, "Steps", "steps", { min: "1", max: "150" }, parentSpec);
  numField(numRow, "CFG scale", "cfg_scale", { min: "1", max: "30", step: "0.5" }, parentSpec);
  numField(numRow, "Clip skip", "clip_skip", { min: "1", max: "12" }, parentSpec);

  return form;
}

function getRerollPct() {
  return currentRerollPct;
}
function setRerollPct(pct) {
  currentRerollPct = pct;
}
// Three independent "expected mutation count" sliders, mirroring
// mutate.py's KEYWORD_MUTATORS/LORA_MUTATORS/OTHER_MUTATORS families --
// replaces the old single combined "Mutation strength" field.
function getKeywordIntensity() {
  return currentKeywordIntensity;
}
function setKeywordIntensity(v) {
  currentKeywordIntensity = v;
}
function getLoraIntensity() {
  return currentLoraIntensity;
}
function setLoraIntensity(v) {
  currentLoraIntensity = v;
}
function getOtherIntensity() {
  return currentOtherIntensity;
}
function setOtherIntensity(v) {
  currentOtherIntensity = v;
}
function getCount() {
  return currentCount;
}
function setCount(v) {
  currentCount = v;
}

function buildRerollField() {
  const wrap = el("div", { class: "slider-row" });
  wrap.appendChild(el("span", { class: "field-label", text: "Reroll probability" }));
  const initial = getRerollPct();
  const slider = el("input", { type: "range", min: "0", max: "100", step: "10" });
  slider.value = String(initial);
  const readout = el("span", { class: "reroll-readout", text: `${initial}%` });
  slider.addEventListener("input", () => {
    readout.textContent = `${slider.value}%`;
    setRerollPct(parseInt(slider.value, 10));
  });
  wrap.appendChild(slider);
  wrap.appendChild(readout);
  return { wrap, slider };
}

function buildLoraCorpusWarning() {
  if (!corpusSummary || corpusSummary.file_count > 0) return null;
  return el("div", {
    class: "corpus-warning",
    text: "No learned corpus scanned yet -- lora \"add\" mutations will silently no-op, so this slider will mostly remove loras rather than balancing adds and removes. Scan a corpus (\"corpus\" button above) to fix this.",
  });
}

function buildIntensityField(label, getValue, setValue) {
  const wrap = el("div", { class: "slider-row" });
  wrap.appendChild(el("span", { class: "field-label", text: label }));
  const initial = getValue();
  const slider = el("input", { type: "range", min: "0", max: "5", step: "0.5" });
  slider.value = String(initial);
  const readout = el("span", { class: "reroll-readout", text: initial.toFixed(2) });
  slider.addEventListener("input", () => {
    const v = parseFloat(slider.value);
    readout.textContent = v.toFixed(2);
    setValue(v);
  });
  wrap.appendChild(slider);
  wrap.appendChild(readout);
  return { wrap, slider };
}

function buildDenoiseField() {
  const wrap = el("div", { class: "field-row" });
  wrap.appendChild(el("span", { class: "field-label", text: "Denoising strength" }));
  const row = el("div", { class: "reroll-row" });
  const initial = currentDenoise;
  const slider = el("input", { type: "range", min: "0", max: "1", step: "0.05" });
  slider.value = String(initial);
  const readout = el("span", { class: "reroll-readout", text: initial.toFixed(2) });
  slider.addEventListener("input", () => {
    const v = parseFloat(slider.value);
    readout.textContent = v.toFixed(2);
    currentDenoise = v;
  });
  row.appendChild(slider);
  row.appendChild(readout);
  wrap.appendChild(row);
  return { wrap, slider };
}

function buildBreedControls(node) {
  const box = el("div", { class: "breed-controls" });

  const countInput = el("input", { type: "number", min: "1", max: "30" });
  countInput.value = String(getCount());
  countInput.addEventListener("input", () => {
    const v = parseInt(countInput.value, 10);
    if (!isNaN(v)) setCount(v);
  });

  const reroll = buildRerollField();
  const keywordIntensity = buildIntensityField("Keyword mutations", getKeywordIntensity, setKeywordIntensity);
  const loraIntensity = buildIntensityField("Lora mutations", getLoraIntensity, setLoraIntensity);
  const otherIntensity = buildIntensityField("Other mutations", getOtherIntensity, setOtherIntensity);
  const sliderStack = el("div", { class: "mutation-sliders" });
  sliderStack.appendChild(reroll.wrap);
  sliderStack.appendChild(keywordIntensity.wrap);
  sliderStack.appendChild(loraIntensity.wrap);
  const loraWarning = buildLoraCorpusWarning();
  if (loraWarning) sliderStack.appendChild(loraWarning);
  sliderStack.appendChild(otherIntensity.wrap);

  let mode = currentMode;
  const modeToggle = el("div", { class: "mode-toggle" });
  const txt2imgBtn = el("button", { type: "button", text: "txt2img" });
  const img2imgBtn = el("button", { type: "button", text: "img2img" });
  const denoise = buildDenoiseField();

  function updateModeUI() {
    txt2imgBtn.classList.toggle("active", mode === "txt2img");
    img2imgBtn.classList.toggle("active", mode === "img2img");
    denoise.wrap.style.display = mode === "img2img" ? "" : "none";
  }
  txt2imgBtn.addEventListener("click", () => { mode = "txt2img"; currentMode = mode; updateModeUI(); });
  img2imgBtn.addEventListener("click", () => { mode = "img2img"; currentMode = mode; updateModeUI(); });
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
      keyword_intensity: parseFloat(keywordIntensity.slider.value) || 0,
      lora_intensity: parseFloat(loraIntensity.slider.value) || 0,
      other_intensity: parseFloat(otherIntensity.slider.value) || 0,
      spec: formSpec,
    };
    if (mode === "img2img") {
      body.denoising_strength = parseFloat(denoise.slider.value) || 0.75;
    }
    const newNodes = await api.post(`/api/nodes/${node.id}/variations`, body);
    inheritBreedControlsForChildren(newNodes);
    breedBtn.disabled = false;
    breedBtn.textContent = "Breed";
    render();
  });

  box.appendChild(fieldRow("Count", countInput));
  box.appendChild(sliderStack);
  box.appendChild(modeToggle);
  box.appendChild(denoise.wrap);
  box.appendChild(breedBtn);
  return box;
}

function buildFreshBreedControls() {
  const box = el("div", { class: "breed-controls" });

  const countInput = el("input", { type: "number", min: "1", max: "30" });
  countInput.value = String(getCount());
  countInput.addEventListener("input", () => {
    const v = parseInt(countInput.value, 10);
    if (!isNaN(v)) setCount(v);
  });

  const reroll = buildRerollField();
  const keywordIntensity = buildIntensityField("Keyword mutations", getKeywordIntensity, setKeywordIntensity);
  const loraIntensity = buildIntensityField("Lora mutations", getLoraIntensity, setLoraIntensity);
  const otherIntensity = buildIntensityField("Other mutations", getOtherIntensity, setOtherIntensity);
  const sliderStack = el("div", { class: "mutation-sliders" });
  sliderStack.appendChild(reroll.wrap);
  sliderStack.appendChild(keywordIntensity.wrap);
  sliderStack.appendChild(loraIntensity.wrap);
  const loraWarning = buildLoraCorpusWarning();
  if (loraWarning) sliderStack.appendChild(loraWarning);
  sliderStack.appendChild(otherIntensity.wrap);

  const breedBtn = el("button", { class: "btn-breed", text: "Breed" });
  breedBtn.addEventListener("click", async () => {
    breedBtn.disabled = true;
    breedBtn.textContent = "Breeding...";
    const body = {
      count: parseInt(countInput.value, 10) || 1,
      reroll_probability: parseFloat(reroll.slider.value) / 100,
      keyword_intensity: parseFloat(keywordIntensity.slider.value) || 0,
      lora_intensity: parseFloat(loraIntensity.slider.value) || 0,
      other_intensity: parseFloat(otherIntensity.slider.value) || 0,
      spec: formSpec,
    };
    const nodes = await api.post("/api/root/breed", body);
    inheritBreedControlsForChildren(nodes);
    navigate(nodes[0].id);
  });

  box.appendChild(fieldRow("Count", countInput));
  box.appendChild(sliderStack);
  box.appendChild(breedBtn);
  return box;
}

function newRootLink() {
  const link = el("button", { class: "new-root-link", text: "+ New" });
  link.addEventListener("click", () => navigate("new"));
  return link;
}

async function uploadRootImage(file, spec) {
  const formData = new FormData();
  formData.append("file", file);
  // omitted entirely -> server extracts the spec from the image's own
  // metadata (plain Import); provided -> server keeps this spec as-is and
  // just adopts the image itself (drag-and-drop onto the image area)
  if (spec) formData.append("spec", JSON.stringify(spec));
  const res = await fetch("/api/root/from-image", { method: "POST", body: formData });
  if (!res.ok) {
    throw new Error((await res.text()) || `upload failed (${res.status})`);
  }
  return res.json();
}

// shared by both drop targets below -- highlights `target` while a file is
// dragged over it, and hands the dropped file to `onDrop` (only the first
// file if several are dropped)
function wireImageDrop(target, onDrop) {
  let dragDepth = 0;
  target.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    target.classList.add("drop-target-active");
  });
  target.addEventListener("dragover", (e) => e.preventDefault());
  target.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) target.classList.remove("drop-target-active");
  });
  target.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0;
    target.classList.remove("drop-target-active");
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    await onDrop(file);
  });
}

// dropped onto the spec/form area: full import, same as the "Import..."
// button -- both the image and its spec come from the dropped file
function wireSpecAreaImageDrop(target) {
  wireImageDrop(target, async (file) => {
    try {
      const node = await uploadRootImage(file);
      navigate(node.id);
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  });
}

// dropped onto the image area: the image is adopted, but the current spec
// is kept as-is -- geared towards then breeding img2img off the dropped
// image, so default the mode toggle to img2img ahead of that
function wireImageOnlyDrop(target) {
  wireImageDrop(target, async (file) => {
    try {
      const node = await uploadRootImage(file, formSpec);
      // pre-seed this specific new node's saved mode (rather than setting
      // currentMode directly) so switchFormFocus picks it up correctly once
      // navigate()'s render actually focuses it
      savedMode.set(node.id, "img2img");
      navigate(node.id);
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  });
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
// mirrors promptsyntax.py's PONY_TAG_RE
const PONY_TAG_RE = /^(score_\d+(_up)?|source_\w+)$/i;
// A1111-style emphasis shorthand: (foo) = 1.1, ((foo)) = 1.2, and so on --
// mirrors promptsyntax.py's NESTED_WEIGHT_RE. Only ever read, never written;
// buildSegmentText always emits the explicit name:weight form (or a bare
// name once weight rounds back to 1.0).
const NESTED_WEIGHT_RE = /^(\(+)([^()]+)(\)+)$/;
const KEYWORD_WEIGHT_BOUNDS = [0.3, 2.0];
const LORA_WEIGHT_BOUNDS = [0.0, 1.5];
const WEIGHT_STEP = 0.1;
// how close a weight has to be to 1.0 to render as a bare name instead of
// "(name:1.0)" -- mirrors promptsyntax.py's _UNWEIGHTED_TOLERANCE
const UNWEIGHTED_TOLERANCE = 0.05;

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
  m = NESTED_WEIGHT_RE.exec(seg);
  if (m && m[1].length === m[3].length) {
    const weight = Math.round((1.0 + 0.1 * m[1].length) * 100) / 100;
    return { name: m[2].trim(), weight, kind: "weighted", bounds: KEYWORD_WEIGHT_BOUNDS };
  }
  return { name: seg, weight: 1.0, kind: "plain", bounds: KEYWORD_WEIGHT_BOUNDS };
}

function buildSegmentText(seg) {
  if (seg.kind === "lora") return `<lora:${seg.name}:${seg.weight}>`;
  if (seg.kind === "weighted") {
    return Math.abs(seg.weight - 1.0) < UNWEIGHTED_TOLERANCE ? seg.name : `(${seg.name}:${seg.weight})`;
  }
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
  // a plain (never-weighted) segment must be promoted to explicit "weighted"
  // syntax to actually show the nudge -- buildSegmentText's "plain" case
  // intentionally ignores weight (correct for the diff overlay's unchanged
  // segments, but not for an active nudge)
  const kind = parsed.kind === "plain" ? "weighted" : parsed.kind;
  const newWeight = clampWeight(parsed.weight + delta, parsed.bounds);
  const replacement = buildSegmentText({ ...parsed, kind, weight: newWeight });
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

// Pulls pony score/source tags out to a new first line and loras out to the
// end (one per line), wherever they were -- even mid-line. Everything else
// keeps its original line grouping and relative order completely untouched:
// users rely on manual newlines to cluster related keywords together (e.g.
// "foo1,foo2,\nbar1,bar2"), and this must not flatten that. Mirrors
// promptsyntax.py's normalize_prompt exactly, so the live preview here
// matches what the server will store. Commas remain the real delimiter
// throughout -- the newlines are just formatting.
function normalizePromptText(text) {
  const pony = [], loras = [], keptLines = [];
  for (const rawLine of text.split("\n")) {
    const kept = [];
    for (const raw of rawLine.split(",")) {
      const seg = raw.trim();
      if (!seg) continue;
      const parsed = parseSegment(seg);
      if (parsed.kind === "lora") loras.push(seg);
      else if (PONY_TAG_RE.test(parsed.name)) pony.push(seg);
      else kept.push(seg);
    }
    if (kept.length) keptLines.push(kept.join(", "));
  }
  const lines = [];
  if (pony.length) lines.push(pony.join(", "));
  lines.push(...keptLines);
  lines.push(...loras);
  return lines.join(",\n");
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
// the field is actually edited or focused, per the field's own
// dismissed-flag). Primary path: the overlay is pointer-events:none (see
// CSS) so a real click passes straight through to inputEl, letting the
// browser place the cursor exactly where clicked -- precision we'd lose if
// the overlay intercepted the click itself. 'focus' fires as part of that
// same click and dismisses the overlay. The overlay's own mousedown handler
// below is a fallback only, for if pointer-events ever fails to hold up in
// some browser/environment: it keeps the field at least usable (imprecise
// cursor placement) rather than fully stuck, but never fires in normal
// operation since the click never reaches the overlay itself.
function wrapFieldWithDiff(inputEl, parentText, currentText, isDismissed, dismiss) {
  const wrap = el("div", { class: "field-prompt-wrap" });
  wrap.appendChild(inputEl);
  if (parentText != null && !isDismissed()) {
    const overlay = buildDiffOverlay(buildPromptDiffSpans(parentText || "", currentText || ""));
    const dismissOverlay = () => {
      dismiss();
      overlay.remove();
    };
    inputEl.addEventListener("focus", dismissOverlay, { once: true });
    overlay.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dismissOverlay();
      inputEl.focus();
    });
    // the overlay is pointer-events:none specifically so clicks/hover pass
    // through to inputEl (see the block comment above) -- which means wheel
    // scrolling over the field already scrolls the real (hidden) textarea,
    // but the visible overlay never followed, so any diff-colored content
    // past the fold was reachable by scrolling yet impossible to actually
    // see. Mirror inputEl's scroll position onto the overlay to fix that,
    // without touching the focus-to-dismiss behavior at all.
    inputEl.addEventListener("scroll", () => {
      overlay.scrollTop = inputEl.scrollTop;
      overlay.scrollLeft = inputEl.scrollLeft;
    });
    wrap.appendChild(overlay);
    inputEl.addEventListener("input", dismissOverlay, { once: true });
  }
  return wrap;
}

// Single-value analog of wrapFieldWithDiff's overlay technique -- there's no
// way to paint colored spans inside native select/number-input chrome, so
// this colors the control itself instead. "numeric" diffs by direction
// (green increase / red decrease, same colors as a keyword's weight nudge);
// "categorical" just flags any change (blue), since there's no meaningful
// "more/less" for e.g. a model name or a rerolled seed.
function fieldDiffClass(parentVal, currentVal, mode) {
  if (parentVal == null || currentVal == null) return null;
  if (mode === "numeric") {
    const p = parseFloat(parentVal), c = parseFloat(currentVal);
    if (isNaN(p) || isNaN(c) || p === c) return null;
    return c > p ? "field-diff-increase" : "field-diff-decrease";
  }
  return String(parentVal) === String(currentVal) ? null : "field-diff-changed";
}

// Applies the diff class to `elements` (usually just the one control, but
// e.g. Model/Sampler have a select plus a custom-text fallback that both
// need it) and removes it the moment the user actually interacts with any
// of them -- once you're editing a field, the "this changed from the
// parent" signal has done its job, same lifecycle as the prompt overlay.
function wireFieldDiff(elements, parentVal, currentVal, mode) {
  const cls = fieldDiffClass(parentVal, currentVal, mode);
  if (!cls) return;
  for (const el of elements) el.classList.add(cls);
  const dismiss = () => { for (const el of elements) el.classList.remove(cls); };
  for (const el of elements) {
    el.addEventListener("focus", dismiss, { once: true });
    el.addEventListener("input", dismiss, { once: true });
    el.addEventListener("change", dismiss, { once: true });
  }
}

function wireFieldPromptShortcuts(panel) {
  panel.addEventListener("keydown", (e) => {
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
    const rebuildForm = switchFormFocus("new");
    const seedSpec = rebuildForm ? (savedFormSpecs.get("new") ?? await api.get("/api/defaults")) : formSpec;

    // no ancestors to show, but the "+ New"/"Import..." actions still need to
    // be reachable here -- this is exactly the screen where "Import" instead
    // of typing from scratch is most likely wanted (this is what the "nothing
    // happens" INBOX report turned out to be: these buttons simply weren't
    // rendered at all on the "+ New" screen, an early-return oversight)
    const crumbBar = breadcrumbs([], "new");
    const crumbActions = el("div", { class: "crumb-actions" });
    crumbActions.appendChild(newRootLink());
    crumbActions.appendChild(importRootLink());
    crumbBar.appendChild(crumbActions);
    panel.appendChild(crumbBar);

    const main = el("div", { class: "detail-main" });
    const imageBox = el("div", { class: "detail-image" });
    imageBox.appendChild(el("div", { class: "placeholder", text: "not generated yet" }));
    main.appendChild(imageBox);
    const formEl = buildForm(seedSpec, knownModels);
    main.appendChild(formEl);
    panel.appendChild(main);
    panel.appendChild(buildFreshBreedControls());
    wireFieldPromptShortcuts(panel);
    wireImageOnlyDrop(imageBox);
    wireSpecAreaImageDrop(formEl);
    return panel;
  }

  const [node, ancestors] = await Promise.all([
    api.get(`/api/nodes/${focusId}`),
    api.get(`/api/nodes/${focusId}/ancestors`),
  ]);

  const crumbBar = breadcrumbs(ancestors.slice(0, -1), focusId);
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

  const rebuildForm = switchFormFocus(
    focusId, node.render_mode || "txt2img", node.spec.denoising_strength ?? 0.75
  );
  const parentNode = ancestors.length >= 2 ? ancestors[ancestors.length - 2] : null;
  const seedSpec = rebuildForm ? (savedFormSpecs.get(focusId) ?? node.spec) : formSpec;
  const formEl = buildForm(seedSpec, knownModels, parentNode && parentNode.spec);
  main.appendChild(formEl);
  panel.appendChild(main);

  panel.appendChild(buildBreedControls(node));
  wireFieldPromptShortcuts(panel);
  wireImageOnlyDrop(imageBox);
  wireSpecAreaImageDrop(formEl);

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
  if (isPoll && hoverEl) {
    // same gotcha again, this time for the breadcrumb hover-preview panel:
    // rebuilding destroys the hovered element (crumbEl), and a *removed*
    // element never gets a mouseleave -- so hideHoverPreview (bound to that
    // listener) never fires, and the panel (a separate document.body node)
    // is orphaned, stuck showing stale content until something else happens
    // to touch it. Defer instead, same as the isEditingUI case above.
    pollTimer = setTimeout(() => render(true), 1500);
    return;
  }

  stopPolling();
  // belt-and-suspenders for the same issue: any render that *does* proceed
  // (this one, or a non-poll one e.g. from clicking the very thumb being
  // hovered to navigate to it) is about to tear down whatever DOM the hover
  // panel's anchor lived in, so clear it explicitly rather than leaving it
  // orphaned -- don't rely solely on deferral above to prevent staleness.
  hideHoverPreview();
  // root.replaceChildren below rebuilds .browser-panel from scratch, which
  // resets scroll position to 0 as a side effect regardless of whether we
  // explicitly scroll anywhere -- same render() gotcha as the focus-loss
  // bug, just for scroll instead. Capture it now, restore it below.
  const prevScrollTop = document.querySelector(".browser-panel")?.scrollTop ?? 0;
  // same gotcha again, this time for the detail panel -- a poll tick firing
  // while the user has scrolled down (e.g. reaching for the Breed button on
  // a tall form) was snapping them straight back to the top, mid-scroll.
  // Only restore this when it's the same node re-rendering, though --
  // switching to a different node should still start scrolled to the top.
  const prevDetailScrollTop = document.querySelector(".detail-panel")?.scrollTop ?? 0;
  // same DOM-rebuild gotcha, this time for a manually-resized prompt textarea:
  // its height lives only in an inline style the browser sets on drag, so a
  // rebuild silently drops it back to the CSS default. Carry it over by hand.
  const prevPromptHeight = document.querySelector(".field-prompt-main")?.style.height || null;
  const prevNegHeight = document.querySelector(".field-prompt-neg")?.style.height || null;
  const [allNodes, knownModels, corpusSummaryResult] = await Promise.all([
    api.get("/api/nodes"),
    api.get("/api/models"),
    api.get("/api/corpus/summary"),
  ]);
  corpusSummary = corpusSummaryResult;
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
  if (prevPromptHeight) {
    const promptEl = wrap.querySelector(".field-prompt-main");
    if (promptEl) promptEl.style.height = prevPromptHeight;
  }
  if (prevNegHeight) {
    const negEl = wrap.querySelector(".field-prompt-neg");
    if (negEl) negEl.style.height = prevNegHeight;
  }

  const detailPanel = wrap.querySelector(".detail-panel");
  if (detailPanel) {
    detailPanel.scrollTop = focusId === lastDetailFocusId ? prevDetailScrollTop : 0;
  }
  lastDetailFocusId = focusId;

  // only scroll the selection into view when arrow-key navigation asked for
  // it (see the keydown handler below) -- doing this on every render was too
  // aggressive: a poll tick firing every 1.5s while something's generating
  // kept snapping the grid back if you'd scrolled elsewhere to look around.
  // Otherwise, restore wherever the user had actually scrolled to.
  if (scrollSelectedIntoView) {
    scrollSelectedIntoView = false;
    const selectedCard = browserPanel.querySelector(".thumb-card.selected");
    if (selectedCard) selectedCard.scrollIntoView({ block: "nearest" });
  } else {
    browserPanel.scrollTop = prevScrollTop;
  }

  // single poll-scheduling site, on purpose -- corpus scanning used to
  // schedule its own independent setTimeout(() => render(true), 2000) from
  // inside buildCorpusPanel, called on every render including the ones
  // *this* check already schedules. Nothing tracked or cancelled that
  // second timer, so it could compound: any render while a scan was still
  // running spawned another one, each of which (being a full render) could
  // spawn yet another -- an untracked, self-multiplying chain of full page
  // rebuilds + 3 API calls each, which is exactly what a page-freezing
  // request storm looks like. Folding it in here means there's exactly one
  // timer, tracked in pollTimer, cleared by stopPolling() like every other
  // poll-driven render.
  if (expectScanSoon && (corpusSummary?.scanning || Date.now() - expectScanSoonSince > EXPECT_SCAN_TIMEOUT_MS)) {
    // either the scan we were waiting for actually started showing up in
    // polled state, or it's been long enough that it must have already
    // finished (or failed) without us ever catching it in-flight -- either
    // way, stop treating this as "might start any moment"
    expectScanSoon = false;
  }
  if (
    allNodes.some((n) => n.status === "pending") ||
    (corpusSummary && corpusSummary.scanning) ||
    expectScanSoon
  ) {
    pollTimer = setTimeout(() => render(true), 1500);
  }
}

render();

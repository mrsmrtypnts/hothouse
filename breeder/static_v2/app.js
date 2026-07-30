const root = document.getElementById("app");

const api = {
  get: (path) => fetch(path).then((r) => r.json()),
  post: (path, body) =>
    fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then((r) => r.json()),
};

// duplicated from mutate.py's SAMPLERS -- breeder has no /api/samplers endpoint,
// this is just a suggestion list (the sampler field accepts free text)
const SAMPLERS = ["DPM++ 2M SDE", "Euler a", "Euler", "DPM++ 2M", "DPM++ 2M Karras", "DPM++ SDE Karras", "UniPC"];
const SIZE_OPTIONS = [
  { width: 800, height: 1200 },
  { width: 1200, height: 800 },
];
const REROLL_OPTIONS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

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
window.addEventListener("popstate", render);

let pollTimer = null;
function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

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

function buildSplitter(browserPanel) {
  const splitter = el("div", { class: "splitter" });
  splitter.addEventListener("mousedown", (e) => {
    e.preventDefault();
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

function thumbCard(node, selected) {
  const card = el("div", { class: `thumb-card${selected ? " selected" : ""}` });
  if (node.status === "done") {
    card.appendChild(el("img", { src: `/images/${node.image_file}`, alt: node.spec.prompt || node.id }));
  } else if (node.status === "error") {
    card.appendChild(el("div", { class: "thumb-status thumb-error", text: "failed" }));
  } else {
    card.appendChild(el("div", { class: "thumb-status", text: "…" }));
  }
  card.addEventListener("click", () => navigate(node.id));
  return card;
}

function buildBrowserPanel(allNodes, focusId) {
  const panel = el("div", { class: "browser-panel" });
  panel.appendChild(el("h2", { text: "Breeder Studio" }));
  const grid = el("div", { class: "thumb-grid" });
  for (const node of allNodes) {
    grid.appendChild(thumbCard(node, node.id === focusId));
  }
  panel.appendChild(grid);
  return panel;
}

function breadcrumbs(ancestors) {
  const bar = el("div", { class: "crumbs" });
  for (const a of ancestors) {
    if (a.status === "done") {
      const img = el("img", { class: "crumb-thumb", src: `/images/${a.image_file}`, alt: a.label || a.id });
      img.addEventListener("click", () => navigate(a.id));
      bar.appendChild(img);
    } else {
      const span = el("span", { class: "crumb-pending", text: a.status === "error" ? "✗" : "…" });
      span.addEventListener("click", () => navigate(a.id));
      bar.appendChild(span);
    }
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

function buildForm(spec, knownModels) {
  formSpec = { ...spec };
  const form = el("div", { class: "detail-form" });

  const promptInput = el("textarea", { class: "field-prompt" });
  promptInput.value = formSpec.prompt || "";
  promptInput.addEventListener("input", () => { formSpec.prompt = promptInput.value; });
  form.appendChild(fieldRow("Prompt", promptInput));

  const negInput = el("textarea", { class: "field-prompt" });
  negInput.value = formSpec.negative_prompt || "";
  negInput.addEventListener("input", () => { formSpec.negative_prompt = negInput.value; });
  form.appendChild(fieldRow("Negative prompt", negInput));

  buildModelField(form, knownModels);

  const samplerInput = el("input", { type: "text", list: "sampler-options" });
  samplerInput.value = formSpec.sampler_name || "";
  samplerInput.addEventListener("input", () => { formSpec.sampler_name = samplerInput.value; });
  const datalist = el("datalist", { id: "sampler-options" });
  for (const s of SAMPLERS) datalist.appendChild(el("option", { value: s }));
  form.appendChild(datalist);
  form.appendChild(fieldRow("Sampler", samplerInput));

  buildSizeField(form);

  const numRow = el("div", { class: "field-grid" });
  form.appendChild(numRow);
  numField(numRow, "Steps", "steps", { min: "1", max: "150" });
  numField(numRow, "CFG scale", "cfg_scale", { min: "1", max: "30", step: "0.5" });
  numField(numRow, "Seed", "seed", { step: "1" });
  numField(numRow, "Clip skip", "clip_skip", { min: "1", max: "12" });
  numField(numRow, "Batch size", "batch_size", { min: "1", max: "8" });
  numField(numRow, "N iter", "n_iter", { min: "1", max: "8" });

  return form;
}

function buildBreedControls(node) {
  const box = el("div", { class: "breed-controls" });

  const countInput = el("input", { type: "number", min: "1", max: "30" });
  countInput.value = "6";

  const rerollSelect = el("select");
  for (const pct of REROLL_OPTIONS) {
    rerollSelect.appendChild(el("option", { value: String(pct / 100), text: `${pct}% reroll` }));
  }
  rerollSelect.value = "0.5";

  const intensityInput = el("input", { type: "number", min: "0", step: "0.5" });
  intensityInput.value = "1";

  let mode = getMode();
  const modeToggle = el("div", { class: "mode-toggle" });
  const txt2imgBtn = el("button", { type: "button", text: "txt2img" });
  const img2imgBtn = el("button", { type: "button", text: "img2img" });
  const denoiseInput = el("input", {
    type: "number", min: "0", max: "1", step: "0.05", class: "denoise-input",
  });
  denoiseInput.value = getDenoise().toFixed(2);
  denoiseInput.addEventListener("change", () => {
    const v = parseFloat(denoiseInput.value);
    if (!isNaN(v)) {
      denoiseInput.value = v.toFixed(2);
      setDenoise(v);
    }
  });

  function updateModeUI() {
    txt2imgBtn.classList.toggle("active", mode === "txt2img");
    img2imgBtn.classList.toggle("active", mode === "img2img");
    denoiseInput.style.display = mode === "img2img" ? "" : "none";
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
      reroll_probability: parseFloat(rerollSelect.value),
      mutator_intensity: parseFloat(intensityInput.value) || 0,
      spec: formSpec,
    };
    if (mode === "img2img") {
      body.denoising_strength = parseFloat(denoiseInput.value) || 0.75;
    }
    await api.post(`/api/nodes/${node.id}/variations`, body);
    breedBtn.disabled = false;
    breedBtn.textContent = "Breed";
    render();
  });

  box.appendChild(fieldRow("Count", countInput));
  box.appendChild(fieldRow("Mutation", rerollSelect));
  box.appendChild(fieldRow("Intensity", intensityInput));
  box.appendChild(modeToggle);
  box.appendChild(denoiseInput);
  box.appendChild(breedBtn);
  return box;
}

function buildCreateControls() {
  const box = el("div", { class: "breed-controls" });
  const createBtn = el("button", { class: "btn-breed", text: "Create" });
  createBtn.addEventListener("click", async () => {
    createBtn.disabled = true;
    createBtn.textContent = "Creating...";
    const { prompt, ...overrides } = formSpec;
    const node = await api.post("/api/root", { prompt, overrides });
    navigate(node.id);
  });
  box.appendChild(createBtn);
  return box;
}

function newRootLink() {
  const link = el("button", { class: "new-root-link", text: "+ New" });
  link.addEventListener("click", () => navigate("new"));
  return link;
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
    panel.appendChild(buildCreateControls());
    return panel;
  }

  const [node, ancestors] = await Promise.all([
    api.get(`/api/nodes/${focusId}`),
    api.get(`/api/nodes/${focusId}/ancestors`),
  ]);

  const crumbBar = breadcrumbs(ancestors.slice(0, -1));
  crumbBar.appendChild(newRootLink());
  panel.appendChild(crumbBar);

  const main = el("div", { class: "detail-main" });
  const imageBox = el("div", { class: "detail-image" });
  if (node.status === "done") {
    imageBox.appendChild(el("img", { src: `/images/${node.image_file}`, alt: "focused" }));
  } else if (node.status === "error") {
    imageBox.appendChild(el("div", { class: "placeholder", text: `error: ${node.error || ""}` }));
  } else {
    imageBox.appendChild(el("div", { class: "placeholder", text: "rendering..." }));
  }
  main.appendChild(imageBox);

  const rebuildForm = focusId !== formFocusId;
  if (rebuildForm) formFocusId = focusId;
  main.appendChild(buildForm(rebuildForm ? node.spec : formSpec, knownModels));
  panel.appendChild(main);

  panel.appendChild(buildBreedControls(node));

  return panel;
}

async function render() {
  stopPolling();
  const [allNodes, knownModels] = await Promise.all([
    api.get("/api/nodes"),
    api.get("/api/models"),
  ]);
  let focusId = currentNodeId();
  if (focusId !== "new" && (!focusId || !allNodes.some((n) => n.id === focusId))) {
    focusId = allNodes.length ? allNodes[0].id : "new";
  }

  const wrap = el("div", { class: "studio" });
  const browserPanel = buildBrowserPanel(allNodes, focusId);
  browserPanel.style.width = `${getBrowserWidth()}px`;
  wrap.appendChild(browserPanel);
  wrap.appendChild(buildSplitter(browserPanel));
  wrap.appendChild(await buildDetailPanel(focusId, knownModels));
  root.replaceChildren(wrap);

  if (allNodes.some((n) => n.status === "pending")) {
    pollTimer = setTimeout(render, 1500);
  }
}

render();

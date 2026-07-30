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
const SAMPLERS = ["Euler a", "Euler", "DPM++ 2M", "DPM++ 2M Karras", "DPM++ SDE Karras", "UniPC"];
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

function buildForm(spec) {
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

  const modelInput = el("input", { type: "text" });
  modelInput.value = formSpec.model_name || "";
  modelInput.addEventListener("input", () => { formSpec.model_name = modelInput.value; });
  form.appendChild(fieldRow("Model", modelInput));

  const samplerInput = el("input", { type: "text", list: "sampler-options" });
  samplerInput.value = formSpec.sampler_name || "";
  samplerInput.addEventListener("input", () => { formSpec.sampler_name = samplerInput.value; });
  const datalist = el("datalist", { id: "sampler-options" });
  for (const s of SAMPLERS) datalist.appendChild(el("option", { value: s }));
  form.appendChild(datalist);
  form.appendChild(fieldRow("Sampler", samplerInput));

  const numRow = el("div", { class: "field-grid" });
  form.appendChild(numRow);
  numField(numRow, "Steps", "steps", { min: "1", max: "150" });
  numField(numRow, "CFG scale", "cfg_scale", { min: "1", max: "30", step: "0.5" });
  numField(numRow, "Seed", "seed", { step: "1" });
  numField(numRow, "Width", "width", { min: "64", step: "64" });
  numField(numRow, "Height", "height", { min: "64", step: "64" });
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

async function buildDetailPanel(focusId) {
  const panel = el("div", { class: "detail-panel" });
  if (!focusId) {
    panel.appendChild(el("div", {
      class: "empty-state",
      text: "No generations yet -- create a root image in the classic UI, then come back here to browse and breed.",
    }));
    return panel;
  }

  const [node, ancestors] = await Promise.all([
    api.get(`/api/nodes/${focusId}`),
    api.get(`/api/nodes/${focusId}/ancestors`),
  ]);

  panel.appendChild(breadcrumbs(ancestors.slice(0, -1)));

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
  main.appendChild(buildForm(rebuildForm ? node.spec : formSpec));
  panel.appendChild(main);

  panel.appendChild(buildBreedControls(node));

  return panel;
}

async function render() {
  stopPolling();
  const allNodes = await api.get("/api/nodes");
  let focusId = currentNodeId();
  if (!focusId || !allNodes.some((n) => n.id === focusId)) {
    focusId = allNodes.length ? allNodes[0].id : null;
  }

  const wrap = el("div", { class: "studio" });
  wrap.appendChild(buildBrowserPanel(allNodes, focusId));
  wrap.appendChild(await buildDetailPanel(focusId));
  root.replaceChildren(wrap);

  if (allNodes.some((n) => n.status === "pending")) {
    pollTimer = setTimeout(render, 1500);
  }
}

render();

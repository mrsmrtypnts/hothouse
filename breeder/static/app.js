const root = document.getElementById("app");
let pollTimer = null;

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

function currentNodeId() {
  return new URLSearchParams(location.search).get("n");
}

function navigate(id) {
  const url = id ? `?n=${id}` : location.pathname;
  history.pushState({}, "", url);
  render();
}

window.addEventListener("popstate", render);

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

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

let lightboxEl = null;
let lightboxItems = null;
let lightboxIndex = -1;
let lightboxPollTimer = null;

function stopLightboxPolling() {
  if (lightboxPollTimer) clearTimeout(lightboxPollTimer);
  lightboxPollTimer = null;
}

function closeLightbox() {
  stopLightboxPolling();
  if (lightboxEl) {
    lightboxEl.remove();
    lightboxEl = null;
  }
  lightboxItems = null;
  lightboxIndex = -1;
}

function renderLightboxContent() {
  stopLightboxPolling();
  if (lightboxEl) lightboxEl.remove();
  const node = lightboxItems[lightboxIndex];
  const overlay = el("div", { class: "lightbox" });

  if (node.status === "done") {
    overlay.appendChild(el("img", { src: `/images/${node.image_file}`, alt: node.label || "variant" }));
  } else if (node.status === "error") {
    overlay.appendChild(
      el("div", { class: "lightbox-placeholder", text: `failed: ${node.error || ""}` })
    );
  } else {
    overlay.appendChild(el("div", { class: "lightbox-placeholder", text: "rendering..." }));
  }

  if (lightboxItems.length > 1) {
    overlay.appendChild(
      el("div", { class: "lightbox-position", text: `${lightboxIndex + 1} / ${lightboxItems.length}` })
    );
  }

  if (node.label) {
    overlay.appendChild(el("div", { class: "lightbox-caption", text: node.label }));
  }

  if (node.status === "done") {
    const selectBtn = el("button", { text: "select as root" });
    selectBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = node.id;
      closeLightbox();
      navigate(id);
    });
    overlay.appendChild(selectBtn);
  }

  if (lightboxItems.length > 1) {
    const prevBtn = el("button", { class: "lightbox-nav prev", text: "‹" });
    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      stepLightbox(-1);
    });
    overlay.appendChild(prevBtn);

    const nextBtn = el("button", { class: "lightbox-nav next", text: "›" });
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      stepLightbox(1);
    });
    overlay.appendChild(nextBtn);
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeLightbox();
  });
  document.body.appendChild(overlay);
  lightboxEl = overlay;

  if (node.status === "pending") {
    lightboxPollTimer = setTimeout(async () => {
      const fresh = await api.get(`/api/nodes/${node.id}`);
      if (lightboxItems && lightboxItems[lightboxIndex] && lightboxItems[lightboxIndex].id === node.id) {
        lightboxItems[lightboxIndex] = fresh;
        renderLightboxContent();
      }
    }, 1500);
  }
}

function openLightbox(node, siblings) {
  lightboxItems = siblings && siblings.length ? siblings : [node];
  lightboxIndex = lightboxItems.findIndex((n) => n.id === node.id);
  if (lightboxIndex === -1) lightboxIndex = 0;
  renderLightboxContent();
}

function stepLightbox(delta) {
  if (!lightboxItems || !lightboxItems.length) return;
  lightboxIndex = (lightboxIndex + delta + lightboxItems.length) % lightboxItems.length;
  renderLightboxContent();
}

document.addEventListener("keydown", (e) => {
  if (!lightboxEl) return;
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowRight") stepLightbox(1);
  else if (e.key === "ArrowLeft") stepLightbox(-1);
});

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

function showHoverPreview(node, anchorEl) {
  hideHoverPreview();
  const panel = el("div", { class: "hover-preview" });
  const img = el("img", { src: `/images/${node.image_file}`, alt: node.label || "variant" });
  panel.appendChild(img);
  if (node.label) {
    panel.appendChild(el("div", { class: "hover-caption", text: node.label }));
  }
  document.body.appendChild(panel);
  hoverEl = panel;

  positionHoverPanel(panel, anchorEl);
  img.addEventListener("load", () => {
    if (hoverEl === panel) positionHoverPanel(panel, anchorEl);
  });
}

async function render() {
  stopPolling();
  hideHoverPreview();
  const id = currentNodeId();
  const content = id ? await renderNode(id) : await renderHome();
  root.replaceChildren(content);
}

function corpusBarList(title, rows) {
  const wrap = el("div", { class: "corpus-list" });
  wrap.appendChild(el("h4", { text: title }));
  if (!rows.length) {
    wrap.appendChild(el("div", { class: "spec", text: "(none yet)" }));
    return wrap;
  }
  const max = Math.max(...rows.map((r) => r.count));
  for (const r of rows) {
    const row = el("div", { class: "corpus-bar-row" });
    row.appendChild(el("div", { class: "name", text: `${r.name} (${r.avg_weight})` }));
    const track = el("div", { class: "corpus-bar-track" });
    const fill = el("div", { class: "corpus-bar-fill" });
    fill.style.width = `${(r.count / max) * 100}%`;
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el("div", { class: "corpus-bar-count", text: String(r.count) }));
    wrap.appendChild(row);
  }
  return wrap;
}

async function corpusPanel() {
  const wrap = el("div", { class: "panel" });
  wrap.appendChild(el("h3", { text: "learned corpus" }));
  const pathsInput = el("textarea", { placeholder: "one directory per line" });
  pathsInput.style.minHeight = "50px";
  const browseBtn = el("button", { text: "browse..." });
  const scanBtn = el("button", { text: "scan" });
  const result = el("div", { class: "corpus-result" });

  browseBtn.addEventListener("click", async () => {
    browseBtn.disabled = true;
    const { path } = await api.post("/api/pick-directory", {});
    browseBtn.disabled = false;
    if (!path) return;
    const existing = pathsInput.value.split("\n").map((p) => p.trim()).filter(Boolean);
    if (!existing.includes(path)) existing.push(path);
    pathsInput.value = existing.join("\n");
  });

  async function refresh() {
    const s = await api.get("/api/corpus/summary");
    result.replaceChildren();
    if (s.file_count) {
      result.appendChild(
        el("div", { class: "spec", text: `${s.file_count} images scanned (${s.paths.join(", ")})` })
      );
      pathsInput.value = s.paths.join("\n");
    }
    result.appendChild(corpusBarList("top prompt keywords", s.top_prompt_keywords));
    result.appendChild(corpusBarList("top negative-prompt keywords", s.top_negative_keywords));
    result.appendChild(corpusBarList("top loras", s.top_loras));
  }

  scanBtn.addEventListener("click", async () => {
    scanBtn.disabled = true;
    scanBtn.textContent = "scanning...";
    const paths = pathsInput.value.split("\n").map((p) => p.trim()).filter(Boolean);
    await api.post("/api/corpus/scan", { paths });
    scanBtn.disabled = false;
    scanBtn.textContent = "scan";
    refresh();
  });

  wrap.appendChild(pathsInput);
  const btnRow = el("div", { class: "controls" });
  btnRow.appendChild(browseBtn);
  btnRow.appendChild(scanBtn);
  wrap.appendChild(btnRow);
  wrap.appendChild(result);
  await refresh();
  return wrap;
}

function buildRootCard(root) {
  const card = el("div", { class: "card" });

  const delBtn = el("button", { class: "delete-x", text: "×" });
  delBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("forget this root and everything grown from it?")) return;
    await api.del(`/api/nodes/${root.id}`);
    render();
  });
  card.appendChild(delBtn);

  if (root.status === "done") {
    const img = el("img", { src: `/images/${root.image_file}`, alt: root.spec.prompt || root.id });
    img.addEventListener("click", () => navigate(root.id));
    img.addEventListener("mouseenter", () => showHoverPreview(root, img));
    img.addEventListener("mouseleave", hideHoverPreview);
    card.appendChild(img);
  } else if (root.status === "error") {
    card.appendChild(el("div", { class: "status", text: "failed" }));
  } else {
    card.appendChild(el("div", { class: "status", text: "..." }));
  }
  card.appendChild(el("div", { class: "mutation", text: (root.spec.prompt || root.id).slice(0, 60) }));
  card.appendChild(el("a", { class: "open-link", href: `?n=${root.id}`, target: "_blank", text: "↗" }));
  return card;
}

async function renderHome() {
  const wrap = el("div");
  wrap.appendChild(el("h2", { text: "Breeder" }));

  const pick = el("div", { class: "panel" });
  pick.appendChild(el("div", { text: "pick a root image" }));
  const fileInput = el("input", { type: "file", accept: "image/png" });
  const pickStatus = el("div", { class: "spec" });
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files[0];
    if (!f) return;
    pickStatus.textContent = "reading...";
    const body = new FormData();
    body.append("file", f);
    const resp = await fetch("/api/root/from-image", { method: "POST", body });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      pickStatus.textContent = err.detail || "failed to read image";
      return;
    }
    const node = await resp.json();
    navigate(node.id);
  });
  pick.appendChild(fileInput);
  pick.appendChild(pickStatus);
  wrap.appendChild(pick);

  const roots = await api.get("/api/roots");
  if (roots.length) {
    const list = el("div");
    list.appendChild(el("h3", { text: "resume" }));
    const grid = el("div", { class: "grid" });
    for (const r of roots) grid.appendChild(buildRootCard(r));
    list.appendChild(grid);
    wrap.appendChild(list);
  }

  wrap.appendChild(await corpusPanel());

  return wrap;
}

function breadcrumbs(ancestors) {
  const bar = el("div", { class: "crumbs" });
  const home = el("a", { href: ".", text: "home" });
  home.addEventListener("click", (e) => {
    e.preventDefault();
    navigate(null);
  });
  bar.appendChild(home);
  for (const a of ancestors) {
    bar.appendChild(el("span", { text: "›" }));
    if (a.status === "done") {
      const img = el("img", { class: "crumb-thumb", src: `/images/${a.image_file}`, alt: a.label || a.id });
      img.addEventListener("click", () => navigate(a.id));
      img.addEventListener("mouseenter", () => showHoverPreview(a, img));
      img.addEventListener("mouseleave", hideHoverPreview);
      bar.appendChild(img);
    } else {
      const link = el("a", { href: `?n=${a.id}`, text: a.status === "error" ? "✗" : "…" });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        navigate(a.id);
      });
      bar.appendChild(link);
    }
  }
  return bar;
}

function nodeMedia(node) {
  if (node.status === "done") {
    return el("img", { src: `/images/${node.image_file}`, alt: "current node" });
  }
  if (node.status === "error") {
    return el("div", { class: "placeholder", text: `error: ${node.error || ""}` });
  }
  return el("div", { class: "placeholder", text: "rendering..." });
}

async function renderNode(id) {
  const [node, ancestors, children] = await Promise.all([
    api.get(`/api/nodes/${id}`),
    api.get(`/api/nodes/${id}/ancestors`),
    api.get(`/api/nodes/${id}/children`),
  ]);

  const wrap = el("div");
  wrap.appendChild(breadcrumbs(ancestors.slice(0, -1)));

  const mainRow = el("div", { class: "main-node" });
  mainRow.appendChild(nodeMedia(node));
  mainRow.appendChild(el("div", { class: "spec", text: JSON.stringify(node.spec, null, 2) }));
  wrap.appendChild(mainRow);

  const controls = el("div", { class: "controls" });
  const count = el("input", { type: "number", value: "6", min: "1", max: "20" });

  let mode = node.render_mode === "img2img" ? "img2img" : "txt2img";
  const modeToggle = el("div", { class: "mode-toggle" });
  const txt2imgBtn = el("button", { type: "button", text: "txt2img" });
  const img2imgBtn = el("button", { type: "button", text: "img2img" });
  const savedDenoise = parseFloat(sessionStorage.getItem("denoisingStrength") || "0.75").toFixed(2);
  const denoiseInput = el("input", {
    type: "number", value: savedDenoise, min: "0", max: "1", step: "0.05", class: "denoise-input",
  });
  denoiseInput.addEventListener("change", () => {
    const val = parseFloat(denoiseInput.value);
    if (!isNaN(val)) denoiseInput.value = val.toFixed(2);
    sessionStorage.setItem("denoisingStrength", denoiseInput.value);
  });

  function updateModeUI() {
    txt2imgBtn.classList.toggle("active", mode === "txt2img");
    img2imgBtn.classList.toggle("active", mode === "img2img");
    denoiseInput.style.display = mode === "img2img" ? "" : "none";
  }
  txt2imgBtn.addEventListener("click", () => {
    mode = "txt2img";
    updateModeUI();
  });
  img2imgBtn.addEventListener("click", () => {
    mode = "img2img";
    updateModeUI();
  });
  updateModeUI();
  modeToggle.appendChild(txt2imgBtn);
  modeToggle.appendChild(img2imgBtn);

  const go = el("button", { class: "btn-primary", text: "generate variations" });
  go.addEventListener("click", async () => {
    if (mode === "img2img" && node.status !== "done") {
      alert("img2img requires this node to have a completed render first");
      return;
    }
    go.disabled = true;
    go.textContent = "generating...";
    const body = { count: parseInt(count.value, 10) || 6, mode };
    if (mode === "img2img") {
      body.denoising_strength = parseFloat(denoiseInput.value) || 0.75;
    }
    await api.post(`/api/nodes/${id}/variations`, body);
    render();
  });
  controls.appendChild(count);
  controls.appendChild(modeToggle);
  controls.appendChild(denoiseInput);
  controls.appendChild(go);
  if (children.some((c) => c.status === "error")) {
    const retryFailed = el("button", { text: "retry failed" });
    retryFailed.addEventListener("click", async () => {
      retryFailed.disabled = true;
      await Promise.all(
        children.filter((c) => c.status === "error").map((c) => api.post(`/api/nodes/${c.id}/retry`, {}))
      );
      render();
    });
    controls.appendChild(retryFailed);

    const clearFailed = el("button", { text: "clear failed" });
    clearFailed.addEventListener("click", async () => {
      clearFailed.disabled = true;
      await Promise.all(
        children.filter((c) => c.status === "error").map((c) => api.del(`/api/nodes/${c.id}`))
      );
      render();
    });
    controls.appendChild(clearFailed);
  }
  wrap.appendChild(controls);

  function buildCard(child, batchSiblings) {
    const card = el("div", { class: "card" });

    const delBtn = el("button", { class: "delete-x", text: "×" });
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("forget this variant?")) return;
      await api.del(`/api/nodes/${child.id}`);
      render();
    });
    card.appendChild(delBtn);

    if (child.status === "done") {
      const img = el("img", { src: `/images/${child.image_file}`, alt: `variant ${child.id}` });
      img.addEventListener("click", () => openLightbox(child, batchSiblings));
      img.addEventListener("mouseenter", () => showHoverPreview(child, img));
      img.addEventListener("mouseleave", hideHoverPreview);
      card.appendChild(img);
    } else if (child.status === "error") {
      const statusBox = el("div", { class: "status" });
      statusBox.style.cursor = "pointer";
      statusBox.addEventListener("click", () => openLightbox(child, batchSiblings));
      statusBox.appendChild(el("span", { text: "failed" }));
      const retryBtn = el("button", { class: "retry", text: "retry" });
      retryBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        retryBtn.disabled = true;
        await api.post(`/api/nodes/${child.id}/retry`, {});
        render();
      });
      statusBox.appendChild(retryBtn);
      card.appendChild(statusBox);
    } else {
      const statusBox = el("div", { class: "status", text: "..." });
      statusBox.style.cursor = "pointer";
      statusBox.addEventListener("click", () => openLightbox(child, batchSiblings));
      card.appendChild(statusBox);
    }
    if (child.label) {
      card.appendChild(el("div", { class: "mutation", text: child.label }));
    }
    card.appendChild(el("a", { class: "open-link", href: `?n=${child.id}`, target: "_blank", text: "↗" }));
    return card;
  }

  const batches = el("div", { class: "batches" });
  const batchOrder = [];
  const batchGroups = new Map();
  for (const child of children) {
    const key = child.batch_id || child.id;
    if (!batchGroups.has(key)) {
      batchGroups.set(key, []);
      batchOrder.push(key);
    }
    batchGroups.get(key).push(child);
  }
  for (const key of batchOrder) {
    const rowGrid = el("div", { class: "grid" });
    const batchSiblings = batchGroups.get(key);
    for (const child of batchSiblings) {
      rowGrid.appendChild(buildCard(child, batchSiblings));
    }
    batches.appendChild(rowGrid);
  }
  wrap.appendChild(batches);

  const pending = [node, ...children].some((n) => n.status === "pending");
  if (pending) {
    pollTimer = setTimeout(() => {
      if (currentNodeId() === id) render();
    }, 1500);
  }

  return wrap;
}

render();

const API_BASE = "https://seize-1lxs.onrender.com/api";

// ===== Pending-file persistence (survives the mobile PWA reload) =====
// android chrome loves to nuke the whole page while the native file
// picker is open (memory reclaim thing), so when you come back the
// File you picked is just... gone. can't be helped, file inputs never
// survive a reload. workaround: stash the blob in indexedDB the second
// it's picked, then check for it on load and rebuild everything.
const IDB_NAME = "seize-pending";
const IDB_STORE = "files";
const QUEUE_STORE = "offline-queue";

function openPendingDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, {
          keyPath: "id",
          autoIncrement: true,
        });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function savePendingFile(file, meta) {
  try {
    const db = await openPendingDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(
        { blob: file, name: file.name, type: file.type, ...meta },
        "convert",
      );
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[seize] Could not persist pending file:", err);
  }
}

async function loadPendingFile() {
  try {
    const db = await openPendingDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get("convert");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function clearPendingFile() {
  try {
    const db = await openPendingDB();
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete("convert");
  } catch {
    /* ignore */
  }
}

// ===== Offline request queue =====
// no signal? no problem. stash the request (blob included for converts)
// and fire it off in order once we're back online instead of just
// letting it fail.
async function addToOfflineQueue(item) {
  try {
    const db = await openPendingDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(QUEUE_STORE, "readwrite");
      tx.objectStore(QUEUE_STORE).add({ ...item, queuedAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("[seize] Could not queue offline request:", err);
  }
}

async function getOfflineQueue() {
  try {
    const db = await openPendingDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(QUEUE_STORE, "readonly");
      const req = tx.objectStore(QUEUE_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

async function removeFromOfflineQueue(id) {
  try {
    const db = await openPendingDB();
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    tx.objectStore(QUEUE_STORE).delete(id);
  } catch {
    /* ignore */
  }
}

function queueOfflineRequest(item) {
  addToOfflineQueue(item);
  updateOfflineBanner();
}

async function processOfflineQueue() {
  if (!navigator.onLine) return;
  const items = await getOfflineQueue();
  for (const item of items) {
    try {
      if (item.kind === "capture-resolve") {
        const res = await fetch(`${API_BASE}/download/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: item.url }),
        });
        if (!res.ok) throw new Error("resolve retry failed");
      } else if (item.kind === "capture-fetch") {
        const res = await fetch(`${API_BASE}/download/fetch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: item.url,
            mode: item.mode,
            quality: item.quality || "best",
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "fetch retry failed");
        await pollJob(
          `${API_BASE}/download/status/${data.jobId}`,
          { style: {} },
          { textContent: "" },
        );
        notifyJobDone(
          "Queued job finished",
          `${item.title || "Media"} is ready — open seize to save it.`,
        );
      } else if (item.kind === "convert") {
        const formData = new FormData();
        formData.append("file", item.blob, item.name);
        const endpoint =
          item.target === "v2a" ? "video-to-audio" : "audio-to-video";
        if (item.target === "v2a")
          formData.append("format", item.format || "mp3");
        const res = await fetch(`${API_BASE}/convert/${endpoint}`, {
          method: "POST",
          body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "convert retry failed");
        await pollJob(
          `${API_BASE}/convert/status/${data.jobId}`,
          { style: {} },
          { textContent: "" },
        );
        notifyJobDone(
          "Queued conversion finished",
          `${item.name || "Your file"} finished converting — open seize to save it.`,
        );
      }
      await removeFromOfflineQueue(item.id);
    } catch (err) {
      console.warn("[seize] Offline queue item failed, will retry later:", err);
      // leave it in the queue, next 'online' event will retry
      break;
    }
  }
  updateOfflineBanner();
}

async function updateOfflineBanner() {
  const banner = document.getElementById("offline-banner");
  if (!banner) return;
  if (!navigator.onLine) {
    banner.textContent =
      "⚠ You're offline — requests will be queued and sent automatically.";
    banner.classList.remove("hidden");
    return;
  }
  const pending = await getOfflineQueue();
  if (pending.length > 0) {
    banner.textContent = `⏳ Back online — sending ${pending.length} queued request${pending.length > 1 ? "s" : ""}…`;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

window.addEventListener("online", () => {
  updateOfflineBanner();
  processOfflineQueue();
});
window.addEventListener("offline", () => updateOfflineBanner());

async function saveMediaToDevice(fileUrl, suggestedName) {
  let blob;
  try {
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error("Could not fetch the file.");
    blob = await res.blob();
  } catch (err) {
    console.error("[seize] Failed to fetch file for saving:", err);
    window.location.href = fileUrl; // last-resort fallback
    return;
  }

  const file = new File([blob], suggestedName, {
    type: blob.type || "application/octet-stream",
  });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return; // user cancelled — not a failure
      console.warn(
        "[seize] Native share failed, falling back to direct download:",
        err,
      );
    }
  }

  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
}

function showSaveButton(container, fileUrl, suggestedName) {
  const existing = container.querySelector(".seize-save-btn");
  if (existing) existing.remove();

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-primary full-width seize-save-btn";
  btn.textContent = "📲 Save to device";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Saving…";
    await saveMediaToDevice(fileUrl, suggestedName);
    btn.textContent = "✅ Done — tap to save again";
    btn.disabled = false;
  });
  container.appendChild(btn);
}

// title/artist/album come back from an external recognition API — always
// set via textContent, never innerHTML, since this is untrusted input.
function showRecognizedTrack(track, container) {
  const target = container || convertProgress.parentElement;
  const existing = target.querySelector(".recognized-track");
  if (existing) existing.remove();

  const card = document.createElement("div");
  card.className = "recognized-track mono small";

  const label = document.createElement("span");
  label.textContent = "🎵 Identified: ";
  card.appendChild(label);

  const name = document.createElement("strong");
  const parts = [track.artist, track.title].filter(Boolean);
  name.textContent = parts.length ? parts.join(" – ") : "Unknown track";
  card.appendChild(name);

  if (track.album) {
    const album = document.createElement("span");
    album.className = "recognized-track-album";
    album.textContent = ` (${track.album})`;
    card.appendChild(album);
  }

  target.appendChild(card);
}

// ===== History (local to this device only) =====
const HISTORY_KEY = "seize_history";
const MAX_HISTORY_ITEMS = 50;

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistoryList(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn("[seize] Could not save history (storage may be full):", err);
  }
}

function addHistoryEntry(entry) {
  const list = loadHistory();
  list.unshift({
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
  });
  saveHistoryList(list.slice(0, MAX_HISTORY_ITEMS));
  renderHistory();
}

function removeHistoryEntry(id) {
  const list = loadHistory().filter((item) => item.id !== id);
  saveHistoryList(list);
  renderHistory();
}

function clearAllHistory() {
  saveHistoryList([]);
  renderHistory();
}

function formatHistoryDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `Today, ${time}` : `${d.toLocaleDateString()}, ${time}`;
}

function historySubtitle(item) {
  const when = formatHistoryDate(item.timestamp);
  if (item.type === "resolve") {
    return `${(item.platform || "link").toUpperCase()} · Resolved · ${when}`;
  }
  if (item.type === "download") {
    return `${item.mode?.toUpperCase() || "FILE"} downloaded · ${when}`;
  }
  if (item.type === "convert") {
    return `${item.direction} · .${item.outFormat} · ${when}`;
  }
  return when;
}

function renderHistory() {
  const list = loadHistory();
  const container = document.getElementById("history-list");
  const emptyMsg = document.getElementById("history-empty");
  if (!container || !emptyMsg) return;

  container.innerHTML = "";

  if (list.length === 0) {
    emptyMsg.classList.remove("hidden");
    return;
  }
  emptyMsg.classList.add("hidden");

  list.forEach((item) => {
    const row = document.createElement("div");
    row.className = "history-item";

    const thumb = document.createElement("img");
    thumb.className = "history-thumb";
    thumb.alt = "";
    thumb.src = item.thumbnail || "icons/icon-192.png";
    thumb.onerror = () => {
      thumb.src = "icons/icon-192.png";
    };

    const meta = document.createElement("div");
    meta.className = "history-meta";
    const title = document.createElement("p");
    title.className = "history-title";
    title.textContent = item.title || "Untitled";
    const sub = document.createElement("p");
    sub.className = "mono small history-sub";
    sub.textContent = historySubtitle(item);
    meta.appendChild(title);
    meta.appendChild(sub);

    const actions = document.createElement("div");
    actions.className = "history-actions";

    if (item.url) {
      const useBtn = document.createElement("button");
      useBtn.type = "button";
      useBtn.className = "history-action-btn";
      useBtn.textContent = "Resolve again";
      useBtn.addEventListener("click", () => {
        document.querySelector('[data-mode="capture"]')?.click();
        urlInput.value = item.url;
        captureForm.dispatchEvent(new Event("submit", { cancelable: true }));
      });
      actions.appendChild(useBtn);
    }

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "history-remove-btn";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove from history";
    removeBtn.addEventListener("click", () => removeHistoryEntry(item.id));
    actions.appendChild(removeBtn);

    row.appendChild(thumb);
    row.appendChild(meta);
    row.appendChild(actions);
    container.appendChild(row);
  });
}

document.getElementById("clear-history-btn")?.addEventListener("click", () => {
  clearAllHistory();
});

renderHistory();

// ===== Thumbnail Helper =====
function loadThumbnail(url, imgElement) {
  if (!url) {
    imgElement.src = "";
    imgElement.style.display = "none";
    return;
  }

  let imageUrl = url;
  if (imageUrl.startsWith("http://")) {
    imageUrl = imageUrl.replace("http://", "https://");
  }

  if (
    imageUrl.includes("tiktokcdn.com") ||
    imageUrl.includes("fbcdn.net") ||
    imageUrl.includes("cdninstagram.com") ||
    imageUrl.includes("twimg.com")
  ) {
    imageUrl =
      imageUrl + (imageUrl.includes("?") ? "&" : "?") + "_t=" + Date.now();
  }

  imgElement.src = imageUrl;
  imgElement.style.display = "block";

  imgElement.onerror = function () {
    console.warn("Failed to load thumbnail:", imageUrl);
    if (imageUrl.includes("_t=")) {
      const cleanUrl = imageUrl.split("_t=")[0];
      imgElement.src = cleanUrl;
      imgElement.onerror = function () {
        this.style.display = "none";
      };
    } else {
      this.style.display = "none";
    }
  };
}

// ===== Oscilloscope =====
const scopeTrace = document.getElementById("scope-trace");
const scopeFreq = document.getElementById("scope-freq");
const scopeMode = document.getElementById("scope-mode");
const POINTS = 60;
let scopeAmplitude = 4;
let scopeSpeed = 0.02;
let t = 0;

function drawScope() {
  t += scopeSpeed;
  let pts = [];
  for (let i = 0; i < POINTS; i++) {
    const x = (i / (POINTS - 1)) * 600;
    const noise = Math.sin(i * 0.6 + t * 3) * 0.3;
    const y =
      80 +
      Math.sin(i * 0.35 + t) * scopeAmplitude +
      noise * scopeAmplitude * 0.4;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  scopeTrace.setAttribute("points", pts.join(" "));
  scopeFreq.textContent = `${(scopeAmplitude * 11.3).toFixed(1)} Hz`;
  requestAnimationFrame(drawScope);
}
requestAnimationFrame(drawScope);

function setScopeState(state) {
  if (state === "active") {
    scopeAmplitude = 34;
    scopeSpeed = 0.09;
    scopeMode.textContent = "CAPTURING";
  } else if (state === "processing") {
    scopeAmplitude = 24;
    scopeSpeed = 0.14;
    scopeMode.textContent = "PROCESSING";
  } else if (state === "done") {
    scopeAmplitude = 10;
    scopeSpeed = 0.03;
    scopeMode.textContent = "CAPTURED";
  } else {
    scopeAmplitude = 4;
    scopeSpeed = 0.02;
    scopeMode.textContent = "STANDBY";
  }
}

// ===== Mode Switch =====
const modeButtons = document.querySelectorAll(".mode-btn");
const panels = {
  capture: document.getElementById("panel-capture"),
  convert: document.getElementById("panel-convert"),
  history: document.getElementById("panel-history"),
};

modeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    modeButtons.forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    const mode = btn.dataset.mode;
    Object.entries(panels).forEach(([key, panel]) =>
      panel.setAttribute("data-active", key === mode ? "true" : "false"),
    );
    sessionStorage.setItem("seize_active_tab", mode);
  });
});

const savedTab = sessionStorage.getItem("seize_active_tab");
if (savedTab && panels[savedTab]) {
  document.querySelector(`[data-mode="${savedTab}"]`)?.click();
}

// ===== Capture Panel =====
const urlInput = document.getElementById("url-input");
const pasteBtn = document.getElementById("paste-btn");
const captureForm = document.getElementById("capture-form");
const resolveBtn = document.getElementById("resolve-btn");
const captureResult = document.getElementById("capture-result");
const resultThumb = document.getElementById("result-thumb");
const resultTitle = document.getElementById("result-title");
const resultUploader = document.getElementById("result-uploader");
const fetchVideoBtn = document.getElementById("fetch-video-btn");
const fetchAudioBtn = document.getElementById("fetch-audio-btn");
const fetchImageBtn = document.getElementById("fetch-image-btn");
const captureProgress = document.getElementById("capture-progress");
const captureProgressFill = document.getElementById("capture-progress-fill");
const captureProgressLabel = document.getElementById("capture-progress-label");
const captureError = document.getElementById("capture-error");
const chips = document.querySelectorAll(".chip");

let currentUrl = "";
let lastResolvedItem = null;

function updateResultButtons(data) {
  const qualityRow = document.getElementById("quality-row");
  const qualitySelect = document.getElementById("quality-select");

  if (data.hasVideo) {
    fetchVideoBtn.style.display = "inline-flex";
    fetchVideoBtn.textContent = "🎬 Download video";

    const heights = [
      ...new Set(
        (data.media?.videos || [])
          .map((v) => v.height)
          .filter((h) => Number.isFinite(h) && h > 0),
      ),
    ].sort((a, b) => b - a);

    qualitySelect.innerHTML = `<option value="best">Best available</option>`;
    heights.forEach((h) => {
      const opt = document.createElement("option");
      opt.value = String(h);
      opt.textContent = `${h}p`;
      qualitySelect.appendChild(opt);
    });
    qualityRow.classList.remove("hidden");
  } else {
    fetchVideoBtn.style.display = "none";
    qualityRow.classList.add("hidden");
  }

  if (data.hasImage || data.contentType === "image") {
    fetchImageBtn.style.display = "inline-flex";
    fetchImageBtn.textContent = "🖼️ Download image";
  } else {
    fetchImageBtn.style.display = "none";
  }

  if (data.media?.audio?.length > 0 || data.hasVideo) {
    fetchAudioBtn.style.display = "inline-flex";
    fetchAudioBtn.textContent = data.hasVideo
      ? "🎵 Extract audio"
      : "🎵 Download audio";
  } else {
    fetchAudioBtn.style.display = "none";
  }
}

urlInput.addEventListener("input", () => {
  const val = urlInput.value.toLowerCase();
  chips.forEach((chip) => {
    const p = chip.dataset.platform;
    const matches =
      (p === "tiktok" && val.includes("tiktok")) ||
      (p === "instagram" && val.includes("instagram")) ||
      (p === "twitter" && (val.includes("twitter") || val.includes("x.com"))) ||
      (p === "pinterest" &&
        (val.includes("pinterest") || val.includes("pin.it"))) ||
      (p === "snapchat" && val.includes("snapchat")) ||
      (p === "facebook" &&
        (val.includes("facebook") || val.includes("fb.watch")));
    chip.classList.toggle("match", matches);
  });
});

function showCaptureError(msg) {
  captureError.textContent = msg;
  captureError.classList.remove("hidden");
}
function clearCaptureError() {
  captureError.classList.add("hidden");
  captureError.textContent = "";
}

captureForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearCaptureError();
  captureResult.classList.add("hidden");
  const url = urlInput.value.trim();
  if (!url) return;
  currentUrl = url;

  if (!navigator.onLine) {
    queueOfflineRequest({ kind: "capture-resolve", url });
    showCaptureError(
      "You're offline — this will resolve automatically once you're back online.",
    );
    return;
  }

  resolveBtn.disabled = true;
  resolveBtn.textContent = "Resolving…";
  setScopeState("active");

  try {
    const res = await fetch(`${API_BASE}/download/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not resolve.");

    if (data.thumbnail) {
      loadThumbnail(data.thumbnail, resultThumb);
    } else {
      resultThumb.style.display = "none";
    }

    resultTitle.textContent = data.title || "Untitled";
    let uploaderText = data.uploader || "unknown uploader";
    if (data.platform) {
      uploaderText = `${data.platform.toUpperCase()} · ${uploaderText}`;
    }
    resultUploader.textContent = uploaderText;

    updateResultButtons(data);
    captureResult.classList.remove("hidden");
    setScopeState("done");

    lastResolvedItem = {
      sourceUrl: url,
      platform: data.platform || null,
      title: data.title || "Untitled",
      thumbnail: data.thumbnail || null,
      contentType: data.contentType || null,
    };

    addHistoryEntry({
      type: "resolve",
      url,
      title: data.title || "Untitled",
      thumbnail: data.thumbnail || null,
      platform: data.platform || null,
      contentType: data.contentType || null,
    });
  } catch (err) {
    showCaptureError(err.message);
    setScopeState("idle");
  } finally {
    resolveBtn.disabled = false;
    resolveBtn.textContent = "Resolve";
  }
});

async function runCaptureFetch(mode) {
  clearCaptureError();
  captureProgress.classList.remove("hidden");

  let labelText = "FETCHING…";
  if (mode === "audio") labelText = "EXTRACTING AUDIO…";
  else if (mode === "image") labelText = "DOWNLOADING IMAGE…";
  else if (mode === "video") labelText = "FETCHING VIDEO…";

  captureProgressLabel.textContent = labelText;
  captureProgressFill.style.width = "10%";
  setScopeState("processing");

  const quality =
    mode === "video"
      ? document.getElementById("quality-select")?.value || "best"
      : "best";

  if (!navigator.onLine) {
    queueOfflineRequest({
      kind: "capture-fetch",
      url: currentUrl,
      mode,
      quality,
      title: resultTitle.textContent || "Untitled",
      thumbnail: resultThumb.src || null,
    });
    captureProgress.classList.add("hidden");
    showCaptureError(
      "You're offline — this will run automatically once you're back online.",
    );
    setScopeState("idle");
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/download/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: currentUrl, mode, quality }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Fetch failed.");

    await pollJob(
      `${API_BASE}/download/status/${data.jobId}`,
      captureProgressFill,
      captureProgressLabel,
    );
    captureProgress.classList.add("hidden");
    setScopeState("done");

    const fileExt = mode === "audio" ? "mp3" : mode === "image" ? "jpg" : "mp4";
    const fileUrl = `${API_BASE}/download/file/${data.jobId}`;
    showSaveButton(
      captureResult.parentElement,
      fileUrl,
      `seize-${mode}-${Date.now()}.${fileExt}`,
    );

    addHistoryEntry({
      type: "download",
      mode,
      url: currentUrl,
      title: resultTitle.textContent || "Untitled",
      thumbnail: resultThumb.src || null,
    });
    notifyJobDone(
      "Your file is ready",
      `${resultTitle.textContent || "Media"} finished — tap to save it.`,
    );
  } catch (err) {
    showCaptureError(err.message);
    captureProgress.classList.add("hidden");
    setScopeState("idle");
  }
}

fetchVideoBtn.addEventListener("click", () => runCaptureFetch("video"));
fetchAudioBtn.addEventListener("click", () => runCaptureFetch("audio"));
fetchImageBtn.addEventListener("click", () => runCaptureFetch("image"));

function pollJob(statusUrl, fillEl, labelEl) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = 120;
    const interval = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(statusUrl);
        const data = await res.json();
        if (data.status === "done") {
          clearInterval(interval);
          fillEl.style.width = "100%";
          resolve(data);
        } else if (data.status === "error") {
          clearInterval(interval);
          reject(new Error(data.error || "Processing failed."));
        } else {
          fillEl.style.width = `${data.progress || 10}%`;
        }
        if (attempts >= maxAttempts) {
          clearInterval(interval);
          reject(new Error("Job timed out. Please try again."));
        }
      } catch (err) {
        clearInterval(interval);
        reject(err);
      }
    }, 2000);
  });
}

// ===== Shareable collections =====
// A small client-side "basket" of resolved items, bundled into a public
// gallery link on demand. Items store the original source URL (not a
// platform CDN link) — see db.js for why that matters: CDN media URLs
// expire, source page URLs don't.
const COLLECTION_BASKET_KEY = "seize_collection_basket";
const collectionBasketEl = document.getElementById("collection-basket");
const collectionBasketCountEl = document.getElementById(
  "collection-basket-count",
);
const collectionClearBtn = document.getElementById("collection-clear-btn");
const collectionCreateBtn = document.getElementById("collection-create-btn");
const addToCollectionBtn = document.getElementById("add-to-collection-btn");

function loadCollectionBasket() {
  try {
    return JSON.parse(sessionStorage.getItem(COLLECTION_BASKET_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveCollectionBasket(items) {
  try {
    sessionStorage.setItem(COLLECTION_BASKET_KEY, JSON.stringify(items));
  } catch {
    /* ignore — sessionStorage can throw in some private-browsing modes */
  }
}

function renderCollectionBasket() {
  const items = loadCollectionBasket();
  collectionBasketCountEl.textContent = String(items.length);
  collectionBasketEl.classList.toggle("hidden", items.length === 0);
}

addToCollectionBtn?.addEventListener("click", () => {
  if (!lastResolvedItem) return;
  const items = loadCollectionBasket();

  const alreadyAdded = items.some(
    (i) => i.sourceUrl === lastResolvedItem.sourceUrl,
  );
  if (alreadyAdded) {
    addToCollectionBtn.textContent = "✅ Already added";
    setTimeout(() => {
      addToCollectionBtn.textContent = "➕ Add to collection";
    }, 1500);
    return;
  }

  items.push(lastResolvedItem);
  saveCollectionBasket(items);
  renderCollectionBasket();

  addToCollectionBtn.textContent = "✅ Added";
  setTimeout(() => {
    addToCollectionBtn.textContent = "➕ Add to collection";
  }, 1500);
});

collectionClearBtn?.addEventListener("click", () => {
  saveCollectionBasket([]);
  renderCollectionBasket();
});

collectionCreateBtn?.addEventListener("click", async () => {
  const items = loadCollectionBasket();
  if (items.length === 0) return;

  collectionCreateBtn.disabled = true;
  collectionCreateBtn.textContent = "Creating…";

  try {
    const res = await fetch(`${API_BASE}/collections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Couldn't create collection.");

    const shareUrl = `${window.location.origin}/?c=${data.id}`;

    // remember collections this device created, so "delete" is possible
    // later without needing an account — the ownerToken is the only
    // credential, keep it local only, never send it anywhere but the
    // delete endpoint.
    const mine = JSON.parse(
      localStorage.getItem("seize_my_collections") || "[]",
    );
    mine.push({
      id: data.id,
      ownerToken: data.ownerToken,
      createdAt: Date.now(),
      itemCount: items.length,
    });
    localStorage.setItem("seize_my_collections", JSON.stringify(mine));

    saveCollectionBasket([]);
    renderCollectionBasket();

    showShareLinkResult(shareUrl);
  } catch (err) {
    showCaptureError(err.message);
  } finally {
    collectionCreateBtn.disabled = false;
    collectionCreateBtn.textContent = "🔗 Create shareable link";
  }
});

function showShareLinkResult(shareUrl) {
  const existing = document.querySelector(".collection-share-result");
  if (existing) existing.remove();

  const card = document.createElement("div");
  card.className = "collection-share-result mono small";

  const label = document.createElement("p");
  label.textContent = "🎉 Your collection is ready:";
  card.appendChild(label);

  const linkRow = document.createElement("div");
  linkRow.className = "collection-share-link-row";

  const link = document.createElement("input");
  link.type = "text";
  link.readOnly = true;
  link.value = shareUrl;
  link.className = "text-input";
  linkRow.appendChild(link);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "btn-secondary";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      copyBtn.textContent = "✅ Copied";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
    } catch {
      link.select();
    }
  });
  linkRow.appendChild(copyBtn);

  card.appendChild(linkRow);
  collectionBasketEl.insertAdjacentElement("afterend", card);
}

renderCollectionBasket();

// ---- Public gallery view (?c=<id>) ----
const panelCollectionView = document.getElementById("panel-collection-view");
const collectionGrid = document.getElementById("collection-grid");
const collectionViewName = document.getElementById("collection-view-name");
const collectionViewMeta = document.getElementById("collection-view-meta");
const collectionViewError = document.getElementById("collection-view-error");

function collectionThumb(item) {
  const img = document.createElement("img");
  img.className = "collection-item-thumb";
  img.alt = "";
  img.loading = "lazy";
  if (item.thumbnail) {
    loadThumbnail(item.thumbnail, img);
  }
  return img;
}

function renderCollectionItem(item) {
  const card = document.createElement("div");
  card.className = "collection-item";

  card.appendChild(collectionThumb(item));

  const meta = document.createElement("div");
  meta.className = "collection-item-meta";

  const title = document.createElement("p");
  title.className = "collection-item-title";
  title.textContent = item.title || "Untitled"; // textContent only — untrusted external data
  meta.appendChild(title);

  const platform = document.createElement("p");
  platform.className = "mono small collection-item-platform";
  platform.textContent = item.platform || "unknown";
  meta.appendChild(platform);

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "btn-secondary";
  openBtn.textContent = "Open in seize →";
  openBtn.addEventListener("click", () => {
    // re-resolve fresh through the normal capture flow, rather than
    // trusting a possibly stale stored media link
    window.location.href = `/?resolve=${encodeURIComponent(item.sourceUrl)}`;
  });
  meta.appendChild(openBtn);

  card.appendChild(meta);
  return card;
}

async function loadCollectionView(id) {
  document.body.classList.add("collection-view-mode");
  document.querySelectorAll(".mode-switch, .hero").forEach((el) => {
    el.style.display = "none";
  });
  document
    .querySelectorAll(".panel")
    .forEach((el) => el.setAttribute("data-active", "false"));
  panelCollectionView.setAttribute("data-active", "true");

  try {
    const res = await fetch(`${API_BASE}/collections/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Collection not found.");

    collectionViewName.textContent = data.name || "Shared collection";
    collectionViewMeta.textContent = `${data.items.length} item(s) · shared via seize`;

    collectionGrid.innerHTML = "";
    data.items.forEach((item) => {
      collectionGrid.appendChild(renderCollectionItem(item));
    });
  } catch (err) {
    collectionViewError.textContent = err.message;
    collectionViewError.classList.remove("hidden");
  }
}

(function checkForCollectionLink() {
  const params = new URLSearchParams(window.location.search);
  const collectionId = params.get("c");
  if (collectionId) {
    loadCollectionView(collectionId);
    return;
  }

  // came from a collection item's "Open in seize" button
  const resolveUrl = params.get("resolve");
  if (resolveUrl) {
    window.addEventListener("load", () => {
      urlInput.value = resolveUrl;
      urlInput.dispatchEvent(new Event("input"));
      setTimeout(() => resolveBtn.click(), 300);
    });
  }
})();

// ===== Batch / Queue mode =====
// paste a bunch of links at once (one per line) and they queue up +
// download one by one instead of forcing one-at-a-time
const LINK_TOKEN_RE = /https?:\/\/[^\s]+/g;
const queueBlock = document.getElementById("queue-block");
const queueList = document.getElementById("queue-list");
const queueCount = document.getElementById("queue-count");
const queueAddBtn = document.getElementById("queue-add-btn");
const queueStartBtn = document.getElementById("queue-start-btn");
const queueClearBtn = document.getElementById("queue-clear-btn");

let batchQueue = [];
let queueRunning = false;

function renderQueue() {
  queueList.innerHTML = "";
  queueCount.textContent = String(batchQueue.length);
  queueBlock.classList.toggle("hidden", batchQueue.length === 0);

  batchQueue.forEach((item) => {
    const row = document.createElement("div");
    row.className = "queue-item";

    const urlSpan = document.createElement("span");
    urlSpan.className = "queue-item-url";
    urlSpan.textContent = item.url;

    const status = document.createElement("span");
    status.className = "queue-item-status";
    status.dataset.state = item.status;
    status.textContent =
      item.status === "pending"
        ? "WAITING"
        : item.status === "processing"
          ? "WORKING…"
          : item.status === "done"
            ? "✓ DONE"
            : "✕ FAILED";

    row.appendChild(urlSpan);
    row.appendChild(status);

    if (item.status === "done" && item.fileUrl) {
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "queue-item-remove";
      saveBtn.title = "Save to device";
      saveBtn.textContent = "📲";
      saveBtn.addEventListener("click", () =>
        saveMediaToDevice(item.fileUrl, `seize-batch-${Date.now()}.mp4`),
      );
      row.appendChild(saveBtn);
    }

    if (item.status !== "processing") {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "queue-item-remove";
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", () => {
        batchQueue = batchQueue.filter((q) => q.id !== item.id);
        renderQueue();
      });
      row.appendChild(removeBtn);
    }

    queueList.appendChild(row);
  });
}

function addLinksToQueue(links) {
  links.forEach((url) => {
    if (batchQueue.some((q) => q.url === url)) return; // no dupes
    batchQueue.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      url,
      status: "pending",
    });
  });
  renderQueue();
}

queueAddBtn.addEventListener("click", () => {
  const url = urlInput.value.trim();
  if (!url) return;
  addLinksToQueue([url]);
  urlInput.value = "";
  urlInput.dispatchEvent(new Event("input"));
});

urlInput.addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text") || "";
  const links = text.match(LINK_TOKEN_RE) || [];
  if (links.length > 1) {
    e.preventDefault();
    addLinksToQueue(links);
  }
});

queueClearBtn.addEventListener("click", () => {
  if (queueRunning) return;
  batchQueue = [];
  renderQueue();
});

async function processQueueItem(item) {
  item.status = "processing";
  renderQueue();
  try {
    const resolveRes = await fetch(`${API_BASE}/download/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: item.url }),
    });
    const resolveData = await resolveRes.json();
    if (!resolveRes.ok)
      throw new Error(resolveData.error || "Could not resolve.");

    const mode = resolveData.hasVideo
      ? "video"
      : resolveData.hasImage
        ? "image"
        : "audio";

    const fetchRes = await fetch(`${API_BASE}/download/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: item.url, mode, quality: "best" }),
    });
    const fetchData = await fetchRes.json();
    if (!fetchRes.ok) throw new Error(fetchData.error || "Fetch failed.");

    await pollJob(
      `${API_BASE}/download/status/${fetchData.jobId}`,
      { style: {} },
      { textContent: "" },
    );

    item.status = "done";
    item.fileUrl = `${API_BASE}/download/file/${fetchData.jobId}`;

    addHistoryEntry({
      type: "download",
      mode,
      url: item.url,
      title: resolveData.title || "Untitled",
      thumbnail: resolveData.thumbnail || null,
    });
  } catch (err) {
    item.status = "error";
    item.error = err.message;
  }
  renderQueue();
}

queueStartBtn.addEventListener("click", async () => {
  if (queueRunning) return;
  if (!navigator.onLine) {
    showCaptureError("You're offline — reconnect to start the queue.");
    return;
  }
  queueRunning = true;
  queueStartBtn.disabled = true;
  queueStartBtn.textContent = "Working…";

  for (const item of batchQueue) {
    if (item.status === "pending") await processQueueItem(item);
  }

  queueRunning = false;
  queueStartBtn.disabled = false;
  queueStartBtn.textContent = "▶ Start queue";
  notifyJobDone(
    "Batch queue finished",
    `${batchQueue.filter((q) => q.status === "done").length} item(s) ready to save.`,
  );
});

// ===== Convert Panel =====
const convertTabs = document.querySelectorAll(".convert-tab");
const dropzone = document.getElementById("dropzone");
const dropzoneEmpty = document.getElementById("dropzone-empty");
const dropzonePreview = document.getElementById("dropzone-preview");
const dropzonePreviewIcon = document.getElementById("dropzone-preview-icon");
const dropzonePreviewName = document.getElementById("dropzone-preview-name");
const dropzonePreviewSize = document.getElementById("dropzone-preview-size");
const dropzonePreviewRemove = document.getElementById("dropzone-preview-remove");
const dropzoneLabel = document.getElementById("dropzone-label");
const dropzoneHint = document.getElementById("dropzone-hint");
const fileInput = document.getElementById("file-input");
const formatRow = document.getElementById("format-row");
const convertForm = document.getElementById("convert-form");
const convertBtn = document.getElementById("convert-btn");
const convertProgress = document.getElementById("convert-progress");
const convertProgressFill = document.getElementById("convert-progress-fill");
const convertProgressLabel = document.getElementById("convert-progress-label");
const convertError = document.getElementById("convert-error");
const convertRestoreBanner = document.getElementById("convert-restore-banner");

let convertTarget = "v2a";
let selectedFile = null;

// remembers whatever format you last converted to, defaults to it next
// time so you're not re-picking mp3 every single run
const LAST_FORMAT_KEY = "seize_last_format";
function lastUsedFormat(setValue, isSave) {
  if (isSave) {
    if (setValue) localStorage.setItem(LAST_FORMAT_KEY, setValue);
    return;
  }
  return localStorage.getItem(LAST_FORMAT_KEY);
}
{
  const remembered = lastUsedFormat();
  if (remembered) {
    const initialSelect = document.getElementById("format-select");
    if (initialSelect) initialSelect.value = remembered;
  }
}

convertTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    convertTabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    convertTarget = tab.dataset.target;
    clearSelectedFile();
    if (convertTarget === "v2a") {
      dropzoneLabel.textContent = "Drop a video file, or click to browse";
      dropzoneHint.textContent = "MP4 · MOV · MKV · WEBM — up to 500MB";
      formatRow.style.display = "flex";
      document.getElementById("format-select").innerHTML =
        `<option value="mp3">MP3</option><option value="wav">WAV</option><option value="aac">AAC</option><option value="flac">FLAC</option><option value="ogg">OGG</option>`;
      const remembered = lastUsedFormat();
      if (remembered)
        document.getElementById("format-select").value = remembered;
    } else {
      dropzoneLabel.textContent = "Drop an audio file, or click to browse";
      dropzoneHint.textContent =
        "MP3 · WAV · AAC · FLAC · OGG · M4A — up to 500MB";
      formatRow.style.display = "none";
    }
  });
});

fileInput.addEventListener("click", (e) => e.stopPropagation());

// dropzone is a plain <div role="button">, not a <label for="file-input">.
// There's no native forwarding behavior to fight here — this is the ONLY
// thing that opens the picker, so there's no risk of a double-dispatch
// (label click -> forwarded input click -> our handler -> fileInput.click()
// -> input click bubbles back up) which is a classic source of mobile
// browsers opening the picker twice or getting confused about the source
// of the "click".
dropzone.addEventListener("click", function (e) {
  e.preventDefault();
  e.stopPropagation();
  fileInput.click();
});

// keyboard support since this is a div, not a real button/label
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dragover");
});

function fileTypeIcon(file) {
  if (file.type.startsWith("audio/")) return "🎵";
  if (file.type.startsWith("video/")) return "🎬";
  return "📄";
}

function applySelectedFile(file, opts = {}) {
  selectedFile = file;
  convertBtn.disabled = false;
  dropzone.classList.add("has-file");

  // Show the real preview inside the container immediately — this is the
  // visible proof the state actually updated, which is exactly the thing
  // that was failing to render before a mobile reload wiped it out.
  dropzoneEmpty.classList.add("hidden");
  dropzonePreview.classList.remove("hidden");
  dropzonePreviewIcon.textContent = fileTypeIcon(file);
  dropzonePreviewName.textContent = file.name;
  dropzonePreviewSize.textContent = `${(file.size / (1024 * 1024)).toFixed(2)} MB`;

  if (!opts.skipPersist) {
    // Synchronous flag FIRST — sessionStorage writes are synchronous, so
    // this lands even if the tab gets frozen/killed a moment later, before
    // the async IndexedDB blob write below has a chance to finish. On
    // reload we can tell "a file was picked but we lost the bytes" apart
    // from "nothing was ever picked" and message the user accordingly
    // instead of silently doing nothing.
    try {
      sessionStorage.setItem(
        "seize_pending_flag",
        JSON.stringify({
          name: file.name,
          size: file.size,
          target: convertTarget,
          ts: Date.now(),
        }),
      );
    } catch {
      /* ignore, sessionStorage can throw in some private-browsing modes */
    }
    savePendingFile(file, { target: convertTarget }).then(() => {
      // blob safely in IndexedDB — the flag has done its job
      try {
        sessionStorage.removeItem("seize_pending_flag");
      } catch {
        /* ignore */
      }
    });
  }
}

function clearSelectedFile() {
  selectedFile = null;
  fileInput.value = "";
  convertBtn.disabled = true;
  dropzone.classList.remove("has-file");
  dropzoneEmpty.classList.remove("hidden");
  dropzonePreview.classList.add("hidden");
  clearPendingFile();
  try {
    sessionStorage.removeItem("seize_pending_flag");
  } catch {
    /* ignore */
  }
}

dropzonePreviewRemove.addEventListener("click", (e) => {
  e.stopPropagation(); // don't let this bubble to the dropzone and reopen the picker
  clearSelectedFile();
});

dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length) {
    fileInput.files = e.dataTransfer.files;
    applySelectedFile(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener("change", () => {
  if (fileInput.files.length) {
    applySelectedFile(fileInput.files[0]);
  }
});

function showRestoreBanner(text) {
  convertRestoreBanner.textContent = text;
  convertRestoreBanner.classList.remove("hidden");
  setTimeout(() => convertRestoreBanner.classList.add("hidden"), 8000);
}

(async function restorePendingFile() {
  const pending = await loadPendingFile();

  if (pending && pending.blob) {
    // Happy path: the file survived (either no reload happened, or the
    // IndexedDB write won the race against the OS killing the tab).
    const file = new File([pending.blob], pending.name, { type: pending.type });

    if (pending.target && pending.target !== convertTarget) {
      document.querySelector(`[data-target="${pending.target}"]`)?.click();
    }

    document.querySelector('[data-mode="convert"]')?.click();
    applySelectedFile(file, { skipPersist: true });
    showRestoreBanner(
      "↺ Restored the file you picked before the app reloaded — hit Convert to continue.",
    );
    try {
      sessionStorage.removeItem("seize_pending_flag");
    } catch {
      /* ignore */
    }
    return;
  }

  // No file recovered. Check whether one was actually mid-pick when this
  // page loaded — if the flag is here but no blob made it into IndexedDB,
  // the tab was killed by the OS before the async write finished (this is
  // the real, unavoidable-at-the-JS-level mobile memory-reclaim case).
  // Tell the person plainly what happened instead of leaving them staring
  // at an empty dropzone with no explanation.
  let flag = null;
  try {
    flag = JSON.parse(sessionStorage.getItem("seize_pending_flag") || "null");
  } catch {
    flag = null;
  }

  if (flag) {
    document.querySelector('[data-mode="convert"]')?.click();
    if (flag.target && flag.target !== convertTarget) {
      document.querySelector(`[data-target="${flag.target}"]`)?.click();
    }
    showRestoreBanner(
      `⚠ Your browser closed the tab while "${flag.name}" was loading — this can happen on low-memory phones. Please pick it again.`,
    );
    try {
      sessionStorage.removeItem("seize_pending_flag");
    } catch {
      /* ignore */
    }
  }
})();

// Best-effort early warning: if the tab is about to be frozen/hidden right
// after a file was chosen but before the IndexedDB write resolves, at least
// we tried to persist synchronously via sessionStorage already (see
// applySelectedFile). There's nothing more JS can do once the OS actually
// kills the process — this is a hard platform limitation, not a bug we can
// "fix" away entirely, only work around.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && selectedFile) {
    console.log("[seize] Tab hidden while a file is selected — persistence flag already written.");
  }
});

function showConvertError(msg) {
  convertError.textContent = msg;
  convertError.classList.remove("hidden");
}
function clearConvertError() {
  convertError.classList.add("hidden");
  convertError.textContent = "";
}

convertBtn.addEventListener("click", async (e) => {
  clearConvertError();
  if (!selectedFile) return;

  if (!navigator.onLine) {
    queueOfflineRequest({
      kind: "convert",
      blob: selectedFile,
      name: selectedFile.name,
      target: convertTarget,
      format: document.getElementById("format-select")?.value,
    });
    showConvertError(
      "You're offline — this will convert automatically once you're back online.",
    );
    return;
  }

  convertBtn.disabled = true;
  convertProgress.classList.remove("hidden");
  convertProgressLabel.textContent = "UPLOADING…";
  convertProgressFill.style.width = "5%";
  setScopeState("processing");

  const formData = new FormData();
  formData.append("file", selectedFile);

  const endpoint =
    convertTarget === "v2a" ? "video-to-audio" : "audio-to-video";
  if (convertTarget === "v2a") {
    formData.append("format", document.getElementById("format-select").value);
  }

  function uploadWithProgress(url, body) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);

      xhr.upload.onprogress = (evt) => {
        if (!evt.lengthComputable) return;
        const pct = Math.round((evt.loaded / evt.total) * 100);
        convertProgressFill.style.width = `${pct}%`;
        convertProgressLabel.textContent =
          pct < 100 ? `UPLOADING… ${pct}%` : "PROCESSING…";
      };

      xhr.onload = () => {
        let data;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          data = {};
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          reject(new Error(data.error || `Upload failed (${xhr.status}).`));
        }
      };

      xhr.onerror = () => reject(new Error("Network error during upload."));
      xhr.send(body);
    });
  }

  try {
    const data = await uploadWithProgress(
      `${API_BASE}/convert/${endpoint}`,
      formData,
    );
    const statusData = await pollJob(
      `${API_BASE}/convert/status/${data.jobId}`,
      convertProgressFill,
      convertProgressLabel,
    );
    convertProgress.classList.add("hidden");
    setScopeState("done");

    const outExt =
      convertTarget === "v2a"
        ? document.getElementById("format-select").value
        : "mp4";
    const fileUrl = `${API_BASE}/convert/download/${data.jobId}`;

    if (statusData?.recognizedTrack?.title || statusData?.recognizedTrack?.artist) {
      showRecognizedTrack(statusData.recognizedTrack);
    }

    showSaveButton(
      convertProgress.parentElement,
      fileUrl,
      `seize-converted-${Date.now()}.${outExt}`,
    );

    addHistoryEntry({
      type: "convert",
      direction: convertTarget === "v2a" ? "Video → Audio" : "Audio → Video",
      title: selectedFile?.name || "Converted file",
      outFormat: outExt,
    });
    clearPendingFile();
    lastUsedFormat(
      convertTarget === "v2a"
        ? document.getElementById("format-select").value
        : null,
      true,
    );
    notifyJobDone(
      "Your file is ready",
      `${selectedFile?.name || "Your file"} finished converting — tap to save it.`,
    );
  } catch (err) {
    showConvertError(err.message);
    convertProgress.classList.add("hidden");
    setScopeState("idle");
  } finally {
    convertBtn.disabled = false;
  }
});

// ===== Share Handler =====
const sharedUrl = sessionStorage.getItem("seize_shared_url");
const sharedMode = sessionStorage.getItem("seize_shared_mode");

if (sharedUrl) {
  window.addEventListener("load", () => {
    if (urlInput) {
      urlInput.value = sharedUrl;
      urlInput.dispatchEvent(new Event("input"));
    }
    setTimeout(() => {
      if (resolveBtn) resolveBtn.click();
    }, 800);
    if (sharedMode === "convert-video") {
      document.querySelector('[data-mode="convert"]')?.click();
      setTimeout(() => {
        document.querySelector('[data-target="v2a"]')?.click();
      }, 300);
    } else if (sharedMode === "convert-audio") {
      document.querySelector('[data-mode="convert"]')?.click();
      setTimeout(() => {
        document.querySelector('[data-target="a2v"]')?.click();
      }, 300);
    }
    sessionStorage.removeItem("seize_shared_url");
    sessionStorage.removeItem("seize_shared_title");
    sessionStorage.removeItem("seize_shared_mode");
  });
}

// ===== File Share Handler =====
async function handleSharedFile(file) {
  const isVideo = file.type.startsWith("video/");
  const isAudio = file.type.startsWith("audio/");

  if (isVideo) {
    document.querySelector('[data-mode="convert"]')?.click();
    setTimeout(() => {
      document.querySelector('[data-target="v2a"]')?.click();
    }, 300);
    if (fileInput) {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;
      fileInput.dispatchEvent(new Event("change"));
    }
    if (convertBtn) {
      convertBtn.disabled = false;
      setTimeout(() => convertBtn.click(), 500);
    }
  } else if (isAudio) {
    document.querySelector('[data-mode="convert"]')?.click();
    setTimeout(() => {
      document.querySelector('[data-target="a2v"]')?.click();
    }, 300);
    if (fileInput) {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;
      fileInput.dispatchEvent(new Event("change"));
    }
    if (convertBtn) {
      convertBtn.disabled = false;
      setTimeout(() => convertBtn.click(), 500);
    }
  }
}

if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (launchParams) => {
    if (!launchParams.files || launchParams.files.length === 0) return;
    const file = launchParams.files[0];
    await handleSharedFile(file);
  });
}

window.addEventListener("load", () => {
  const params = new URLSearchParams(window.location.search);
  const shareUrl = params.get("share_url");
  if (shareUrl) {
    sessionStorage.setItem("seize_shared_url", shareUrl);
    window.location.href = "/";
  }
});

// ===== Clipboard auto-detect =====
// check the clipboard when the app comes back to foreground, offer to
// autofill if there's a link on it. saves a paste every time
const CLIPBOARD_LINK_RE =
  /https?:\/\/[^\s]*(tiktok\.com|instagram\.com|twitter\.com|x\.com|pinterest\.com|pin\.it|snapchat\.com|facebook\.com|fb\.watch)[^\s]*/i;
let lastClipboardSuggestion = "";

async function checkClipboardForLink() {
  if (!navigator.clipboard || !navigator.clipboard.readText) return;

  // Installed standalone PWAs on Android fire focus/visibilitychange
  // events before document.hasFocus() actually flips true — readText()
  // throws "Document is not focused" if called too early. A tab doesn't
  // usually hit this race; a standalone window does. Retry briefly
  // instead of giving up on the first tick.
  for (let attempt = 0; attempt < 4; attempt++) {
    if (document.hasFocus()) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  try {
    const text = await navigator.clipboard.readText();
    const match = text && text.match(CLIPBOARD_LINK_RE);
    if (!match) return;
    const found = match[0];
    if (found === lastClipboardSuggestion) return;
    if (urlInput.value.trim() === found) return;
    lastClipboardSuggestion = found;
    showClipboardSuggestion(found);
  } catch {
    // Still no permission/focus after retrying — this is the case where
    // standalone mode has no UI surface to grant clipboard access at all.
    // The manual paste button (wired up below) is the reliable fallback.
  }
}

function showClipboardSuggestion(link) {
  document.querySelector(".clipboard-suggestion")?.remove();

  const bar = document.createElement("div");
  bar.className = "clipboard-suggestion mono small";

  const label = document.createElement("span");
  label.textContent = "📋 Link found on clipboard — use it?";
  bar.appendChild(label);

  const useBtn = document.createElement("button");
  useBtn.type = "button";
  useBtn.className = "clipboard-use-btn";
  useBtn.textContent = "Use it";
  useBtn.addEventListener("click", () => {
    document.querySelector('[data-mode="capture"]')?.click();
    urlInput.value = link;
    urlInput.dispatchEvent(new Event("input"));
    bar.remove();
  });
  bar.appendChild(useBtn);

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "clipboard-dismiss-btn";
  dismissBtn.textContent = "✕";
  dismissBtn.addEventListener("click", () => bar.remove());
  bar.appendChild(dismissBtn);

  document.body.appendChild(bar);
  setTimeout(() => bar.remove(), 12000);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkClipboardForLink();
});
window.addEventListener("focus", checkClipboardForLink);

// Manual fallback: a real click is a genuine user gesture, so this works
// reliably even in standalone/installed mode where the automatic
// focus-based detection above can be permanently blocked (no address bar
// = no surface for the browser to ever prompt for clipboard permission).
pasteBtn?.addEventListener("click", async () => {
  if (!navigator.clipboard || !navigator.clipboard.readText) {
    showCaptureError("Clipboard access isn't supported in this browser.");
    return;
  }
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      showCaptureError("Clipboard is empty.");
      return;
    }
    const match = text.match(CLIPBOARD_LINK_RE);
    const value = match ? match[0] : text.trim();
    urlInput.value = value;
    urlInput.dispatchEvent(new Event("input"));
    urlInput.focus();
    clearCaptureError();
  } catch {
    showCaptureError(
      "Couldn't read the clipboard — your browser may have blocked it. Try pasting manually.",
    );
  }
});

// ===== Local notifications on job completion =====
// so you can background the app on a long convert instead of staring
// at the progress bar. goes through the service worker so it fires
// even if the tab got suspended
let notificationPermissionAsked = false;

async function ensureNotificationPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  if (notificationPermissionAsked) return false;
  notificationPermissionAsked = true;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

async function notifyJobDone(title, body) {
  const ok = await ensureNotificationPermission();
  if (!ok) return;
  // only bug them if they've actually left the tab
  if (document.visibilityState === "visible") return;
  try {
    if (navigator.serviceWorker) {
      const reg = await navigator.serviceWorker.ready;
      reg.showNotification(title, {
        body,
        icon: "icons/icon-192.png",
        badge: "icons/icon-192.png",
      });
    } else {
      new Notification(title, { body, icon: "icons/icon-192.png" });
    }
  } catch (err) {
    console.warn("[seize] Notification failed:", err);
  }
}

// ===== Install Button =====
const installBtn = document.getElementById("install-btn");
let deferredPrompt;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.classList.remove("hidden");
  installBtn.textContent = "📲 Install App";
});

installBtn.addEventListener("click", async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") {
      installBtn.classList.add("hidden");
    }
    deferredPrompt = null;
    return;
  }
  if (isIOS() && !navigator.standalone) {
    showIOSInstallGuide();
  }
});

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

function showIOSInstallGuide() {
  const modal = document.createElement("div");
  modal.className = "ios-install-modal";
  modal.innerHTML = `
    <div class="ios-modal-content">
      <h3>📱 Install seize on your iPhone</h3>
      <ol>
        <li>Tap the <strong>Share</strong> button <span class="share-icon">⎔</span></li>
        <li>Scroll down and tap <strong>Add to Home Screen</strong></li>
        <li>Tap <strong>Add</strong> in the top-right corner</li>
      </ol>
      <button class="btn-primary" id="ios-modal-close">Got it</button>
    </div>
  `;
  document.body.appendChild(modal);
  document.getElementById("ios-modal-close").addEventListener("click", () => {
    modal.remove();
  });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
}

if (isIOS() && !navigator.standalone) {
  installBtn.classList.remove("hidden");
  installBtn.textContent = "📱 Install on iOS";
}

// ===== Service Worker =====
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

updateOfflineBanner();
if (navigator.onLine) processOfflineQueue();

console.log("✅ seize app loaded successfully");
console.log("🔗 API Base:", API_BASE);

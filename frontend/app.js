const API_BASE = "https://seize-1lxs.onrender.com/api";

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

function updateResultButtons(data) {
  if (data.hasVideo) {
    fetchVideoBtn.style.display = "inline-flex";
    fetchVideoBtn.textContent = "🎬 Download video";
  } else {
    fetchVideoBtn.style.display = "none";
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
      (p === "youtube" &&
        (val.includes("youtube") || val.includes("youtu.be")));
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

  try {
    const res = await fetch(`${API_BASE}/download/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: currentUrl, mode }),
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
          resolve();
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

// ===== Convert Panel =====
const convertTabs = document.querySelectorAll(".convert-tab");
const dropzone = document.getElementById("dropzone");
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

let convertTarget = "v2a";
let selectedFile = null;

convertTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    convertTabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    convertTarget = tab.dataset.target;
    selectedFile = null;
    fileInput.value = "";
    convertBtn.disabled = true;
    dropzone.classList.remove("has-file");
    if (convertTarget === "v2a") {
      dropzoneLabel.textContent = "Drop a video file, or click to browse";
      dropzoneHint.textContent = "MP4 · MOV · MKV · WEBM — up to 500MB";
      formatRow.style.display = "flex";
      document.getElementById("format-select").innerHTML =
        `<option value="mp3">MP3</option><option value="wav">WAV</option><option value="aac">AAC</option><option value="flac">FLAC</option><option value="ogg">OGG</option>`;
    } else {
      dropzoneLabel.textContent = "Drop an audio file, or click to browse";
      dropzoneHint.textContent =
        "MP3 · WAV · AAC · FLAC · OGG · M4A — up to 500MB";
      formatRow.style.display = "none";
    }
  });
});

fileInput.addEventListener("click", (e) => e.stopPropagation());

dropzone.addEventListener("click", function (e) {
  e.preventDefault();
  fileInput.click();
});

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dragover");
});

function applySelectedFile(file) {
  selectedFile = file;
  convertBtn.disabled = false;
  dropzone.classList.add("has-file");
  const fileSize = (file.size / (1024 * 1024)).toFixed(2);
  dropzoneLabel.textContent = `✅ ${file.name}`;
  dropzoneHint.textContent = `${fileSize} MB — click to choose a different file`;
}

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

function showConvertError(msg) {
  convertError.textContent = msg;
  convertError.classList.remove("hidden");
}
function clearConvertError() {
  convertError.classList.add("hidden");
  convertError.textContent = "";
}

convertForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearConvertError();
  if (!selectedFile) return;

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
    await pollJob(
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
    if (dropzoneLabel) dropzoneLabel.textContent = file.name;
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
    if (dropzoneLabel) dropzoneLabel.textContent = file.name;
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

console.log("✅ seize app loaded successfully");
console.log("🔗 API Base:", API_BASE);

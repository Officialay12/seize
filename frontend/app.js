// ===== Config =====
const API_BASE = "https://seize-1lxs.onrender.com/api";

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
  });
});

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
    window.location.href = `${API_BASE}/download/file/${data.jobId}`;
    captureProgress.classList.add("hidden");
    setScopeState("done");
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

// Fix: Mobile file input - works when clicking dropzone
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

dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length) {
    selectedFile = e.dataTransfer.files[0];
    fileInput.files = e.dataTransfer.files;
    dropzoneLabel.textContent = selectedFile.name;
    convertBtn.disabled = false;
    const fileSize = (selectedFile.size / (1024 * 1024)).toFixed(2);
    dropzoneHint.textContent = `${selectedFile.name} (${fileSize} MB)`;
  }
});

fileInput.addEventListener("change", () => {
  if (fileInput.files.length) {
    selectedFile = fileInput.files[0];
    dropzoneLabel.textContent = selectedFile.name;
    convertBtn.disabled = false;
    const fileSize = (selectedFile.size / (1024 * 1024)).toFixed(2);
    dropzoneHint.textContent = `${selectedFile.name} (${fileSize} MB)`;
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

  try {
    const res = await fetch(`${API_BASE}/convert/${endpoint}`, {
      method: "POST",
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Conversion failed.");

    convertProgressLabel.textContent = "PROCESSING…";
    await pollJob(
      `${API_BASE}/convert/status/${data.jobId}`,
      convertProgressFill,
      convertProgressLabel,
    );
    window.location.href = `${API_BASE}/convert/download/${data.jobId}`;
    convertProgress.classList.add("hidden");
    setScopeState("done");
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

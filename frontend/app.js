const API_BASE = "https://seize-1lxs.onrender.com/api";

// ============================================================
// PRELOADER - Show logo before app loads
// ============================================================
(function hidePreloader() {
  const preloader = document.getElementById("preloader");
  if (preloader) {
    setTimeout(() => {
      preloader.classList.add("fade-out");
      setTimeout(() => {
        preloader.style.display = "none";
      }, 600);
    }, 1200);
  }
})();

// ============================================================
// PERMISSIONS - Ask on load, remember choice
// ============================================================
const PERMISSION_KEY = "seize_permissions_granted";

async function requestAppPermissions() {
  const alreadyGranted = localStorage.getItem(PERMISSION_KEY);
  if (alreadyGranted === "true") return;
  if (alreadyGranted === "false") return;

  // used to only show on mobile — now shows everywhere, since real push
  // notifications (not just the in-app "job done" kind) work on desktop
  // browsers too and this is the one place we ask for that permission
  const isMobile =
    /Android|iPhone|iPad|iPod|webOS|BlackBerry|Windows Phone/i.test(
      navigator.userAgent,
    );

  const banner = document.createElement("div");
  banner.className = "permission-banner";
  banner.innerHTML = `
    <p>🔔 <strong>seize</strong> needs permission to:</p>
    <ul>
      ${isMobile ? "<li>📥 Save media to your device storage (gallery/downloads)</li>" : ""}
      <li>🔔 Send notifications when downloads are ready — and the occasional reminder to come back</li>
      <li>📋 Read clipboard for quick link pasting</li>
    </ul>
    <div class="permission-actions">
      <button class="later-btn" id="perm-later">Later</button>
      <button class="deny-btn" id="perm-deny">Deny</button>
      <button class="allow-btn" id="perm-allow">Allow</button>
    </div>
  `;
  document.body.appendChild(banner);

  const allowBtn = document.getElementById("perm-allow");
  const denyBtn = document.getElementById("perm-deny");
  const laterBtn = document.getElementById("perm-later");

  const handleAllow = async () => {
    try {
      if ("Notification" in window && Notification.permission === "default") {
        const result = await Notification.requestPermission();
        if (result === "granted") subscribeToPush();
      } else if (Notification.permission === "granted") {
        subscribeToPush();
      }
      localStorage.setItem(PERMISSION_KEY, "true");
      banner.remove();
    } catch (err) {
      console.warn("[seize] Permission request failed:", err);
      banner.remove();
    }
  };

  const handleDeny = () => {
    localStorage.setItem(PERMISSION_KEY, "false");
    banner.remove();
  };

  const handleLater = () => {
    banner.remove();
    // Ask again after 5 minutes
    setTimeout(requestAppPermissions, 300000);
  };

  allowBtn.addEventListener("click", handleAllow);
  denyBtn.addEventListener("click", handleDeny);
  laterBtn.addEventListener("click", handleLater);
}

// ============================================================
// PENDING FILE PERSISTENCE
// ============================================================
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
    // shrug
  }
}

// ============================================================
// OFFLINE QUEUE
// ============================================================
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
    // whatever
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
        // Auto-save on completion
        const fileExt =
          item.mode === "audio" ? "mp3" : item.mode === "image" ? "jpg" : "mp4";
        const fileUrl = `${API_BASE}/download/file/${data.jobId}`;
        await saveMediaToDevice(
          fileUrl,
          `seize-${item.mode}-${Date.now()}.${fileExt}`,
        );
        notifyJobDone(
          "Queued job finished",
          `${item.title || "Media"} saved automatically.`,
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
        const outExt = item.target === "v2a" ? item.format || "mp3" : "mp4";
        const fileUrl = `${API_BASE}/convert/download/${data.jobId}`;
        await saveMediaToDevice(
          fileUrl,
          `seize-converted-${Date.now()}.${outExt}`,
        );
        notifyJobDone(
          "Queued conversion finished",
          `${item.name || "Your file"} converted and saved automatically.`,
        );
      }
      await removeFromOfflineQueue(item.id);
    } catch (err) {
      console.warn("[seize] Offline queue item failed, will retry later:", err);
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

// ============================================================
// EXTRACT PLATFORM URL
// ============================================================
function extractPlatformUrl(str) {
  if (!str) return null;

  const patterns = [
    /https?:\/\/[^\s]*(tiktok\.com\/[^\s]+)/i,
    /https?:\/\/[^\s]*(instagram\.com\/[^\s]+)/i,
    /https?:\/\/[^\s]*(twitter\.com\/[^\s]+)/i,
    /https?:\/\/[^\s]*(x\.com\/[^\s]+)/i,
    /https?:\/\/[^\s]*(pinterest\.com\/[^\s]+)/i,
    /https?:\/\/[^\s]*(pin\.it\/[^\s]+)/i,
    /https?:\/\/[^\s]*(snapchat\.com\/[^\s]+)/i,
    /https?:\/\/[^\s]*(facebook\.com\/[^\s]+)/i,
    /https?:\/\/[^\s]*(fb\.watch\/[^\s]+)/i,
    /https?:\/\/[^\s]*(youtube\.com\/[^\s]+)/i,
    /https?:\/\/[^\s]*(youtu\.be\/[^\s]+)/i,
  ];

  for (const pattern of patterns) {
    const match = str.match(pattern);
    if (match) {
      const fullMatch = str.match(/https?:\/\/[^\s]+/i);
      return fullMatch ? fullMatch[0] : match[0];
    }
  }

  const urls = str.match(/https?:\/\/[^\s]+/gi);
  return urls && urls.length > 0 ? urls[0] : null;
}

// ============================================================
// SHARE HANDLER
// ============================================================
(function checkForSharedUrl() {
  const sharedUrl = sessionStorage.getItem("seize_shared_url");
  const sharedMode = sessionStorage.getItem("seize_shared_mode");

  if (sharedUrl) {
    console.log("[seize] Found shared URL:", sharedUrl);

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        processSharedUrl(sharedUrl, sharedMode);
      });
    } else {
      processSharedUrl(sharedUrl, sharedMode);
    }

    setTimeout(() => {
      sessionStorage.removeItem("seize_shared_url");
      sessionStorage.removeItem("seize_shared_title");
      sessionStorage.removeItem("seize_shared_mode");
    }, 5000);
  }

  const urlParams = new URLSearchParams(window.location.search);
  const paramUrl =
    urlParams.get("share_url") || urlParams.get("url") || urlParams.get("text");

  if (paramUrl && !sharedUrl) {
    const extracted = extractPlatformUrl(paramUrl);
    if (extracted) {
      console.log("[seize] Found shared URL in params:", extracted);
      sessionStorage.setItem("seize_shared_url", extracted);
      processSharedUrl(extracted, null);
    }
  }
})();

function processSharedUrl(url, mode) {
  console.log("[seize] Processing shared URL:", url);

  document.querySelector('[data-mode="capture"]')?.click();

  const urlInput = document.getElementById("url-input");
  if (urlInput) {
    urlInput.value = url;
    urlInput.dispatchEvent(new Event("input"));
    urlInput.dispatchEvent(new Event("change"));
  }

  setTimeout(() => {
    const resolveBtn = document.getElementById("resolve-btn");
    if (resolveBtn) {
      resolveBtn.click();
    }
  }, 800);

  if (mode === "convert-video") {
    document.querySelector('[data-mode="convert"]')?.click();
    setTimeout(() => {
      document.querySelector('[data-target="v2a"]')?.click();
    }, 300);
  } else if (mode === "convert-audio") {
    document.querySelector('[data-mode="convert"]')?.click();
    setTimeout(() => {
      document.querySelector('[data-target="a2v"]')?.click();
    }, 300);
  }
}

// ============================================================
// SAVE TO DEVICE - AUTO SAVE WITH MULTIPLE FALLBACKS
// ============================================================
const MIME_BY_EXT = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

const EXT_BY_MIME = Object.fromEntries(
  Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext]),
);

function resolveFileInfo(response, blob, fallbackName) {
  let name = fallbackName;

  const disposition = response.headers?.get?.("content-disposition") || "";
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (match && match[1]) {
    name = decodeURIComponent(match[1]);
  }

  let ext = (name.split(".").pop() || "").toLowerCase();

  if (!MIME_BY_EXT[ext]) {
    const sniffedExt = EXT_BY_MIME[blob.type];
    if (sniffedExt) {
      ext = sniffedExt;
      const base = name.includes(".")
        ? name.slice(0, name.lastIndexOf("."))
        : name;
      name = `${base}.${ext}`;
    }
  }

  const mimeType = MIME_BY_EXT[ext] || blob.type || "application/octet-stream";
  return { name, mimeType };
}

// Main save function - auto saves to device without user interaction
async function saveMediaToDevice(fileUrl, suggestedName) {
  let res, blob;
  try {
    res = await fetch(fileUrl);
    if (!res.ok) throw new Error("couldn't grab the file from the server");
    blob = await res.blob();
  } catch (err) {
    console.error("[seize] fetch for save failed:", err);
    window.open(fileUrl, "_blank");
    return;
  }

  const { name, mimeType } = resolveFileInfo(res, blob, suggestedName);
  const file = new File([blob], name, { type: mimeType });
  const isMobileUA = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // Strategy 1 (mobile only): Web Share — the system share sheet with
  // "Save to Photos/Files" is the closest thing to a straight-to-gallery
  // save on a phone. Skipped on desktop entirely, since navigator.share
  // exists on some desktop browsers too and would pop a share sheet
  // nobody asked for there.
  if (
    isMobileUA &&
    navigator.canShare &&
    navigator.canShare({ files: [file] })
  ) {
    try {
      await navigator.share({ files: [file] });
      console.log("[seize] saved via share sheet");
      showToast("✅ File saved to device!", "success");
      return;
    } catch (err) {
      if (err?.name === "AbortError") {
        return;
      }
      console.warn("[seize] share sheet bailed:", err);
    }
  }

  // Strategy 2: plain blob download. This used to be strategy 3, behind
  // the File System Access "Save As" picker — but that picker is a manual
  // "choose a folder" dialog by definition, which isn't automatic no
  // matter how you slice it. This one is: the browser writes straight to
  // the default Downloads folder (or straight into Downloads on Android
  // Chrome) with zero prompt, zero dialog.
  try {
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();

    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    setTimeout(
      () => {
        a.remove();
        URL.revokeObjectURL(blobUrl);
      },
      isIOS ? 1000 : 5000,
    );

    console.log("[seize] triggered plain download");
    showToast("✅ Download started!", "success");
    return;
  } catch (err) {
    console.warn("[seize] anchor download bailed:", err);
  }

  // Strategy 4: Open in new tab as last resort
  console.warn("[seize] everything failed, opening in a new tab");
  if (blob.type.startsWith("image/")) {
    const imgUrl = URL.createObjectURL(blob);
    const win = window.open("");
    if (win) {
      win.document.write(
        `<img src="${imgUrl}" style="max-width:100%;height:auto;" />`,
      );
      win.document.title = name;
    } else {
      window.open(fileUrl, "_blank");
    }
  } else {
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, "_blank");
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
  }
}

// ============================================================
// TOAST NOTIFICATION
// ============================================================
function showToast(message, level = "info") {
  const existing = document.querySelector(".custom-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = "custom-toast";
  const colors = {
    info: "#7FFFB0",
    success: "#7FFFB0",
    error: "#FF6B6B",
    warning: "#FFB86B",
  };
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 99999;
    background: #141715;
    border: 1px solid #262B27;
    border-left: 3px solid ${colors[level] || "#7FFFB0"};
    border-radius: 8px;
    padding: 14px 20px;
    color: #E8EDE9;
    font-size: 0.9rem;
    max-width: 400px;
    animation: slideUp 0.3s ease-out;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  `;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ============================================================
// SONG ID
// ============================================================
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

// ============================================================
// HISTORY
// ============================================================
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
    console.warn("[seize] Could not save history:", err);
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

// ============================================================
// THUMBNAIL HELPER
// ============================================================
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

// ============================================================
// OSCILLOSCOPE
// ============================================================
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

// ============================================================
// MODE SWITCH
// ============================================================
const modeButtons = document.querySelectorAll(".mode-btn");
const panels = {
  capture: document.getElementById("panel-capture"),
  convert: document.getElementById("panel-convert"),
  history: document.getElementById("panel-history"),
  archive: document.getElementById("panel-archive"),
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

// ============================================================
// CAPTURE PANEL
// ============================================================
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

// ============================================================
// FETCH & AUTO-SAVE - No save button, saves automatically
// ============================================================
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

    // AUTO-SAVE: Save directly to device without showing a save button
    await saveMediaToDevice(fileUrl, `seize-${mode}-${Date.now()}.${fileExt}`);

    addHistoryEntry({
      type: "download",
      mode,
      url: currentUrl,
      title: resultTitle.textContent || "Untitled",
      thumbnail: resultThumb.src || null,
    });
    notifyJobDone(
      "Your file is ready",
      `${resultTitle.textContent || "Media"} saved to your device.`,
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

// ============================================================
// COLLECTIONS
// ============================================================
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
    // shrug
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

// ============================================================
// PUBLIC GALLERY VIEW
// ============================================================
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
  title.textContent = item.title || "Untitled";
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

  const resolveUrl = params.get("resolve");
  if (resolveUrl) {
    window.addEventListener("load", () => {
      urlInput.value = resolveUrl;
      urlInput.dispatchEvent(new Event("input"));
      setTimeout(() => resolveBtn.click(), 300);
    });
  }
})();

// ============================================================
// BATCH QUEUE - Auto-save on completion
// ============================================================
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

    // no manual "save" button here on purpose — processQueueItem() below
    // already calls saveMediaToDevice() the instant an item finishes, so
    // by the time a row shows "done" it's already saved. a leftover
    // button here would just make it look like an extra step was needed.

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
    if (batchQueue.some((q) => q.url === url)) return;
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
    const fileExt = mode === "audio" ? "mp3" : mode === "image" ? "jpg" : "mp4";
    item.fileUrl = `${API_BASE}/download/file/${fetchData.jobId}`;

    // AUTO-SAVE: Save directly to device
    await saveMediaToDevice(
      item.fileUrl,
      `seize-batch-${Date.now()}.${fileExt}`,
    );

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
    `${batchQueue.filter((q) => q.status === "done").length} item(s) saved to your device.`,
  );
});

// ============================================================
// CONVERT PANEL - Auto-save on completion
// ============================================================
const convertTabs = document.querySelectorAll(".convert-tab");
const dropzone = document.getElementById("dropzone");
const dropzoneEmpty = document.getElementById("dropzone-empty");
const dropzonePreview = document.getElementById("dropzone-preview");
const dropzonePreviewIcon = document.getElementById("dropzone-preview-icon");
const dropzonePreviewName = document.getElementById("dropzone-preview-name");
const dropzonePreviewSize = document.getElementById("dropzone-preview-size");
const dropzonePreviewRemove = document.getElementById(
  "dropzone-preview-remove",
);
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

dropzone.addEventListener("click", function (e) {
  e.preventDefault();
  e.stopPropagation();
  fileInput.click();
});

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

  dropzoneEmpty.classList.add("hidden");
  dropzonePreview.classList.remove("hidden");
  dropzonePreviewIcon.textContent = fileTypeIcon(file);
  dropzonePreviewName.textContent = file.name;
  dropzonePreviewSize.textContent = `${(file.size / (1024 * 1024)).toFixed(2)} MB`;

  if (!opts.skipPersist) {
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
      // shrug
    }
    savePendingFile(file, { target: convertTarget }).then(() => {
      try {
        sessionStorage.removeItem("seize_pending_flag");
      } catch {
        // shrug
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
    // shrug
  }
}

dropzonePreviewRemove.addEventListener("click", (e) => {
  e.stopPropagation();
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
      // shrug
    }
    return;
  }

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
      // shrug
    }
  }
})();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && selectedFile) {
    console.log(
      "[seize] Tab hidden while a file is selected — persistence flag already written.",
    );
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

    if (
      statusData?.recognizedTrack?.title ||
      statusData?.recognizedTrack?.artist
    ) {
      showRecognizedTrack(statusData.recognizedTrack);
    }

    // AUTO-SAVE: Save directly to device without showing a save button
    await saveMediaToDevice(fileUrl, `seize-converted-${Date.now()}.${outExt}`);

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
      `${selectedFile?.name || "Your file"} converted and saved to your device.`,
    );
  } catch (err) {
    showConvertError(err.message);
    convertProgress.classList.add("hidden");
    setScopeState("idle");
  } finally {
    convertBtn.disabled = false;
  }
});

// ============================================================
// SHARE HANDLER (legacy)
// ============================================================
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

// ============================================================
// FILE SHARE HANDLER
// ============================================================
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

// ============================================================
// CLIPBOARD AUTO-DETECT
// ============================================================
const CLIPBOARD_LINK_RE =
  /https?:\/\/[^\s]*(tiktok\.com|instagram\.com|twitter\.com|x\.com|pinterest\.com|pin\.it|snapchat\.com|facebook\.com|fb\.watch)[^\s]*/i;
let lastClipboardSuggestion = "";

async function checkClipboardForLink() {
  if (!navigator.clipboard || !navigator.clipboard.readText) return;

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
    // manual paste button is the fallback
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

// ============================================================
// NOTIFICATIONS
// ============================================================
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

// ============================================================
// REAL PUSH NOTIFICATIONS — the kind that show up even when seize
// isn't open, e.g. "it's been a while, download your media with seize"
// ============================================================
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function subscribeToPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  if (Notification.permission !== "granted") return;

  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();

    if (!sub) {
      const keyRes = await fetch(`${API_BASE}/push/public-key`);
      const { publicKey } = await keyRes.json();
      if (!publicKey) return;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }

    await fetch(`${API_BASE}/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub }),
    });
    localStorage.setItem("seize_push_endpoint", sub.endpoint);
  } catch (err) {
    console.warn("[seize] push subscribe failed:", err);
  }
}

// bumps "last seen" on the backend so the reminder sweep doesn't nag
// someone who was literally just here
async function pingPushSubscription() {
  const endpoint = localStorage.getItem("seize_push_endpoint");
  if (!endpoint) return;
  try {
    await fetch(`${API_BASE}/push/ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    // fine, next open will try again
  }
}

// returning user who already granted permission earlier — resubscribe
// quietly (getSubscription() reuses the existing one if it's still
// valid) and check in, no banner needed
if ("Notification" in window && Notification.permission === "granted") {
  window.addEventListener("load", () => {
    subscribeToPush().then(pingPushSubscription);
  });
}

// ============================================================
// INSTALL BUTTON
// ============================================================
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

// ============================================================
// SERVICE WORKER
// ============================================================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// ============================================================
// EXTENSION - Desktop only, with instructions
// ============================================================
const extensionBtn = document.getElementById("install-extension-btn");
const downloadExtensionBtn = document.getElementById("download-extension-btn");

function isDesktop() {
  const ua = navigator.userAgent;
  const isMobile =
    /Android|iPhone|iPad|iPod|webOS|BlackBerry|Windows Phone/i.test(ua);
  const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  return !isMobile && !isTouch;
}

async function checkExtensionInstalled() {
  try {
    const marker = document.getElementById("seize-extension-marker");
    if (marker) return true;
    const styles = document.querySelectorAll("style");
    for (const style of styles) {
      if (
        style.textContent &&
        style.textContent.includes("seize-extension-btn")
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function showExtensionButtons() {
  // Only show on desktop
  if (!isDesktop()) {
    extensionBtn.classList.add("hidden");
    downloadExtensionBtn.classList.add("hidden");
    return;
  }

  const installed = await checkExtensionInstalled();
  if (installed) {
    extensionBtn.classList.add("hidden");
    downloadExtensionBtn.classList.add("hidden");
    return;
  }

  // Show both buttons on desktop
  extensionBtn.classList.remove("hidden");
  downloadExtensionBtn.classList.remove("hidden");
  extensionBtn.textContent = "🧩 Add to Chrome";
  downloadExtensionBtn.textContent = "📦 Download Extension";
}

function showExtensionInstructions() {
  document.querySelector(".extension-modal")?.remove();

  const modal = document.createElement("div");
  modal.className = "extension-modal";
  modal.style.cssText = `
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    padding: 20px;
    animation: fadeIn 0.3s ease;
  `;

  modal.innerHTML = `
    <div style="
      background: #141715;
      border: 1px solid #262B27;
      border-radius: 8px;
      padding: 32px;
      max-width: 480px;
      width: 100%;
      max-height: 90vh;
      overflow-y: auto;
    ">
      <h2 style="color: #7FFFB0; font-family: var(--font-display); font-size: 1.3rem; margin: 0 0 8px;">
        🧩 Install Seize Extension
      </h2>
      <p style="color: #8A928C; font-size: 0.9rem; margin: 0 0 20px; line-height: 1.6;">
        Add one-click download buttons to TikTok, Instagram, Twitter/X, and Pinterest.
      </p>

      <button id="modal-download-btn" style="
        width: 100%;
        padding: 12px;
        background: #7FFFB0;
        color: #06120A;
        border: none;
        border-radius: 6px;
        font-weight: 600;
        font-size: 1rem;
        cursor: pointer;
        margin-bottom: 20px;
        transition: background 0.2s;
        font-family: inherit;
      " onmouseover="this.style.background='#9AFFC4'" onmouseout="this.style.background='#7FFFB0'">
        📦 Download Extension ZIP
      </button>

      <div style="display: flex; flex-direction: column; gap: 12px; margin-bottom: 20px;">
        <div style="display: flex; gap: 12px; align-items: flex-start; padding: 12px; background: #0B0D0C; border-radius: 6px; border: 1px solid #262B27;">
          <span style="font-size: 1.2rem; min-width: 28px;">1</span>
          <div>
            <strong style="color: #E8EDE9;">Download the extension</strong>
            <p style="color: #8A928C; font-size: 0.8rem; margin: 4px 0 0;">Click the green button above to download <code style="background: #0B0D0C; padding: 2px 6px; border-radius: 4px; color: #7FFFB0;">seize-extension.zip</code></p>
          </div>
        </div>
        <div style="display: flex; gap: 12px; align-items: flex-start; padding: 12px; background: #0B0D0C; border-radius: 6px; border: 1px solid #262B27;">
          <span style="font-size: 1.2rem; min-width: 28px;">2</span>
          <div>
            <strong style="color: #E8EDE9;">Extract the ZIP</strong>
            <p style="color: #8A928C; font-size: 0.8rem; margin: 4px 0 0;">Right-click the ZIP → <strong style="color: #E8EDE9;">Extract All</strong></p>
          </div>
        </div>
        <div style="display: flex; gap: 12px; align-items: flex-start; padding: 12px; background: #0B0D0C; border-radius: 6px; border: 1px solid #262B27;">
          <span style="font-size: 1.2rem; min-width: 28px;">3</span>
          <div>
            <strong style="color: #E8EDE9;">Open Chrome Extensions</strong>
            <p style="color: #8A928C; font-size: 0.8rem; margin: 4px 0 0;">Go to <code style="background: #0B0D0C; padding: 2px 6px; border-radius: 4px; color: #7FFFB0;">chrome://extensions/</code> and enable <strong style="color: #E8EDE9;">Developer Mode</strong></p>
          </div>
        </div>
        <div style="display: flex; gap: 12px; align-items: flex-start; padding: 12px; background: #0B0D0C; border-radius: 6px; border: 1px solid #262B27;">
          <span style="font-size: 1.2rem; min-width: 28px;">4</span>
          <div>
            <strong style="color: #E8EDE9;">Load the extension</strong>
            <p style="color: #8A928C; font-size: 0.8rem; margin: 4px 0 0;">Click <strong style="color: #E8EDE9;">Load unpacked</strong> and select the extracted <code style="background: #0B0D0C; padding: 2px 6px; border-radius: 4px; color: #7FFFB0;">extension/</code> folder</p>
          </div>
        </div>
      </div>

      <div style="display: flex; gap: 10px;">
        <button class="btn-primary" id="extension-modal-close" style="flex: 1;">Got it</button>
        <button class="btn-secondary" id="extension-modal-open" style="flex: 1;">Open chrome://extensions</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  document
    .getElementById("modal-download-btn")
    ?.addEventListener("click", () => {
      downloadExtensionBtn?.click();
    });

  document
    .getElementById("extension-modal-close")
    .addEventListener("click", () => {
      modal.remove();
    });

  document
    .getElementById("extension-modal-open")
    .addEventListener("click", () => {
      window.open("chrome://extensions/", "_blank");
      modal.remove();
    });

  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
}

// ============================================================
// DOWNLOAD EXTENSION BUTTON
// ============================================================
downloadExtensionBtn?.addEventListener("click", () => {
  const zipUrl = "/extension.zip";

  fetch(zipUrl)
    .then((response) => {
      if (!response.ok) {
        showExtensionInstructions();
        throw new Error("ZIP file not found");
      }
      return response.blob();
    })
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "seize-extension.zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(
        "📦 Extension downloaded! Check your Downloads folder.",
        "success",
      );
    })
    .catch(() => {
      showExtensionInstructions();
    });
});

extensionBtn?.addEventListener("click", showExtensionInstructions);

window.addEventListener("load", () => {
  setTimeout(showExtensionButtons, 1500);
  // Request permissions after app loads
  setTimeout(requestAppPermissions, 2000);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    showExtensionButtons();
  }
});

// ============================================================
// ARCHIVE MODE
// ============================================================
const archiveInput = document.getElementById("archive-input");
const archiveBtn = document.getElementById("archive-btn");
const archiveMode = document.getElementById("archive-mode");
const archiveLimit = document.getElementById("archive-limit");
const archiveGrid = document.getElementById("archive-grid");
const archiveProgress = document.getElementById("archive-progress");
const archiveProgressFill = document.getElementById("archive-progress-fill");
const archiveProgressLabel = document.getElementById("archive-progress-label");
const archiveStatus = document.getElementById("archive-status");
const archiveSelectAll = document.getElementById("archive-select-all");
const archiveDownloadSelected = document.getElementById(
  "archive-download-selected",
);
const archiveClear = document.getElementById("archive-clear");
const archiveCount = document.getElementById("archive-count");

let archiveItems = [];
let selectedArchiveItems = new Set();
let currentArchiveJobId = null;
let archiveBatchId = null;

document
  .querySelector('[data-mode="archive"]')
  ?.addEventListener("click", () => {
    document.querySelector('[data-mode="archive"]').classList.add("active");
    document
      .getElementById("panel-archive")
      .setAttribute("data-active", "true");
  });

archiveBtn?.addEventListener("click", async () => {
  const url = archiveInput.value.trim();
  if (!url) {
    showArchiveError("Please enter a profile URL");
    return;
  }

  const mode = archiveMode?.value || "all";
  const limit = parseInt(archiveLimit?.value) || 50;

  archiveBtn.disabled = true;
  archiveBtn.textContent = "Scanning...";
  archiveGrid.innerHTML = `<div class="archive-loading">🔍 Scanning profile...</div>`;
  archiveProgress.classList.remove("hidden");
  archiveProgressFill.style.width = "10%";
  archiveProgressLabel.textContent = "Connecting...";
  archiveStatus.classList.add("hidden");
  document.getElementById("archive-error")?.classList.add("hidden");

  try {
    const res = await fetch(`${API_BASE}/download/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, mode, limit }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to scan profile");

    currentArchiveJobId = data.jobId;
    pollArchiveStatus(data.jobId);
  } catch (err) {
    showArchiveError(err.message);
    archiveBtn.disabled = false;
    archiveBtn.textContent = "🔍 Scan Profile";
    archiveProgress.classList.add("hidden");
    archiveGrid.innerHTML = `<div class="archive-empty">Something went wrong. Try again.</div>`;
  }
});

function pollArchiveStatus(jobId) {
  let attempts = 0;
  const maxAttempts = 120;

  const interval = setInterval(async () => {
    attempts++;
    try {
      const res = await fetch(`${API_BASE}/download/profile/status/${jobId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      archiveProgressFill.style.width = `${data.progress || 0}%`;

      if (data.progress < 100) {
        archiveProgressLabel.textContent = `Scanning... ${data.progress || 0}%`;
      }

      if (data.status === "done") {
        clearInterval(interval);
        archiveItems = data.items || [];
        renderArchiveGrid(archiveItems);
        archiveProgress.classList.add("hidden");
        archiveBtn.disabled = false;
        archiveBtn.textContent = "🔍 Scan Profile";
        archiveStatus.textContent = `📊 ${archiveItems.length} items found`;
        archiveStatus.classList.remove("hidden");
        updateArchiveCount();
      } else if (data.status === "error") {
        clearInterval(interval);
        showArchiveError(data.error || "Scan failed");
        archiveBtn.disabled = false;
        archiveBtn.textContent = "🔍 Scan Profile";
        archiveProgress.classList.add("hidden");
        archiveGrid.innerHTML = `<div class="archive-empty">${data.error || "Failed to scan profile"}</div>`;
      }

      if (attempts >= maxAttempts) {
        clearInterval(interval);
        showArchiveError("Scan timed out. Try again.");
        archiveBtn.disabled = false;
        archiveBtn.textContent = "🔍 Scan Profile";
        archiveProgress.classList.add("hidden");
      }
    } catch (err) {
      clearInterval(interval);
      showArchiveError(err.message);
      archiveBtn.disabled = false;
      archiveBtn.textContent = "🔍 Scan Profile";
      archiveProgress.classList.add("hidden");
    }
  }, 1500);
}

function renderArchiveGrid(items) {
  if (!items || items.length === 0) {
    archiveGrid.innerHTML = `<div class="archive-empty">No items found in this profile.</div>`;
    return;
  }

  let html = `<div class="archive-grid">`;
  items.forEach((item, index) => {
    const isSelected = selectedArchiveItems.has(index);
    const thumbnail = item.thumbnail || "/icons/icon-192.png";
    const typeIcon = item.hasVideo ? "🎬" : item.hasImage ? "🖼️" : "📄";
    const duration = item.duration
      ? `${Math.floor(item.duration / 60)}:${String(Math.floor(item.duration % 60)).padStart(2, "0")}`
      : "";
    const title = item.title || "Untitled";
    const uploader = item.uploader || "";
    const views = item.viewCount ? `${item.viewCount}` : "";

    html += `
      <div class="archive-item ${isSelected ? "selected" : ""}" data-index="${index}">
        <div class="archive-item-checkbox">
          <input type="checkbox" ${isSelected ? "checked" : ""} data-index="${index}" />
        </div>
        <img class="archive-item-thumb" src="${thumbnail}" alt="${title}" loading="lazy"
             onerror="this.src='/icons/icon-192.png'" />
        <div class="archive-item-overlay">
          <span class="archive-item-type">${typeIcon}</span>
          ${duration ? `<span class="archive-item-duration">${duration}</span>` : ""}
        </div>
        <div class="archive-item-info">
          <p class="archive-item-title" title="${title}">${title}</p>
          <p class="archive-item-meta">${uploader} ${views ? `· ${views} views` : ""}</p>
        </div>
        <div class="archive-item-status"></div>
      </div>
    `;
  });
  html += `</div>`;
  archiveGrid.innerHTML = html;

  document.querySelectorAll(".archive-item-checkbox input").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      e.stopPropagation();
      const index = parseInt(e.target.dataset.index);
      if (e.target.checked) {
        selectedArchiveItems.add(index);
      } else {
        selectedArchiveItems.delete(index);
      }
      updateArchiveSelectionUI();
    });
  });

  document.querySelectorAll(".archive-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".archive-item-checkbox")) return;
      const index = parseInt(el.dataset.index);
      const cb = el.querySelector(".archive-item-checkbox input");
      if (cb) {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change"));
      }
    });
  });

  updateArchiveSelectionUI();
}

function updateArchiveSelectionUI() {
  const count = selectedArchiveItems.size;
  document.querySelectorAll(".archive-item").forEach((el) => {
    const index = parseInt(el.dataset.index);
    el.classList.toggle("selected", selectedArchiveItems.has(index));
  });

  if (archiveSelectAll) {
    archiveSelectAll.checked =
      selectedArchiveItems.size === archiveItems.length &&
      archiveItems.length > 0;
    archiveSelectAll.indeterminate =
      selectedArchiveItems.size > 0 &&
      selectedArchiveItems.size < archiveItems.length;
  }

  if (archiveDownloadSelected) {
    archiveDownloadSelected.textContent = `📥 Download Selected (${count})`;
    archiveDownloadSelected.disabled = count === 0;
  }

  updateArchiveCount();
}

function updateArchiveCount() {
  if (archiveCount) {
    archiveCount.textContent = `${archiveItems.length} items`;
  }
}

archiveSelectAll?.addEventListener("change", (e) => {
  if (e.target.checked) {
    archiveItems.forEach((_, i) => selectedArchiveItems.add(i));
  } else {
    selectedArchiveItems.clear();
  }
  updateArchiveSelectionUI();
  renderArchiveGrid(archiveItems);
});

archiveDownloadSelected?.addEventListener("click", async () => {
  if (selectedArchiveItems.size === 0) return;

  const items = Array.from(selectedArchiveItems).map((i) => archiveItems[i]);
  archiveDownloadSelected.disabled = true;
  archiveDownloadSelected.textContent = "⏳ Preparing...";

  try {
    const res = await fetch(`${API_BASE}/download/profile/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Batch download failed");

    archiveBatchId = data.batchId;
    pollBatchStatus(data.batchId);
  } catch (err) {
    showArchiveError(err.message);
    archiveDownloadSelected.disabled = false;
    archiveDownloadSelected.textContent = `📥 Download Selected (${selectedArchiveItems.size})`;
  }
});

function pollBatchStatus(batchId) {
  let attempts = 0;
  const maxAttempts = 300;

  const interval = setInterval(async () => {
    attempts++;
    try {
      const res = await fetch(`${API_BASE}/download/batch/status/${batchId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      archiveProgress.classList.remove("hidden");
      archiveProgressFill.style.width = `${data.progress || 0}%`;
      archiveProgressLabel.textContent = `Downloading ${data.processed || 0}/${data.total || 0}...`;

      if (data.items) {
        data.items.forEach((item, i) => {
          const el = document.querySelector(`.archive-item[data-index="${i}"]`);
          if (el) {
            const statusEl = el.querySelector(".archive-item-status");
            if (statusEl) {
              const icons = {
                done: "✅",
                processing: "⏳",
                error: "❌",
                pending: "⏸️",
              };
              statusEl.textContent = icons[item.status] || "⏸️";
            }
          }
        });
      }

      if (data.status === "done") {
        clearInterval(interval);
        archiveProgress.classList.add("hidden");
        archiveDownloadSelected.disabled = false;
        archiveDownloadSelected.textContent = `📥 Download Selected (${selectedArchiveItems.size})`;

        const doneItems = data.items.filter((i) => i.status === "done");
        // Auto-save all done items
        for (const item of doneItems) {
          if (item.fileUrl) {
            const ext = item.hasVideo ? "mp4" : "jpg";
            await saveMediaToDevice(
              item.fileUrl,
              `seize-archive-${Date.now()}.${ext}`,
            );
          }
        }
        if (doneItems.length > 0) {
          showBatchSuccess(doneItems);
        }
      } else if (data.status === "error") {
        clearInterval(interval);
        showArchiveError(data.error || "Batch download failed");
        archiveDownloadSelected.disabled = false;
        archiveDownloadSelected.textContent = `📥 Download Selected (${selectedArchiveItems.size})`;
        archiveProgress.classList.add("hidden");
      }

      if (attempts >= maxAttempts) {
        clearInterval(interval);
        showArchiveError("Batch download timed out");
        archiveDownloadSelected.disabled = false;
        archiveDownloadSelected.textContent = `📥 Download Selected (${selectedArchiveItems.size})`;
        archiveProgress.classList.add("hidden");
      }
    } catch (err) {
      clearInterval(interval);
      showArchiveError(err.message);
      archiveDownloadSelected.disabled = false;
      archiveDownloadSelected.textContent = `📥 Download Selected (${selectedArchiveItems.size})`;
      archiveProgress.classList.add("hidden");
    }
  }, 2000);
}

function showBatchSuccess(items) {
  const container = document.getElementById("archive-batch-success");
  if (!container) return;

  let html = `
    <div class="batch-success">✅ ${items.length} item(s) downloaded and saved!</div>
    <div class="batch-success-items">
  `;

  items.slice(0, 5).forEach((item) => {
    html += `<div class="batch-success-item">📄 ${item.title || "Untitled"}</div>`;
  });

  if (items.length > 5) {
    html += `<div class="batch-success-more">...and ${items.length - 5} more</div>`;
  }

  html += `
    </div>
    <button class="btn-secondary" onclick="document.getElementById('archive-batch-success').innerHTML = ''; document.getElementById('archive-batch-success').classList.add('hidden')">
      Dismiss
    </button>
  `;

  container.innerHTML = html;
  container.classList.remove("hidden");
  setTimeout(() => {
    container.classList.add("hidden");
    setTimeout(() => (container.innerHTML = ""), 500);
  }, 10000);
}

function showArchiveError(msg) {
  const errorEl = document.getElementById("archive-error");
  if (errorEl) {
    errorEl.textContent = msg;
    errorEl.classList.remove("hidden");
    setTimeout(() => errorEl.classList.add("hidden"), 8000);
  }
}

archiveClear?.addEventListener("click", () => {
  archiveItems = [];
  selectedArchiveItems.clear();
  archiveGrid.innerHTML = `<div class="archive-empty">Enter a profile URL above to get started.</div>`;
  archiveStatus.classList.add("hidden");
  archiveStatus.textContent = "";
  document.getElementById("archive-batch-success")?.classList.add("hidden");
  document.getElementById("archive-batch-success").innerHTML = "";
  archiveInput.value = "";
  updateArchiveCount();
});

updateOfflineBanner();
if (navigator.onLine) processOfflineQueue();

console.log("✅ seize app loaded successfully");
console.log("🔗 API Base:", API_BASE);

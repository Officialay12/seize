// @ts-nocheck
const API_BASE = "https://seize-iw4w.onrender.com/api";

// ============================================================
// PRELOADER
// ============================================================
!(function () {
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
// PERMISSIONS
// ============================================================
const PERMISSION_KEY = "seize_permissions_granted";

async function requestAppPermissions() {
  const granted = localStorage.getItem(PERMISSION_KEY);
  if (granted === "true") return;
  if (granted === "false") return;

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
      <li>🔔 Send notifications when downloads are ready</li>
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

  allowBtn.addEventListener("click", async () => {
    try {
      if ("Notification" in window && Notification.permission === "default") {
        if ((await Notification.requestPermission()) === "granted") {
          subscribeToPush();
        }
      } else if (Notification.permission === "granted") {
        subscribeToPush();
      }
      localStorage.setItem(PERMISSION_KEY, "true");
      banner.remove();
    } catch (e) {
      console.warn("[seize] Permission request failed:", e);
      banner.remove();
    }
  });

  denyBtn.addEventListener("click", () => {
    localStorage.setItem(PERMISSION_KEY, "false");
    banner.remove();
  });

  laterBtn.addEventListener("click", () => {
    banner.remove();
    setTimeout(requestAppPermissions, 300000);
  });
}

// ============================================================
// OFFLINE QUEUE SYSTEM
// ============================================================
const IDB_NAME = "seize-pending";
const IDB_STORE = "files";
const QUEUE_STORE = "offline-queue";

function openPendingDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("files")) {
        db.createObjectStore("files");
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
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").put(
        { blob: file, name: file.name, type: file.type, ...meta },
        "convert",
      );
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn("[seize] Could not persist pending file:", e);
  }
}

async function loadPendingFile() {
  try {
    const db = await openPendingDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("files", "readonly");
      const req = tx.objectStore("files").get("convert");
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
    db.transaction("files", "readwrite").objectStore("files").delete("convert");
  } catch {}
}

async function addToOfflineQueue(item) {
  try {
    const db = await openPendingDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(QUEUE_STORE, "readwrite");
      tx.objectStore(QUEUE_STORE).add({ ...item, queuedAt: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn("[seize] Could not queue offline request:", e);
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
    db.transaction(QUEUE_STORE, "readwrite")
      .objectStore(QUEUE_STORE)
      .delete(id);
  } catch {}
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

        await pollJob(`${API_BASE}/download/status/${data.jobId}`, null, null);
        const ext =
          item.mode === "audio" ? "mp3" : item.mode === "image" ? "jpg" : "mp4";
        const fileUrl = `${API_BASE}/download/file/${data.jobId}`;
        await saveMediaToDevice(
          fileUrl,
          `seize-${item.mode}-${Date.now()}.${ext}`,
        );
        notifyJobDone(
          "Queued job finished",
          `${item.title || "Media"} saved automatically.`,
        );
      } else if (item.kind === "convert") {
        const form = new FormData();
        form.append("file", item.blob, item.name);
        const endpoint =
          item.target === "v2a" ? "video-to-audio" : "audio-to-video";
        if (item.target === "v2a") form.append("format", item.format || "mp3");

        const res = await fetch(`${API_BASE}/convert/${endpoint}`, {
          method: "POST",
          body: form,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "convert retry failed");

        await pollJob(`${API_BASE}/convert/status/${data.jobId}`, null, null);
        const ext = item.target === "v2a" ? item.format || "mp3" : "mp4";
        const fileUrl = `${API_BASE}/convert/download/${data.jobId}`;
        await saveMediaToDevice(
          fileUrl,
          `seize-converted-${Date.now()}.${ext}`,
        );
        notifyJobDone(
          "Queued conversion finished",
          `${item.name || "Your file"} converted and saved automatically.`,
        );
      }
      await removeFromOfflineQueue(item.id);
    } catch (e) {
      console.warn("[seize] Offline queue item failed, will retry later:", e);
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

  const items = await getOfflineQueue();
  if (items.length > 0) {
    banner.textContent = `⏳ Back online — sending ${items.length} queued request${items.length > 1 ? "s" : ""}…`;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

// ============================================================
// POLL JOB - FIXED: handles null progress elements
// ============================================================
function pollJob(url, progressFill, progressLabel) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = 60;

    const interval = setInterval(async () => {
      attempts++;
      try {
        const res = await fetch(url);
        const data = await res.json();

        if (data.status === "done") {
          clearInterval(interval);
          if (progressFill) progressFill.style.width = "100%";
          if (progressLabel) progressLabel.textContent = "✅ Done!";
          resolve(data);
          return;
        } else if (data.status === "error") {
          clearInterval(interval);
          reject(new Error(data.error || "Processing failed."));
          return;
        } else {
          if (progressFill) {
            progressFill.style.width = `${data.progress || 10}%`;
          }
          if (progressLabel) {
            progressLabel.textContent = `Processing... ${data.progress || 0}%`;
          }
        }

        if (attempts >= maxAttempts) {
          clearInterval(interval);
          reject(new Error("Download timed out. Please try again."));
        }
      } catch (e) {
        clearInterval(interval);
        reject(e);
      }
    }, 1000);
  });
}

// ============================================================
// EXTRACT PLATFORM URL
// ============================================================
function extractPlatformUrl(text) {
  if (!text) return null;
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
    /https?:\/\/[^\s]*(reddit\.com\/[^\s]+)/i,
    /https?:\/\/[^\s]*(imgur\.com\/[^\s]+)/i,
    /https?:\/\/[^\s]*(giphy\.com\/[^\s]+)/i,
    /https?:\/\/[^\s]*(vimeo\.com\/[^\s]+)/i,
    /https?:\/\/[^\s]*(dailymotion\.com\/[^\s]+)/i,
    /https?:\/\/[^\s]*(twitch\.tv\/[^\s]+)/i,
    /https?:\/\/[^\s]*(soundcloud\.com\/[^\s]+)/i,
    /https?:\/\/[^\s]*(spotify\.com\/[^\s]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const urlMatch = text.match(/https?:\/\/[^\s]+/i);
      return urlMatch ? urlMatch[0] : match[0];
    }
  }

  const fallback = text.match(/https?:\/\/[^\s]+/gi);
  return fallback && fallback.length > 0 ? fallback[0] : null;
}

// ============================================================
// PROCESS SHARED URL
// ============================================================
function processSharedUrl(url, mode) {
  console.log("[seize] Processing shared URL:", url);
  document.querySelector('[data-mode="capture"]')?.click();
  const input = document.getElementById("url-input");
  if (input) {
    input.value = url;
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new Event("change"));
  }
  setTimeout(() => {
    const btn = document.getElementById("resolve-btn");
    if (btn) btn.click();
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
// ONLINE/OFFLINE HANDLING
// ============================================================
window.addEventListener("online", () => {
  updateOfflineBanner();
  processOfflineQueue();
});
window.addEventListener("offline", () => updateOfflineBanner());

// ============================================================
// SHARED URL HANDLER
// ============================================================
(function () {
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

  const params = new URLSearchParams(window.location.search);
  const paramUrl =
    params.get("share_url") || params.get("url") || params.get("text");
  if (paramUrl && !sharedUrl) {
    const extracted = extractPlatformUrl(paramUrl);
    if (extracted) {
      console.log("[seize] Found shared URL in params:", extracted);
      sessionStorage.setItem("seize_shared_url", extracted);
      processSharedUrl(extracted, null);
    }
  }
})();

// ============================================================
// FILE SAVE HELPERS - OPTIMIZED FOR FAST DOWNLOADS
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
  avif: "image/avif",
};

const EXT_BY_MIME = Object.fromEntries(
  Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext]),
);

function resolveFileInfo(response, blob, fallbackName) {
  let name = fallbackName;
  const cd = response.headers?.get?.("content-disposition") || "";
  const cdMatch = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (cdMatch && cdMatch[1]) {
    name = decodeURIComponent(cdMatch[1]);
  }

  let ext = (name.split(".").pop() || "").toLowerCase();
  if (!MIME_BY_EXT[ext]) {
    const mimeExt = EXT_BY_MIME[blob.type];
    if (mimeExt) {
      ext = mimeExt;
      const baseName = name.includes(".")
        ? name.slice(0, name.lastIndexOf("."))
        : name;
      name = `${baseName}.${ext}`;
    }
  }

  return {
    name: name,
    mimeType: MIME_BY_EXT[ext] || blob.type || "application/octet-stream",
  };
}

// ============================================================
// OPTIMIZED FAST DOWNLOAD - Downloads Immediately
// ============================================================
async function saveMediaToDevice(url, fallbackName) {
  let response, blob;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });
    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    blob = await response.blob();
  } catch (err) {
    console.error("[seize] fetch failed:", err);
    window.open(url, "_blank");
    showToast("⚠️ Opening in new tab - please save manually", "warning");
    return;
  }

  const { name, mimeType } = resolveFileInfo(response, blob, fallbackName);
  const file = new File([blob], name, { type: mimeType });

  const isAndroid = /Android/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

  // ============================================================
  // ANDROID - Direct download
  // ============================================================
  if (isAndroid) {
    try {
      const urlObj = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = urlObj;
      a.download = name;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      showToast("✅ Downloading to device...", "success");
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(urlObj);
      }, 3000);
      return;
    } catch (e) {
      console.warn("[seize] Android download failed:", e);
    }
  }

  // ============================================================
  // iOS - Share sheet or direct download
  // ============================================================
  if (isIOS) {
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
          showToast("✅ Saved to device!", "success");
          return;
        } catch (e) {
          if (e?.name === "AbortError") return;
          console.warn("[seize] iOS share failed:", e);
        }
      }

      const urlObj = URL.createObjectURL(blob);
      if (mimeType.startsWith("image/")) {
        const win = window.open("", "_blank");
        if (win) {
          win.document.write(`
            <html>
              <head>
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>${name}</title>
                <style>
                  body { margin: 0; display: flex; justify-content: center; align-items: center; height: 100vh; background: #000; }
                  img { max-width: 100%; max-height: 100%; object-fit: contain; }
                </style>
              </head>
              <body>
                <img src="${urlObj}" alt="${name}" />
                <script>
                  setTimeout(() => {
                    const a = document.createElement('a');
                    a.href = '${urlObj}';
                    a.download = '${name}';
                    a.click();
                  }, 500);
                <\/script>
              </body>
            </html>
          `);
          showToast("✅ Image opened - long press to save", "success");
          return;
        }
      }

      const a = document.createElement("a");
      a.href = urlObj;
      a.download = name;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(urlObj);
      }, 3000);
      showToast("✅ Download started!", "success");
      return;
    } catch (e) {
      console.warn("[seize] iOS save failed:", e);
    }
  }

  // ============================================================
  // DESKTOP / FALLBACK - Direct download
  // ============================================================
  try {
    const urlObj = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = urlObj;
    a.download = name;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    showToast("✅ Download started!", "success");
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(urlObj);
    }, 3000);
    return;
  } catch (e) {
    console.warn("[seize] download failed:", e);
  }

  // ============================================================
  // ULTIMATE FALLBACK - Open in new tab
  // ============================================================
  console.warn("[seize] All download methods failed, opening in new tab");
  window.open(url, "_blank");
  showToast("⚠️ Opening in new tab - please save manually", "warning");
}

function showToast(message, type = "info") {
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
    border-left: 3px solid ${colors[type] || "#7FFFB0"};
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

function showRecognizedTrack(track, container) {
  const parent =
    container || document.getElementById("convert-progress")?.parentElement;
  if (!parent) return;

  const existing = parent.querySelector(".recognized-track");
  if (existing) existing.remove();

  const div = document.createElement("div");
  div.className = "recognized-track mono small";

  const label = document.createElement("span");
  label.textContent = "🎵 Identified: ";
  div.appendChild(label);

  const strong = document.createElement("strong");
  const parts = [track.artist, track.title].filter(Boolean);
  strong.textContent = parts.length ? parts.join(" – ") : "Unknown track";
  div.appendChild(strong);

  if (track.album) {
    const album = document.createElement("span");
    album.className = "recognized-track-album";
    album.textContent = ` (${track.album})`;
    div.appendChild(album);
  }

  parent.appendChild(div);
}

// ============================================================
// HISTORY SYSTEM
// ============================================================
const HISTORY_KEY = "seize_history";
const MAX_HISTORY_ITEMS = 50;

function loadHistory() {
  try {
    const data = localStorage.getItem(HISTORY_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function saveHistoryList(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch (e) {
    console.warn("[seize] Could not save history:", e);
  }
}

function addHistoryEntry(entry) {
  const history = loadHistory();
  history.unshift({
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
  });
  saveHistoryList(history.slice(0, MAX_HISTORY_ITEMS));
  renderHistory();
}

function removeHistoryEntry(id) {
  const history = loadHistory().filter((item) => item.id !== id);
  saveHistoryList(history);
  renderHistory();
}

function clearAllHistory() {
  saveHistoryList([]);
  renderHistory();
}

function formatHistoryDate(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return isToday ? `Today, ${time}` : `${date.toLocaleDateString()}, ${time}`;
}

function historySubtitle(entry) {
  const time = formatHistoryDate(entry.timestamp);
  if (entry.type === "resolve") {
    return `${(entry.platform || "link").toUpperCase()} · Resolved · ${time}`;
  } else if (entry.type === "download") {
    return `${entry.mode?.toUpperCase() || "FILE"} downloaded · ${time}`;
  } else if (entry.type === "convert") {
    return `${entry.direction} · .${entry.outFormat} · ${time}`;
  }
  return time;
}

function renderHistory() {
  const history = loadHistory();
  const list = document.getElementById("history-list");
  const empty = document.getElementById("history-empty");
  if (!list || !empty) return;

  list.innerHTML = "";

  if (history.length === 0) {
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");

  history.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "history-item";

    const thumb = document.createElement("img");
    thumb.className = "history-thumb";
    thumb.alt = "";
    thumb.src = entry.thumbnail || "icons/icon-192.png";
    thumb.onerror = () => {
      thumb.src = "icons/icon-192.png";
    };

    const meta = document.createElement("div");
    meta.className = "history-meta";

    const title = document.createElement("p");
    title.className = "history-title";
    title.textContent = entry.title || "Untitled";

    const sub = document.createElement("p");
    sub.className = "mono small history-sub";
    sub.textContent = historySubtitle(entry);

    meta.appendChild(title);
    meta.appendChild(sub);

    const actions = document.createElement("div");
    actions.className = "history-actions";

    if (entry.url) {
      const resolveBtn = document.createElement("button");
      resolveBtn.type = "button";
      resolveBtn.className = "history-action-btn";
      resolveBtn.textContent = "Resolve again";
      resolveBtn.addEventListener("click", () => {
        document.querySelector('[data-mode="capture"]')?.click();
        const input = document.getElementById("url-input");
        if (input) {
          input.value = entry.url;
          document
            .getElementById("capture-form")
            ?.dispatchEvent(new Event("submit", { cancelable: true }));
        }
      });
      actions.appendChild(resolveBtn);
    }

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "history-remove-btn";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove from history";
    removeBtn.addEventListener("click", () => removeHistoryEntry(entry.id));
    actions.appendChild(removeBtn);

    item.appendChild(thumb);
    item.appendChild(meta);
    item.appendChild(actions);
    list.appendChild(item);
  });
}

function loadThumbnail(src, img) {
  if (!src) {
    img.src = "";
    img.style.display = "none";
    return;
  }

  let url = src;
  if (url.startsWith("http://")) {
    url = url.replace("http://", "https://");
  }

  if (
    url.includes("tiktokcdn.com") ||
    url.includes("fbcdn.net") ||
    url.includes("cdninstagram.com") ||
    url.includes("twimg.com")
  ) {
    url = url + (url.includes("?") ? "&" : "?") + "_t=" + Date.now();
  }

  img.src = url;
  img.style.display = "block";
  img.onerror = function () {
    console.warn("Failed to load thumbnail:", url);
    if (url.includes("_t=")) {
      const base = url.split("_t=")[0];
      img.src = base;
      img.onerror = function () {
        this.style.display = "none";
      };
    } else {
      this.style.display = "none";
    }
  };
}

document.getElementById("clear-history-btn")?.addEventListener("click", () => {
  if (confirm("Clear all history?")) {
    clearAllHistory();
  }
});

renderHistory();

// ============================================================
// SCOPE OSCILLOSCOPE
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
  let points = [];
  for (let i = 0; i < POINTS; i++) {
    const x = (i / (POINTS - 1)) * 600;
    const wave = 0.3 * Math.sin(0.6 * i + 3 * t);
    const y =
      80 +
      Math.sin(0.35 * i + t) * scopeAmplitude +
      wave * scopeAmplitude * 0.4;
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  scopeTrace.setAttribute("points", points.join(" "));
  scopeFreq.textContent = `${(11.3 * scopeAmplitude).toFixed(1)} Hz`;
  requestAnimationFrame(drawScope);
}

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

requestAnimationFrame(drawScope);

// ============================================================
// MODE SWITCHING
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
    Object.entries(panels).forEach(([key, panel]) => {
      panel.setAttribute("data-active", key === mode ? "true" : "false");
    });
    sessionStorage.setItem("seize_active_tab", mode);
  });
});

const savedTab = sessionStorage.getItem("seize_active_tab");
if (savedTab && panels[savedTab]) {
  document.querySelector(`[data-mode="${savedTab}"]`)?.click();
}

// ============================================================
// CAPTURE FUNCTIONALITY - COMPLETELY FIXED
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

// ============================================================
// PLATFORM CONFIGURATION - AUDIO-ONLY FIXED
// ============================================================
const PLATFORM_CONFIG = {
  tiktok: {
    hasVideo: true,
    hasAudio: true,
    hasImage: true,
    defaultMode: "video",
  },
  instagram: {
    hasVideo: true,
    hasAudio: true,
    hasImage: true,
    defaultMode: "video",
  },
  twitter: {
    hasVideo: true,
    hasAudio: true,
    hasImage: true,
    defaultMode: "video",
  },
  facebook: {
    hasVideo: true,
    hasAudio: true,
    hasImage: true,
    defaultMode: "video",
  },
  youtube: {
    hasVideo: true,
    hasAudio: true,
    hasImage: false,
    defaultMode: "video",
  },
  vimeo: {
    hasVideo: true,
    hasAudio: true,
    hasImage: false,
    defaultMode: "video",
  },
  twitch: {
    hasVideo: true,
    hasAudio: true,
    hasImage: false,
    defaultMode: "video",
  },
  dailymotion: {
    hasVideo: true,
    hasAudio: true,
    hasImage: false,
    defaultMode: "video",
  },
  pinterest: {
    hasVideo: false,
    hasAudio: false,
    hasImage: true,
    defaultMode: "image",
  },
  imgur: {
    hasVideo: false,
    hasAudio: false,
    hasImage: true,
    defaultMode: "image",
  },
  giphy: {
    hasVideo: false,
    hasAudio: false,
    hasImage: true,
    defaultMode: "image",
  },
  snapchat: {
    hasVideo: false,
    hasAudio: false,
    hasImage: true,
    defaultMode: "image",
  },
  soundcloud: {
    hasVideo: false,
    hasAudio: true,
    hasImage: false,
    defaultMode: "audio",
    isAudioOnly: true,
  },
  spotify: {
    hasVideo: false,
    hasAudio: true,
    hasImage: false,
    defaultMode: "audio",
    isAudioOnly: true,
  },
  reddit: {
    hasVideo: true,
    hasAudio: false,
    hasImage: true,
    defaultMode: "video",
  },
};

function getPlatformConfig(platform) {
  return (
    PLATFORM_CONFIG[platform] || {
      hasVideo: true,
      hasAudio: true,
      hasImage: true,
      defaultMode: "video",
      isAudioOnly: false,
    }
  );
}

function isAudioOnlyPlatform(platform) {
  return platform === "spotify" || platform === "soundcloud";
}

// ============================================================
// UPDATE RESULT BUTTONS - COMPLETELY FIXED
// ============================================================
function updateResultButtons(data) {
  const qualityRow = document.getElementById("quality-row");
  const qualitySelect = document.getElementById("quality-select");
  const platform = data.platform || "unknown";
  const config = getPlatformConfig(platform);

  const audioOnly = isAudioOnlyPlatform(platform);

  const supportsVideo = !audioOnly && (config.hasVideo || data.hasVideo);
  const supportsAudio =
    config.hasAudio ||
    data.media?.audio?.length > 0 ||
    data.hasVideo ||
    audioOnly;
  const supportsImage =
    !audioOnly &&
    (config.hasImage || data.hasImage || data.contentType === "image");

  // VIDEO BUTTON
  if (supportsVideo) {
    fetchVideoBtn.style.display = "inline-flex";
    fetchVideoBtn.textContent = "🎬 Download video";

    const heights = [
      ...new Set(
        (data.media?.videos || [])
          .map((v) => v.height)
          .filter((h) => Number.isFinite(h) && h > 0),
      ),
    ];
    heights.sort((a, b) => b - a);

    qualitySelect.innerHTML = '<option value="best">Best available</option>';
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

  // IMAGE BUTTON
  if (supportsImage) {
    fetchImageBtn.style.display = "inline-flex";
    fetchImageBtn.textContent = "🖼️ Download image";
  } else {
    fetchImageBtn.style.display = "none";
  }

  // AUDIO BUTTON
  if (supportsAudio) {
    fetchAudioBtn.style.display = "inline-flex";
    if (audioOnly) {
      fetchAudioBtn.textContent = "🎵 Download audio";
    } else if (data.hasVideo) {
      fetchAudioBtn.textContent = "🎵 Extract audio";
    } else {
      fetchAudioBtn.textContent = "🎵 Download audio";
    }
  } else {
    fetchAudioBtn.style.display = "none";
  }

  // Track info for SoundCloud/Spotify
  const metaDiv = document.querySelector(".result-meta");
  const existingTrackInfo = metaDiv.querySelector(".track-info");
  if (existingTrackInfo) existingTrackInfo.remove();

  if (audioOnly) {
    const trackInfo = document.createElement("div");
    trackInfo.className = "track-info mono small";
    trackInfo.innerHTML = `
      <span>🎵 </span>
      <strong>${data.title || "Unknown Track"}</strong>
      <span class="track-info-artist"> · ${data.uploader || "Unknown Artist"}</span>
      ${data.duration ? `<span class="track-info-duration"> · ${Math.floor(data.duration / 60)}:${String(Math.floor(data.duration % 60)).padStart(2, "0")}</span>` : ""}
    `;
    metaDiv.appendChild(trackInfo);
  }
}

function showCaptureError(message) {
  captureError.textContent = message;
  captureError.classList.remove("hidden");
}

function clearCaptureError() {
  captureError.classList.add("hidden");
  captureError.textContent = "";
}

// ============================================================
// OPTIMIZED RUN CAPTURE FETCH - Faster downloads
// ============================================================
async function runCaptureFetch(mode) {
  clearCaptureError();
  captureProgress.classList.remove("hidden");

  const audioOnly =
    lastResolvedItem && isAudioOnlyPlatform(lastResolvedItem.platform);

  if (audioOnly) {
    mode = "audio";
  }

  if (!mode || mode === "auto") {
    if (lastResolvedItem) {
      const config = getPlatformConfig(lastResolvedItem.platform);
      mode = config.defaultMode || "video";
    } else {
      mode = "video";
    }
  }

  let label = "FETCHING…";
  if (mode === "audio") label = "EXTRACTING AUDIO…";
  else if (mode === "image") label = "DOWNLOADING IMAGE…";
  else if (mode === "video") label = "FETCHING VIDEO…";

  captureProgressLabel.textContent = label;
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
      mode: mode,
      quality: quality,
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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    const res = await fetch(`${API_BASE}/download/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: currentUrl, mode: mode, quality: quality }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Fetch failed.");

    await pollJob(
      `${API_BASE}/download/status/${data.jobId}`,
      captureProgressFill,
      captureProgressLabel,
    );

    captureProgress.classList.add("hidden");
    setScopeState("done");

    const ext = mode === "audio" ? "mp3" : mode === "image" ? "jpg" : "mp4";
    const fileUrl = `${API_BASE}/download/file/${data.jobId}`;
    const platform = lastResolvedItem?.platform || "media";
    const filename = `seize-${platform}-${mode}-${Date.now()}.${ext}`;

    await saveMediaToDevice(fileUrl, filename);

    addHistoryEntry({
      type: "download",
      mode: mode,
      url: currentUrl,
      title: resultTitle.textContent || "Untitled",
      thumbnail: resultThumb.src || null,
      platform: platform,
    });

    const platformName = platform.charAt(0).toUpperCase() + platform.slice(1);
    notifyJobDone(
      "Your file is ready",
      `${resultTitle.textContent || platformName} saved to your device.`,
    );
  } catch (err) {
    showCaptureError(err.message);
    captureProgress.classList.add("hidden");
    setScopeState("idle");
  }
}

// URL Input detection
urlInput.addEventListener("input", () => {
  const text = urlInput.value.toLowerCase();
  chips.forEach((chip) => {
    const platform = chip.dataset.platform;
    const match =
      (platform === "tiktok" && text.includes("tiktok")) ||
      (platform === "instagram" && text.includes("instagram")) ||
      (platform === "twitter" &&
        (text.includes("twitter") || text.includes("x.com"))) ||
      (platform === "pinterest" &&
        (text.includes("pinterest") || text.includes("pin.it"))) ||
      (platform === "snapchat" && text.includes("snapchat")) ||
      (platform === "facebook" &&
        (text.includes("facebook") || text.includes("fb.watch"))) ||
      (platform === "youtube" &&
        (text.includes("youtube") || text.includes("youtu.be"))) ||
      (platform === "reddit" &&
        (text.includes("reddit") || text.includes("redd.it"))) ||
      (platform === "imgur" && text.includes("imgur")) ||
      (platform === "giphy" && text.includes("giphy")) ||
      (platform === "vimeo" && text.includes("vimeo")) ||
      (platform === "dailymotion" && text.includes("dailymotion")) ||
      (platform === "twitch" && text.includes("twitch")) ||
      (platform === "soundcloud" && text.includes("soundcloud")) ||
      (platform === "spotify" && text.includes("spotify"));
    chip.classList.toggle("match", match);
  });
});

// ============================================================
// CAPTURE FORM SUBMIT - COMPLETELY FIXED
// ============================================================
captureForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearCaptureError();
  captureResult.classList.add("hidden");

  const url = urlInput.value.trim();
  if (!url) return;

  currentUrl = url;

  if (!navigator.onLine) {
    queueOfflineRequest({ kind: "capture-resolve", url: url });
    showCaptureError(
      "You're offline — this will resolve automatically once you're back online.",
    );
    return;
  }

  resolveBtn.disabled = true;
  resolveBtn.textContent = "Resolving…";
  setScopeState("active");

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const res = await fetch(`${API_BASE}/download/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not resolve.");

    lastResolvedItem = {
      sourceUrl: url,
      platform: data.platform || null,
      title: data.title || "Untitled",
      thumbnail: data.thumbnail || null,
      contentType: data.contentType || null,
      hasVideo: data.hasVideo || false,
      hasImage: data.hasImage || false,
      media: data.media || { videos: [], images: [], audio: [] },
    };

    const audioOnly = isAudioOnlyPlatform(data.platform);

    if (audioOnly) {
      fetchImageBtn.style.display = "none";
      fetchVideoBtn.style.display = "none";
      fetchAudioBtn.style.display = "inline-flex";
      fetchAudioBtn.textContent = "🎵 Download audio";
      document.getElementById("quality-row").classList.add("hidden");

      resultTitle.textContent = data.title || `${data.platform} Track`;
      resultUploader.textContent = `${data.platform.toUpperCase()} · ${data.uploader || "Unknown Artist"}`;

      const metaDiv = document.querySelector(".result-meta");
      const existingTrackInfo = metaDiv.querySelector(".track-info");
      if (existingTrackInfo) existingTrackInfo.remove();

      const trackInfo = document.createElement("div");
      trackInfo.className = "track-info mono small";
      trackInfo.innerHTML = `
        <span>🎵 </span>
        <strong>${data.title || "Unknown Track"}</strong>
        <span class="track-info-artist"> · ${data.uploader || "Unknown Artist"}</span>
        ${data.duration ? `<span class="track-info-duration"> · ${Math.floor(data.duration / 60)}:${String(Math.floor(data.duration % 60)).padStart(2, "0")}</span>` : ""}
      `;
      metaDiv.appendChild(trackInfo);

      if (!data.thumbnail) {
        resultThumb.style.display = "none";
      }
    }

    if (data.thumbnail && !audioOnly) {
      loadThumbnail(data.thumbnail, resultThumb);
    } else if (!audioOnly) {
      resultThumb.style.display = "none";
    }

    if (!audioOnly) {
      resultTitle.textContent = data.title || "Untitled";
      let uploader = data.uploader || "unknown uploader";
      if (data.platform) {
        uploader = `${data.platform.toUpperCase()} · ${uploader}`;
      }
      resultUploader.textContent = uploader;
    }

    updateResultButtons(data);
    captureResult.classList.remove("hidden");
    setScopeState("done");

    addHistoryEntry({
      type: "resolve",
      url: url,
      title: data.title || "Untitled",
      thumbnail: data.thumbnail || null,
      platform: data.platform || null,
      contentType: data.contentType || null,
    });
  } catch (err) {
    const message =
      err?.name === "AbortError"
        ? "This is taking longer than expected. The link may still resolve — please try again in a moment."
        : err.message;
    showCaptureError(message);
    setScopeState("idle");
  } finally {
    resolveBtn.disabled = false;
    resolveBtn.textContent = "Resolve";
  }
});

// Fetch buttons
fetchVideoBtn.addEventListener("click", () => runCaptureFetch("video"));
fetchAudioBtn.addEventListener("click", () => runCaptureFetch("audio"));
fetchImageBtn.addEventListener("click", () => runCaptureFetch("image"));

// ============================================================
// COLLECTION BASKET
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
  } catch {}
}

function renderCollectionBasket() {
  const items = loadCollectionBasket();
  collectionBasketCountEl.textContent = String(items.length);
  collectionBasketEl.classList.toggle("hidden", items.length === 0);
}

function showShareLinkResult(url) {
  const existing = document.querySelector(".collection-share-result");
  if (existing) existing.remove();

  const div = document.createElement("div");
  div.className = "collection-share-result mono small";

  const p = document.createElement("p");
  p.textContent = "🎉 Your collection is ready:";
  div.appendChild(p);

  const row = document.createElement("div");
  row.className = "collection-share-link-row";

  const input = document.createElement("input");
  input.type = "text";
  input.readOnly = true;
  input.value = url;
  input.className = "text-input";
  row.appendChild(input);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "btn-secondary";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      copyBtn.textContent = "✅ Copied";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
    } catch {
      input.select();
    }
  });
  row.appendChild(copyBtn);

  div.appendChild(row);
  collectionBasketEl.insertAdjacentElement("afterend", div);
}

addToCollectionBtn?.addEventListener("click", () => {
  if (!lastResolvedItem) return;
  const items = loadCollectionBasket();
  if (items.some((item) => item.sourceUrl === lastResolvedItem.sourceUrl)) {
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

    const url = `${window.location.origin}/?c=${data.id}`;

    const myCollections = JSON.parse(
      localStorage.getItem("seize_my_collections") || "[]",
    );
    myCollections.push({
      id: data.id,
      ownerToken: data.ownerToken,
      createdAt: Date.now(),
      itemCount: items.length,
    });
    localStorage.setItem("seize_my_collections", JSON.stringify(myCollections));

    saveCollectionBasket([]);
    renderCollectionBasket();
    showShareLinkResult(url);
  } catch (err) {
    showCaptureError(err.message);
  } finally {
    collectionCreateBtn.disabled = false;
    collectionCreateBtn.textContent = "🔗 Create shareable link";
  }
});

renderCollectionBasket();

// ============================================================
// COLLECTION VIEW
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
  if (item.thumbnail) loadThumbnail(item.thumbnail, img);
  return img;
}

function renderCollectionItem(item) {
  const div = document.createElement("div");
  div.className = "collection-item";
  div.appendChild(collectionThumb(item));

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

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-secondary";
  btn.textContent = "Open in seize →";
  btn.addEventListener("click", () => {
    window.location.href = `/?resolve=${encodeURIComponent(item.sourceUrl)}`;
  });
  meta.appendChild(btn);

  div.appendChild(meta);
  return div;
}

async function loadCollectionView(id) {
  document.body.classList.add("collection-view-mode");
  document.querySelectorAll(".mode-switch, .hero").forEach((el) => {
    el.style.display = "none";
  });
  document.querySelectorAll(".panel").forEach((el) => {
    el.setAttribute("data-active", "false");
  });
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

(function () {
  const params = new URLSearchParams(window.location.search);
  const c = params.get("c");
  if (c) {
    loadCollectionView(c);
    return;
  }
  const resolve = params.get("resolve");
  if (resolve) {
    window.addEventListener("load", () => {
      urlInput.value = resolve;
      urlInput.dispatchEvent(new Event("input"));
      setTimeout(() => resolveBtn.click(), 300);
    });
  }
})();

// ============================================================
// QUEUE SYSTEM
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
    const div = document.createElement("div");
    div.className = "queue-item";

    const url = document.createElement("span");
    url.className = "queue-item-url";
    url.textContent = item.url;
    div.appendChild(url);

    const status = document.createElement("span");
    status.className = "queue-item-status";
    status.dataset.state = item.status;
    const statusText = {
      pending: "WAITING",
      processing: "WORKING…",
      done: "✓ DONE",
      error: "✕ FAILED",
    };
    status.textContent = statusText[item.status] || "WAITING";
    div.appendChild(status);

    if (item.status !== "processing") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "queue-item-remove";
      remove.textContent = "✕";
      remove.addEventListener("click", () => {
        batchQueue = batchQueue.filter((q) => q.id !== item.id);
        renderQueue();
      });
      div.appendChild(remove);
    }

    queueList.appendChild(div);
  });
}

function addLinksToQueue(urls) {
  urls.forEach((url) => {
    if (!batchQueue.some((item) => item.url === url)) {
      batchQueue.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        url: url,
        status: "pending",
      });
    }
  });
  renderQueue();
}

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

    const config = getPlatformConfig(resolveData.platform);
    let mode = config.defaultMode || "video";

    if (isAudioOnlyPlatform(resolveData.platform)) {
      mode = "audio";
    }

    if (mode === "video" && !resolveData.hasVideo) {
      mode = resolveData.hasImage ? "image" : "audio";
    } else if (mode === "image" && !resolveData.hasImage) {
      mode = resolveData.hasVideo ? "video" : "audio";
    }

    const fetchRes = await fetch(`${API_BASE}/download/fetch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: item.url, mode: mode, quality: "best" }),
    });
    const fetchData = await fetchRes.json();
    if (!fetchRes.ok) throw new Error(fetchData.error || "Fetch failed.");

    await pollJob(`${API_BASE}/download/status/${fetchData.jobId}`, null, null);
    item.status = "done";

    const ext = mode === "audio" ? "mp3" : mode === "image" ? "jpg" : "mp4";
    item.fileUrl = `${API_BASE}/download/file/${fetchData.jobId}`;
    await saveMediaToDevice(item.fileUrl, `seize-batch-${Date.now()}.${ext}`);

    addHistoryEntry({
      type: "download",
      mode: mode,
      url: item.url,
      title: resolveData.title || "Untitled",
      thumbnail: resolveData.thumbnail || null,
      platform: resolveData.platform || null,
    });
  } catch (err) {
    item.status = "error";
    item.error = err.message;
  }
  renderQueue();
}

queueAddBtn.addEventListener("click", () => {
  const url = urlInput.value.trim();
  if (url) {
    addLinksToQueue([url]);
    urlInput.value = "";
    urlInput.dispatchEvent(new Event("input"));
  }
});

urlInput.addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text") || "";
  const urls = text.match(LINK_TOKEN_RE) || [];
  if (urls.length > 1) {
    e.preventDefault();
    addLinksToQueue(urls);
  }
});

queueClearBtn.addEventListener("click", () => {
  if (!queueRunning) {
    batchQueue = [];
    renderQueue();
  }
});

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
    if (item.status === "pending") {
      await processQueueItem(item);
    }
  }

  queueRunning = false;
  queueStartBtn.disabled = false;
  queueStartBtn.textContent = "▶ Start queue";

  const done = batchQueue.filter((item) => item.status === "done").length;
  notifyJobDone(
    "Batch queue finished",
    `${done} item(s) saved to your device.`,
  );
});

// ============================================================
// CONVERT FUNCTIONALITY
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
const convertBtn = document.getElementById("convert-btn");
const convertProgress = document.getElementById("convert-progress");
const convertProgressFill = document.getElementById("convert-progress-fill");
const convertProgressLabel = document.getElementById("convert-progress-label");
const convertError = document.getElementById("convert-error");
const convertRestoreBanner = document.getElementById("convert-restore-banner");

let convertTarget = "v2a";
let selectedFile = null;
const LAST_FORMAT_KEY = "seize_last_format";

function lastUsedFormat(format, set) {
  if (set && format) {
    localStorage.setItem(LAST_FORMAT_KEY, format);
  }
  if (!set) {
    return localStorage.getItem(LAST_FORMAT_KEY);
  }
}

(function () {
  const format = lastUsedFormat();
  if (format) {
    const select = document.getElementById("format-select");
    if (select) select.value = format;
  }
})();

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
  dropzonePreviewSize.textContent = `${(file.size / 1048576).toFixed(2)} MB`;

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
    } catch {}
    savePendingFile(file, { target: convertTarget }).then(() => {
      try {
        sessionStorage.removeItem("seize_pending_flag");
      } catch {}
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
  } catch {}
}

function showRestoreBanner(message) {
  convertRestoreBanner.textContent = message;
  convertRestoreBanner.classList.remove("hidden");
  setTimeout(() => convertRestoreBanner.classList.add("hidden"), 8000);
}

function showConvertError(message) {
  convertError.textContent = message;
  convertError.classList.remove("hidden");
}

function clearConvertError() {
  convertError.classList.add("hidden");
  convertError.textContent = "";
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
      document.getElementById("format-select").innerHTML = `
        <option value="mp3">MP3</option>
        <option value="wav">WAV</option>
        <option value="aac">AAC</option>
        <option value="flac">FLAC</option>
        <option value="ogg">OGG</option>
      `;
      const saved = lastUsedFormat();
      if (saved) document.getElementById("format-select").value = saved;
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

(async function () {
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
    } catch {}
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
      `⚠ Your browser closed the tab while "${flag.name}" was loading — please pick it again.`,
    );
    try {
      sessionStorage.removeItem("seize_pending_flag");
    } catch {}
  }
})();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && selectedFile) {
    console.log(
      "[seize] Tab hidden while a file is selected — persistence flag already written.",
    );
  }
});

convertBtn.addEventListener("click", async () => {
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

  const form = new FormData();
  form.append("file", selectedFile);
  const endpoint =
    convertTarget === "v2a" ? "video-to-audio" : "audio-to-video";
  if (convertTarget === "v2a") {
    form.append("format", document.getElementById("format-select").value);
  }

  try {
    const uploadRes = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_BASE}/convert/${endpoint}`);
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
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
      xhr.send(form);
    });

    const jobData = await pollJob(
      `${API_BASE}/convert/status/${uploadRes.jobId}`,
      convertProgressFill,
      convertProgressLabel,
    );

    convertProgress.classList.add("hidden");
    setScopeState("done");

    const ext =
      convertTarget === "v2a"
        ? document.getElementById("format-select").value
        : "mp4";
    const fileUrl = `${API_BASE}/convert/download/${uploadRes.jobId}`;

    if (jobData?.recognizedTrack?.title || jobData?.recognizedTrack?.artist) {
      showRecognizedTrack(jobData.recognizedTrack);
    }

    await saveMediaToDevice(fileUrl, `seize-converted-${Date.now()}.${ext}`);
    addHistoryEntry({
      type: "convert",
      direction: convertTarget === "v2a" ? "Video → Audio" : "Audio → Video",
      title: selectedFile?.name || "Converted file",
      outFormat: ext,
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
// SHARED FILE HANDLER
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
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
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
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
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

// ============================================================
// CLIPBOARD DETECTION
// ============================================================
const CLIPBOARD_LINK_RE =
  /https?:\/\/[^\s]*(tiktok\.com|instagram\.com|twitter\.com|x\.com|pinterest\.com|pin\.it|snapchat\.com|facebook\.com|fb\.watch|youtube\.com|youtu\.be|reddit\.com|imgur\.com|giphy\.com|vimeo\.com|dailymotion\.com|twitch\.tv|soundcloud\.com|spotify\.com)[^\s]*/i;
let lastClipboardSuggestion = "";

async function checkClipboardForLink() {
  if (!navigator.clipboard || !navigator.clipboard.readText) return;

  for (let i = 0; i < 4 && !document.hasFocus(); i++) {
    await new Promise((r) => setTimeout(r, 150));
  }

  try {
    const text = await navigator.clipboard.readText();
    const match = text && text.match(CLIPBOARD_LINK_RE);
    if (!match) return;
    const url = match[0];
    if (url === lastClipboardSuggestion) return;
    if (urlInput.value.trim() === url) return;
    lastClipboardSuggestion = url;
    showClipboardSuggestion(url);
  } catch {}
}

function showClipboardSuggestion(url) {
  const existing = document.querySelector(".clipboard-suggestion");
  if (existing) existing.remove();

  const div = document.createElement("div");
  div.className = "clipboard-suggestion mono small";

  const span = document.createElement("span");
  span.textContent = "📋 Link found on clipboard — use it?";
  div.appendChild(span);

  const useBtn = document.createElement("button");
  useBtn.type = "button";
  useBtn.className = "clipboard-use-btn";
  useBtn.textContent = "Use it";
  useBtn.addEventListener("click", () => {
    document.querySelector('[data-mode="capture"]')?.click();
    urlInput.value = url;
    urlInput.dispatchEvent(new Event("input"));
    div.remove();
  });
  div.appendChild(useBtn);

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "clipboard-dismiss-btn";
  dismissBtn.textContent = "✕";
  dismissBtn.addEventListener("click", () => div.remove());
  div.appendChild(dismissBtn);

  document.body.appendChild(div);
  setTimeout(() => div.remove(), 12000);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    checkClipboardForLink();
  }
});
window.addEventListener("focus", checkClipboardForLink);

pasteBtn?.addEventListener("click", async () => {
  if (navigator.clipboard && navigator.clipboard.readText) {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        showCaptureError("Clipboard is empty.");
        return;
      }
      const match = text.match(CLIPBOARD_LINK_RE);
      const url = match ? match[0] : text.trim();
      urlInput.value = url;
      urlInput.dispatchEvent(new Event("input"));
      urlInput.focus();
      clearCaptureError();
    } catch {
      showCaptureError(
        "Couldn't read the clipboard — your browser may have blocked it. Try pasting manually.",
      );
    }
  } else {
    showCaptureError("Clipboard access isn't supported in this browser.");
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
  const hasPermission = await ensureNotificationPermission();
  if (hasPermission && document.visibilityState !== "visible") {
    try {
      if (navigator.serviceWorker) {
        const sw = await navigator.serviceWorker.ready;
        sw.showNotification(title, {
          body: body,
          icon: "icons/icon-192.png",
          badge: "icons/icon-192.png",
        });
      } else {
        new Notification(title, {
          body: body,
          icon: "icons/icon-192.png",
        });
      }
    } catch (e) {
      console.warn("[seize] Notification failed:", e);
    }
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

async function subscribeToPush() {
  if (
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    Notification.permission !== "granted"
  ) {
    return;
  }
  try {
    const sw = await navigator.serviceWorker.ready;
    let subscription = await sw.pushManager.getSubscription();
    if (!subscription) {
      const res = await fetch(`${API_BASE}/push/public-key`);
      const { publicKey } = await res.json();
      if (!publicKey) return;
      subscription = await sw.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    await fetch(`${API_BASE}/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription }),
    });
    localStorage.setItem("seize_push_endpoint", subscription.endpoint);
  } catch (e) {
    console.warn("[seize] push subscribe failed:", e);
  }
}

async function pingPushSubscription() {
  const endpoint = localStorage.getItem("seize_push_endpoint");
  if (endpoint) {
    try {
      await fetch(`${API_BASE}/push/ping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
    } catch {}
  }
}

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

if (isIOS() && !navigator.standalone) {
  installBtn.classList.remove("hidden");
  installBtn.textContent = "📱 Install on iOS";
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// ============================================================
// EXTENSION BUTTONS
// ============================================================
const extensionBtn = document.getElementById("install-extension-btn");
const downloadExtensionBtn = document.getElementById("download-extension-btn");

function isDesktop() {
  const isMobile =
    /Android|iPhone|iPad|iPod|webOS|BlackBerry|Windows Phone/i.test(
      navigator.userAgent,
    );
  const hasTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  return !isMobile && !hasTouch;
}

async function checkExtensionInstalled() {
  try {
    if (document.getElementById("seize-extension-marker")) return true;
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
  if (!isDesktop()) {
    extensionBtn.classList.add("hidden");
    downloadExtensionBtn.classList.add("hidden");
    return;
  }

  if (await checkExtensionInstalled()) {
    extensionBtn.classList.add("hidden");
    downloadExtensionBtn.classList.add("hidden");
    return;
  }

  extensionBtn.classList.remove("hidden");
  downloadExtensionBtn.classList.remove("hidden");
  extensionBtn.textContent = "🧩 Add to Chrome";
  downloadExtensionBtn.textContent = "📦 Download Extension";
}

function showExtensionInstructions() {
  const existing = document.querySelector(".extension-modal");
  if (existing) existing.remove();

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
        Add one-click download buttons to TikTok, Instagram, Twitter/X, Pinterest, YouTube, Reddit, Spotify, SoundCloud, and more.
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

downloadExtensionBtn?.addEventListener("click", () => {
  fetch("/extension.zip")
    .then((res) => {
      if (!res.ok) {
        showExtensionInstructions();
        throw new Error("ZIP file not found");
      }
      return res.blob();
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
  setTimeout(requestAppPermissions, 2000);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    showExtensionButtons();
  }
});

// ============================================================
// ARCHIVE PANEL
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

function pollArchiveStatus(jobId) {
  let attempts = 0;
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

      if (attempts >= 180) {
        clearInterval(interval);
        showArchiveError("Scan timed out. Try again.");
        archiveBtn.disabled = false;
        archiveBtn.textContent = "🔍 Scan Profile";
        archiveProgress.classList.add("hidden");
      }
    } catch (e) {
      clearInterval(interval);
      showArchiveError(e.message);
      archiveBtn.disabled = false;
      archiveBtn.textContent = "🔍 Scan Profile";
      archiveProgress.classList.add("hidden");
    }
  }, 1500);
}

function renderArchiveGrid(items) {
  if (!items || items.length === 0) {
    archiveGrid.innerHTML =
      '<div class="archive-empty">No items found in this profile.</div>';
    return;
  }

  let html = '<div class="archive-grid">';
  items.forEach((item, index) => {
    const selected = selectedArchiveItems.has(index);
    const thumb = item.thumbnail || "/icons/icon-192.png";
    const icon = item.hasVideo ? "🎬" : item.hasImage ? "🖼️" : "📄";
    const duration = item.duration
      ? `${Math.floor(item.duration / 60)}:${String(Math.floor(item.duration % 60)).padStart(2, "0")}`
      : "";
    const title = item.title || "Untitled";
    const uploader = item.uploader || "";
    const views = item.viewCount ? `${item.viewCount}` : "";

    html += `
      <div class="archive-item ${selected ? "selected" : ""}" data-index="${index}">
        <div class="archive-item-checkbox">
          <input type="checkbox" ${selected ? "checked" : ""} data-index="${index}" />
        </div>
        <img class="archive-item-thumb" src="${thumb}" alt="${title}" loading="lazy"
             onerror="this.src='/icons/icon-192.png'" />
        <div class="archive-item-overlay">
          <span class="archive-item-type">${icon}</span>
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
  html += "</div>";
  archiveGrid.innerHTML = html;

  document.querySelectorAll(".archive-item-checkbox input").forEach((el) => {
    el.addEventListener("change", (e) => {
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
      const checkbox = el.querySelector(".archive-item-checkbox input");
      if (checkbox) {
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event("change"));
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

function pollBatchStatus(batchId) {
  let attempts = 0;
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
        data.items.forEach((item, idx) => {
          const el = document.querySelector(
            `.archive-item[data-index="${idx}"]`,
          );
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

        const doneItems = data.items.filter((item) => item.status === "done");
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

      if (attempts >= 300) {
        clearInterval(interval);
        showArchiveError("Batch download timed out");
        archiveDownloadSelected.disabled = false;
        archiveDownloadSelected.textContent = `📥 Download Selected (${selectedArchiveItems.size})`;
        archiveProgress.classList.add("hidden");
      }
    } catch (e) {
      clearInterval(interval);
      showArchiveError(e.message);
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

function showArchiveError(message) {
  const el = document.getElementById("archive-error");
  if (el) {
    el.textContent = message;
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 8000);
  }
}

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
  archiveGrid.innerHTML =
    '<div class="archive-loading">🔍 Scanning profile...</div>';
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
    archiveGrid.innerHTML =
      '<div class="archive-empty">Something went wrong. Try again.</div>';
  }
});

archiveSelectAll?.addEventListener("change", (e) => {
  if (e.target.checked) {
    archiveItems.forEach((_, index) => selectedArchiveItems.add(index));
  } else {
    selectedArchiveItems.clear();
  }
  updateArchiveSelectionUI();
  renderArchiveGrid(archiveItems);
});

archiveDownloadSelected?.addEventListener("click", async () => {
  if (selectedArchiveItems.size === 0) return;

  const items = Array.from(selectedArchiveItems).map(
    (index) => archiveItems[index],
  );
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

archiveClear?.addEventListener("click", () => {
  archiveItems = [];
  selectedArchiveItems.clear();
  archiveGrid.innerHTML =
    '<div class="archive-empty">Enter a profile URL above to get started.</div>';
  archiveStatus.classList.add("hidden");
  archiveStatus.textContent = "";
  document.getElementById("archive-batch-success")?.classList.add("hidden");
  document.getElementById("archive-batch-success").innerHTML = "";
  archiveInput.value = "";
  updateArchiveCount();
});

// ============================================================
// FINAL INIT
// ============================================================
updateOfflineBanner();
if (navigator.onLine) {
  processOfflineQueue();
}

console.log("✅ seize app loaded successfully");
console.log("🔗 API Base:", API_BASE);
console.log("📱 15+ platforms supported with full audio/video/image support");

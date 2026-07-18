const API_BASE = "https://seize-1lxs.onrender.com/api";
let activeDownloads = new Map();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "resolve") {
    resolveUrl(request.url)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "download") {
    downloadMedia(request.url, request.mode)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "getStatus") {
    const status = activeDownloads.get(request.jobId);
    sendResponse({ success: true, status });
    return true;
  }
});

async function resolveUrl(url) {
  const response = await fetch(`${API_BASE}/download/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || "Failed to resolve");
  }

  return response.json();
}

async function downloadMedia(url, mode) {
  const response = await fetch(`${API_BASE}/download/fetch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, mode, quality: "best" }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || "Download failed");
  }

  const data = await response.json();

  activeDownloads.set(data.jobId, {
    status: "processing",
    progress: 0,
    mode,
    timestamp: Date.now(),
  });

  pollJob(data.jobId);

  return data;
}

async function pollJob(jobId) {
  try {
    const response = await fetch(`${API_BASE}/download/status/${jobId}`);
    if (!response.ok) {
      activeDownloads.set(jobId, {
        status: "error",
        error: "Status check failed",
      });
      return;
    }

    const data = await response.json();
    const status = activeDownloads.get(jobId) || {};
    activeDownloads.set(jobId, {
      ...status,
      status: data.status,
      progress: data.progress || 0,
      error: data.error,
    });

    if (data.status === "done") {
      const job = activeDownloads.get(jobId) || {};
      const ext =
        job.mode === "audio" ? "mp3" : job.mode === "image" ? "jpg" : "mp4";
      const filename = `seize-${Date.now()}.${ext}`;

      // Hand the URL straight to Chrome's download manager instead of
      // fetching the whole file into this service worker first. MV3
      // service workers can be terminated at any time, including mid-fetch
      // — for a large video, buffering it into memory here and then
      // re-downloading via a blob: URL is a well-known source of silently
      // failed downloads. A direct URL download is fetched by Chrome's
      // own robust download pipeline and doesn't depend on this service
      // worker staying alive for the whole transfer.
      chrome.downloads.download(
        {
          url: `${API_BASE}/download/file/${jobId}`,
          filename,
          saveAs: true,
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            console.error("Download failed:", chrome.runtime.lastError);
            activeDownloads.set(jobId, {
              ...job,
              status: "error",
              error: chrome.runtime.lastError.message,
            });
          }
        },
      );
    } else if (data.status === "error") {
      activeDownloads.set(jobId, { status: "error", error: data.error });
    } else {
      setTimeout(() => pollJob(jobId), 2000);
    }
  } catch (err) {
    activeDownloads.set(jobId, { status: "error", error: err.message });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "seize-download",
    title: "Download with Seize",
    contexts: ["link", "video", "image", "page"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // The backend resolves posts by their page URL, not by raw media
  // links — a right-clicked video/image's linkUrl or srcUrl is almost
  // always a CDN URL (e.g. a *.tiktokcdn.com asset link) that the
  // platform-detection step won't recognize as TikTok/Instagram/etc.
  // tab.url is the actual post page, which always works.
  const url = tab?.url || info.pageUrl;
  if (url) {
    chrome.tabs.sendMessage(tab.id, {
      action: "contextDownload",
      mode: info.mediaType === "image" ? "image" : "video",
      url: url,
    });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [id, data] of activeDownloads) {
    if (data.timestamp && now - data.timestamp > 600000) {
      activeDownloads.delete(id);
    }
  }
}, 300000);

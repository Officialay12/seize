let currentUrl = window.location.href;
let platform = detectPlatform(currentUrl);

function detectPlatform(url) {
  if (url.includes("tiktok.com")) return "tiktok";
  if (url.includes("instagram.com")) return "instagram";
  if (url.includes("twitter.com") || url.includes("x.com")) return "twitter";
  if (url.includes("pinterest.com") || url.includes("pin.it"))
    return "pinterest";
  if (url.includes("snapchat.com")) return "snapchat";
  if (url.includes("facebook.com") || url.includes("fb.watch"))
    return "facebook";
  return null;
}

function injectButtons() {
  if (!platform) return;

  document
    .querySelectorAll(".seize-extension-btn")
    .forEach((el) => el.remove());

  const videos = document.querySelectorAll("video");
  videos.forEach((video) => {
    if (video.closest(".seize-extension-btn")) return;

    const parent = video.parentElement;
    if (!parent) return;

    const btn = document.createElement("button");
    btn.className = "seize-extension-btn";
    btn.textContent = "⬇️ Seize";
    btn.title = "Download with Seize";
    btn.style.cssText = `
      position: absolute;
      bottom: 10px;
      right: 10px;
      z-index: 9999;
      background: rgba(11, 13, 12, 0.9);
      color: #7FFFB0;
      border: 1px solid #3F8F65;
      border-radius: 4px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      backdrop-filter: blur(4px);
      transition: all 0.2s;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      letter-spacing: 0.5px;
    `;

    btn.onmouseover = () => {
      btn.style.background = "rgba(127, 255, 176, 0.15)";
      btn.style.borderColor = "#7FFFB0";
    };
    btn.onmouseout = () => {
      btn.style.background = "rgba(11, 13, 12, 0.9)";
      btn.style.borderColor = "#3F8F65";
    };

    btn.onclick = (e) => {
      e.stopPropagation();
      handleDownload(currentUrl, "video");
    };

    if (getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
    parent.appendChild(btn);
  });

  if (platform === "pinterest") {
    const images = document.querySelectorAll('img[src*="pinimg.com"]');
    images.forEach((img) => {
      if (img.closest(".seize-extension-btn")) return;

      const parent = img.parentElement;
      if (!parent) return;

      const btn = document.createElement("button");
      btn.className = "seize-extension-btn";
      btn.textContent = "⬇️ Seize";
      btn.title = "Download image with Seize";
      btn.style.cssText = `
        position: absolute;
        bottom: 10px;
        right: 10px;
        z-index: 9999;
        background: rgba(11, 13, 12, 0.9);
        color: #7FFFB0;
        border: 1px solid #3F8F65;
        border-radius: 4px;
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        backdrop-filter: blur(4px);
        transition: all 0.2s;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        letter-spacing: 0.5px;
      `;

      btn.onmouseover = () => {
        btn.style.background = "rgba(127, 255, 176, 0.15)";
        btn.style.borderColor = "#7FFFB0";
      };
      btn.onmouseout = () => {
        btn.style.background = "rgba(11, 13, 12, 0.9)";
        btn.style.borderColor = "#3F8F65";
      };

      btn.onclick = (e) => {
        e.stopPropagation();
        // Resolve via the pin's page URL, not the raw pinimg.com CDN
        // link — the backend's platform detection only recognizes
        // pinterest.com/pin.it, so a direct CDN URL always fails here.
        handleDownload(currentUrl, "image");
      };

      if (getComputedStyle(parent).position === "static") {
        parent.style.position = "relative";
      }
      parent.appendChild(btn);
    });
  }
}

async function handleDownload(url, mode) {
  try {
    const response = await chrome.runtime.sendMessage({
      action: "resolve",
      url: url,
    });

    if (!response.success) {
      showNotification("❌ " + response.error);
      return;
    }

    const data = response.data;

    if (data.hasVideo) {
      showNotification("🎬 Downloading video...");
      chrome.runtime.sendMessage({
        action: "download",
        url: url,
        mode: "video",
      });
    } else if (data.hasImage) {
      showNotification("🖼️ Downloading image...");
      chrome.runtime.sendMessage({
        action: "download",
        url: url,
        mode: "image",
      });
    } else {
      showNotification("⚠️ No downloadable media found");
    }
  } catch (err) {
    showNotification("❌ " + err.message);
  }
}

function showNotification(message) {
  const existing = document.querySelector(".seize-notification");
  if (existing) existing.remove();

  const div = document.createElement("div");
  div.className = "seize-notification";
  div.textContent = message;
  div.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 99999;
    background: rgba(11, 13, 12, 0.95);
    color: #E8EDE9;
    border: 1px solid #3F8F65;
    border-radius: 8px;
    padding: 12px 20px;
    font-size: 14px;
    font-weight: 500;
    backdrop-filter: blur(8px);
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    max-width: 400px;
    animation: slideUp 0.3s ease-out;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;

  const style = document.createElement("style");
  style.textContent = `
    @keyframes slideUp {
      from { transform: translateY(20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);

  document.body.appendChild(div);

  setTimeout(() => {
    div.style.opacity = "0";
    div.style.transition = "opacity 0.3s";
    setTimeout(() => div.remove(), 300);
  }, 4000);
}

let lastUrl = window.location.href;
new MutationObserver(() => {
  const current = window.location.href;
  if (current !== lastUrl) {
    lastUrl = current;
    currentUrl = current;
    platform = detectPlatform(current);
    setTimeout(injectButtons, 500);
  }
}).observe(document, { subtree: true, childList: true });

setTimeout(injectButtons, 1000);

const observer = new MutationObserver(() => {
  if (
    document.querySelector("video") ||
    document.querySelector('img[src*="pinimg.com"]')
  ) {
    injectButtons();
  }
});
observer.observe(document.body, { childList: true, subtree: true });

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "contextDownload") {
    // Always resolve via the current page URL — a right-click's
    // linkUrl/srcUrl is usually a raw CDN media link (e.g. a TikTok CDN
    // domain, not tiktok.com itself), which the backend's platform
    // detection won't recognize. The page URL is the one thing that's
    // always resolvable.
    handleDownload(currentUrl, request.mode || "video");
    sendResponse({ success: true });
  }
});

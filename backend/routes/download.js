const express = require("express");
const path = require("path");
const fs = require("fs");
const { v4: uuid } = require("uuid");
const ytDlp = require("yt-dlp-exec");
const ffmpegStaticPath = require("ffmpeg-static");
const https = require("https");
const http = require("http");
const { execFile } = require("child_process");
const { scheduleCleanup } = require("../utils/cleanup");

const router = express.Router();

const TMP_DIR = path.join(__dirname, "..", "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const jobs = new Map();
scheduleCleanup({ jobs, tmpDir: TMP_DIR });

const YT_DLP_BIN =
  (ytDlp && ytDlp.binPath) ||
  path.join(
    process.cwd(),
    "node_modules",
    "yt-dlp-exec",
    "bin",
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
  );

function updateYtDlpBinary() {
  execFile(YT_DLP_BIN, ["-U"], { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.log("[seize] yt-dlp self-update skipped:", err.message);
      return;
    }
    const out = (stdout || stderr || "").trim();
    if (out) console.log("[seize] yt-dlp update check:", out.split("\n").pop());
  });
}

setTimeout(updateYtDlpBinary, 5000);
setInterval(updateYtDlpBinary, 6 * 60 * 60 * 1000).unref();

const COOKIE_SOURCE_FILES = {
  tiktok: process.env.TIKTOK_COOKIES_FILE,
  instagram: process.env.INSTAGRAM_COOKIES_FILE,
  twitter: process.env.TWITTER_COOKIES_FILE,
  facebook: process.env.FACEBOOK_COOKIES_FILE,
  pinterest: process.env.PINTEREST_COOKIES_FILE,
  youtube: process.env.YT_COOKIES_FILE,
};

const COOKIE_FILES = {};
for (const [platform, sourcePath] of Object.entries(COOKIE_SOURCE_FILES)) {
  if (!sourcePath) continue;
  try {
    if (fs.existsSync(sourcePath)) {
      const writablePath = path.join(TMP_DIR, `${platform}-cookies.txt`);
      fs.copyFileSync(sourcePath, writablePath);
      COOKIE_FILES[platform] = writablePath;
      console.log(`[seize] ${platform} cookies loaded (writable copy at ${writablePath})`);
    } else {
      console.warn(`[seize] ${platform} cookies env var set but file not found: ${sourcePath}`);
    }
  } catch (e) {
    console.warn(`[seize] Failed to prepare ${platform} cookies:`, e.message);
  }
}

function cookiesFor(platform) {
  const file = COOKIE_FILES[platform];
  return file && fs.existsSync(file) ? file : null;
}

const PLATFORM_PATTERNS = [
  { name: "tiktok", re: /tiktok\.com/i },
  { name: "instagram", re: /instagram\.com/i },
  { name: "twitter", re: /(twitter\.com|x\.com)/i },
  {
    name: "pinterest",
    re: /(pinterest\.com|pin\.it|pinterest\.com\.au|pinterest\.co\.uk|pinterest\.de|pinterest\.fr|pinterest\.es|pinterest\.it)/i
  },
  { name: "snapchat", re: /snapchat\.com/i },
  { name: "facebook", re: /(facebook\.com|fb\.watch)/i },
];

function detectPlatform(url) {
  const match = PLATFORM_PATTERNS.find((p) => p.re.test(url));
  return match ? match.name : null;
}

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

function baseOptions(platform) {
  const opts = {
    noWarnings: true,
    noCheckCertificates: true,
    ffmpegLocation: ffmpegStaticPath,
    retries: 5,
    socketTimeout: 45,
    concurrentFragments: 8,
  };
  const cookies = cookiesFor(platform);
  if (cookies) opts.cookies = cookies;
  return opts;
}

function getStrategies(platform) {
  const base = baseOptions(platform);

  switch (platform) {
    case "tiktok":
      return [
        {
          ...base,
          extractorArgs: "tiktok:device_id=auto",
          addHeaders: {
            "User-Agent": ANDROID_UA,
            Accept: "application/json, text/plain, */*",
            Referer: "https://www.tiktok.com/",
          },
        },
        {
          ...base,
          addHeaders: {
            "User-Agent": DESKTOP_UA,
            Referer: "https://www.tiktok.com/",
          },
        },
      ];
    case "instagram":
      return [
        {
          ...base,
          extractorArgs: "instagram:include_ads=false",
          addHeaders: { "User-Agent": DESKTOP_UA },
        },
        {
          ...base,
          addHeaders: { "User-Agent": ANDROID_UA },
        },
      ];
    case "twitter":
      return [
        {
          ...base,
          addHeaders: {
            "User-Agent": DESKTOP_UA,
            Accept: "application/json, text/plain, */*",
          },
        },
        {
          ...base,
          extractorArgs: "twitter:api=syndication",
          addHeaders: { "User-Agent": DESKTOP_UA },
        },
      ];
    case "pinterest":
      return [
        {
          ...base,
          extractorArgs: "generic",
          addHeaders: {
            "User-Agent": DESKTOP_UA,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
          },
        },
        {
          ...base,
          extractorArgs: "generic",
          cookies: undefined,
          addHeaders: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
        },
        {
          ...base,
          extractorArgs: "generic",
          cookies: undefined,
          addHeaders: {
            "User-Agent": ANDROID_UA,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
        },
        {
          ...base,
          extractorArgs: "generic",
          cookies: undefined,
          addHeaders: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
        },
      ];
    case "snapchat":
      return [
        {
          ...base,
          addHeaders: {
            "User-Agent": DESKTOP_UA,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
        },
        {
          ...base,
          addHeaders: {
            "User-Agent": ANDROID_UA,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
        },
      ];
    case "facebook":
      return [
        {
          ...base,
          addHeaders: { "User-Agent": DESKTOP_UA },
        },
        {
          ...base,
          addHeaders: {
            "User-Agent": ANDROID_UA,
            Referer: "https://m.facebook.com/",
          },
        },
      ];
    default:
      return [{ ...base, addHeaders: { "User-Agent": DESKTOP_UA } }];
  }
}

async function resolveWithStrategies(url, platform, isUsable) {
  const strategies = getStrategies(platform);
  let lastErr;

  for (let i = 0; i < strategies.length; i++) {
    const options = {
      dumpSingleJson: true,
      preferFreeFormats: true,
      ...strategies[i],
    };
    try {
      console.log(`[seize] Trying strategy ${i + 1}/${strategies.length} for ${platform}...`);
      const info = await ytDlp(url, options, { timeout: 60000 });
      if (!isUsable || isUsable(info)) {
        console.log(`[seize] Strategy ${i + 1} succeeded!`);
        return { info, strategyIndex: i };
      }
      lastErr = new Error("Strategy returned no usable media");
    } catch (err) {
      lastErr = err;
      const msg = (err.stderr || err.message || "").toLowerCase();
      console.log(`[seize] Strategy ${i + 1} failed:`, msg.slice(0, 100));
      if (msg.includes("429") || msg.includes("rate limit")) throw err;
    }
    if (i < strategies.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr || new Error("All extraction strategies failed");
}

function runYtDlpWithProgress(url, options, jobId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    try {
      child = ytDlp.exec(url, options);
    } catch (err) {
      reject(err);
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
      reject(new Error("Download timed out."));
    }, timeoutMs);

    const parseProgress = (chunk) => {
      const text = chunk.toString();
      const match = text.match(/\[download\]\s+([\d.]+)%/);
      if (match) {
        const pct = Math.min(99, Math.round(parseFloat(match[1])));
        const job = jobs.get(jobId);
        if (job && job.status === "processing") job.progress = pct;
      }
    };

    if (child.stdout) child.stdout.on("data", parseProgress);
    if (child.stderr) child.stderr.on("data", parseProgress);

    child
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

function downloadFile(url, filePath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error("Too many redirects"));
      return;
    }
    const protocol = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(filePath);

    protocol
      .get(url, { headers: { "User-Agent": DESKTOP_UA } }, (response) => {
        if (
          [301, 302, 303, 307, 308].includes(response.statusCode) &&
          response.headers.location
        ) {
          file.close();
          fs.unlink(filePath, () => {});
          downloadFile(response.headers.location, filePath, redirects + 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          file.close();
          fs.unlink(filePath, () => {});
          reject(new Error(`Download failed: ${response.statusCode}`));
          return;
        }

        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve(filePath);
        });
      })
      .on("error", (err) => {
        fs.unlink(filePath, () => {});
        reject(err);
      });
  });
}

function friendlyError(stderr = "") {
  const s = stderr.toLowerCase();

  if (s.includes("pinterest") && (s.includes("login") || s.includes("sign in"))) {
    return "Pinterest is blocking automated access. Try again in a few minutes or use a different pin.";
  }
  if (s.includes("pinterest") && s.includes("not found")) {
    return "This Pinterest pin doesn't exist or has been removed.";
  }
  if (s.includes("pinterest") && s.includes("rate limit") || s.includes("429")) {
    return "Pinterest is rate limiting. Wait 5-10 minutes and try again.";
  }
  if (s.includes("pinterest") && s.includes("403")) {
    return "Pinterest blocked this request. Try: 1) Different pin 2) Wait a few minutes 3) Refresh your cookies";
  }
  if (s.includes("pinterest") && s.includes("blocked")) {
    return "Pinterest blocked this request. Try again later or use a VPN.";
  }
  if (s.includes("pinterest") && s.includes("timed out") || s.includes("timeout")) {
    return "Pinterest timed out. The site might be slow or your connection is unstable.";
  }

  if (s.includes("snapchat") && s.includes("private")) {
    return "This Snapchat post is private. Only public Spotlight or Story links work.";
  }
  if (s.includes("snapchat") && s.includes("expired")) {
    return "This Snapchat link has expired. Stories expire after 24 hours.";
  }
  if (s.includes("snapchat") && s.includes("not found")) {
    return "This Snapchat post doesn't exist or has been removed.";
  }

  if (
    s.includes("geo") ||
    s.includes("not available in your country") ||
    s.includes("blocked in your country") ||
    s.includes("not available on this app or country")
  )
    return "This content is region-locked and isn't available from your location.";
  if (s.includes("private")) return "This post is private.";
  if (s.includes("age") && s.includes("restrict"))
    return "This video is age-restricted and requires a signed-in account to access.";
  if (s.includes("sign in") || s.includes("login"))
    return "This content requires a logged-in session on the platform to view.";
  if (s.includes("copyright") || s.includes("blocked it on copyright"))
    return "This content was blocked due to a copyright claim.";
  if (
    s.includes("removed") ||
    s.includes("video unavailable") ||
    s.includes("this video is unavailable")
  )
    return "This content has been removed or deleted.";
  if (s.includes("unavailable") || s.includes("not available"))
    return "This content isn't available right now — it may have been removed or restricted.";
  if (s.includes("timed out") || s.includes("timeout"))
    return "The platform took too long to respond. Try again in a moment.";
  if (s.includes("rate limit") || s.includes("429"))
    return "Rate limited by the platform. Please wait a bit and try again.";
  if (
    s.includes("econnrefused") ||
    s.includes("enotfound") ||
    s.includes("getaddrinfo") ||
    s.includes("network") ||
    s.includes("fetch failed") ||
    s.includes("502") ||
    s.includes("503")
  )
    return "The platform's service seems to be down right now. Try again shortly.";
  if (s.includes("no video") || s.includes("could not be found"))
    return "No downloadable media found at this link (it may be text-only or an unsupported post type).";
  if (s.includes("profile") || s.includes("channel"))
    return "Use a specific post/video URL, not a profile or channel link.";
  if (s.includes("unsupported url"))
    return "This link format isn't recognized. Try copying the link directly from the app's share button.";
  return "Couldn't resolve this link. It may have been deleted, made private, or the platform is temporarily blocking automated access.";
}

function extractMediaUrls(info) {
  const media = {
    images: [],
    videos: [],
    audio: [],
    thumbnail: null,
    hasVideo: false,
    hasImage: false,
    isGif: false,
  };

  const nodes =
    Array.isArray(info.entries) && info.entries.length
      ? info.entries.filter(Boolean)
      : [info];

  for (const node of nodes) {
    if (!media.thumbnail) {
      if (node.thumbnail) {
        media.thumbnail = node.thumbnail;
      } else if (Array.isArray(node.thumbnails) && node.thumbnails.length) {
        const largest = [...node.thumbnails].sort(
          (a, b) => (b.width || 0) - (a.width || 0),
        )[0];
        media.thumbnail = largest?.url || null;
      }
    }

    const isGifFormat = (f) => {
      if (!f) return false;
      const note = (f.format_note || "").toLowerCase();
      const ext = (f.ext || "").toLowerCase();
      return note.includes("gif") ||
             note.includes("animated") ||
             ext === "gif" ||
             (f.vcodec && f.vcodec !== "none" && note.includes("video") && (f.width || 0) < 400);
    };

    if (node.url && node.ext) {
      const ext = node.ext.toLowerCase();
      const note = (node.format_note || "").toLowerCase();
      const isGif = ext === "gif" || note.includes("gif") || note.includes("animated");

      if (isGif) {
        media.videos.push({
          url: node.url,
          format: "mp4",
          quality: "GIF",
          width: node.width || null,
          height: node.height || null,
          isGif: true,
        });
        media.hasVideo = true;
        media.isGif = true;
        continue;
      }

      if (["mp4", "mov", "webm", "mkv"].includes(ext)) {
        media.videos.push({
          url: node.url,
          format: ext,
          quality: node.format_note || "Unknown",
          width: node.width || null,
          height: node.height || null,
        });
        media.hasVideo = true;
      } else if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) {
        if (ext !== "gif") {
          media.images.push({
            url: node.url,
            format: ext,
            width: node.width || null,
            height: node.height || null,
          });
          media.hasImage = true;
        }
      }
    }

    if (Array.isArray(node.formats)) {
      for (const format of node.formats) {
        if (!format.url) continue;

        const isVideoFormat = format.vcodec && format.vcodec !== "none";
        const isVideoExt = format.ext && ["mp4", "mov", "webm", "mkv", "avi", "3gp"].includes(format.ext.toLowerCase());
        const hasVideoQuality = format.format_note && /(h264|h265|video|1080|720|480|360|240)/i.test(format.format_note);
        const isSnapchatVideo = format.format_note && /(video|story|snap|spotlight)/i.test(format.format_note);

        const isTwitterGif = format.format_note &&
          /(gif|animated|loop)/i.test(format.format_note);
        const isGifBySize = format.width && format.width < 400 && format.format_note &&
          /video/i.test(format.format_note);

        if (isTwitterGif || isGifBySize) {
          media.videos.push({
            url: format.url,
            format: format.ext || "mp4",
            quality: "GIF",
            width: format.width || null,
            height: format.height || null,
            isGif: true,
          });
          media.hasVideo = true;
          media.isGif = true;
          continue;
        }

        if (isVideoFormat || (isVideoExt && (isSnapchatVideo || hasVideoQuality))) {
          media.videos.push({
            url: format.url,
            format: format.ext || "mp4",
            quality: format.format_note || format.quality || "Unknown",
            width: format.width || null,
            height: format.height || null,
          });
          media.hasVideo = true;
        }

        if (
          format.acodec &&
          format.acodec !== "none" &&
          (!format.vcodec || format.vcodec === "none")
        ) {
          media.audio.push({
            url: format.url,
            format: format.ext || "mp3",
            bitrate: format.abr || null,
          });
        }

        const isImageExt = format.ext &&
          ["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "tiff"].includes(
            format.ext.toLowerCase()
          );
        const isPinterestImage = format.format_note && /(image|photo|pin)/i.test(format.format_note);

        if (format.ext && format.ext.toLowerCase() === "gif") {
          continue;
        }

        if (isImageExt || isPinterestImage) {
          media.images.push({
            url: format.url,
            format: format.ext || "jpg",
            width: format.width || null,
            height: format.height || null,
          });
          media.hasImage = true;
        }
      }
    }

    if (node.formats && !Array.isArray(node.formats) && typeof node.formats === 'object') {
      const formatValues = Object.values(node.formats);
      for (const format of formatValues) {
        if (format && format.url) {
          const isVideo = format.vcodec && format.vcodec !== "none";
          const isVideoExt = format.ext && ["mp4", "mov", "webm"].includes(format.ext.toLowerCase());

          if (isVideo || isVideoExt) {
            media.videos.push({
              url: format.url,
              format: format.ext || "mp4",
              quality: format.format_note || "Unknown",
              width: format.width || null,
              height: format.height || null,
            });
            media.hasVideo = true;
          } else if (format.ext && ["jpg", "jpeg", "png", "webp"].includes(format.ext.toLowerCase())) {
            media.images.push({
              url: format.url,
              format: format.ext,
              width: format.width || null,
              height: format.height || null,
            });
            media.hasImage = true;
          }
        }
      }
    }

    if (node._type === "url" && node.url) {
      const url = node.url;
      if (/\.(mp4|mov|webm)(\?|$)/i.test(url)) {
        media.videos.push({
          url: url,
          format: "mp4",
          quality: "Unknown",
        });
        media.hasVideo = true;
      } else if (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(url)) {
        media.images.push({
          url: url,
          format: "jpg",
        });
        media.hasImage = true;
      }
    }

    if (node.description) {
      const videoMatch = node.description.match(/https?:\/\/[^\s]+\.(mp4|mov|webm)[^\s]*/i);
      if (videoMatch) {
        media.videos.push({
          url: videoMatch[0],
          format: "mp4",
          quality: "Unknown",
        });
        media.hasVideo = true;
      }
    }
  }

  if (!media.thumbnail && media.images.length > 0) {
    media.thumbnail = media.images[0].url;
  }

  if (!media.thumbnail && media.videos.length > 0) {
    const videoUrl = media.videos[0].url;
    if (videoUrl) {
      media.thumbnail = videoUrl;
    }
  }

  if (!media.hasImage && media.thumbnail) {
    media.images.push({
      url: media.thumbnail,
      format: "jpg",
      isThumbnail: true,
    });
    media.hasImage = true;
  }

  media.videos.sort((a, b) => {
    const aQuality = a.width || a.height || 0;
    const bQuality = b.width || b.height || 0;
    return bQuality - aQuality;
  });

  return media;
}

function isUsableInfo(info) {
  if (!info) return false;

  const media = extractMediaUrls(info);

  if (info.formats && Array.isArray(info.formats)) {
    const hasSnapchatVideo = info.formats.some(f =>
      (f.ext && f.ext.toLowerCase() === 'mp4') ||
      (f.format_note && /(video|story|snap)/i.test(f.format_note))
    );
    if (hasSnapchatVideo) return true;
  }

  if (info.formats && Array.isArray(info.formats)) {
    const hasTwitterGif = info.formats.some(f =>
      (f.format_note && /(gif|animated)/i.test(f.format_note)) ||
      (f.ext && f.ext.toLowerCase() === 'mp4' && f.format_note && /video/i.test(f.format_note))
    );
    if (hasTwitterGif) return true;
  }

  if (info.url && info.ext) {
    const ext = info.ext.toLowerCase();
    if (["mp4", "mov", "webm", "mkv", "jpg", "jpeg", "png", "webp"].includes(ext)) {
      return true;
    }
  }

  if (info._type === "url" && info.url) {
    const url = info.url.toLowerCase();
    if (/\.(mp4|mov|webm|jpg|jpeg|png|webp)(\?|$)/i.test(url)) {
      return true;
    }
  }

  if (info.description) {
    if (/https?:\/\/[^\s]+\.(mp4|mov|webm)[^\s]*/i.test(info.description)) {
      return true;
    }
  }

  return media.hasVideo || media.hasImage || media.audio.length > 0;
}

function dedupeByHeight(videos, max = 12) {
  const seen = new Set();
  const out = [];
  for (const v of videos) {
    const key = v.height || v.width || 0;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

function sanitizeFilename(name) {
  return String(name || "seize")
    .replace(/[\/\\?%*:|"<>]/g, "")
    .replace(/[\r\n]/g, "")
    .trim()
    .slice(0, 150) || "seize";
}

// ============================================================
// RESOLVE ENDPOINT
// ============================================================
router.post("/resolve", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "A URL is required" });

  const platform = detectPlatform(url);
  if (!platform) {
    return res.status(400).json({
      error:
        "Unsupported. Only TikTok, Instagram, Twitter/X, Pinterest, Snapchat, and Facebook.",
    });
  }

  if (platform === "tiktok") {
    const profileMatch = url.match(/tiktok\.com\/@([^/]+)(\/?$)/);
    if (profileMatch && !url.includes("/video/") && !url.includes("/photo/")) {
      return res.status(400).json({
        error: "Please use a specific video/photo URL, not a profile.",
      });
    }
  }

  let finalUrl = url;
  if (platform === "pinterest" && (url.includes("pin.it") || url.includes("/pin/"))) {
    try {
      console.log("[seize] Expanding Pinterest shortlink...");
      const response = await fetch(url, {
        method: "HEAD",
        headers: { "User-Agent": DESKTOP_UA },
        redirect: "follow"
      });
      finalUrl = response.url || url;
      console.log("[seize] Expanded to:", finalUrl);
    } catch (e) {
      console.log("[seize] Could not expand shortlink, using original");
    }
  }

  try {
    console.log(`[seize] Resolving ${platform}...`);
    const { info } = await resolveWithStrategies(finalUrl, platform, isUsableInfo);

    const media = extractMediaUrls(info);

    let title = info.title || info.fulltitle || info.description || "Untitled";
    if (platform === "twitter") {
      title = info.description || info.tweet_text || title;
      title = title.replace(/^Tweets? from /i, "").trim();
      if (title.length > 100) title = title.substring(0, 100) + "...";
      if (["Untitled", "Twitter", "Twitter/X Post"].includes(title)) {
        title = "Twitter/X Post";
      }
    }
    if (platform === "pinterest") {
      title = info.title || "Pinterest Pin";
      if (title.length > 100) title = title.substring(0, 100) + "...";
    }

    let uploader = info.uploader || info.channel || info.author || info.creator || info.owner || null;

    let contentType = "unknown";
    if (media.hasVideo) contentType = "video";
    else if (media.hasImage) contentType = "image";
    else if (media.audio.length > 0) contentType = "audio";

    if (media.isGif) {
      contentType = "video";
    }

    let thumbnail = media.thumbnail || "/icons/icon-192.png";
    if (thumbnail === "/icons/icon-192.png" && media.images.length > 0) {
      thumbnail = media.images[0].url;
    }

    res.json({
      platform,
      title,
      thumbnail,
      uploader: uploader || "Unknown",
      contentType,
      hasVideo: media.hasVideo,
      hasImage: media.hasImage,
      isGif: media.isGif || false,
      media: {
        videos: dedupeByHeight(media.videos, 12),
        images: media.images.slice(0, 10),
        audio: media.audio.slice(0, 3),
      },
      formatsAvailable: Array.isArray(info.formats)
        ? [...new Set(info.formats.map((f) => f.ext).filter(Boolean))]
        : [],
      duration: info.duration || null,
      isImageOnly: contentType === "image",
    });
  } catch (err) {
    const stderr = err.stderr || err.message || "";
    console.error("[resolve] Failed:", stderr);
    if (
      stderr.toLowerCase().includes("429") ||
      stderr.toLowerCase().includes("rate limit")
    ) {
      return res
        .status(429)
        .json({ error: `${platform} is rate limiting. Please wait.` });
    }
    res.status(502).json({ error: friendlyError(stderr) });
  }
});

// ============================================================
// FETCH ENDPOINT
// ============================================================
router.post("/fetch", async (req, res) => {
  const { url, mode = "video", quality = "best" } = req.body;
  if (!url) return res.status(400).json({ error: "A URL is required" });

  const platform = detectPlatform(url);
  if (!platform) {
    return res.status(400).json({ error: "Unsupported link." });
  }

  const jobId = uuid();
  const ext = mode === "audio" ? "mp3" : mode === "image" ? "jpg" : "mp4";
  const outputPath = path.join(TMP_DIR, `${jobId}.${ext}`);

  jobs.set(jobId, { status: "processing", progress: 0, createdAt: Date.now() });
  res.json({ jobId });

  try {
    if (mode === "image") {
      const { info } = await resolveWithStrategies(url, platform, isUsableInfo);
      const media = extractMediaUrls(info);

      if (media.images.length === 0) {
        throw new Error("No images found");
      }

      const sortedImages = [...media.images].sort((a, b) => {
        const aSize = (a.width || 0) * (a.height || 0);
        const bSize = (b.width || 0) * (b.height || 0);
        return bSize - aSize;
      });
      const bestImage = sortedImages[0];

      await downloadFile(bestImage.url, outputPath);

      jobs.set(jobId, {
        status: "done",
        progress: 100,
        outputPath,
        downloadName: `seize-${platform}-image.${bestImage.format || "jpg"}`,
        finishedAt: Date.now(),
      });
      return;
    }

    const heightCap = /^\d+$/.test(String(quality)) ? String(quality) : null;
    const capFmt = (fmt) => {
      if (!heightCap) return fmt;
      return fmt
        .split("/")
        .map((part) =>
          part.replace(
            /\b(bestvideo|best)\b(?!audio)(\[[^\]]*\])?/g,
            (m, base, existing) =>
              `${base}${existing || ""}[height<=${heightCap}]`,
          ),
        )
        .join("/");
    };

    const formatChains = {
      audio: ["bestaudio/best", "best"],
      video: ["bestvideo+bestaudio/best", "best[ext=mp4]/best", "best"].map(
        capFmt,
      ),
    };
    const chain = formatChains[mode === "audio" ? "audio" : "video"];
    const strategies = getStrategies(platform);

    let lastErr;
    let succeeded = false;

    outer: for (const strategy of strategies) {
      for (const formatStr of chain) {
        const options = {
          output: outputPath,
          ...strategy,
          format: formatStr,
        };
        if (mode === "audio") {
          options.extractAudio = true;
          options.audioFormat = "mp3";
          options.audioQuality = 0;
        } else {
          options.mergeOutputFormat = "mp4";
        }

        try {
          await runYtDlpWithProgress(url, options, jobId, 120000);
          succeeded = true;
          break outer;
        } catch (err) {
          lastErr = err;
          const msg = (err.stderr || err.message || "").toLowerCase();
          if (msg.includes("429") || msg.includes("rate limit")) {
            throw err;
          }
          if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
        }
      }
    }

    if (!succeeded)
      throw lastErr || new Error("All download strategies failed");

    let finalPath = outputPath;
    if (!fs.existsSync(finalPath)) {
      const dirFiles = fs.readdirSync(TMP_DIR);
      const match = dirFiles.find((f) => f.startsWith(jobId));
      if (match) finalPath = path.join(TMP_DIR, match);
    }

    if (!fs.existsSync(finalPath)) {
      throw new Error("Output file not produced.");
    }

    jobs.set(jobId, {
      status: "done",
      progress: 100,
      outputPath: finalPath,
      downloadName: `seize-${platform}-${mode}.${ext}`,
      finishedAt: Date.now(),
    });
  } catch (err) {
    const stderr = err.stderr || err.message || "";
    console.error("[fetch] Failed:", stderr);
    jobs.set(jobId, {
      status: "error",
      error: friendlyError(stderr),
      finishedAt: Date.now(),
    });
    if (fs.existsSync(outputPath)) {
      fs.unlink(outputPath, () => {});
    }
  }
});

// ============================================================
// STATUS ENDPOINT
// ============================================================
router.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ status: job.status, progress: job.progress, error: job.error });
});

// ============================================================
// FILE DOWNLOAD ENDPOINT
// ============================================================
router.get("/file/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "done")
    return res.status(404).json({ error: "File not ready" });
  res.download(job.outputPath, job.downloadName, (err) => {
    if (!err) {
      fs.unlink(job.outputPath, () => {});
      jobs.delete(req.params.jobId);
    }
  });
});

// ============================================================
// CREATOR ARCHIVE MODE - Profile extraction
// ============================================================
router.post("/profile", async (req, res) => {
  const { url, platform, limit = 50, mode = "all" } = req.body;
  if (!url) return res.status(400).json({ error: "Profile URL is required" });

  const detectedPlatform = platform || detectPlatform(url);
  if (!detectedPlatform) {
    return res.status(400).json({
      error: "Unsupported platform. Only TikTok, Instagram, Twitter/X, and Pinterest are supported for profile extraction.",
    });
  }

  const supportedProfiles = ["tiktok", "instagram", "twitter", "pinterest"];
  if (!supportedProfiles.includes(detectedPlatform)) {
    return res.status(400).json({
      error: `${detectedPlatform} doesn't support profile extraction yet.`,
    });
  }

  const jobId = uuid();
  jobs.set(jobId, {
    status: "processing",
    progress: 0,
    items: [],
    total: 0,
    processed: 0,
    createdAt: Date.now()
  });

  (async () => {
    try {
      const options = {
        dumpSingleJson: true,
        noWarnings: true,
        noCheckCertificates: true,
        ffmpegLocation: ffmpegStaticPath,
        retries: 3,
        socketTimeout: 60,
        extractorArgs: `${detectedPlatform}:include_ads=false`,
        addHeaders: {
          "User-Agent": DESKTOP_UA,
          Accept: "application/json, text/plain, */*",
        },
        playlistItems: true,
        playlistEnd: Math.min(limit, 100),
      };

      const cookies = cookiesFor(detectedPlatform);
      if (cookies) options.cookies = cookies;

      console.log(`[seize] Extracting profile from ${detectedPlatform}: ${url}`);
      const info = await ytDlp(url, options, { timeout: 120000 });

      const entries = Array.isArray(info.entries) ? info.entries : [info];
      const items = [];

      for (const entry of entries) {
        if (!entry) continue;

        const media = extractMediaUrls(entry);
        const item = {
          id: entry.id || entry.webpage_url || `item-${Date.now()}`,
          title: entry.title || entry.fulltitle || "Untitled",
          url: entry.webpage_url || entry.url || null,
          thumbnail: media.thumbnail || entry.thumbnail || null,
          duration: entry.duration || null,
          hasVideo: media.hasVideo || false,
          hasImage: media.hasImage || false,
          contentType: media.hasVideo ? "video" : media.hasImage ? "image" : "unknown",
          media: {
            videos: media.videos.slice(0, 1),
            images: media.images.slice(0, 1),
          },
          uploader: info.uploader || info.channel || info.author || null,
          viewCount: entry.view_count || entry.views || null,
          likeCount: entry.like_count || entry.likes || null,
          commentCount: entry.comment_count || entry.comments || null,
          timestamp: entry.timestamp || entry.upload_date || null,
        };

        if (mode === "videos" && !item.hasVideo) continue;
        if (mode === "images" && !item.hasImage) continue;
        if (mode === "all" || (item.hasVideo || item.hasImage)) {
          items.push(item);
        }
      }

      const job = jobs.get(jobId);
      if (job) {
        job.status = "done";
        job.progress = 100;
        job.items = items.slice(0, limit);
        job.total = items.length;
        job.processed = items.length;
        job.finishedAt = Date.now();
      }

      console.log(`[seize] Extracted ${items.length} items from ${detectedPlatform} profile`);
    } catch (err) {
      console.error("[seize] Profile extraction failed:", err.message);
      const job = jobs.get(jobId);
      if (job) {
        job.status = "error";
        job.error = friendlyError(err.stderr || err.message);
        job.finishedAt = Date.now();
      }
    }
  })();

  res.json({ jobId });
});

router.get("/profile/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({
    status: job.status,
    progress: job.progress,
    total: job.total,
    processed: job.processed,
    items: job.status === "done" ? job.items : [],
    error: job.error,
  });
});

router.post("/profile/batch", async (req, res) => {
  const { items, quality = "best" } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "At least one item is required" });
  }

  const batchId = uuid();
  const batchItems = items.map(item => ({
    ...item,
    status: "pending",
    progress: 0,
    jobId: null,
    fileUrl: null,
    error: null,
  }));

  jobs.set(batchId, {
    status: "processing",
    progress: 0,
    items: batchItems,
    total: batchItems.length,
    processed: 0,
    createdAt: Date.now(),
  });

  (async () => {
    const job = jobs.get(batchId);
    if (!job) return;

    for (let i = 0; i < job.items.length; i++) {
      const item = job.items[i];
      item.status = "processing";

      try {
        const url = item.url;
        if (!url) {
          item.status = "error";
          item.error = "No URL available";
          continue;
        }

        const platform = detectPlatform(url);
        if (!platform) {
          item.status = "error";
          item.error = "Unsupported platform";
          continue;
        }

        const ext = item.hasVideo ? "mp4" : "jpg";
        const outputPath = path.join(TMP_DIR, `${batchId}-${i}.${ext}`);
        const itemJobId = uuid();

        const options = {
          output: outputPath,
          format: item.hasVideo ? "bestvideo+bestaudio/best[ext=mp4]/best" : "best",
          mergeOutputFormat: "mp4",
          noWarnings: true,
          noCheckCertificates: true,
          ffmpegLocation: ffmpegStaticPath,
          retries: 3,
          socketTimeout: 45,
          addHeaders: { "User-Agent": DESKTOP_UA },
        };

        const cookies = cookiesFor(platform);
        if (cookies) options.cookies = cookies;

        await runYtDlpWithProgress(url, options, itemJobId, 120000);

        let finalPath = outputPath;
        if (!fs.existsSync(finalPath)) {
          const dirFiles = fs.readdirSync(TMP_DIR);
          const match = dirFiles.find((f) => f.startsWith(`${batchId}-${i}`));
          if (match) finalPath = path.join(TMP_DIR, match);
        }

        if (fs.existsSync(finalPath)) {
          item.status = "done";
          item.fileUrl = `/api/download/batch/${batchId}/${i}`;
          item.progress = 100;
        } else {
          throw new Error("Output file not produced");
        }
      } catch (err) {
        item.status = "error";
        item.error = friendlyError(err.stderr || err.message);
        console.error(`[seize] Batch item ${i} failed:`, err.message);
      }

      job.processed = i + 1;
      job.progress = Math.round(((i + 1) / job.total) * 100);
      job.items[i] = item;
    }

    job.status = "done";
    job.finishedAt = Date.now();
  })();

  res.json({ batchId });
});

router.get("/batch/:batchId/:index", (req, res) => {
  const job = jobs.get(req.params.batchId);
  if (!job) return res.status(404).json({ error: "Batch not found" });

  const index = parseInt(req.params.index);
  const item = job.items[index];
  if (!item) return res.status(404).json({ error: "Item not found" });
  if (item.status !== "done") {
    return res.status(404).json({ error: "Item not ready" });
  }

  const ext = item.hasVideo ? "mp4" : "jpg";
  const filePath = path.join(TMP_DIR, `${req.params.batchId}-${index}.${ext}`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  const filename = `${sanitizeFilename(item.title || "seize")}.${ext}`;
  res.download(filePath, filename, (err) => {
    if (!err) {
      // Cleanup will handle it
    }
  });
});

router.get("/batch/status/:batchId", (req, res) => {
  const job = jobs.get(req.params.batchId);
  if (!job) return res.status(404).json({ error: "Batch not found" });
  res.json({
    status: job.status,
    progress: job.progress,
    total: job.total,
    processed: job.processed,
    items: job.items,
    error: job.error,
  });
});

module.exports = router;

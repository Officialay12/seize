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
      console.log(`[seize] ${platform} cookies loaded`);
    } else {
      console.warn(`[seize] ${platform} cookies file not found: ${sourcePath}`);
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
    re: /(pinterest\.com|pin\.it|pinterest\.com\.au|pinterest\.co\.uk|pinterest\.de|pinterest\.fr|pinterest\.es|pinterest\.it)/i,
  },
  { name: "snapchat", re: /snapchat\.com/i },
  { name: "facebook", re: /(facebook\.com|fb\.watch)/i },
];

function detectPlatform(url) {
  const match = PLATFORM_PATTERNS.find((p) => p.re.test(url));
  return match ? match.name : null;
}

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
];

const DESKTOP_UA = USER_AGENTS[0];
const ANDROID_UA = USER_AGENTS[6];

function baseOptions(platform) {
  const opts = {
    noWarnings: true,
    noCheckCertificates: true,
    ffmpegLocation: ffmpegStaticPath,
    retries: 3,
    socketTimeout: 30,
    concurrentFragments: 16,
    throttledRate: "50M",
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
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
        },
        {
          ...base,
          cookies: undefined,
          addHeaders: {
            "User-Agent": USER_AGENTS[3],
            Referer: "https://www.tiktok.com/",
          },
        },
      ];
    case "instagram":
      return [
        {
          ...base,
          extractorArgs: "instagram:include_ads=false",
          addHeaders: {
            "User-Agent": DESKTOP_UA,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
        },
        {
          ...base,
          extractorArgs: "instagram:include_ads=false",
          addHeaders: {
            "User-Agent": ANDROID_UA,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
        },
        {
          ...base,
          cookies: undefined,
          addHeaders: {
            "User-Agent": DESKTOP_UA,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
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
          addHeaders: {
            "User-Agent": DESKTOP_UA,
            Accept: "application/json, text/plain, */*",
          },
        },
        {
          ...base,
          addHeaders: {
            "User-Agent": ANDROID_UA,
            Accept: "application/json, text/plain, */*",
          },
        },
        {
          ...base,
          cookies: undefined,
          addHeaders: {
            "User-Agent": DESKTOP_UA,
            Accept: "application/json, text/plain, */*",
          },
        },
      ];
    case "pinterest":
      return [
        {
          ...base,
          extractorArgs: "generic",
          addHeaders: {
            "User-Agent": DESKTOP_UA,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Upgrade-Insecure-Requests": "1",
          },
        },
        {
          ...base,
          cookies: undefined,
          extractorArgs: "generic",
          addHeaders: {
            "User-Agent": DESKTOP_UA,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
          },
        },
        {
          ...base,
          extractorArgs: "generic",
          addHeaders: {
            "User-Agent": ANDROID_UA,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
          },
        },
        {
          ...base,
          cookies: undefined,
          extractorArgs: "generic",
          addHeaders: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
        },
        {
          ...base,
          cookies: undefined,
          extractorArgs: "generic",
          addHeaders: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
        },
      ];
    case "snapchat":
      return [
        {
          ...base,
          addHeaders: {
            "User-Agent": DESKTOP_UA,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
        },
        {
          ...base,
          addHeaders: {
            "User-Agent": ANDROID_UA,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
        },
        {
          ...base,
          cookies: undefined,
          addHeaders: {
            "User-Agent": DESKTOP_UA,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
        },
      ];
    case "facebook":
      return [
        {
          ...base,
          addHeaders: {
            "User-Agent": DESKTOP_UA,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
        },
        {
          ...base,
          addHeaders: {
            "User-Agent": ANDROID_UA,
            Referer: "https://m.facebook.com/",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
        },
        {
          ...base,
          cookies: undefined,
          addHeaders: {
            "User-Agent": DESKTOP_UA,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
        },
        {
          ...base,
          extractorArgs: "facebook:include_ads=false",
          addHeaders: {
            "User-Agent": DESKTOP_UA,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
        },
      ];
    default:
      return [{ ...base, addHeaders: { "User-Agent": DESKTOP_UA } }];
  }
}

async function extractPinterestDirect(url) {
  console.log("[seize] Direct Pinterest extraction...");

  for (const ua of USER_AGENTS) {
    try {
      console.log(`[seize] Pinterest UA: ${ua.slice(0, 40)}...`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(url, {
        headers: {
          "User-Agent": ua,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Upgrade-Insecure-Requests": "1",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        console.log(`[seize] Pinterest HTTP ${response.status}`);
        continue;
      }

      const html = await response.text();

      const videoPatterns = [
        /"videoUrl"\s*:\s*"([^"]+)"/i,
        /"video_url"\s*:\s*"([^"]+)"/i,
        /"contentUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/i,
        /"url"\s*:\s*"([^"]+\.mp4[^"]*)"/i,
        /<video[^>]+src="([^"]+\.mp4[^"]*)"/i,
        /<video[^>]+src="([^"]+\.mov[^"]*)"/i,
        /https:\/\/[^\s"]+\.mp4[^\s"]*/i,
        /https:\/\/[^\s"]+\.mov[^\s"]*/i,
        /https:\/\/[^\s"]+\.webm[^\s"]*/i,
        /https:\/\/[a-z0-9]+\.pinimg\.com\/[^\s"']+\.mp4[^\s"']*/i,
        /https:\/\/video\.pinimg\.com\/[^\s"']+/i,
        /"videoList"\s*:\s*\[\s*\{[^}]*"url"\s*:\s*"([^"]+)"/i,
      ];

      let videoUrl = null;
      for (const pattern of videoPatterns) {
        const match = html.match(pattern);
        if (match) {
          videoUrl = match[1] || match[0];
          videoUrl = videoUrl.replace(/\\/g, "");
          console.log(`[seize] Found Pinterest video`);
          break;
        }
      }

      const imagePatterns = [
        /"imageUrl"\s*:\s*"([^"]+)"/i,
        /"image_url"\s*:\s*"([^"]+)"/i,
        /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
        /<img[^>]+src="([^"]+\.(jpg|jpeg|png|webp)[^"]*)"/i,
        /https:\/\/[^\s"]+\.(jpg|jpeg|png|webp)[^\s"]*/i,
        /https:\/\/[a-z0-9]+\.pinimg\.com\/[^\s"']+\.(jpg|jpeg|png|webp)[^\s"']*/i,
      ];

      let imageUrl = null;
      for (const pattern of imagePatterns) {
        const match = html.match(pattern);
        if (match) {
          imageUrl = match[1] || match[0];
          imageUrl = imageUrl.replace(/\\/g, "");
          console.log(`[seize] Found Pinterest image`);
          break;
        }
      }

      let title = html.match(
        /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i,
      );
      title = title ? title[1] : "Pinterest Pin";

      let uploader = html.match(
        /<meta[^>]+property="og:site_name"[^>]+content="([^"]+)"/i,
      );
      uploader = uploader ? uploader[1] : "Pinterest";

      const hasVideo = !!videoUrl;
      const hasImage = !!imageUrl;

      if (!hasVideo && !hasImage) {
        console.log("[seize] No media found, trying yt-dlp...");
        continue;
      }

      let thumbnail = imageUrl || videoUrl || null;

      return {
        platform: "pinterest",
        title: title,
        uploader: uploader,
        thumbnail: thumbnail,
        contentType: hasVideo ? "video" : "image",
        hasVideo: hasVideo,
        hasImage: hasImage || !hasVideo,
        media: {
          videos: hasVideo
            ? [{ url: videoUrl, format: "mp4", quality: "HD" }]
            : [],
          images: hasImage
            ? [{ url: imageUrl || thumbnail, format: "jpg" }]
            : [],
          audio: [],
        },
        directExtract: true,
      };
    } catch (err) {
      console.log(`[seize] Pinterest direct attempt failed: ${err.message}`);
      continue;
    }
  }

  return null;
}

async function resolveWithStrategies(url, platform, isUsable) {
  if (platform === "pinterest") {
    const directResult = await extractPinterestDirect(url);
    if (directResult) {
      return { info: directResult, strategyIndex: -1, directExtract: true };
    }
  }

  const strategies = getStrategies(platform);
  let lastErr;

  for (let i = 0; i < strategies.length; i++) {
    const options = {
      dumpSingleJson: true,
      preferFreeFormats: true,
      ...strategies[i],
    };
    try {
      console.log(
        `[seize] Strategy ${i + 1}/${strategies.length} for ${platform}...`,
      );
      const info = await ytDlp(url, options, { timeout: 45000 });
      if (!isUsable || isUsable(info)) {
        console.log(`[seize] Strategy ${i + 1} succeeded!`);
        return { info, strategyIndex: i };
      }
      lastErr = new Error("Strategy returned no usable media");
    } catch (err) {
      lastErr = err;
      const msg = (err.stderr || err.message || "").toLowerCase();
      console.log(`[seize] Strategy ${i + 1} failed`);
      if (
        msg.includes("429") ||
        msg.includes("rate limit") ||
        msg.includes("blocked")
      ) {
        console.log("[seize] Rate limited, trying next strategy");
      }
    }
    if (i < strategies.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr || new Error("All extraction strategies failed");
}

function runYtDlpWithProgress(url, options, jobId, timeoutMs = 90000) {
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

  if (
    s.includes("pinterest") &&
    (s.includes("login") || s.includes("sign in"))
  ) {
    return "Pinterest is blocking automated access. Try again in a few minutes.";
  }
  if (s.includes("pinterest") && s.includes("not found")) {
    return "This Pinterest pin doesn't exist or has been removed.";
  }
  if (
    s.includes("pinterest") &&
    (s.includes("rate limit") || s.includes("429"))
  ) {
    return "Pinterest is rate limiting. Wait 5-10 minutes.";
  }
  if (s.includes("pinterest") && s.includes("403")) {
    return "Pinterest blocked this request. Try a different pin or wait.";
  }
  if (s.includes("tiktok") && s.includes("private")) {
    return "This TikTok video is private.";
  }
  if (s.includes("tiktok") && s.includes("not found")) {
    return "This TikTok video doesn't exist or was removed.";
  }
  if (s.includes("tiktok") && s.includes("rate limit")) {
    return "TikTok is rate limiting. Wait a moment.";
  }
  if (s.includes("instagram") && s.includes("private")) {
    return "This Instagram post is private.";
  }
  if (s.includes("instagram") && s.includes("not found")) {
    return "This Instagram post doesn't exist or was removed.";
  }
  if (s.includes("instagram") && s.includes("rate limit")) {
    return "Instagram is rate limiting. Wait a moment.";
  }
  if (
    (s.includes("twitter") && s.includes("private")) ||
    s.includes("protected")
  ) {
    return "This Twitter/X post is protected or private.";
  }
  if (s.includes("twitter") && s.includes("not found")) {
    return "This Twitter/X post doesn't exist or was removed.";
  }
  if (s.includes("twitter") && s.includes("rate limit")) {
    return "Twitter/X is rate limiting. Wait a moment.";
  }
  if (s.includes("snapchat") && s.includes("private")) {
    return "This Snapchat post is private. Only public Spotlight or Story links work.";
  }
  if (s.includes("snapchat") && s.includes("expired")) {
    return "This Snapchat link has expired. Stories expire after 24 hours.";
  }
  if (s.includes("snapchat") && s.includes("not found")) {
    return "This Snapchat post doesn't exist or was removed.";
  }
  if (s.includes("facebook") && s.includes("private")) {
    return "This Facebook post is private.";
  }
  if (s.includes("facebook") && s.includes("not found")) {
    return "This Facebook post doesn't exist or was removed.";
  }
  if (s.includes("geo") || s.includes("not available in your country")) {
    return "This content is region-locked.";
  }
  if (s.includes("age") && s.includes("restrict")) {
    return "This video is age-restricted.";
  }
  if (s.includes("sign in") || s.includes("login")) {
    return "This content requires a logged-in session.";
  }
  if (s.includes("copyright") || s.includes("blocked it on copyright")) {
    return "This content was blocked due to a copyright claim.";
  }
  if (s.includes("removed") || s.includes("video unavailable")) {
    return "This content has been removed or deleted.";
  }
  if (s.includes("timed out") || s.includes("timeout")) {
    return "The platform took too long to respond. Try again.";
  }
  if (s.includes("rate limit") || s.includes("429")) {
    return "Rate limited. Please wait a bit.";
  }
  if (
    s.includes("econnrefused") ||
    s.includes("enotfound") ||
    s.includes("network")
  ) {
    return "The platform seems to be down. Try again shortly.";
  }
  if (s.includes("no video") || s.includes("could not be found")) {
    return "No downloadable media found at this link.";
  }
  if (s.includes("profile") || s.includes("channel")) {
    return "Use a specific post URL, not a profile.";
  }
  if (s.includes("unsupported url")) {
    return "This link format isn't recognized.";
  }

  return "Couldn't resolve this link. It may be blocked, deleted, or private.";
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

  if (info.directExtract) {
    return {
      images: info.media.images || [],
      videos: info.media.videos || [],
      audio: info.media.audio || [],
      thumbnail: info.thumbnail || null,
      hasVideo: info.hasVideo || false,
      hasImage: info.hasImage || false,
      isGif: false,
    };
  }

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

    if (node.url && node.ext) {
      const ext = node.ext.toLowerCase();
      const isGif =
        ext === "gif" ||
        (node.format_note && node.format_note.toLowerCase().includes("gif"));

      if (isGif || ["mp4", "mov", "webm", "mkv"].includes(ext)) {
        media.videos.push({
          url: node.url,
          format: isGif ? "mp4" : ext,
          quality: node.format_note || "Unknown",
          width: node.width || null,
          height: node.height || null,
          isGif: isGif,
        });
        media.hasVideo = true;
        if (isGif) media.isGif = true;
      } else if (["jpg", "jpeg", "png", "webp"].includes(ext)) {
        media.images.push({
          url: node.url,
          format: ext,
          width: node.width || null,
          height: node.height || null,
        });
        media.hasImage = true;
      }
    }

    if (Array.isArray(node.formats)) {
      for (const format of node.formats) {
        if (!format.url) continue;

        const isVideoFormat = format.vcodec && format.vcodec !== "none";
        const isVideoExt =
          format.ext &&
          ["mp4", "mov", "webm", "mkv", "avi", "3gp"].includes(
            format.ext.toLowerCase(),
          );
        const isGifFormat =
          format.format_note && /(gif|animated|loop)/i.test(format.format_note);
        const isSnapchatVideo =
          format.format_note &&
          /(video|story|snap|spotlight)/i.test(format.format_note);

        if (isVideoFormat || (isVideoExt && (isSnapchatVideo || isGifFormat))) {
          media.videos.push({
            url: format.url,
            format: format.ext || "mp4",
            quality: format.format_note || format.quality || "Unknown",
            width: format.width || null,
            height: format.height || null,
            isGif: isGifFormat,
          });
          media.hasVideo = true;
          if (isGifFormat) media.isGif = true;
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

        const isImageExt =
          format.ext &&
          ["jpg", "jpeg", "png", "webp", "avif", "bmp", "tiff"].includes(
            format.ext.toLowerCase(),
          );

        if (isImageExt && format.ext !== "gif") {
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
  }

  if (!media.thumbnail && media.images.length > 0) {
    media.thumbnail = media.images[0].url;
  }
  if (!media.thumbnail && media.videos.length > 0) {
    media.thumbnail = media.videos[0].url;
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
  if (info.directExtract) {
    return info.hasVideo || info.hasImage;
  }

  const media = extractMediaUrls(info);

  if (info.formats && Array.isArray(info.formats)) {
    const hasVideo = info.formats.some(
      (f) =>
        (f.vcodec && f.vcodec !== "none") ||
        (f.ext && ["mp4", "mov", "webm"].includes(f.ext.toLowerCase())) ||
        (f.format_note && /(video|gif|story|snap)/i.test(f.format_note)),
    );
    if (hasVideo) return true;
  }

  if (info.url && info.ext) {
    const ext = info.ext.toLowerCase();
    if (
      ["mp4", "mov", "webm", "mkv", "jpg", "jpeg", "png", "webp"].includes(ext)
    ) {
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
  return (
    String(name || "seize")
      .replace(/[\/\\?%*:|"<>]/g, "")
      .replace(/[\r\n]/g, "")
      .trim()
      .slice(0, 150) || "seize"
  );
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
  if (
    platform === "pinterest" &&
    (url.includes("pin.it") || url.includes("/pin/"))
  ) {
    try {
      const response = await fetch(url, {
        method: "HEAD",
        headers: { "User-Agent": DESKTOP_UA },
        redirect: "follow",
      });
      finalUrl = response.url || url;
    } catch (e) {
      // use original
    }
  }

  try {
    console.log(`[seize] Resolving ${platform}...`);
    const { info } = await resolveWithStrategies(
      finalUrl,
      platform,
      isUsableInfo,
    );

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

    let uploader =
      info.uploader ||
      info.channel ||
      info.author ||
      info.creator ||
      info.owner ||
      null;

    let contentType = "unknown";
    if (media.hasVideo) contentType = "video";
    else if (media.hasImage) contentType = "image";
    else if (media.audio.length > 0) contentType = "audio";

    if (media.isGif) contentType = "video";

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
          await runYtDlpWithProgress(url, options, jobId, 90000);
          succeeded = true;
          break outer;
        } catch (err) {
          lastErr = err;
          const msg = (err.stderr || err.message || "").toLowerCase();
          if (
            msg.includes("429") ||
            msg.includes("rate limit") ||
            msg.includes("blocked")
          ) {
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
// CREATOR ARCHIVE - FAST & OPTIMIZED
// ============================================================
router.post("/profile", async (req, res) => {
  const { url, platform, limit = 50, mode = "all" } = req.body;
  if (!url) return res.status(400).json({ error: "Profile URL is required" });

  const detectedPlatform = platform || detectPlatform(url);
  if (!detectedPlatform) {
    return res.status(400).json({
      error:
        "Unsupported platform. Only TikTok, Instagram, Twitter/X, and Pinterest are supported.",
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
    createdAt: Date.now(),
  });

  // Process in background
  (async () => {
    try {
      console.log(
        `[seize] Fast scanning profile from ${detectedPlatform}: ${url}`,
      );

      let items = [];
      const maxItems = Math.min(limit, 100);

      if (detectedPlatform === "tiktok") {
        // TikTok - use flat playlist with minimal data
        const options = {
          dumpSingleJson: true,
          noWarnings: true,
          noCheckCertificates: true,
          ffmpegLocation: ffmpegStaticPath,
          retries: 2,
          socketTimeout: 20,
          playlistItems: true,
          playlistEnd: maxItems,
          extractorArgs: "tiktok:device_id=auto",
          addHeaders: {
            "User-Agent": ANDROID_UA,
            Accept: "application/json, text/plain, */*",
            Referer: "https://www.tiktok.com/",
          },
          // Skip downloading media - just metadata
          skipDownload: true,
        };

        const cookies = cookiesFor(detectedPlatform);
        if (cookies) options.cookies = cookies;

        const info = await ytDlp(url, options, { timeout: 30000 });

        const entries = Array.isArray(info.entries) ? info.entries : [info];

        for (const entry of entries) {
          if (!entry || items.length >= maxItems) continue;

          const hasVideo = !!(
            entry.formats?.some((f) => f.vcodec && f.vcodec !== "none") ||
            entry.ext === "mp4" ||
            entry.ext === "mov" ||
            entry.ext === "webm"
          );
          const hasImage = !!(
            entry.formats?.some(
              (f) => f.ext && ["jpg", "jpeg", "png", "webp"].includes(f.ext),
            ) ||
            entry.ext === "jpg" ||
            entry.ext === "jpeg" ||
            entry.ext === "png" ||
            entry.ext === "webp"
          );

          let thumbnail = entry.thumbnail || null;
          if (!thumbnail && entry.thumbnails && entry.thumbnails.length) {
            const largest = [...entry.thumbnails].sort(
              (a, b) => (b.width || 0) - (a.width || 0),
            )[0];
            thumbnail = largest?.url || null;
          }

          const item = {
            id: entry.id || entry.webpage_url || `item-${Date.now()}`,
            title: entry.title || entry.fulltitle || "Untitled",
            url: entry.webpage_url || entry.url || null,
            thumbnail: thumbnail,
            duration: entry.duration || null,
            hasVideo: hasVideo,
            hasImage: hasImage || (!hasVideo && !!thumbnail),
            contentType: hasVideo ? "video" : hasImage ? "image" : "unknown",
            uploader: info.uploader || info.channel || info.author || null,
            viewCount: entry.view_count || entry.views || null,
            likeCount: entry.like_count || entry.likes || null,
            timestamp: entry.timestamp || entry.upload_date || null,
          };

          if (mode === "videos" && !item.hasVideo) continue;
          if (mode === "images" && !item.hasImage) continue;
          if (mode === "all" || item.hasVideo || item.hasImage) {
            items.push(item);
          }
        }
      } else if (detectedPlatform === "instagram") {
        // Instagram - fast playlist extraction
        const options = {
          dumpSingleJson: true,
          noWarnings: true,
          noCheckCertificates: true,
          ffmpegLocation: ffmpegStaticPath,
          retries: 2,
          socketTimeout: 20,
          playlistItems: true,
          playlistEnd: maxItems,
          extractorArgs: "instagram:include_ads=false",
          addHeaders: {
            "User-Agent": DESKTOP_UA,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          },
          skipDownload: true,
        };

        const cookies = cookiesFor(detectedPlatform);
        if (cookies) options.cookies = cookies;

        const info = await ytDlp(url, options, { timeout: 30000 });

        const entries = Array.isArray(info.entries) ? info.entries : [info];

        for (const entry of entries) {
          if (!entry || items.length >= maxItems) continue;

          const hasVideo = !!(
            entry.formats?.some((f) => f.vcodec && f.vcodec !== "none") ||
            entry.ext === "mp4" ||
            entry.ext === "mov" ||
            entry.ext === "webm"
          );
          const hasImage = !!(
            entry.formats?.some(
              (f) => f.ext && ["jpg", "jpeg", "png", "webp"].includes(f.ext),
            ) ||
            entry.ext === "jpg" ||
            entry.ext === "jpeg" ||
            entry.ext === "png" ||
            entry.ext === "webp"
          );

          let thumbnail = entry.thumbnail || null;
          if (!thumbnail && entry.thumbnails && entry.thumbnails.length) {
            const largest = [...entry.thumbnails].sort(
              (a, b) => (b.width || 0) - (a.width || 0),
            )[0];
            thumbnail = largest?.url || null;
          }

          const item = {
            id: entry.id || entry.webpage_url || `item-${Date.now()}`,
            title: entry.title || entry.fulltitle || "Untitled",
            url: entry.webpage_url || entry.url || null,
            thumbnail: thumbnail,
            duration: entry.duration || null,
            hasVideo: hasVideo,
            hasImage: hasImage || (!hasVideo && !!thumbnail),
            contentType: hasVideo ? "video" : hasImage ? "image" : "unknown",
            uploader: info.uploader || info.channel || info.author || null,
            viewCount: entry.view_count || entry.views || null,
            likeCount: entry.like_count || entry.likes || null,
            timestamp: entry.timestamp || entry.upload_date || null,
          };

          if (mode === "videos" && !item.hasVideo) continue;
          if (mode === "images" && !item.hasImage) continue;
          if (mode === "all" || item.hasVideo || item.hasImage) {
            items.push(item);
          }
        }
      } else if (detectedPlatform === "twitter") {
        // Twitter/X - fast playlist extraction
        const options = {
          dumpSingleJson: true,
          noWarnings: true,
          noCheckCertificates: true,
          ffmpegLocation: ffmpegStaticPath,
          retries: 2,
          socketTimeout: 20,
          playlistItems: true,
          playlistEnd: maxItems,
          extractorArgs: "twitter:api=syndication",
          addHeaders: {
            "User-Agent": DESKTOP_UA,
            Accept: "application/json, text/plain, */*",
          },
          skipDownload: true,
        };

        const cookies = cookiesFor(detectedPlatform);
        if (cookies) options.cookies = cookies;

        const info = await ytDlp(url, options, { timeout: 30000 });

        const entries = Array.isArray(info.entries) ? info.entries : [info];

        for (const entry of entries) {
          if (!entry || items.length >= maxItems) continue;

          const hasVideo = !!(
            entry.formats?.some((f) => f.vcodec && f.vcodec !== "none") ||
            entry.ext === "mp4" ||
            entry.ext === "mov" ||
            entry.ext === "webm"
          );
          const hasImage = !!(
            entry.formats?.some(
              (f) => f.ext && ["jpg", "jpeg", "png", "webp"].includes(f.ext),
            ) ||
            entry.ext === "jpg" ||
            entry.ext === "jpeg" ||
            entry.ext === "png" ||
            entry.ext === "webp"
          );

          let thumbnail = entry.thumbnail || null;
          if (!thumbnail && entry.thumbnails && entry.thumbnails.length) {
            const largest = [...entry.thumbnails].sort(
              (a, b) => (b.width || 0) - (a.width || 0),
            )[0];
            thumbnail = largest?.url || null;
          }

          const item = {
            id: entry.id || entry.webpage_url || `item-${Date.now()}`,
            title: entry.title || entry.fulltitle || "Untitled",
            url: entry.webpage_url || entry.url || null,
            thumbnail: thumbnail,
            duration: entry.duration || null,
            hasVideo: hasVideo,
            hasImage: hasImage || (!hasVideo && !!thumbnail),
            contentType: hasVideo ? "video" : hasImage ? "image" : "unknown",
            uploader: info.uploader || info.channel || info.author || null,
            viewCount: entry.view_count || entry.views || null,
            likeCount: entry.like_count || entry.likes || null,
            timestamp: entry.timestamp || entry.upload_date || null,
          };

          if (mode === "videos" && !item.hasVideo) continue;
          if (mode === "images" && !item.hasImage) continue;
          if (mode === "all" || item.hasVideo || item.hasImage) {
            items.push(item);
          }
        }
      } else if (detectedPlatform === "pinterest") {
        // Pinterest - use direct extraction or generic
        const options = {
          dumpSingleJson: true,
          noWarnings: true,
          noCheckCertificates: true,
          ffmpegLocation: ffmpegStaticPath,
          retries: 2,
          socketTimeout: 20,
          extractorArgs: "generic",
          addHeaders: {
            "User-Agent": DESKTOP_UA,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
          },
          skipDownload: true,
        };

        const cookies = cookiesFor(detectedPlatform);
        if (cookies) options.cookies = cookies;

        // Try to get the pin feed
        let pinterestUrl = url;
        if (!url.includes("/feed/") && !url.includes("/pins/")) {
          pinterestUrl = url.replace(/\/$/, "") + "/pins/";
        }

        const info = await ytDlp(pinterestUrl, options, { timeout: 30000 });

        const entries = Array.isArray(info.entries) ? info.entries : [info];

        for (const entry of entries) {
          if (!entry || items.length >= maxItems) continue;

          const hasVideo = !!(
            entry.formats?.some((f) => f.vcodec && f.vcodec !== "none") ||
            entry.ext === "mp4" ||
            entry.ext === "mov" ||
            entry.ext === "webm"
          );
          const hasImage = !!(
            entry.formats?.some(
              (f) => f.ext && ["jpg", "jpeg", "png", "webp"].includes(f.ext),
            ) ||
            entry.ext === "jpg" ||
            entry.ext === "jpeg" ||
            entry.ext === "png" ||
            entry.ext === "webp"
          );

          let thumbnail = entry.thumbnail || null;
          if (!thumbnail && entry.thumbnails && entry.thumbnails.length) {
            const largest = [...entry.thumbnails].sort(
              (a, b) => (b.width || 0) - (a.width || 0),
            )[0];
            thumbnail = largest?.url || null;
          }

          const item = {
            id: entry.id || entry.webpage_url || `item-${Date.now()}`,
            title: entry.title || entry.fulltitle || "Untitled",
            url: entry.webpage_url || entry.url || null,
            thumbnail: thumbnail,
            duration: entry.duration || null,
            hasVideo: hasVideo,
            hasImage: hasImage || (!hasVideo && !!thumbnail),
            contentType: hasVideo ? "video" : hasImage ? "image" : "unknown",
            uploader: info.uploader || info.channel || info.author || null,
            viewCount: entry.view_count || entry.views || null,
            likeCount: entry.like_count || entry.likes || null,
            timestamp: entry.timestamp || entry.upload_date || null,
          };

          if (mode === "videos" && !item.hasVideo) continue;
          if (mode === "images" && !item.hasImage) continue;
          if (mode === "all" || item.hasVideo || item.hasImage) {
            items.push(item);
          }
        }
      }

      // Limit items
      items = items.slice(0, limit);

      const job = jobs.get(jobId);
      if (job) {
        job.status = "done";
        job.progress = 100;
        job.items = items;
        job.total = items.length;
        job.processed = items.length;
        job.finishedAt = Date.now();
      }

      console.log(
        `[seize] Fast scan complete: ${items.length} items from ${detectedPlatform} in ${Date.now() - job.createdAt}ms`,
      );
    } catch (err) {
      console.error("[seize] Profile scan failed:", err.message);
      console.error("[seize] Error details:", err.stderr || err);

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

// ============================================================
// PROFILE STATUS
// ============================================================
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

// ============================================================
// BATCH DOWNLOAD - PARALLEL
// ============================================================
router.post("/profile/batch", async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "At least one item is required" });
  }

  const batchId = uuid();
  const batchItems = items.map((item) => ({
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

    const concurrency = 5;

    for (let i = 0; i < job.items.length; i += concurrency) {
      const chunk = job.items.slice(i, i + concurrency);

      await Promise.all(
        chunk.map(async (item, chunkIndex) => {
          const actualIndex = i + chunkIndex;

          try {
            const url = item.url;
            if (!url) {
              item.status = "error";
              item.error = "No URL available";
              return;
            }

            const platform = detectPlatform(url);
            if (!platform) {
              item.status = "error";
              item.error = "Unsupported platform";
              return;
            }

            const ext = item.hasVideo ? "mp4" : "jpg";
            const outputPath = path.join(
              TMP_DIR,
              `${batchId}-${actualIndex}.${ext}`,
            );
            const itemJobId = uuid();

            const options = {
              output: outputPath,
              format: item.hasVideo
                ? "bestvideo+bestaudio/best[ext=mp4]/best"
                : "best",
              mergeOutputFormat: "mp4",
              noWarnings: true,
              noCheckCertificates: true,
              ffmpegLocation: ffmpegStaticPath,
              retries: 2,
              socketTimeout: 30,
              addHeaders: { "User-Agent": DESKTOP_UA },
              concurrentFragments: 16,
              throttledRate: "50M",
            };

            const cookies = cookiesFor(platform);
            if (cookies) options.cookies = cookies;

            await runYtDlpWithProgress(url, options, itemJobId, 60000);

            let finalPath = outputPath;
            if (!fs.existsSync(finalPath)) {
              const dirFiles = fs.readdirSync(TMP_DIR);
              const match = dirFiles.find((f) =>
                f.startsWith(`${batchId}-${actualIndex}`),
              );
              if (match) finalPath = path.join(TMP_DIR, match);
            }

            if (fs.existsSync(finalPath)) {
              item.status = "done";
              item.fileUrl = `/api/download/batch/${batchId}/${actualIndex}`;
              item.progress = 100;
            } else {
              throw new Error("Output file not produced");
            }
          } catch (err) {
            item.status = "error";
            item.error = friendlyError(err.stderr || err.message);
          }

          job.processed = (job.processed || 0) + 1;
          job.progress = Math.round((job.processed / job.total) * 100);
          job.items[actualIndex] = item;
        }),
      );
    }

    job.status = "done";
    job.finishedAt = Date.now();
  })();

  res.json({ batchId });
});

// ============================================================
// BATCH DOWNLOAD FILE
// ============================================================
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
      // cleanup will handle it
    }
  });
});

// ============================================================
// BATCH STATUS
// ============================================================
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

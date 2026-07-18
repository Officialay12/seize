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

// ===
// Render Secret Files (and similar mounts on other hosts) are read-only.
// yt-dlp writes updated session data back to the cookies file after every
// run — pointed directly at a read-only mount, that write throws an
// unhandled OSError that crashes the whole request. Copy each configured
// cookies file into the writable tmp dir once at boot, and use that copy.
const COOKIE_SOURCE_FILES = {
  tiktok: process.env.TIKTOK_COOKIES_FILE,
  instagram: process.env.INSTAGRAM_COOKIES_FILE,
  twitter: process.env.TWITTER_COOKIES_FILE,
  facebook: process.env.FACEBOOK_COOKIES_FILE,
  pinterest: process.env.PINTEREST_COOKIES_FILE,
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
  { name: "pinterest", re: /(pinterest\.com|pin\.it)/i },
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
          addHeaders: { "User-Agent": DESKTOP_UA },
        },
        {
          ...base,
          addHeaders: { "User-Agent": ANDROID_UA },
        },
      ];
    case "snapchat":
      // Only public Spotlight/Story links are reachable at all — Snapchat
      // has no concept of a stable "post URL" for private snaps/stories,
      // by design (that's the whole premise of the app). Nothing short of
      // account-level access could ever resolve those, and that's out of
      // scope here the same way it is for WhatsApp statuses.
      return [
        {
          ...base,
          addHeaders: { "User-Agent": DESKTOP_UA },
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
      const info = await ytDlp(url, options, { timeout: 60000 });
      if (!isUsable || isUsable(info)) {
        return { info, strategyIndex: i };
      }
      lastErr = new Error("Strategy returned no usable media");
    } catch (err) {
      lastErr = err;
      const msg = (err.stderr || err.message || "").toLowerCase();
      // rate limit = give up early, switching client won't fix that
      if (msg.includes("429") || msg.includes("rate limit")) throw err;
    }
    if (i < strategies.length - 1) {
      // tiny gap between strategies, dodges transient blocks
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastErr || new Error("All extraction strategies failed");
}

// parses yt-dlp's own stdout ("[download] 42.3% of 12.34MiB") for real
// progress instead of faking a linear bar
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

  // --- most specific checks first ---
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
  };

  // carousels (IG sidecar, twitter multi-photo, tiktok slideshows) come
  // back as a playlist with `entries` — flatten those into the same buckets
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

    if (Array.isArray(node.formats)) {
      for (const format of node.formats) {
        if (!format.url) continue;

        if (format.vcodec && format.vcodec !== "none") {
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

        if (
          format.ext &&
          ["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "tiff"].includes(
            format.ext,
          )
        ) {
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

    // some image posts expose the image directly, not as a "format"
    // (IG/twitter photo posts do this)
    if (
      node.url &&
      (node.ext === "jpg" ||
        node.ext === "jpeg" ||
        node.ext === "png" ||
        node.ext === "webp")
    ) {
      media.images.push({ url: node.url, format: node.ext });
      media.hasImage = true;
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
  return media.hasVideo || media.hasImage || media.audio.length > 0;
}

// media.videos is already sorted best->worst by extractMediaUrls. Slicing
// by position used to just keep the top N, which — since platforms expose
// many near-duplicate high-res formats — meant lower resolutions almost
// never survived the cut. Dedupe by height instead so every distinct
// quality tier gets one representative entry.
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

  try {
    console.log(`[seize] Resolving ${platform}...`);
    const { info } = await resolveWithStrategies(url, platform, isUsableInfo);

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
    // ---------- IMAGE MODE ----------
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

    // ---------- VIDEO / AUDIO MODE ----------
    // fallback chain of format strings, weakest last. quality tier
    // (e.g. "720") caps height on every entry; "best" leaves it alone
    const heightCap = /^\d+$/.test(String(quality)) ? String(quality) : null;
    const capFmt = (fmt) => {
      if (!heightCap) return fmt;
      // cap height per alternative, leave the "/" fallbacks alone
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
          // wipe partial file before the next attempt
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

router.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ status: job.status, progress: job.progress, error: job.error });
});

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

module.exports = router;

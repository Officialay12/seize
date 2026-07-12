const express = require("express");
const path = require("path");
const fs = require("fs");
const { v4: uuid } = require("uuid");
const ytDlp = require("yt-dlp-exec");
const ffmpegStaticPath = require("ffmpeg-static");
const https = require("https");
const http = require("http");
const { scheduleCleanup } = require("../utils/cleanup");

const router = express.Router();

const TMP_DIR = path.join(__dirname, "..", "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const jobs = new Map();
scheduleCleanup({ jobs, tmpDir: TMP_DIR });

const PLATFORM_PATTERNS = [
  { name: "youtube", re: /(youtube\.com|youtu\.be)/i },
  { name: "tiktok", re: /tiktok\.com/i },
  { name: "instagram", re: /instagram\.com/i },
  { name: "twitter", re: /(twitter\.com|x\.com)/i },
];

function detectPlatform(url) {
  const match = PLATFORM_PATTERNS.find((p) => p.re.test(url));
  return match ? match.name : null;
}

function getPlatformOptions(platform) {
  const base = {
    noWarnings: true,
    noCheckCertificates: true,
    ffmpegLocation: ffmpegStaticPath,
    retries: 5,
    socketTimeout: 45,
  };

  switch (platform) {
    case "youtube":
      return {
        ...base,
        extractorArgs: "youtube:player_client=android",
        addHeaders: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36",
        },
      };
    case "tiktok":
      return {
        ...base,
        extractorArgs: "tiktok:device_id=auto",
        addHeaders: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36",
          Accept: "application/json, text/plain, */*",
        },
      };
    case "instagram":
      return {
        ...base,
        extractorArgs: "instagram:include_ads=false",
        addHeaders: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      };
    case "twitter":
      return {
        ...base,
        addHeaders: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "application/json, text/plain, */*",
        },
      };
    default:
      return base;
  }
}

function downloadFile(url, filePath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(filePath);

    protocol
      .get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          downloadFile(response.headers.location, filePath)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
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

async function fetchWithRetry(url, options, maxRetries = 3) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await ytDlp(url, options, { timeout: 90000 });
    } catch (err) {
      lastError = err;
      if (i < maxRetries - 1) {
        const delay = 3000 * Math.pow(2, i);
        console.log(`[seize] Retry ${i + 1}/${maxRetries} after ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

function friendlyError(stderr = "") {
  const s = stderr.toLowerCase();
  if (s.includes("private")) return "This post is private.";
  if (s.includes("age") && s.includes("restrict"))
    return "This video is age-restricted.";
  if (s.includes("unavailable") || s.includes("not available"))
    return "Content removed or region-locked.";
  if (s.includes("sign in") || s.includes("login"))
    return "Requires authentication.";
  if (s.includes("timed out") || s.includes("timeout"))
    return "Platform took too long. Try again.";
  if (s.includes("rate limit") || s.includes("429"))
    return "Rate limited. Please wait.";
  if (s.includes("no video") || s.includes("could not be found"))
    return "No video found (may be an image).";
  if (s.includes("profile") || s.includes("channel"))
    return "Use a specific video URL, not profile.";
  return "Could not resolve. Try again.";
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

  if (info.thumbnail) {
    media.thumbnail = info.thumbnail;
  } else if (info.thumbnails && Array.isArray(info.thumbnails)) {
    const largest = [...info.thumbnails].sort(
      (a, b) => (b.width || 0) - (a.width || 0),
    )[0];
    media.thumbnail = largest?.url || null;
  }

  if (info.formats && Array.isArray(info.formats)) {
    for (const format of info.formats) {
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

router.post("/resolve", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "A URL is required" });

  const platform = detectPlatform(url);
  if (!platform) {
    return res.status(400).json({
      error: "Unsupported. Only YouTube, TikTok, Instagram, Twitter/X.",
    });
  }

  // Check TikTok profile URL
  if (platform === "tiktok") {
    const profileMatch = url.match(/tiktok\.com\/@([^\/]+)(\/?$)/);
    if (profileMatch && !url.includes("/video/")) {
      return res.status(400).json({
        error: "Please use a specific video URL, not a profile.",
      });
    }
  }

  try {
    const options = {
      dumpSingleJson: true,
      preferFreeFormats: true,
      ...getPlatformOptions(platform),
    };

    let info;
    let isImageOnly = false;

    try {
      console.log(`[seize] Resolving ${platform}...`);
      info = await ytDlp(url, options, { timeout: 60000 });
    } catch (err) {
      const errorMsg = err.stderr || err.message || "";

      // If it's a rate limit, return friendly error
      if (errorMsg.includes("429") || errorMsg.includes("rate limit")) {
        return res.status(429).json({
          error: `${platform} is rate limiting. Please wait.`,
        });
      }

      // Twitter image fallback
      if (platform === "twitter" && errorMsg.includes("No video")) {
        isImageOnly = true;
        console.log("[seize] Twitter: image-only post detected");
        info = {
          title: "Twitter/X Post",
          thumbnail: null,
          description: "Image post",
          uploader: "Unknown",
          formats: [],
          thumbnails: [],
        };
      } else {
        throw err;
      }
    }

    if (!info) {
      throw new Error("Could not extract media info");
    }

    const media = extractMediaUrls(info);

    // Get title
    let title = info.title || info.fulltitle || info.description || "Untitled";
    if (platform === "twitter") {
      title = info.description || info.tweet_text || title;
      title = title.replace(/^Tweets? from /i, "").trim();
      if (title.length > 100) title = title.substring(0, 100) + "...";
      if (
        title === "Untitled" ||
        title === "Twitter" ||
        title === "Twitter/X Post"
      ) {
        title = "Twitter/X Post";
      }
    }

    // Get uploader
    let uploader =
      info.uploader ||
      info.channel ||
      info.author ||
      info.creator ||
      info.owner ||
      null;
    if (platform === "twitter") {
      uploader =
        info.uploader || info.author || info.creator || info.channel || null;
    }

    // Determine content type
    let contentType = "unknown";
    if (media.hasVideo) contentType = "video";
    else if (media.hasImage || isImageOnly) contentType = "image";
    else if (media.audio.length > 0) contentType = "audio";

    // Get thumbnail
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
      hasImage: media.hasImage || isImageOnly,
      media: {
        videos: media.videos.slice(0, 5),
        images: media.images.slice(0, 5),
        audio: media.audio.slice(0, 3),
      },
      formatsAvailable: Array.isArray(info.formats)
        ? [...new Set(info.formats.map((f) => f.ext).filter(Boolean))]
        : [],
      duration: info.duration || null,
      isImageOnly: isImageOnly,
    });
  } catch (err) {
    const stderr = err.stderr || err.message || "";
    console.error("[resolve] Failed:", stderr);
    res.status(502).json({ error: friendlyError(stderr) });
  }
});

router.post("/fetch", async (req, res) => {
  const { url, mode = "video" } = req.body;
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
    // Image mode - download image directly
    if (mode === "image") {
      const infoOptions = {
        dumpSingleJson: true,
        preferFreeFormats: true,
        noWarnings: true,
        noCheckCertificates: true,
        ffmpegLocation: ffmpegStaticPath,
        addHeaders: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      };

      let info = await ytDlp(url, infoOptions, { timeout: 60000 });
      const media = extractMediaUrls(info);

      if (media.images.length === 0) {
        if (media.thumbnail) {
          media.images.push({
            url: media.thumbnail,
            format: "jpg",
            isThumbnail: true,
          });
        } else {
          throw new Error("No images found");
        }
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

    // Video/Audio mode
    let options = {
      output: outputPath,
      ...getPlatformOptions(platform),
    };

    if (mode === "audio") {
      options.extractAudio = true;
      options.audioFormat = "mp3";
      options.audioQuality = 0;
      options.format = "bestaudio/best";

      if (platform === "youtube") {
        options.extractorArgs = "youtube:player_client=android";
        options.format = "bestaudio[ext=m4a]/bestaudio/best";
      }
    } else {
      if (platform === "youtube") {
        options.format =
          "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best";
      } else {
        options.format = "bestvideo+bestaudio/best";
      }
      options.mergeOutputFormat = "mp4";
    }

    let progress = 0;
    const progressInterval = setInterval(() => {
      if (progress < 90) {
        progress += 5;
        const job = jobs.get(jobId);
        if (job) job.progress = Math.min(90, progress);
      }
    }, 3000);

    try {
      await ytDlp(url, options, { timeout: 120000 });
    } catch (err) {
      // Fallback with simpler options
      console.log("[seize] Download failed, trying fallback...");
      const fallbackOptions = {
        output: outputPath,
        noWarnings: true,
        noCheckCertificates: true,
        ffmpegLocation: ffmpegStaticPath,
        retries: 3,
        socketTimeout: 30,
        addHeaders: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      };
      if (mode === "audio") {
        fallbackOptions.extractAudio = true;
        fallbackOptions.audioFormat = "mp3";
        fallbackOptions.audioQuality = 0;
        fallbackOptions.format = "bestaudio/best";
      } else {
        fallbackOptions.format = "bestvideo+bestaudio/best";
        fallbackOptions.mergeOutputFormat = "mp4";
      }
      await ytDlp(url, fallbackOptions, { timeout: 120000 });
    } finally {
      clearInterval(progressInterval);
    }

    // Find output file
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

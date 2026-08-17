const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { v4: uuid } = require("uuid");
const {
  isAvailable,
  videoToAudio,
  audioToVideo,
  generatePromptVideo,
  generatePlainCoverFallback,
  embedAudioTags,
  probeAudioDuration,
} = require("../utils/ffmpeg");
const {
  recognizeSong,
  isConfigured: songIdConfigured,
} = require("../utils/songid");
const { scheduleCleanup } = require("../utils/cleanup");
const { logEvent } = require("../utils/activityLog");

const router = express.Router();

// ============================================================
// TEMP STORAGE + JOB QUEUE
// ============================================================
const TMP_DIR = path.join(__dirname, "..", "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const jobs = new Map();
scheduleCleanup({ jobs, tmpDir: TMP_DIR });

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const MAX_CONCURRENT_JOBS = Number(process.env.SEIZE_MAX_CONCURRENT_JOBS) || 3;
let activeJobs = 0;

function updateJob(jobId, patch) {
  const existing = jobs.get(jobId) || {};
  const next = { ...existing, ...patch };
  jobs.set(jobId, next);
  return next;
}

// ============================================================
// UPLOAD HANDLING
// ============================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    cb(null, `upload-${uuid()}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  const okPrefix = req.path.includes("audio-to-video") ? "audio/" : "video/";
  if (
    file.mimetype.startsWith(okPrefix) ||
    file.mimetype === "application/octet-stream"
  ) {
    cb(null, true);
  } else {
    cb(
      new Error(
        `Unsupported file type for this conversion (expected ${okPrefix}*).`,
      ),
    );
  }
}

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter,
});

function uploadSingle(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res
          .status(413)
          .json({ error: "File too large. Maximum size is 500MB." });
      }
      return res.status(400).json({ error: err.message || "Upload failed." });
    }
    next();
  });
}

function requireEngine(req, res, next) {
  if (!isAvailable()) {
    return res.status(503).json({ error: "Conversion engine unavailable." });
  }
  next();
}

function requireCapacity(req, res, next) {
  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    return res.status(503).json({
      error:
        "Server is busy processing other conversions. Please try again shortly.",
    });
  }
  next();
}

// ============================================================
// COVER IMAGE FOR AUDIO -> VIDEO
// ============================================================
const BRANDED_COVER_PATH = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "icons",
  "seize-cover.png",
);
const FALLBACK_COVER_PATH = path.join(TMP_DIR, "_fallback-cover.png");
let coverReadyPromise = null;

function ensureCoverImage() {
  if (coverReadyPromise) return coverReadyPromise;

  coverReadyPromise = (async () => {
    if (fs.existsSync(BRANDED_COVER_PATH)) return BRANDED_COVER_PATH;
    if (fs.existsSync(FALLBACK_COVER_PATH)) return FALLBACK_COVER_PATH;
    console.warn(
      "[seize] Branded cover asset missing, generating a plain fallback cover once.",
    );
    await generatePlainCoverFallback(FALLBACK_COVER_PATH);
    return FALLBACK_COVER_PATH;
  })().catch((err) => {
    coverReadyPromise = null;
    throw err;
  });

  return coverReadyPromise;
}

function cleanupUploadedFile(req) {
  if (req.file?.path && fs.existsSync(req.file.path)) {
    fs.unlink(req.file.path, () => {});
  }
}

async function downloadCoverArt(url, destPath) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let resp;
    try {
      resp = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!resp.ok) return null;
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length > 8 * 1024 * 1024) return null;
    fs.writeFileSync(destPath, buffer);
    return destPath;
  } catch {
    return null;
  }
}

function sanitizeFilename(name) {
  const cleaned = String(name || "")
    .replace(/[\/\\?%*:|"<>]/g, "")
    .replace(/[\r\n]/g, "")
    .trim()
    .slice(0, 150);
  return cleaned || "seize-audio";
}

function convertFriendlyError(err) {
  if (err?.seizeReason === "no-audio-track")
    return "This file has no audio track to extract.";
  if (err?.seizeReason === "cover-image-unavailable")
    return "Couldn't prepare a cover image for the video. Please try again.";

  const raw = String(err?.message || err || "");
  const s = raw.toLowerCase();

  if (s.includes("invalid data") || s.includes("moov atom not found"))
    return "This file appears to be corrupt or incomplete.";
  if (s.includes("could not find codec") || s.includes("unknown codec"))
    return "This file's codec isn't supported for conversion.";
  if (s.includes("no such file"))
    return "The uploaded file couldn't be found — please try uploading again.";
  if (s.includes("enospc"))
    return "The server ran out of temporary storage. Please try again.";
  if (s.includes("permission denied"))
    return "A server-side permissions issue prevented this conversion.";
  if (s.includes("etimedout") || s.includes("aborted"))
    return "The conversion timed out. Please try again.";
  if (s.includes("showspectrum") || s.includes("filter"))
    return "The audio visualization encountered an error. The audio file may be too short or in an unsupported format.";

  return raw
    ? `Conversion failed: ${raw.slice(0, 200)}`
    : "Conversion failed for an unknown reason.";
}

function clampProgress(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(100, Math.max(0, Math.round(n)));
}

// ============================================================
// VIDEO -> AUDIO
// ============================================================
router.post(
  "/video-to-audio",
  requireEngine,
  requireCapacity,
  uploadSingle,
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    const format = ["mp3", "wav", "aac", "flac", "ogg"].includes(
      req.body.format,
    )
      ? req.body.format
      : "mp3";

    const jobId = uuid();
    const outputPath = path.join(TMP_DIR, `${jobId}.${format}`);

    activeJobs += 1;
    updateJob(jobId, {
      status: "processing",
      progress: 0,
      createdAt: Date.now(),
    });
    logEvent("conversion:started", {
      jobId,
      direction: "video-to-audio",
      format,
    });
    res.json({ jobId });

    try {
      await videoToAudio(req.file.path, outputPath, format, (pct) => {
        const job = jobs.get(jobId);
        const clamped = clampProgress(pct);
        if (job && job.status === "processing" && clamped !== undefined) {
          job.progress = clamped;
        }
      });

      let recognizedTrack = null;
      let downloadName = `seize-audio.${format}`;

      if (format === "mp3" && songIdConfigured()) {
        let taggedPath = null;
        let coverPath = null;
        try {
          const job = jobs.get(jobId);
          if (job) job.progress = 99;

          const match = await recognizeSong(outputPath);
          if (match && (match.title || match.artist)) {
            if (match.coverUrl) {
              coverPath = await downloadCoverArt(
                match.coverUrl,
                path.join(TMP_DIR, `${jobId}-cover.jpg`),
              );
            }
            taggedPath = await embedAudioTags(outputPath, coverPath, {
              title: match.title,
              artist: match.artist,
              album: match.album,
            });

            fs.unlinkSync(outputPath);
            fs.renameSync(taggedPath, outputPath);
            taggedPath = null;

            recognizedTrack = {
              title: match.title || null,
              artist: match.artist || null,
              album: match.album || null,
            };
            if (match.artist && match.title) {
              downloadName = `${sanitizeFilename(`${match.artist} - ${match.title}`)}.mp3`;
            }
          }
        } catch (tagErr) {
          console.warn(
            "[convert] Song ID/tagging skipped:",
            tagErr.message || tagErr,
          );
        } finally {
          if (coverPath && fs.existsSync(coverPath))
            fs.unlink(coverPath, () => {});
          if (taggedPath && fs.existsSync(taggedPath))
            fs.unlink(taggedPath, () => {});
        }
      }

      updateJob(jobId, {
        status: "done",
        progress: 100,
        outputPath,
        downloadName,
        recognizedTrack,
        finishedAt: Date.now(),
      });
      logEvent("conversion:done", {
        jobId,
        direction: "video-to-audio",
        format,
      });
    } catch (err) {
      console.error("[convert] video-to-audio failed:", err.message || err);
      updateJob(jobId, {
        status: "error",
        error: convertFriendlyError(err),
        finishedAt: Date.now(),
      });
      logEvent("conversion:error", {
        jobId,
        direction: "video-to-audio",
        error: err.message || String(err),
      });
      if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
    } finally {
      activeJobs = Math.max(0, activeJobs - 1);
      cleanupUploadedFile(req);
    }
  },
);

// ============================================================
// AUDIO -> VIDEO - FIXED: Audio properly included
// ============================================================
router.post(
  "/audio-to-video",
  requireEngine,
  requireCapacity,
  uploadSingle,
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    const prompt =
      typeof req.body.prompt === "string"
        ? req.body.prompt.trim().slice(0, 150)
        : "";

    const jobId = uuid();
    const outputPath = path.join(TMP_DIR, `${jobId}.mp4`);

    activeJobs += 1;
    updateJob(jobId, {
      status: "processing",
      progress: 0,
      createdAt: Date.now(),
    });
    logEvent("conversion:started", {
      jobId,
      direction: "audio-to-video",
      hasPrompt: !!prompt,
    });
    res.json({ jobId });

    try {
      // Validate audio file
      try {
        const stats = fs.statSync(req.file.path);
        if (stats.size < 1024) {
          throw new Error("The audio file is too small or empty.");
        }

        // Check if file has audio stream
        const duration = await probeAudioDuration(req.file.path);
        if (duration < 1) {
          throw new Error(
            "The audio file appears to have no valid audio stream.",
          );
        }
        console.log(`[convert] Audio duration: ${duration}s`);
      } catch (statErr) {
        throw new Error(`Invalid audio file: ${statErr.message}`);
      }

      const onProgress = (pct) => {
        const job = jobs.get(jobId);
        const clamped = clampProgress(pct);
        if (job && job.status === "processing" && clamped !== undefined) {
          job.progress = clamped;
        }
      };

      // Try prompt video first, fallback to cover
      if (prompt) {
        try {
          console.log(
            `[convert] Generating prompt video with theme: "${prompt}"`,
          );
          await generatePromptVideo(
            req.file.path,
            outputPath,
            prompt,
            onProgress,
          );
        } catch (err) {
          console.error(
            "[convert] Prompt video generation failed, falling back to cover:",
            err.message,
          );
          let coverPath;
          try {
            coverPath = await ensureCoverImage();
          } catch (coverErr) {
            const wrapped = new Error(coverErr.message || String(coverErr));
            wrapped.seizeReason = "cover-image-unavailable";
            throw wrapped;
          }
          await audioToVideo(req.file.path, outputPath, coverPath, onProgress);
        }
      } else {
        let coverPath;
        try {
          coverPath = await ensureCoverImage();
        } catch (coverErr) {
          const wrapped = new Error(coverErr.message || String(coverErr));
          wrapped.seizeReason = "cover-image-unavailable";
          throw wrapped;
        }
        await audioToVideo(req.file.path, outputPath, coverPath, onProgress);
      }

      // Verify the output file has audio
      const outputStats = fs.statSync(outputPath);
      if (outputStats.size < 1024) {
        throw new Error(
          "Generated video file is too small. The conversion may have failed.",
        );
      }

      updateJob(jobId, {
        status: "done",
        progress: 100,
        outputPath,
        downloadName: "seize-video.mp4",
        finishedAt: Date.now(),
      });
      logEvent("conversion:done", {
        jobId,
        direction: "audio-to-video",
        hasPrompt: !!prompt,
      });
    } catch (err) {
      console.error("[convert] audio-to-video failed:", err.message || err);
      updateJob(jobId, {
        status: "error",
        error: convertFriendlyError(err),
        finishedAt: Date.now(),
      });
      logEvent("conversion:error", {
        jobId,
        direction: "audio-to-video",
        error: err.message || String(err),
      });
      if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
    } finally {
      activeJobs = Math.max(0, activeJobs - 1);
      cleanupUploadedFile(req);
    }
  },
);

// ============================================================
// STATUS + DOWNLOAD
// ============================================================
router.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({
    status: job.status,
    progress: job.progress,
    error: job.error,
    recognizedTrack: job.recognizedTrack || null,
  });
});

router.get("/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "done") {
    return res.status(404).json({ error: "File not ready" });
  }
  if (!fs.existsSync(job.outputPath)) {
    jobs.delete(req.params.jobId);
    return res
      .status(410)
      .json({ error: "This file has expired. Please convert again." });
  }
  res.download(job.outputPath, job.downloadName, (err) => {
    if (!err) {
      fs.unlink(job.outputPath, () => {});
      jobs.delete(req.params.jobId);
    } else {
      console.error("[convert] download failed:", err.message || err);
    }
  });
});

module.exports = router;

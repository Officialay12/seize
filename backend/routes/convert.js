const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { v4: uuid } = require("uuid");
const {
  isAvailable,
  videoToAudio,
  audioToVideo,
  generatePlainCoverFallback,
} = require("../utils/ffmpeg");
const { scheduleCleanup } = require("../utils/cleanup");

const router = express.Router();

// ============================================================
// TEMP STORAGE + JOB QUEUE
// ============================================================
const TMP_DIR = path.join(__dirname, "..", "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const jobs = new Map();
scheduleCleanup({ jobs, tmpDir: TMP_DIR });

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB, matches the UI's stated limit

// ============================================================
// UPLOAD HANDLING
// ============================================================
// Disk storage, not memory storage — files here can be up to 500MB, and
// buffering that in RAM per concurrent request is how a server falls
// over under real load. Writing straight to disk also means fluent-ffmpeg
// can start reading immediately with no extra copy step.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    cb(null, `upload-${uuid()}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  const okPrefix = req.path.includes("audio-to-video") ? "audio/" : "video/";
  // Be permissive rather than strict here: some browsers/mobile OSes send
  // generic mimetypes (application/octet-stream) for valid media files.
  // Reject only things that are clearly the wrong broad category.
  if (
    file.mimetype.startsWith(okPrefix) ||
    file.mimetype.startsWith("video/") ||
    file.mimetype.startsWith("audio/") ||
    file.mimetype === "application/octet-stream"
  ) {
    cb(null, true);
  } else {
    cb(new Error("Unsupported file type."));
  }
}

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter,
});

// Wraps multer's callback-style middleware so its errors (file too large,
// bad type, etc.) come back as clean JSON instead of an unhandled 500.
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

// ============================================================
// COVER IMAGE FOR AUDIO -> VIDEO
// ============================================================
// Prefer the shipped branded cover asset; fall back to generating a
// plain solid-color frame once and reusing that generated file for
// every subsequent request (never regenerate per-request — that would
// add pointless latency to every single conversion).
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
  })();

  return coverReadyPromise;
}

function cleanupUploadedFile(req) {
  if (req.file?.path && fs.existsSync(req.file.path)) {
    fs.unlink(req.file.path, () => {});
  }
}

// ============================================================
// VIDEO -> AUDIO
// ============================================================
router.post("/video-to-audio", uploadSingle, async (req, res) => {
  if (!isAvailable()) {
    cleanupUploadedFile(req);
    return res.status(503).json({ error: "Conversion engine unavailable." });
  }
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded." });
  }

  const format = ["mp3", "wav", "aac", "flac", "ogg"].includes(req.body.format)
    ? req.body.format
    : "mp3";

  const jobId = uuid();
  const outputPath = path.join(TMP_DIR, `${jobId}.${format}`);

  jobs.set(jobId, { status: "processing", progress: 0, createdAt: Date.now() });
  res.json({ jobId });

  try {
    await videoToAudio(req.file.path, outputPath, format, (pct) => {
      const job = jobs.get(jobId);
      if (job && job.status === "processing") job.progress = pct;
    });

    jobs.set(jobId, {
      status: "done",
      progress: 100,
      outputPath,
      downloadName: `seize-audio.${format}`,
      finishedAt: Date.now(),
    });
  } catch (err) {
    console.error("[convert] video-to-audio failed:", err.message);
    jobs.set(jobId, {
      status: "error",
      error:
        "Conversion failed. The file may be corrupt or an unsupported format.",
      finishedAt: Date.now(),
    });
    if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
  } finally {
    cleanupUploadedFile(req);
  }
});

// ============================================================
// AUDIO -> VIDEO
// ============================================================
router.post("/audio-to-video", uploadSingle, async (req, res) => {
  if (!isAvailable()) {
    cleanupUploadedFile(req);
    return res.status(503).json({ error: "Conversion engine unavailable." });
  }
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded." });
  }

  const jobId = uuid();
  const outputPath = path.join(TMP_DIR, `${jobId}.mp4`);

  jobs.set(jobId, { status: "processing", progress: 0, createdAt: Date.now() });
  res.json({ jobId });

  try {
    const coverPath = await ensureCoverImage();

    await audioToVideo(req.file.path, outputPath, coverPath, (pct) => {
      const job = jobs.get(jobId);
      if (job && job.status === "processing") job.progress = pct;
    });

    jobs.set(jobId, {
      status: "done",
      progress: 100,
      outputPath,
      downloadName: "seize-video.mp4",
      finishedAt: Date.now(),
    });
  } catch (err) {
    console.error("[convert] audio-to-video failed:", err.message);
    jobs.set(jobId, {
      status: "error",
      error:
        "Conversion failed. The file may be corrupt or an unsupported format.",
      finishedAt: Date.now(),
    });
    if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
  } finally {
    cleanupUploadedFile(req);
  }
});

// ============================================================
// STATUS + DOWNLOAD
// ============================================================
router.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ status: job.status, progress: job.progress, error: job.error });
});

router.get("/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "done") {
    return res.status(404).json({ error: "File not ready" });
  }
  res.download(job.outputPath, job.downloadName, (err) => {
    if (!err) {
      fs.unlink(job.outputPath, () => {});
      jobs.delete(req.params.jobId);
    }
  });
});

module.exports = router;

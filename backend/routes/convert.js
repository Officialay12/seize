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
  embedAudioTags,
} = require("../utils/ffmpeg");
const { recognizeSong, isConfigured: songIdConfigured } = require("../utils/songid");
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
  })().catch((err) => {
    // Critical: do NOT leave a rejected promise cached. Without this, one
    // transient failure (e.g. a cold-start race, a disk hiccup) would wedge
    // every single audio-to-video request behind the same cached rejection
    // until the server process restarted — "it just always fails" with no
    // way to recover short of a redeploy.
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

// Downloads recognized cover art to a local temp file, bounded by a
// timeout and a sanity size cap. Any failure here just means "no cover
// art embedded" — never a reason to fail the whole conversion.
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
    if (buffer.length > 8 * 1024 * 1024) return null; // sanity cap
    fs.writeFileSync(destPath, buffer);
    return destPath;
  } catch {
    return null;
  }
}

// Song title/artist come back from an external API — untrusted input.
// Strip anything unsafe for a filename or an HTTP header before ever
// using it in Content-Disposition.
function sanitizeFilename(name) {
  const cleaned = String(name || "")
    .replace(/[\/\\?%*:|"<>]/g, "")
    .replace(/[\r\n]/g, "")
    .trim()
    .slice(0, 150);
  return cleaned || "seize-audio";
}

// The old behavior always returned the same generic sentence for every
// ffmpeg failure, which actively hid real bugs (like the cover-cache issue
// above) from both users and whoever's debugging this later. This maps
// known failure signatures to accurate messages and otherwise surfaces a
// trimmed version of the actual error instead of guessing.
function convertFriendlyError(err) {
  if (err?.seizeReason === "no-audio-track")
    return "This file has no audio track to extract — it may be a video with muted/no sound.";

  const raw = String(err?.message || err || "");
  const s = raw.toLowerCase();

  if (
    s.includes("invalid data found when processing input") ||
    s.includes("moov atom not found")
  )
    return "This file appears to be corrupt or incomplete.";
  if (s.includes("could not find codec parameters") || s.includes("unknown codec") || s.includes("decoder not found"))
    return "This file's codec isn't supported for conversion.";
  if (s.includes("no such file or directory") && s.includes("upload-"))
    return "The uploaded file couldn't be found on the server — please try uploading again.";
  if (s.includes("enospc"))
    return "The server ran out of temporary storage. Please try again in a moment.";
  if (s.includes("permission denied") || s.includes("eacces"))
    return "A server-side permissions issue prevented this conversion. This is a bug on our end.";

  // Unknown cause — better to show a truncated real error than to lie
  // about it being a "corrupt file", which was misleading users and
  // masking genuine server bugs.
  return raw
    ? `Conversion failed: ${raw.slice(0, 200)}`
    : "Conversion failed for an unknown reason.";
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

    let recognizedTrack = null;
    let downloadName = `seize-audio.${format}`;

    // Song ID is a bonus enhancement, scoped to mp3 only — that's the one
    // format where embedded cover art is reliably supported everywhere.
    // Every failure mode here (no API key configured, no match found,
    // network hiccup, a bad cover image, a tagging error) falls straight
    // through to the plain, already-successful converted file. This can
    // never turn a working conversion into a failed one.
    if (format === "mp3" && songIdConfigured()) {
      let taggedPath = null;
      let coverPath = null;
      try {
        const job = jobs.get(jobId);
        if (job) job.progress = 99; // conversion done, just identifying now

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
          taggedPath = null; // renamed away, nothing left to clean up

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
        if (coverPath && fs.existsSync(coverPath)) fs.unlink(coverPath, () => {});
        if (taggedPath && fs.existsSync(taggedPath)) fs.unlink(taggedPath, () => {});
      }
    }

    jobs.set(jobId, {
      status: "done",
      progress: 100,
      outputPath,
      downloadName,
      recognizedTrack,
      finishedAt: Date.now(),
    });
  } catch (err) {
    console.error("[convert] video-to-audio failed:", err.message || err);
    jobs.set(jobId, {
      status: "error",
      error: convertFriendlyError(err),
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
    console.error("[convert] audio-to-video failed:", err.message || err);
    jobs.set(jobId, {
      status: "error",
      error: convertFriendlyError(err),
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
  res.download(job.outputPath, job.downloadName, (err) => {
    if (!err) {
      fs.unlink(job.outputPath, () => {});
      jobs.delete(req.params.jobId);
    }
  });
});

module.exports = router;

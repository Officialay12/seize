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

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB, matches the UI's stated limit

// Hard cap on simultaneous ffmpeg conversions. Render's free/hobby tiers
// have very little CPU/RAM headroom, and letting an unbounded number of
// concurrent conversions pile up is exactly the kind of thing that takes
// the whole dyno down under real traffic. New requests past the cap get a
// clean 503 instead of everyone's job silently crawling or the process OOMing.
const MAX_CONCURRENT_JOBS = Number(process.env.SEIZE_MAX_CONCURRENT_JOBS) || 3;
let activeJobs = 0;

// Single source of truth for mutating a job's state. Previously some
// handlers replaced the whole job object with `jobs.set(jobId, {...})`
// on completion/error, which silently dropped fields set earlier
// (most importantly `createdAt`). If the cleanup sweeper relies on
// `createdAt` to decide what's stale, a finished job missing that field
// could either never get swept or get treated as instantly stale —
// this always merges onto whatever's already there.
function updateJob(jobId, patch) {
  const existing = jobs.get(jobId) || {};
  const next = { ...existing, ...patch };
  jobs.set(jobId, next);
  return next;
}

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
  //
  // BUG FIX: the previous version also unconditionally allowed any
  // "video/*" AND any "audio/*" mimetype regardless of which route was
  // hit, which made `okPrefix` dead code — a video file uploaded to
  // /audio-to-video (or vice versa) would sail through the filter and
  // only fail later, deep inside ffmpeg, with a confusing error. Now we
  // only allow the route-appropriate prefix, plus the octet-stream escape
  // hatch for browsers that don't send a useful mimetype at all.
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

// Rejects the request before multer even starts buffering a (possibly
// huge) file to disk if the conversion engine isn't available. There's no
// point spending bandwidth and disk I/O on an upload that's guaranteed to
// be thrown away a moment later.
function requireEngine(req, res, next) {
  if (!isAvailable()) {
    return res.status(503).json({ error: "Conversion engine unavailable." });
  }
  next();
}

// Enforces the concurrency cap ahead of the (potentially large) upload too,
// for the same reason as requireEngine — fail fast, don't waste I/O.
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
// COVER IMAGE FOR AUDIO -> VIDEO (plain, non-prompt mode)
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
  if (err?.seizeReason === "cover-image-unavailable")
    return "Couldn't prepare a cover image for the video. Please try again in a moment.";

  const raw = String(err?.message || err || "");
  const s = raw.toLowerCase();

  if (
    s.includes("invalid data found when processing input") ||
    s.includes("moov atom not found")
  )
    return "This file appears to be corrupt or incomplete.";
  if (
    s.includes("could not find codec parameters") ||
    s.includes("unknown codec") ||
    s.includes("decoder not found")
  )
    return "This file's codec isn't supported for conversion.";
  if (s.includes("no such file or directory") && s.includes("upload-"))
    return "The uploaded file couldn't be found on the server — please try uploading again.";
  if (s.includes("enospc"))
    return "The server ran out of temporary storage. Please try again in a moment.";
  if (s.includes("permission denied") || s.includes("eacces"))
    return "A server-side permissions issue prevented this conversion. This is a bug on our end.";
  if (s.includes("etimedout") || s.includes("aborted"))
    return "The conversion timed out. Please try again.";

  // Unknown cause — better to show a truncated real error than to lie
  // about it being a "corrupt file", which was misleading users and
  // masking genuine server bugs.
  return raw
    ? `Conversion failed: ${raw.slice(0, 200)}`
    : "Conversion failed for an unknown reason.";
}

// Clamps progress into a sane 0-100 range so a flaky ffmpeg progress
// parser can never push the UI into a nonsensical state (negative,
// >100, NaN).
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
// AUDIO -> VIDEO
// Supports an optional `prompt` field: when present, seize generates a
// prompt-themed, audio-reactive video (spectrum + waveform + palette
// chosen from prompt keywords) instead of the plain static-cover video.
// This is entirely local (ffmpeg lavfi filters) — free, no external API,
// no rate limit.
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

    // Cap length defensively here too (generatePromptVideo also truncates
    // what it burns into the video) so an absurdly long field can't bloat
    // logs or the ffmpeg command line.
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
      const onProgress = (pct) => {
        const job = jobs.get(jobId);
        const clamped = clampProgress(pct);
        if (job && job.status === "processing" && clamped !== undefined) {
          job.progress = clamped;
        }
      };

      if (prompt) {
        // Prompt path never touches the branded/fallback cover image —
        // it builds the frame procedurally from the audio itself.
        await generatePromptVideo(
          req.file.path,
          outputPath,
          prompt,
          onProgress,
        );
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
  // The output file could in principle have been swept by the cleanup
  // job between "done" being set and the download request arriving.
  // Fail with a clear 410 instead of letting res.download throw an
  // ENOENT that bubbles up as an unhandled error.
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

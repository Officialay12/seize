const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");
const fs = require("fs");
const os = require("os");

let ffmpegPath = null;
let ffprobePath = null;

function tryPath(p, label) {
  try {
    if (p && fs.existsSync(p)) return p;
  } catch (e) {
    console.log(`⚠️ ${label} path check failed:`, e.message);
  }
  return null;
}

ffmpegPath = tryPath(ffmpegStatic, "ffmpeg-static");
ffprobePath = tryPath(ffprobeStatic && ffprobeStatic.path, "ffprobe-static");

if (!ffmpegPath || !ffprobePath) {
  try {
    const { execSync } = require("child_process");
    const which = (bin) => {
      try {
        const result = execSync(`command -v ${bin} 2>/dev/null || echo ""`, {
          encoding: "utf8",
          timeout: 3000,
        })
          .toString()
          .trim();
        return result && fs.existsSync(result) ? result : null;
      } catch {
        return null;
      }
    };
    if (!ffmpegPath) ffmpegPath = which("ffmpeg");
    if (!ffprobePath) ffprobePath = which("ffprobe");
  } catch (e) {
    console.log("⚠️ System ffmpeg/ffprobe detection failed:", e.message);
  }
}

if (!ffmpegPath) {
  for (const p of [
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
  ]) {
    const found = tryPath(p, "ffmpeg common path");
    if (found) {
      ffmpegPath = found;
      break;
    }
  }
}
if (!ffprobePath) {
  for (const p of [
    "/usr/bin/ffprobe",
    "/usr/local/bin/ffprobe",
    "/opt/homebrew/bin/ffprobe",
  ]) {
    const found = tryPath(p, "ffprobe common path");
    if (found) {
      ffprobePath = found;
      break;
    }
  }
}

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
  console.log("✅ FFmpeg path set:", ffmpegPath);
} else {
  console.error(
    "❌ FFmpeg not found! Conversions will fail until this is resolved.",
  );
}

if (ffprobePath) {
  ffmpeg.setFfprobePath(ffprobePath);
  console.log("✅ FFprobe path set:", ffprobePath);
} else {
  console.error(
    "❌ FFprobe not found! Media inspection will fail until this is resolved.",
  );
}

const CPU_THREADS = Math.max(1, os.cpus()?.length || 1);

// Hard safety net on every ffmpeg run. Without this, a malformed or
// adversarial input that makes ffmpeg hang (rather than error out) leaves
// the returned promise pending forever. That's bad on its own, but it's
// worse combined with routes/convert.js's MAX_CONCURRENT_JOBS cap — a
// handful of hung conversions would permanently eat concurrency slots
// and the server would look "busy" forever with nothing actually
// happening. Configurable via env for slower/larger jobs if needed.
const DEFAULT_TIMEOUT_MS =
  Number(process.env.SEIZE_FFMPEG_TIMEOUT_MS) || 15 * 60 * 1000; // 15 min

function safeUnlink(p) {
  if (p && fs.existsSync(p)) fs.unlink(p, () => {});
}

// Runs a built (but not yet executed) fluent-ffmpeg command, wiring up
// progress/error/end consistently and enforcing the timeout above. Every
// conversion helper below goes through this single execution path.
function runCommand(
  cmd,
  outputPath,
  { onProgress, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        cmd.kill("SIGKILL");
      } catch {
        /* process may already be gone — nothing to do */
      }
      safeUnlink(outputPath);
      const err = new Error("Conversion timed out.");
      err.seizeReason = "timeout";
      reject(err);
    }, timeoutMs);

    cmd
      .on("progress", (p) => {
        if (onProgress) onProgress(Math.min(99, Math.round(p.percent || 0)));
      })
      .on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      })
      .on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outputPath);
      })
      .save(outputPath);
  });
}

// ============================================================
// CONVERSION HELPERS
// (These are what routes/convert.js actually calls.)
// ============================================================

const AUDIO_CODECS = {
  mp3: { codec: "libmp3lame", bitrate: 192 },
  aac: { codec: "aac", bitrate: 192 },
  m4a: { codec: "aac", bitrate: 192 },
  wav: { codec: "pcm_s16le" },
  flac: { codec: "flac" },
  ogg: { codec: "libvorbis", bitrate: 192 },
};

// NOTE: "m4a" is fully supported here but routes/convert.js's format
// whitelist (`["mp3","wav","aac","flac","ogg"]`) never lets a request
// select it, so this branch is currently unreachable dead code from the
// route's perspective. Not fixed here since it's a route-layer decision,
// but worth adding "m4a" to that whitelist if you want to expose it.

function probe(filePath, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Best-effort only: ffprobe has no handle exposed here to kill, so
      // this frees up the caller (and the concurrency slot upstream)
      // even though the underlying ffprobe process may still exit on
      // its own shortly after. Still strictly better than hanging forever.
      reject(new Error("Media inspection timed out."));
    }, timeoutMs);

    ffmpeg.ffprobe(filePath, (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(data);
    });
  });
}

const COMPATIBLE_SOURCE_CODECS = {
  mp3: ["mp3"],
  aac: ["aac"],
  m4a: ["aac"],
  flac: ["flac"],
  ogg: ["vorbis", "opus"],
};

async function videoToAudio(inputPath, outputPath, format = "mp3", onProgress) {
  const fmt = AUDIO_CODECS[format] ? format : "mp3";
  const { codec, bitrate } = AUDIO_CODECS[fmt];

  let canCopy = false;
  let probeSucceeded = false;
  let audioStream;
  try {
    const info = await probe(inputPath);
    probeSucceeded = true;
    audioStream = info.streams?.find((s) => s.codec_type === "audio");
    const sourceCodec = audioStream?.codec_name;
    canCopy =
      !!sourceCodec &&
      (COMPATIBLE_SOURCE_CODECS[fmt] || []).includes(sourceCodec);
  } catch (e) {
    // If probing fails for any reason, just fall through to a normal
    // re-encode rather than blocking the conversion entirely — ffmpeg's
    // own error (if any) will surface naturally below.
    canCopy = false;
  }

  // Fail fast with a clear reason instead of letting ffmpeg run into a
  // cryptic "no stream" error further down. A video-only file (muted
  // export, screen recording with no mic track, etc.) is a real, common
  // case — worth its own message rather than the generic catch-all.
  if (probeSucceeded && !audioStream) {
    const err = new Error("This file has no audio track to extract.");
    err.seizeReason = "no-audio-track";
    throw err;
  }

  const cmd = ffmpeg(inputPath).noVideo();

  if (canCopy) {
    cmd.audioCodec("copy");
  } else {
    cmd.audioCodec(codec).outputOptions(["-threads", String(CPU_THREADS)]);
    if (bitrate) cmd.audioBitrate(bitrate);
  }

  return runCommand(cmd, outputPath, { onProgress });
}

function audioToVideo(audioPath, outputPath, coverImagePath, onProgress) {
  const cmd = ffmpeg()
    .input(coverImagePath)
    .loop()
    .input(audioPath)
    .videoCodec("libx264")
    .audioCodec("aac")
    .audioBitrate(192)
    .outputOptions([
      "-shortest",
      // yuv420p requires even width/height. A branded cover asset with
      // odd dimensions (or a resized/cropped one down the line) will
      // otherwise fail every single conversion with an opaque ffmpeg
      // error. This guarantees even dimensions regardless of source.
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-pix_fmt",
      "yuv420p",
      "-tune",
      "stillimage",
      "-preset",
      "ultrafast",
      "-crf",
      "28",
      "-threads",
      String(CPU_THREADS),
      "-g",
      "250",
    ]);

  return runCommand(cmd, outputPath, { onProgress });
}

// ============================================================
// PROMPT-THEMED AUDIO-REACTIVE VIDEO (Audio -> Video, "generate by prompt")
// ============================================================
// Zero-cost, zero-external-API alternative to a text-to-video model. Uses
// only ffmpeg's built-in lavfi filters (showspectrum / showwaves / drawtext),
// which ship with every ffmpeg build — nothing to install, no API key, no
// rate limit, no network call, and it finishes in roughly the same time as
// a normal audio-to-video conversion. The "prompt" is parsed for mood/color
// keywords to pick a palette and is optionally burned in as an on-screen
// caption. This is NOT a literal scene-generation model — it's an
// audio-reactive visualizer themed by the prompt — but it is genuinely free
// and reliable, which a hosted text-to-video model cannot promise.

const PROMPT_THEMES = [
  {
    keys: [
      "fire",
      "energetic",
      "hype",
      "party",
      "neon",
      "rage",
      "intense",
      "edm",
    ],
    bg: "1a0a05",
    fg: "ff6b35",
    fg2: "ffb86b",
  },
  {
    keys: [
      "calm",
      "chill",
      "ocean",
      "blue",
      "relax",
      "lofi",
      "peaceful",
      "ambient",
      "water",
    ],
    bg: "050a14",
    fg: "3fa9f5",
    fg2: "7fffb0",
  },
  {
    keys: ["dark", "sad", "moody", "melancholy", "night", "rain", "grief"],
    bg: "0a0a0a",
    fg: "6b6f76",
    fg2: "b0b6bd",
  },
  {
    keys: ["love", "romantic", "pink", "sunset", "warm", "heart"],
    bg: "1a050e",
    fg: "ff6ba0",
    fg2: "ffd166",
  },
  {
    keys: ["nature", "forest", "green", "earthy", "jungle"],
    bg: "05140a",
    fg: "3fdb7a",
    fg2: "7fffb0",
  },
  {
    keys: ["gold", "luxury", "cinematic", "epic", "royal"],
    bg: "0d0a02",
    fg: "ffb86b",
    fg2: "ffe38a",
  },
];

const DEFAULT_THEME = { bg: "0b0d0c", fg: "7fffb0", fg2: "ffb86b" };

function promptToTheme(prompt = "") {
  const p = String(prompt || "").toLowerCase();
  for (const t of PROMPT_THEMES) {
    if (t.keys.some((k) => p.includes(k))) return t;
  }
  return DEFAULT_THEME;
}

// ffmpeg drawtext treats backslash, colon, and single-quote as special.
// Escaping (rather than stripping) keeps the visible text close to what
// the user typed while guaranteeing it can't break out of the filter
// string. Also hard-capped in length so a very long prompt can't produce
// an unreadable wall of on-screen text.
function escapeDrawtext(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/[\r\n]/g, " ")
    .slice(0, 80);
}

function generatePromptVideo(audioPath, outputPath, prompt, onProgress) {
  const theme = promptToTheme(prompt);
  const safeText = prompt ? escapeDrawtext(prompt) : "";

  const filters = [
    `color=size=1280x720:color=0x${theme.bg}:rate=30[bg]`,
    `[0:a]showspectrum=s=1280x520:mode=combined:color=intensity:scale=cbrt:legend=0:slide=scroll[spec]`,
    `[0:a]showwaves=s=1280x200:mode=cline:colors=0x${theme.fg}:rate=30[waves]`,
    `[bg][spec]overlay=0:80:format=auto[bg2]`,
    `[bg2][waves]overlay=0:H-h-20:format=auto[merged]`,
  ];

  let videoLabel = "merged";
  if (safeText) {
    filters.push(
      `[merged]drawtext=text='${safeText}':fontcolor=0x${theme.fg2}:fontsize=34:` +
        `x=(w-text_w)/2:y=40:box=1:boxcolor=0x000000@0.35:boxborderw=12[final]`,
    );
    videoLabel = "final";
  }

  const cmd = ffmpeg()
    .input(audioPath)
    .complexFilter(filters, [])
    .outputOptions([
      "-map",
      `[${videoLabel}]`,
      "-map",
      "0:a",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-threads",
      String(CPU_THREADS),
    ]);

  // BUG FIX: same leftover-file hazard as generatePlainCoverFallback /
  // embedAudioTags below — if the complex filter graph fails partway
  // (e.g. an unusual input causes showspectrum/showwaves to error), don't
  // leave a partial/corrupt .mp4 sitting in outputPath. runCommand's own
  // timeout branch already cleans up; this covers the plain-error branch.
  return runCommand(cmd, outputPath, { onProgress }).catch((err) => {
    safeUnlink(outputPath);
    throw err;
  });
}

// Generates a single-frame solid-color placeholder cover using ffmpeg's
// built-in lavfi "color" source. Previously this hand-built a raw rgb24
// byte buffer and piped it into ffmpeg via a PassThrough stream — a much
// flakier path (behavior varies across ffmpeg builds/platforms and was a
// real source of silent, hard-to-diagnose failures). lavfi is a single,
// well-supported ffmpeg feature and needs no manual buffer math.
function generatePlainCoverFallback(destPath) {
  const cmd = ffmpeg()
    .input("color=c=0x0B0D0C:s=720x720:d=1")
    .inputFormat("lavfi")
    .outputOptions(["-frames:v", "1", "-update", "1"]);

  // BUG FIX: the previous version let a failed generation leave behind
  // a partial/corrupt file at destPath. Since callers (routes/convert.js)
  // only check `fs.existsSync(FALLBACK_COVER_PATH)` to decide whether
  // regeneration is needed, a broken leftover file would be treated as
  // "ready" forever — every subsequent audio-to-video conversion would
  // pick up the corrupt cover and fail, with no way to recover short of
  // manually deleting the file or redeploying. runCommand already cleans
  // up outputPath on a timeout; this covers the plain error case too.
  return runCommand(cmd, destPath).catch((err) => {
    safeUnlink(destPath);
    throw err;
  });
}

// Strips characters that have no business in an ID3 metadata value —
// mainly newlines/control characters, which some ffmpeg builds can
// mishandle in `-metadata key=value` and which have no legitimate reason
// to appear in a song title/artist/album pulled from an external API.
function sanitizeMetadataValue(value) {
  return String(value)
    .replace(/[\r\n\x00-\x1f]/g, "")
    .slice(0, 300);
}

// Remuxes an MP3 with ID3v2 tags and (optionally) embedded cover art. Only
// mp3 is supported — embedded artwork conventions differ across
// wav/flac/aac/ogg, and getting that wrong risks corrupting the file the
// user already successfully converted. If it's not mp3, or anything here
// fails, the caller keeps the original untagged file — tagging is a
// bonus, never a requirement for the download to succeed.
function embedAudioTags(mp3Path, coverPath, tags = {}) {
  const tmpOut = `${mp3Path}.tagged.mp3`;
  const cmd = ffmpeg().input(mp3Path);

  const metadataArgs = [];
  if (tags.title)
    metadataArgs.push(
      "-metadata",
      `title=${sanitizeMetadataValue(tags.title)}`,
    );
  if (tags.artist)
    metadataArgs.push(
      "-metadata",
      `artist=${sanitizeMetadataValue(tags.artist)}`,
    );
  if (tags.album)
    metadataArgs.push(
      "-metadata",
      `album=${sanitizeMetadataValue(tags.album)}`,
    );

  if (coverPath) {
    cmd.input(coverPath);
    cmd.outputOptions([
      "-map",
      "0:a",
      "-map",
      "1:0",
      "-c",
      "copy",
      "-id3v2_version",
      "3",
      "-disposition:v:0",
      "attached_pic",
      ...metadataArgs,
    ]);
  } else {
    cmd.outputOptions(["-c", "copy", "-id3v2_version", "3", ...metadataArgs]);
  }

  // BUG FIX: previously, if this failed partway (bad cover image, ffmpeg
  // error, timeout), the half-written `${mp3Path}.tagged.mp3` was never
  // cleaned up — the caller only ever tracks `taggedPath` after a
  // successful resolve, so nothing else in the app owns that file. Left
  // alone, these orphaned temp files just accumulate on disk. Clean up
  // here, at the source, on any failure.
  return runCommand(cmd, tmpOut).catch((err) => {
    safeUnlink(tmpOut);
    throw err;
  });
}

module.exports = ffmpeg;
module.exports.ffmpegPath = ffmpegPath;
module.exports.ffprobePath = ffprobePath;
module.exports.isAvailable = () => !!ffmpegPath && !!ffprobePath;
module.exports.probe = probe;
module.exports.videoToAudio = videoToAudio;
module.exports.audioToVideo = audioToVideo;
module.exports.generatePromptVideo = generatePromptVideo;
module.exports.promptToTheme = promptToTheme;
module.exports.generatePlainCoverFallback = generatePlainCoverFallback;
module.exports.embedAudioTags = embedAudioTags;

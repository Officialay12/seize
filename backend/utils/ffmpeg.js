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

function probe(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) =>
      err ? reject(err) : resolve(data),
    );
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

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(inputPath).noVideo();

    if (canCopy) {
      cmd.audioCodec("copy");
    } else {
      cmd.audioCodec(codec).outputOptions(["-threads", String(CPU_THREADS)]);
      if (bitrate) cmd.audioBitrate(bitrate);
    }

    cmd
      .on("progress", (p) => {
        if (onProgress) onProgress(Math.min(99, Math.round(p.percent || 0)));
      })
      .on("error", (err) => reject(err))
      .on("end", () => resolve(outputPath))
      .save(outputPath);
  });
}

function audioToVideo(audioPath, outputPath, coverImagePath, onProgress) {
  return new Promise((resolve, reject) => {
    ffmpeg()
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
      ])
      .on("progress", (p) => {
        if (onProgress) onProgress(Math.min(99, Math.round(p.percent || 0)));
      })
      .on("error", (err) => reject(err))
      .on("end", () => resolve(outputPath))
      .save(outputPath);
  });
}

// Generates a single-frame solid-color placeholder cover using ffmpeg's
// built-in lavfi "color" source. Previously this hand-built a raw rgb24
// byte buffer and piped it into ffmpeg via a PassThrough stream — a much
// flakier path (behavior varies across ffmpeg builds/platforms and was a
// real source of silent, hard-to-diagnose failures). lavfi is a single,
// well-supported ffmpeg feature and needs no manual buffer math.
function generatePlainCoverFallback(destPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input("color=c=0x0B0D0C:s=720x720:d=1")
      .inputFormat("lavfi")
      .outputOptions(["-frames:v", "1", "-update", "1"])
      .on("error", (err) => reject(err))
      .on("end", () => resolve(destPath))
      .save(destPath);
  });
}

// Remuxes an MP3 with ID3v2 tags and (optionally) embedded cover art. Only
// mp3 is supported — embedded artwork conventions differ across
// wav/flac/aac/ogg, and getting that wrong risks corrupting the file the
// user already successfully converted. If it's not mp3, or anything here
// fails, the caller keeps the original untagged file — tagging is a
// bonus, never a requirement for the download to succeed.
function embedAudioTags(mp3Path, coverPath, tags = {}) {
  return new Promise((resolve, reject) => {
    const tmpOut = `${mp3Path}.tagged.mp3`;
    const cmd = ffmpeg().input(mp3Path);

    const metadataArgs = [];
    if (tags.title) metadataArgs.push("-metadata", `title=${tags.title}`);
    if (tags.artist) metadataArgs.push("-metadata", `artist=${tags.artist}`);
    if (tags.album) metadataArgs.push("-metadata", `album=${tags.album}`);

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

    cmd
      .on("error", (err) => reject(err))
      .on("end", () => resolve(tmpOut))
      .save(tmpOut);
  });
}

module.exports = ffmpeg;
module.exports.ffmpegPath = ffmpegPath;
module.exports.ffprobePath = ffprobePath;
module.exports.isAvailable = () => !!ffmpegPath && !!ffprobePath;
module.exports.probe = probe;
module.exports.videoToAudio = videoToAudio;
module.exports.audioToVideo = audioToVideo;
module.exports.generatePlainCoverFallback = generatePlainCoverFallback;
module.exports.embedAudioTags = embedAudioTags;

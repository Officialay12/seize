const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");
const fs = require("fs");

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

function videoToAudio(inputPath, outputPath, format = "mp3", onProgress) {
  const fmt = AUDIO_CODECS[format] ? format : "mp3";
  const { codec, bitrate } = AUDIO_CODECS[fmt];

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(inputPath).noVideo().audioCodec(codec);
    if (bitrate) cmd.audioBitrate(bitrate);

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
      .loop(true)
      .input(audioPath)
      .videoCodec("libx264")
      .audioCodec("aac")
      .audioBitrate(192)
      .outputOptions([
        "-shortest",
        "-pix_fmt",
        "yuv420p",
        "-tune",
        "stillimage",
      ])
      .on("progress", (p) => {
        if (onProgress) onProgress(Math.min(99, Math.round(p.percent || 0)));
      })
      .on("error", (err) => reject(err))
      .on("end", () => resolve(outputPath))
      .save(outputPath);
  });
}

function generatePlainCoverFallback(destPath) {
  return new Promise((resolve, reject) => {
    const { PassThrough } = require("stream");
    const width = 1080;
    const height = 1080;
    const [r, g, b] = [0x0b, 0x0d, 0x0c]; // brand background color

    const frame = Buffer.alloc(width * height * 3);
    for (let i = 0; i < frame.length; i += 3) {
      frame[i] = r;
      frame[i + 1] = g;
      frame[i + 2] = b;
    }

    const input = new PassThrough();
    input.end(frame);

    ffmpeg(input)
      .inputFormat("rawvideo")
      .inputOptions(["-pix_fmt", "rgb24", "-s", `${width}x${height}`])
      .outputOptions(["-frames:v", "1", "-update", "1"])
      .on("error", (err) => reject(err))
      .on("end", () => resolve(destPath))
      .save(destPath);
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

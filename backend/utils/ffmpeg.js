const fs = require("fs");
const path = require("path");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { spawn } = require("child_process");

const execFileAsync = promisify(execFile);

// FFmpeg binary paths
const FFMPEG_PATH = ffmpegStatic;
const FFPROBE_PATH = ffprobeStatic?.path || ffprobeStatic;

let ffmpeg = null;
let ffprobe = null;

function getFFmpeg() {
  if (!ffmpeg) {
    const ffmpegLib = require("fluent-ffmpeg");
    ffmpeg = ffmpegLib;
    if (FFMPEG_PATH) {
      ffmpeg.setFfmpegPath(FFMPEG_PATH);
    }
    if (FFPROBE_PATH) {
      ffmpeg.setFfprobePath(FFPROBE_PATH);
    }
    console.log(`✅ FFmpeg path set: ${FFMPEG_PATH || "default"}`);
    console.log(`✅ FFprobe path set: ${FFPROBE_PATH || "default"}`);
  }
  return ffmpeg;
}

function isAvailable() {
  try {
    getFFmpeg();
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// PARSE PROMPT COLORS
// ============================================================
function parsePromptColors(prompt) {
  const colors = {
    bg: "0x050a14",
    wave: "0x7FFFB0",
    text: "0xE8EDE9",
    accent: "0x3F8F65",
  };

  if (!prompt) return colors;

  const p = prompt.toLowerCase();
  const colorMap = {
    blue: {
      bg: "0x0a1628",
      wave: "0x4a9eff",
      text: "0xffffff",
      accent: "0x1a6aff",
    },
    dark: {
      bg: "0x0a0a0a",
      wave: "0x7FFFB0",
      text: "0xffffff",
      accent: "0x3a8f65",
    },
    neon: {
      bg: "0x0a0014",
      wave: "0xff00ff",
      text: "0x00ffff",
      accent: "0x7f00ff",
    },
    warm: {
      bg: "0x1a0a05",
      wave: "0xff6b35",
      text: "0xffdd99",
      accent: "0xcc4400",
    },
    ocean: {
      bg: "0x050a1a",
      wave: "0x00ccff",
      text: "0xffffff",
      accent: "0x006699",
    },
    forest: {
      bg: "0x050a05",
      wave: "0x33cc66",
      text: "0xccffcc",
      accent: "0x1a6633",
    },
    sunset: {
      bg: "0x1a0505",
      wave: "0xff6633",
      text: "0xffcc99",
      accent: "0xcc3300",
    },
    cyber: {
      bg: "0x0a051a",
      wave: "0x00ffcc",
      text: "0x99ffcc",
      accent: "0x006666",
    },
    purple: {
      bg: "0x0a051a",
      wave: "0x9966ff",
      text: "0xcc99ff",
      accent: "0x6633cc",
    },
    pink: {
      bg: "0x1a0510",
      wave: "0xff66cc",
      text: "0xffccdd",
      accent: "0xcc3366",
    },
    retro: {
      bg: "0x1a0a05",
      wave: "0xff9933",
      text: "0xffcc66",
      accent: "0xcc6600",
    },
  };

  for (const [key, value] of Object.entries(colorMap)) {
    if (p.includes(key)) {
      return { ...colors, ...value };
    }
  }

  return colors;
}

// ============================================================
// VIDEO TO AUDIO
// ============================================================
function videoToAudio(inputPath, outputPath, format = "mp3", onProgress) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(inputPath)) {
      reject(new Error("Input file not found"));
      return;
    }

    const ff = getFFmpeg();
    const cmd = ff(inputPath)
      .noVideo()
      .audioCodec(format === "mp3" ? "libmp3lame" : format)
      .audioBitrate(192)
      .format(format)
      .output(outputPath);

    let lastProgress = 0;

    cmd
      .on("start", () => {
        console.log(`[ffmpeg] Video to audio conversion started: ${inputPath}`);
        if (onProgress) onProgress(5);
      })
      .on("progress", (progress) => {
        const pct = Math.round(progress.percent || 0);
        if (pct > lastProgress) {
          lastProgress = pct;
          if (onProgress) onProgress(Math.min(pct, 95));
        }
      })
      .on("end", () => {
        console.log(
          `[ffmpeg] Video to audio conversion complete: ${outputPath}`,
        );
        if (onProgress) onProgress(100);
        resolve();
      })
      .on("error", (err) => {
        console.error("[ffmpeg] Video to audio failed:", err.message);
        reject(new Error(`Conversion failed: ${err.message}`));
      })
      .run();
  });
}

// ============================================================
// AUDIO TO VIDEO (Cover Image)
// ============================================================
function audioToVideo(inputPath, outputPath, coverPath, onProgress) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(inputPath)) {
      reject(new Error("Input file not found"));
      return;
    }

    if (!fs.existsSync(coverPath)) {
      reject(new Error("Cover image not found"));
      return;
    }

    const ff = getFFmpeg();
    const cmd = ff()
      .input(coverPath)
      .input(inputPath)
      .videoCodec("libx264")
      .videoBitrate("2000k")
      .size("1280x720")
      .aspect("16:9")
      .audioCodec("aac")
      .audioBitrate("192k")
      .format("mp4")
      .outputOptions([
        "-shortest",
        "-preset",
        "medium",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-vsync",
        "2",
      ])
      .output(outputPath);

    let lastProgress = 0;

    cmd
      .on("start", () => {
        console.log(`[ffmpeg] Audio to video conversion started: ${inputPath}`);
        if (onProgress) onProgress(5);
      })
      .on("progress", (progress) => {
        const pct = Math.round(progress.percent || 0);
        if (pct > lastProgress) {
          lastProgress = pct;
          if (onProgress) onProgress(Math.min(pct, 95));
        }
      })
      .on("end", () => {
        console.log(
          `[ffmpeg] Audio to video conversion complete: ${outputPath}`,
        );
        if (onProgress) onProgress(100);
        resolve();
      })
      .on("error", (err) => {
        console.error("[ffmpeg] Audio to video failed:", err.message);
        reject(new Error(`Conversion failed: ${err.message}`));
      })
      .run();
  });
}

// ============================================================
// GENERATE PROMPT VIDEO - FIXED VERSION
// ============================================================
function generatePromptVideo(inputPath, outputPath, prompt, onProgress) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(inputPath)) {
      reject(new Error("Input file not found"));
      return;
    }

    const colors = parsePromptColors(prompt);
    const bgColor = colors.bg;
    const waveColor = colors.wave;
    const accentColor = colors.accent;

    // Get audio duration first
    const ff = getFFmpeg();

    // Build the ffmpeg command with CORRECTED filter syntax
    // FIXED: Removed invalid 'color=wave' parameter, using proper showspectrum options
    const cmd = ff(inputPath)
      .output(outputPath)
      .audioCodec("aac")
      .audioBitrate("192k")
      .videoCodec("libx264")
      .videoBitrate("2000k")
      .size("1280x720")
      .format("mp4")
      .outputOptions([
        // FIXED: CORRECT showspectrum syntax - removed 'color=wave'
        "-filter_complex",
        `[0:a]showspectrum=s=1280x520:mode=combined:scale=cbr:slide=scroll:win_func=hann[spec];` +
          `[0:a]showwaves=s=1280x200:mode=cline:rate=25:colors=${waveColor}|${accentColor}[waves];` +
          `color=c=${bgColor}:s=1280x720:r=30[bg];` +
          `[bg][spec]overlay=x=0:y=0[bg1];` +
          `[bg1][waves]overlay=x=0:y=520[out]`,
        "-map",
        "[out]",
        "-map",
        "0:a",
        "-shortest",
        "-preset",
        "medium",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-vsync",
        "2",
      ]);

    let lastProgress = 0;

    cmd
      .on("start", () => {
        console.log(
          `[ffmpeg] Prompt video generation started for: ${inputPath}`,
        );
        if (onProgress) onProgress(5);
      })
      .on("progress", (progress) => {
        const pct = Math.round(progress.percent || 0);
        if (pct > lastProgress) {
          lastProgress = pct;
          if (onProgress) onProgress(Math.min(pct, 90));
        }
      })
      .on("end", () => {
        console.log(`[ffmpeg] Prompt video generated: ${outputPath}`);
        if (onProgress) onProgress(100);
        resolve();
      })
      .on("error", (err) => {
        console.error("[ffmpeg] Prompt video generation failed:", err.message);
        reject(new Error(`Audio visualization failed: ${err.message}`));
      })
      .run();
  });
}

// ============================================================
// ALTERNATIVE: SIMPLER PROMPT VIDEO (Fallback)
// ============================================================
function generateSimplePromptVideo(inputPath, outputPath, prompt, onProgress) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(inputPath)) {
      reject(new Error("Input file not found"));
      return;
    }

    const colors = parsePromptColors(prompt);
    const bgColor = colors.bg;
    const waveColor = colors.wave;

    const ff = getFFmpeg();
    const cmd = ff(inputPath)
      .output(outputPath)
      .audioCodec("aac")
      .audioBitrate("192k")
      .videoCodec("libx264")
      .videoBitrate("2000k")
      .size("1280x720")
      .format("mp4")
      .outputOptions([
        // SIMPLER VERSION - works more reliably
        "-filter_complex",
        `[0:a]showspectrum=s=1280x720:mode=combined:scale=cbr:slide=scroll:win_func=hann[out]`,
        "-map",
        "[out]",
        "-map",
        "0:a",
        "-shortest",
        "-preset",
        "medium",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-vsync",
        "2",
      ]);

    let lastProgress = 0;

    cmd
      .on("start", () => {
        console.log(
          `[ffmpeg] Simple prompt video generation started for: ${inputPath}`,
        );
        if (onProgress) onProgress(5);
      })
      .on("progress", (progress) => {
        const pct = Math.round(progress.percent || 0);
        if (pct > lastProgress) {
          lastProgress = pct;
          if (onProgress) onProgress(Math.min(pct, 90));
        }
      })
      .on("end", () => {
        console.log(`[ffmpeg] Simple prompt video generated: ${outputPath}`);
        if (onProgress) onProgress(100);
        resolve();
      })
      .on("error", (err) => {
        console.error(
          "[ffmpeg] Simple prompt video generation failed:",
          err.message,
        );
        reject(new Error(`Audio visualization failed: ${err.message}`));
      })
      .run();
  });
}

// ============================================================
// GENERATE PLAIN COVER FALLBACK
// ============================================================
function generatePlainCoverFallback(outputPath) {
  return new Promise((resolve, reject) => {
    const ff = getFFmpeg();
    const cmd = ff()
      .input("color=c=0x050a14:s=1280x720:r=1")
      .input("color=c=0x7FFFB0:s=1280x1:r=1")
      .input("color=c=0x3F8F65:s=1280x1:r=1")
      .output(outputPath)
      .videoCodec("png")
      .format("image2")
      .outputOptions([
        "-filter_complex",
        `[0:v]drawtext=fontsize=60:fontcolor=0xE8EDE9:x=(w-text_w)/2:y=(h-text_h)/2-30:text='seize'[bg];` +
          `[1:v]scale=1280:1[s1];` +
          `[2:v]scale=1280:1[s2];` +
          `[bg][s1]overlay=x=0:y=360[bg1];` +
          `[bg1][s2]overlay=x=0:y=362[out]`,
        "-map",
        "[out]",
        "-frames:v",
        "1",
      ]);

    cmd
      .on("start", () => {
        console.log(`[ffmpeg] Generating fallback cover: ${outputPath}`);
      })
      .on("end", () => {
        console.log(`[ffmpeg] Fallback cover generated: ${outputPath}`);
        resolve();
      })
      .on("error", (err) => {
        console.error(
          "[ffmpeg] Fallback cover generation failed:",
          err.message,
        );
        reject(new Error(`Cover generation failed: ${err.message}`));
      })
      .run();
  });
}

// ============================================================
// EMBED AUDIO TAGS
// ============================================================
function embedAudioTags(inputPath, coverPath, tags) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(inputPath)) {
      reject(new Error("Input file not found"));
      return;
    }

    const outputPath = inputPath.replace(/\.mp3$/, "-tagged.mp3");

    const ff = getFFmpeg();
    const cmd = ff(inputPath)
      .output(outputPath)
      .audioCodec("copy")
      .outputOptions([
        `-metadata`,
        `title=${tags.title || ""}`,
        `-metadata`,
        `artist=${tags.artist || ""}`,
        `-metadata`,
        `album=${tags.album || ""}`,
      ]);

    if (coverPath && fs.existsSync(coverPath)) {
      cmd.input(coverPath);
      cmd.outputOptions([
        "-map",
        "0",
        "-map",
        "1",
        "-c:v",
        "mjpeg",
        "-id3v2_version",
        "3",
      ]);
    }

    cmd
      .on("start", () => {
        console.log(`[ffmpeg] Embedding audio tags for: ${inputPath}`);
      })
      .on("end", () => {
        console.log(`[ffmpeg] Audio tags embedded: ${outputPath}`);
        resolve(outputPath);
      })
      .on("error", (err) => {
        console.error("[ffmpeg] Tag embedding failed:", err.message);
        reject(new Error(`Tagging failed: ${err.message}`));
      })
      .run();
  });
}

// ============================================================
// PROBE AUDIO DURATION
// ============================================================
function probeAudioDuration(inputPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(inputPath)) {
      resolve(60);
      return;
    }

    const ff = getFFmpeg();
    ff.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        console.warn("[ffmpeg] Could not probe audio, using default duration");
        resolve(60);
        return;
      }
      if (metadata?.format?.duration) {
        const duration = parseFloat(metadata.format.duration);
        if (!isNaN(duration) && duration > 0) {
          resolve(Math.min(duration, 300));
          return;
        }
      }
      resolve(60);
    });
  });
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  isAvailable,
  videoToAudio,
  audioToVideo,
  generatePromptVideo,
  generateSimplePromptVideo,
  generatePlainCoverFallback,
  embedAudioTags,
  probeAudioDuration,
};

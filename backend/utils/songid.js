const fs = require("fs");

const AUDD_API_URL = "https://api.audd.io/";
const AUDD_API_TOKEN = process.env.AUDD_API_KEY || null;

// Song ID is a bonus enhancement layered on top of a successful audio
// extraction — it must NEVER be able to break or delay the core
// conversion. Every failure mode here (no API key, network error, no
// match, bad response shape) resolves to `null`, never throws, so the
// caller can always fall back to "just return the plain converted file."
async function recognizeSong(filePath) {
  if (!AUDD_API_TOKEN) return null;
  if (!fs.existsSync(filePath)) return null;

  try {
    const stats = fs.statSync(filePath);
    // AudD only needs a short sample to fingerprint — capping what we
    // send keeps this fast and cheap regardless of the source file size.
    const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15MB is generous headroom
    const buffer =
      stats.size > MAX_UPLOAD_BYTES
        ? fs.readFileSync(filePath).subarray(0, MAX_UPLOAD_BYTES)
        : fs.readFileSync(filePath);

    const form = new FormData();
    form.append("api_token", AUDD_API_TOKEN);
    form.append("return", "apple_music,spotify");
    form.append("file", new Blob([buffer]), "audio.mp3");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let response;
    try {
      response = await fetch(AUDD_API_URL, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      console.warn("[songid] AudD request failed:", response.status);
      return null;
    }

    const data = await response.json();

    if (data.status !== "success" || !data.result) {
      // no match found — not an error, just nothing to tag with
      return null;
    }

    const r = data.result;
    const coverUrl =
      r.spotify?.album?.images?.[0]?.url ||
      r.apple_music?.artwork?.url?.replace("{w}x{h}", "600x600") ||
      null;

    return {
      title: r.title || null,
      artist: r.artist || null,
      album: r.album || null,
      coverUrl,
    };
  } catch (err) {
    console.warn("[songid] Recognition failed:", err.message || err);
    return null;
  }
}

module.exports = { recognizeSong, isConfigured: () => !!AUDD_API_TOKEN };

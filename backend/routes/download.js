const express = require("express");
const path = require("path");
const fs = require("fs");
const { v4: uuid } = require("uuid");
const ytDlp = require("yt-dlp-exec");
const ffmpegStaticPath = require("ffmpeg-static");
const https = require("https");
const http = require("http");
const { execFile } = require("child_process");
const { scheduleCleanup } = require("../utils/cleanup");
const { logEvent } = require("../utils/activityLog");

const router = express.Router();

const TMP_DIR = path.join(__dirname, "..", "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const jobs = new Map();
scheduleCleanup({ jobs, tmpDir: TMP_DIR });

const YT_DLP_BIN =
  (ytDlp && ytDlp.binPath) ||
  path.join(
    process.cwd(),
    "node_modules",
    "yt-dlp-exec",
    "bin",
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
  );

// ============================================================
// CACHE SYSTEM
// ============================================================
class FastCache {
  constructor(maxSize = 500, ttl = 1800000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttl = ttl;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }
}

const mediaCache = new FastCache(500, 1800000);
const profileCache = new FastCache(100, 3600000);
const shortLinkCache = new FastCache(200, 600000);
const negativeCache = new FastCache(1000, 90000);

// ============================================================
// COOKIE MANAGEMENT
// ============================================================
const COOKIE_SOURCE_FILES = {
  tiktok: process.env.TIKTOK_COOKIES_FILE || "./cookies/tiktok_cookies.txt",
  instagram:
    process.env.INSTAGRAM_COOKIES_FILE || "./cookies/instagram_cookies.txt",
  twitter: process.env.TWITTER_COOKIES_FILE || "./cookies/twitter_cookies.txt",
  facebook:
    process.env.FACEBOOK_COOKIES_FILE || "./cookies/facebook_cookies.txt",
  pinterest:
    process.env.PINTEREST_COOKIES_FILE || "./cookies/pinterest_cookies.txt",
  snapchat:
    process.env.SNAPCHAT_COOKIES_FILE || "./cookies/snapchat_cookies.txt",
  youtube: process.env.YT_COOKIES_FILE || "./cookies/youtube_cookies.txt",
  reddit: process.env.REDDIT_COOKIES_FILE || "./cookies/reddit_cookies.txt",
  imgur: process.env.IMGUR_COOKIES_FILE || "./cookies/imgur_cookies.txt",
  giphy: process.env.GIPHY_COOKIES_FILE || "./cookies/giphy_cookies.txt",
  vimeo: process.env.VIMEO_COOKIES_FILE || "./cookies/vimeo_cookies.txt",
  dailymotion:
    process.env.DAILYMOTION_COOKIES_FILE || "./cookies/dailymotion_cookies.txt",
  twitch: process.env.TWITCH_COOKIES_FILE || "./cookies/twitch_cookies.txt",
  soundcloud:
    process.env.SOUNDCLOUD_COOKIES_FILE || "./cookies/soundcloud_cookies.txt",
  spotify: process.env.SPOTIFY_COOKIES_FILE || "./cookies/spotify_cookies.txt",
};

const COOKIE_FILES = {};
for (const [platform, sourcePath] of Object.entries(COOKIE_SOURCE_FILES)) {
  if (!sourcePath) continue;
  try {
    const resolvedPath = path.resolve(process.cwd(), sourcePath);
    if (fs.existsSync(resolvedPath)) {
      const writablePath = path.join(TMP_DIR, `${platform}-cookies.txt`);
      fs.copyFileSync(resolvedPath, writablePath);
      COOKIE_FILES[platform] = writablePath;
      console.log(`[seize] ${platform} cookies loaded`);
    }
  } catch (e) {}
}

function cookiesFor(platform) {
  const file = COOKIE_FILES[platform];
  return file && fs.existsSync(file) ? file : null;
}

// ============================================================
// PLATFORM DEFINITIONS
// ============================================================
const PLATFORMS = [
  { name: "tiktok", re: /tiktok\.com/i },
  { name: "instagram", re: /instagram\.com/i },
  { name: "twitter", re: /(twitter\.com|x\.com)/i },
  { name: "pinterest", re: /(pinterest\.com|pin\.it)/i },
  { name: "snapchat", re: /snapchat\.com/i },
  { name: "facebook", re: /(facebook\.com|fb\.watch)/i },
  { name: "youtube", re: /(youtube\.com|youtu\.be)/i },
  { name: "reddit", re: /(reddit\.com|redd\.it)/i },
  { name: "imgur", re: /(imgur\.com|i\.imgur\.com)/i },
  { name: "giphy", re: /giphy\.com/i },
  { name: "vimeo", re: /vimeo\.com/i },
  { name: "dailymotion", re: /dailymotion\.com/i },
  { name: "twitch", re: /twitch\.tv/i },
  { name: "soundcloud", re: /soundcloud\.com/i },
  { name: "spotify", re: /(spotify\.com|open\.spotify\.com)/i },
];

function detectPlatform(url) {
  const match = PLATFORMS.find((p) => p.re.test(url));
  return match ? match.name : null;
}

function getAllPlatforms() {
  return PLATFORMS.map((p) => p.name);
}

// ============================================================
// USER AGENTS - MULTIPLE BYPASS VECTORS
// ============================================================
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:129.0) Gecko/20100101 Firefox/129.0",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/126.0.0.0",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 TikTok/36.0.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram/330.0.0",
  // Bot user agents for bypass
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; Bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Twitterbot/1.0",
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ============================================================
// CLEAN URL - HANDLES ALL ENCODING ISSUES
// ============================================================
function cleanUrl(url) {
  if (!url) return url;
  if (typeof url !== "string") return url;

  let u = url.trim();

  // Decode all encoded slash sequences
  u = u.replace(/u002f/gi, "/");
  u = u.replace(/\\/g, "");
  u = u.replace(/%2f/gi, "/");
  u = u.replace(/%2F/gi, "/");

  // Strip multiple protocol fragments
  let scheme = null;
  let stripped = true;
  while (stripped) {
    stripped = false;
    const m = u.match(/^(https?):\/{0,3}/i);
    if (m) {
      scheme = m[1].toLowerCase();
      u = u.slice(m[0].length);
      stripped = true;
    }
  }
  if (!scheme) scheme = "https";

  // Remove leading slashes
  u = u.replace(/^\/+/, "");

  // Collapse duplicate slashes in path only
  const qIndex = u.search(/[?#]/);
  let pathPart = qIndex === -1 ? u : u.slice(0, qIndex);
  const tailPart = qIndex === -1 ? "" : u.slice(qIndex);
  pathPart = pathPart.replace(/\/{2,}/g, "/");

  return `${scheme}://${pathPart}${tailPart}`;
}

// ============================================================
// NORMALIZE URL
// ============================================================
function normalizeUrl(url) {
  if (!url) return null;
  const cleaned = cleanUrl(url);
  try {
    new URL(cleaned);
    return cleaned;
  } catch {
    return null;
  }
}

// ============================================================
// RESOLVE SHORT LINKS - MULTIPLE METHODS
// ============================================================
async function resolveShortLink(url) {
  const cached = shortLinkCache.get(url);
  if (cached) return cached;

  console.log(`[seize] Resolving short link: ${url}`);

  const validUrl = normalizeUrl(url);
  if (!validUrl) {
    console.log(`[seize] Invalid URL format: ${url}`);
    return url;
  }

  // Already a full URL
  if (
    !validUrl.includes("vt.tiktok.com") &&
    !validUrl.includes("vm.tiktok.com") &&
    !validUrl.includes("pin.it") &&
    !validUrl.includes("fb.watch") &&
    !validUrl.includes("youtu.be")
  ) {
    const cleaned = cleanUrl(validUrl);
    shortLinkCache.set(url, cleaned);
    return cleaned;
  }

  // METHOD 1: yt-dlp
  try {
    console.log("[seize] Method 1: yt-dlp...");
    const result = await ytDlp(validUrl, {
      dumpJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      retries: 5,
    });
    if (result && result.webpage_url) {
      const resolved = cleanUrl(result.webpage_url);
      console.log(`[seize] yt-dlp resolved: ${resolved}`);
      shortLinkCache.set(url, resolved);
      return resolved;
    }
  } catch (err) {
    console.log(`[seize] yt-dlp failed: ${err.message}`);
  }

  // METHOD 2: Fetch with redirect
  try {
    console.log("[seize] Method 2: Fetch redirect...");
    const response = await fetch(validUrl, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Cache-Control": "no-cache",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    const finalUrl = response.url;
    if (
      finalUrl &&
      !finalUrl.includes("vt.tiktok.com") &&
      !finalUrl.includes("vm.tiktok.com")
    ) {
      const cleaned = cleanUrl(finalUrl);
      console.log(`[seize] Fetch resolved: ${cleaned}`);
      shortLinkCache.set(url, cleaned);
      return cleaned;
    }
  } catch (err) {
    console.log(`[seize] Fetch failed: ${err.message}`);
  }

  // METHOD 3: Mobile user agent
  try {
    console.log("[seize] Method 3: Mobile UA...");
    const response = await fetch(validUrl, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 TikTok/36.0.0",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    const finalUrl = response.url;
    if (
      finalUrl &&
      !finalUrl.includes("vt.tiktok.com") &&
      !finalUrl.includes("vm.tiktok.com")
    ) {
      const cleaned = cleanUrl(finalUrl);
      console.log(`[seize] Mobile resolved: ${cleaned}`);
      shortLinkCache.set(url, cleaned);
      return cleaned;
    }
  } catch (err) {
    console.log(`[seize] Mobile failed: ${err.message}`);
  }

  // METHOD 4: HEAD request
  try {
    console.log("[seize] Method 4: HEAD request...");
    const response = await fetch(validUrl, {
      method: "HEAD",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    const finalUrl = response.url;
    if (
      finalUrl &&
      !finalUrl.includes("vt.tiktok.com") &&
      !finalUrl.includes("vm.tiktok.com")
    ) {
      const cleaned = cleanUrl(finalUrl);
      console.log(`[seize] HEAD resolved: ${cleaned}`);
      shortLinkCache.set(url, cleaned);
      return cleaned;
    }
  } catch (err) {
    console.log(`[seize] HEAD failed: ${err.message}`);
  }

  console.log("[seize] All methods failed, returning original");
  return cleanUrl(validUrl);
}

// ============================================================
// FETCH WITH RETRY - HANDLES DNS ERRORS
// ============================================================
async function fetchWithRetry(url, options = {}, retries = 3) {
  const validUrl = normalizeUrl(url);
  if (!validUrl) {
    throw new Error("Invalid URL format");
  }

  const cleanedUrl = cleanUrl(validUrl);

  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(cleanedUrl, {
        ...options,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          ...options.headers,
        },
      });
      return response;
    } catch (error) {
      if (error.code === "ENOTFOUND" || error.message.includes("ENOTFOUND")) {
        console.error(
          `[fetch] DNS resolution failed (attempt ${i + 1}):`,
          error.message,
        );
        if (i === retries - 1) {
          throw new Error(
            "Could not reach the server. The domain may not exist.",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
      } else if (i === retries - 1) {
        throw error;
      }
    }
  }
}

// ============================================================
// SANITIZE URL
// ============================================================
function sanitizeUrl(input) {
  if (!input) return null;

  let url = input.trim();
  url = url.replace(/[:;,.\s]+$/, "");
  url = url.replace(/^[@]+/, "");
  url = url.replace(/[<>{}|\\^`[\]]/g, "");

  // Remove tracking
  url = url.replace(/\?si=[^&]*&?/g, "?").replace(/\?$/, "");
  url = url.replace(/&si=[^&]*/g, "");

  return cleanUrl(url);
}

// ============================================================
// HEADER GENERATION - MULTIPLE BYPASS VECTORS
// ============================================================
function generateHeaders(platform, ua = null) {
  const userAgent = ua || getRandomUserAgent();
  const isMobile =
    userAgent.includes("Mobile") ||
    userAgent.includes("Android") ||
    userAgent.includes("iPhone");

  const headers = {
    "User-Agent": userAgent,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,es;q=0.8,fr;q=0.7,de;q=0.6",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    DNT: "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Sec-GPC": "1",
  };

  // Platform-specific headers
  const platformHeaders = {
    tiktok: {
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.tiktok.com/",
      Origin: "https://www.tiktok.com",
      "X-Requested-With": "XMLHttpRequest",
    },
    instagram: {
      "X-Requested-With": "XMLHttpRequest",
      "X-Instagram-AJAX": "1",
      "X-IG-App-ID": "936619743392459",
      Accept: "application/json, text/plain, */*",
    },
    twitter: {
      Accept: "application/json, text/plain, */*",
      Referer: "https://twitter.com/",
      "X-Twitter-Client": "web",
      "X-Requested-With": "XMLHttpRequest",
    },
    youtube: {
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.youtube.com/",
      "X-YouTube-Client-Name": "1",
      "X-YouTube-Client-Version": "2.20240730.00.00",
    },
    reddit: {
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.reddit.com/",
      "X-Requested-With": "XMLHttpRequest",
    },
    soundcloud: {
      Accept: "application/json, text/plain, */*",
      Referer: "https://soundcloud.com/",
    },
    spotify: {
      Accept: "application/json, text/plain, */*",
      Referer: "https://open.spotify.com/",
    },
    vimeo: {
      Accept: "application/json, text/plain, */*",
      Referer: "https://vimeo.com/",
    },
    dailymotion: {
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.dailymotion.com/",
    },
    twitch: {
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.twitch.tv/",
      "Client-ID": "kimne78kx3ncx6brgo4mv6wki5h1ko",
    },
    facebook: {
      "X-Requested-With": "XMLHttpRequest",
      Referer: "https://www.facebook.com/",
      Accept: "application/json, text/plain, */*",
    },
    pinterest: {
      "X-Requested-With": "XMLHttpRequest",
      Referer: "https://www.pinterest.com/",
      Accept: "application/json, text/plain, */*",
    },
  };

  if (platformHeaders[platform]) {
    Object.assign(headers, platformHeaders[platform]);
  }

  return headers;
}

// ============================================================
// DIRECT EXTRACTOR - FAST HTML PARSING
// ============================================================
async function universalDirectExtractor(url, platform) {
  const cleanUrlStr = cleanUrl(url);
  const cacheKey = `direct_${platform}_${cleanUrlStr}`;

  const cached = mediaCache.get(cacheKey);
  if (cached) return cached;
  if (negativeCache.get(cacheKey)) return null;

  const userAgents = [
    getRandomUserAgent(),
    USER_AGENTS[0],
    USER_AGENTS[3],
    USER_AGENTS[5],
    USER_AGENTS[8],
    USER_AGENTS[10],
  ];

  for (const ua of userAgents) {
    try {
      const headers = generateHeaders(platform, ua);
      const response = await fetchWithRetry(cleanUrlStr, {
        headers,
        signal: AbortSignal.timeout(15000),
        redirect: "follow",
      });

      if (!response.ok) continue;

      const html = await response.text();
      const result = extractMediaFromHtml(html, platform, cleanUrlStr);

      if (result && (result.videos.length > 0 || result.images.length > 0)) {
        mediaCache.set(cacheKey, result);
        return result;
      }
    } catch (err) {}
  }

  negativeCache.set(cacheKey, true);
  return null;
}

function extractMediaFromHtml(html, platform, url) {
  const videos = [];
  const images = [];
  let title = `${platform} Post`;
  let thumbnail = null;

  // Meta tags
  const ogTitleMatch = html.match(
    /<meta property="og:title" content="([^"]+)"/,
  );
  if (ogTitleMatch) title = ogTitleMatch[1];

  const ogImageMatch = html.match(
    /<meta property="og:image" content="([^"]+)"/,
  );
  if (ogImageMatch) thumbnail = cleanUrl(ogImageMatch[1]);

  const twitterImageMatch = html.match(
    /<meta name="twitter:image" content="([^"]+)"/,
  );
  if (!thumbnail && twitterImageMatch)
    thumbnail = cleanUrl(twitterImageMatch[1]);

  // Video patterns - comprehensive
  const videoPatterns = [
    /https:\/\/[^\s"']+\.(mp4|mov|webm|m3u8)[^\s"']*/gi,
    /"videoUrl":"([^"]+)"/gi,
    /"video_url":"([^"]+)"/gi,
    /"playAddr":"([^"]+)"/gi,
    /"downloadAddr":"([^"]+)"/gi,
    /"playback_url":"([^"]+)"/gi,
    /"contentUrl":"([^"]+\.(mp4|mov|webm|mkv)[^"]*)"/gi,
    /"url":"([^"]+\.(mp4|mov|webm|mkv)[^"]*)"/gi,
    /"hls_url":"([^"]+)"/gi,
    /"video_manifest":"([^"]+)"/gi,
    /"playlist":"([^"]+)"/gi,
    /"source":"([^"]+\.(mp4|mov|webm))"/gi,
    /"src":"([^"]+\.(mp4|mov|webm))"/gi,
    /"data-video":"([^"]+)"/gi,
    /"data-source":"([^"]+)"/gi,
    /"mediaUrl":"([^"]+)"/gi,
    /"media_url":"([^"]+)"/gi,
    /"content":"([^"]+\.(mp4|mov|webm))"/gi,
  ];

  // Image patterns - comprehensive
  const imagePatterns = [
    /https:\/\/[^\s"']+\.(jpg|jpeg|png|webp|gif)[^\s"']*/gi,
    /"displayUrl":"([^"]+)"/gi,
    /"display_url":"([^"]+)"/gi,
    /"imageUrl":"([^"]+)"/gi,
    /"image_url":"([^"]+)"/gi,
    /"thumbnail":"([^"]+)"/gi,
    /"thumbnailUrl":"([^"]+)"/gi,
    /"coverUrl":"([^"]+)"/gi,
    /"cover_url":"([^"]+)"/gi,
    /"poster":"([^"]+)"/gi,
    /"data-src":"([^"]+\.(jpg|jpeg|png|webp|gif))"/gi,
    /"data-image":"([^"]+)"/gi,
    /"data-media":"([^"]+)"/gi,
  ];

  for (const pattern of videoPatterns) {
    const matches = [...html.matchAll(pattern)];
    for (const match of matches) {
      let cleanUrlStr = match[1] || match[0];
      if (cleanUrlStr && typeof cleanUrlStr === "string") {
        cleanUrlStr = cleanUrl(cleanUrlStr);
        if (
          !cleanUrlStr.includes("placeholder") &&
          !cleanUrlStr.includes("default") &&
          !cleanUrlStr.includes("data:image")
        ) {
          videos.push({ url: cleanUrlStr, format: "mp4", quality: "HD" });
        }
      }
    }
  }

  for (const pattern of imagePatterns) {
    const matches = [...html.matchAll(pattern)];
    for (const match of matches) {
      let cleanUrlStr = match[1] || match[0];
      if (cleanUrlStr && typeof cleanUrlStr === "string") {
        cleanUrlStr = cleanUrl(cleanUrlStr);
        if (
          !cleanUrlStr.includes("placeholder") &&
          !cleanUrlStr.includes("default") &&
          !cleanUrlStr.includes("data:image")
        ) {
          images.push({ url: cleanUrlStr, format: "jpg" });
        }
      }
    }
  }

  // JSON-LD extraction
  const jsonLdMatches = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
  );
  if (jsonLdMatches) {
    for (const match of jsonLdMatches) {
      try {
        const json = JSON.parse(
          match.replace(
            /<script type="application\/ld\+json">|<\/script>/g,
            "",
          ),
        );
        const videoUrls = extractUrlsFromJson(json, "video");
        const imageUrls = extractUrlsFromJson(json, "image");
        for (const v of videoUrls) {
          const cleanV = cleanUrl(v);
          if (!cleanV.includes("placeholder")) {
            videos.push({ url: cleanV, format: "mp4", quality: "HD" });
          }
        }
        for (const i of imageUrls) {
          const cleanI = cleanUrl(i);
          if (!cleanI.includes("placeholder")) {
            images.push({ url: cleanI, format: "jpg" });
          }
        }
      } catch (e) {}
    }
  }

  const uniqueVideos = videos.filter(
    (v, i) => videos.findIndex((x) => x.url === v.url) === i,
  );
  const uniqueImages = images.filter(
    (i, idx) => images.findIndex((x) => x.url === i.url) === idx,
  );

  if (uniqueVideos.length > 0 || uniqueImages.length > 0) {
    const username =
      url.match(/@([a-zA-Z0-9_.-]+)/)?.[1] ||
      url.split("/").pop().split("?")[0];
    return {
      platform,
      title: title || `${platform} Post`,
      uploader: username || platform,
      thumbnail: thumbnail || uniqueImages[0]?.url || null,
      hasVideo: uniqueVideos.length > 0,
      hasImage: uniqueImages.length > 0,
      videos: uniqueVideos.slice(0, 10),
      images: uniqueImages.slice(0, 10),
      audio: [],
      directExtract: true,
    };
  }

  return null;
}

function extractUrlsFromJson(obj, type) {
  const urls = [];
  const pattern =
    type === "video"
      ? /\.(mp4|mov|webm|mkv|m3u8)/i
      : /\.(jpg|jpeg|png|webp|gif)/i;

  function traverse(obj) {
    if (!obj || typeof obj !== "object") return;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (typeof item === "string" && pattern.test(item)) {
          urls.push(item);
        } else if (typeof item === "object") {
          traverse(item);
        }
      }
    } else {
      for (const key of Object.keys(obj)) {
        if (typeof obj[key] === "string" && pattern.test(obj[key])) {
          if (
            key.includes("url") ||
            key.includes("src") ||
            key.includes("content") ||
            key.includes("source") ||
            key.includes("media")
          ) {
            urls.push(obj[key]);
          }
        } else if (typeof obj[key] === "object") {
          traverse(obj[key]);
        }
      }
    }
  }

  traverse(obj);
  return urls;
}

// ============================================================
// YT-DLP STRATEGIES - MULTIPLE BYPASS VECTORS
// ============================================================
function baseOptions(platform) {
  const opts = {
    noWarnings: true,
    noCheckCertificates: true,
    ffmpegLocation: ffmpegStaticPath,
    retries: 10,
    socketTimeout: 60,
    concurrentFragments: 32,
    throttledRate: "200M",
    sleepInterval: 0.5,
    maxSleepInterval: 2,
    extractorRetries: 5,
    fragmentRetries: 10,
    ignoreErrors: true,
    preferFreeFormats: true,
    httpChunkSize: 10485760,
  };

  const cookies = cookiesFor(platform);
  if (cookies) opts.cookies = cookies;

  return opts;
}

function getPlatformStrategies(platform) {
  const strategies = {
    tiktok: [
      { extractorArgs: "tiktok:device_id=auto" },
      { extractorArgs: "tiktok:api=web" },
      { extractorArgs: "tiktok:api=android" },
      { extractorArgs: "tiktok:api=ios" },
      { forceGenericExtractor: true },
    ],
    instagram: [
      { extractorArgs: "instagram:include_ads=false" },
      { extractorArgs: "instagram:api=web;include_ads=false" },
      { extractorArgs: "instagram:api=android;include_ads=false" },
      { extractorArgs: "instagram:api=ios;include_ads=false" },
    ],
    twitter: [
      { extractorArgs: "twitter:api=syndication" },
      { extractorArgs: "twitter:api=web" },
      { extractorArgs: "twitter:api=android" },
      { extractorArgs: "twitter:api=ios" },
    ],
    youtube: [
      {
        extractorArgs:
          "youtube:include_dash_manifest=true;include_hls_manifest=true",
      },
      { extractorArgs: "youtube:api=web" },
      { extractorArgs: "youtube:api=android" },
      { extractorArgs: "youtube:api=ios" },
    ],
    facebook: [
      { extractorArgs: "facebook:include_ads=false" },
      { extractorArgs: "facebook:api=web;include_ads=false" },
      { extractorArgs: "facebook:api=android;include_ads=false" },
    ],
    pinterest: [
      { extractorArgs: "generic" },
      { extractorArgs: "pinterest:api=web" },
      { extractorArgs: "pinterest:api=android" },
    ],
    snapchat: [
      { extractorArgs: "generic" },
      { extractorArgs: "snapchat:api=web" },
      { extractorArgs: "snapchat:api=android" },
    ],
    reddit: [
      { extractorArgs: "reddit:api=web" },
      { extractorArgs: "reddit:api=android" },
      { extractorArgs: "generic" },
    ],
    soundcloud: [
      { extractorArgs: "soundcloud:api=web" },
      { extractorArgs: "soundcloud:api=android" },
      { extractorArgs: "soundcloud:api=ios" },
    ],
    spotify: [
      { extractorArgs: "spotify:api=web" },
      { extractorArgs: "spotify:api=android" },
      { extractorArgs: "spotify:api=ios" },
    ],
    vimeo: [
      { extractorArgs: "vimeo:api=web" },
      { extractorArgs: "vimeo:api=android" },
      { extractorArgs: "vimeo:api=ios" },
    ],
    dailymotion: [
      { extractorArgs: "dailymotion:api=web" },
      { extractorArgs: "dailymotion:api=android" },
      { extractorArgs: "dailymotion:api=ios" },
    ],
    twitch: [
      { extractorArgs: "twitch:api=web" },
      { extractorArgs: "twitch:api=android" },
      { extractorArgs: "twitch:api=ios" },
    ],
    imgur: [
      { extractorArgs: "generic" },
      { extractorArgs: "imgur:api=web" },
      { extractorArgs: "generic;force_generic_extractor=true" },
    ],
    giphy: [
      { extractorArgs: "generic" },
      { extractorArgs: "giphy:api=web" },
      { extractorArgs: "generic;force_generic_extractor=true" },
    ],
  };

  return strategies[platform] || [{ extractorArgs: "generic" }];
}

// ============================================================
// RESOLVE WITH STRATEGIES
// ============================================================
async function resolveWithStrategies(
  url,
  platform,
  isUsable,
  preFetchedDirectResult = undefined,
) {
  const cleanUrlStr = cleanUrl(url);
  const cacheKey = `resolve_${platform}_${cleanUrlStr}`;

  const cached = mediaCache.get(cacheKey);
  if (cached) return { info: cached, strategyIndex: -1, directExtract: true };

  const directResult =
    preFetchedDirectResult !== undefined
      ? preFetchedDirectResult
      : await universalDirectExtractor(cleanUrlStr, platform);

  if (
    directResult &&
    (directResult.videos.length > 0 || directResult.images.length > 0)
  ) {
    mediaCache.set(cacheKey, directResult);
    return { info: directResult, strategyIndex: -1, directExtract: true };
  }

  const ytDlpCooldownKey = `ytdlp_${cacheKey}`;
  if (negativeCache.get(ytDlpCooldownKey)) {
    throw new Error(
      "This link failed recently — cooling down before retrying.",
    );
  }

  const base = baseOptions(platform);
  const strategies = [];
  const platformStrategies = getPlatformStrategies(platform);

  for (let i = 0; i < Math.min(5, platformStrategies.length); i++) {
    const ua = USER_AGENTS[i % USER_AGENTS.length];
    const strategy = {
      dumpSingleJson: true,
      preferFreeFormats: true,
      ...base,
      addHeaders: generateHeaders(platform, ua),
    };
    Object.assign(strategy, platformStrategies[i]);
    if (i % 2 === 0) strategy.cookies = cookiesFor(platform) || undefined;
    if (i % 3 === 0) delete strategy.cookies;
    strategies.push(strategy);
  }

  let lastErr;
  for (let i = 0; i < strategies.length; i++) {
    try {
      console.log(
        `[seize] Strategy ${i + 1}/${strategies.length} for ${platform}...`,
      );
      const info = await ytDlp(cleanUrlStr, strategies[i], {
        timeout: 30000,
        maxBuffer: 1024 * 1024 * 20,
      });
      if (!isUsable || isUsable(info)) {
        console.log(`[seize] Strategy ${i + 1} succeeded!`);
        mediaCache.set(cacheKey, info);
        return { info, strategyIndex: i };
      }
      lastErr = new Error("Strategy returned no usable media");
    } catch (err) {
      lastErr = err;
      console.log(`[seize] Strategy ${i + 1} failed`);
    }
  }
  negativeCache.set(ytDlpCooldownKey, true);
  throw lastErr || new Error("All extraction strategies failed");
}

// ============================================================
// YT-DLP WITH PROGRESS
// ============================================================
function runYtDlpWithProgress(url, options, jobId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child;
    try {
      child = ytDlp.exec(url, options);
    } catch (err) {
      reject(err);
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {}
      reject(new Error("Download timed out. Please try again."));
    }, timeoutMs);

    const parseProgress = (chunk) => {
      const text = chunk.toString();
      const match = text.match(/\[download\]\s+([\d.]+)%/);
      if (match) {
        const pct = Math.min(99, Math.round(parseFloat(match[1])));
        const job = jobs.get(jobId);
        if (job && job.status === "processing") job.progress = pct;
      }
    };

    if (child.stdout) child.stdout.on("data", parseProgress);
    if (child.stderr) child.stderr.on("data", parseProgress);

    child
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

// ============================================================
// DOWNLOAD FILE HELPER
// ============================================================
function downloadFile(url, filePath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error("Too many redirects"));
      return;
    }

    let cleanUrlStr = cleanUrl(url);

    let parsed;
    try {
      parsed = new URL(cleanUrlStr);
    } catch (err) {
      reject(new Error(`Invalid URL: ${cleanUrlStr}`));
      return;
    }

    const protocol = parsed.protocol === "https:" ? https : http;
    const file = fs.createWriteStream(filePath);

    const headers = {
      "User-Agent": getRandomUserAgent(),
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
      Range: "bytes=0-",
    };

    const request = protocol.get(cleanUrlStr, { headers }, (response) => {
      if (
        [301, 302, 303, 307, 308].includes(response.statusCode) &&
        response.headers.location
      ) {
        file.close();
        fs.unlink(filePath, () => {});
        downloadFile(
          cleanUrl(response.headers.location),
          filePath,
          redirects + 1,
        )
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200 && response.statusCode !== 206) {
        file.close();
        fs.unlink(filePath, () => {});
        reject(new Error(`Download failed: ${response.statusCode}`));
        return;
      }

      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve(filePath);
      });
    });

    request.on("error", (err) => {
      fs.unlink(filePath, () => {});
      reject(err);
    });

    request.setTimeout(60000, () => {
      request.destroy();
      fs.unlink(filePath, () => {});
      reject(new Error("Download timeout"));
    });
  });
}

// ============================================================
// MEDIA EXTRACTION HELPERS
// ============================================================
function extractMediaUrls(info) {
  if (info.directExtract) {
    return {
      images: (info.images || []).map((i) => ({ ...i, url: cleanUrl(i.url) })),
      videos: (info.videos || []).map((v) => ({ ...v, url: cleanUrl(v.url) })),
      audio: (info.audio || []).map((a) => ({ ...a, url: cleanUrl(a.url) })),
      thumbnail: info.thumbnail ? cleanUrl(info.thumbnail) : null,
      hasVideo: info.hasVideo || false,
      hasImage: info.hasImage || false,
      isGif: false,
    };
  }

  const media = {
    images: [],
    videos: [],
    audio: [],
    thumbnail: null,
    hasVideo: false,
    hasImage: false,
    isGif: false,
  };
  const nodes =
    Array.isArray(info.entries) && info.entries.length
      ? info.entries.filter(Boolean)
      : [info];

  for (const node of nodes) {
    if (!media.thumbnail) {
      if (node.thumbnail) {
        media.thumbnail = cleanUrl(node.thumbnail);
      } else if (Array.isArray(node.thumbnails) && node.thumbnails.length) {
        const largest = [...node.thumbnails].sort(
          (a, b) => (b.width || 0) - (a.width || 0),
        )[0];
        media.thumbnail = largest?.url ? cleanUrl(largest.url) : null;
      }
    }

    if (Array.isArray(node.formats)) {
      for (const format of node.formats) {
        if (!format.url) continue;
        const safeUrl = cleanUrl(format.url);
        const isVideo = format.vcodec && format.vcodec !== "none";
        const isAudio = format.acodec && format.acodec !== "none" && !isVideo;
        const isImage =
          format.ext &&
          ["jpg", "jpeg", "png", "webp", "gif"].includes(
            format.ext.toLowerCase(),
          );

        if (isVideo) {
          media.videos.push({
            url: safeUrl,
            format: format.ext || "mp4",
            quality: format.format_note || format.quality || "Unknown",
            width: format.width || null,
            height: format.height || null,
            isGif: format.format_note && /gif/i.test(format.format_note),
          });
          media.hasVideo = true;
        } else if (isImage) {
          media.images.push({
            url: safeUrl,
            format: format.ext || "jpg",
            width: format.width || null,
            height: format.height || null,
          });
          media.hasImage = true;
        } else if (isAudio) {
          media.audio.push({
            url: safeUrl,
            format: format.ext || "mp3",
            bitrate: format.abr || null,
          });
        }
      }
    }

    if (node.url && node.ext) {
      const ext = node.ext.toLowerCase();
      const safeUrl = cleanUrl(node.url);
      if (["mp4", "mov", "webm", "mkv"].includes(ext)) {
        media.videos.push({ url: safeUrl, format: ext, quality: "Unknown" });
        media.hasVideo = true;
      } else if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) {
        media.images.push({ url: safeUrl, format: ext });
        media.hasImage = true;
      }
    }
  }

  if (!media.thumbnail && media.images.length > 0) {
    media.thumbnail = media.images[0].url;
  }
  if (!media.thumbnail && media.videos.length > 0) {
    media.thumbnail = media.videos[0].url;
  }

  media.videos.sort(
    (a, b) => (b.height || b.width || 0) - (a.height || a.width || 0),
  );

  return media;
}

function isUsableInfo(info) {
  if (!info) return false;
  if (info.directExtract) return info.hasVideo || info.hasImage;

  if (info.formats && Array.isArray(info.formats)) {
    const hasVideo = info.formats.some(
      (f) =>
        (f.vcodec && f.vcodec !== "none") ||
        (f.ext && ["mp4", "mov", "webm"].includes(f.ext.toLowerCase())),
    );
    if (hasVideo) return true;
  }

  const media = extractMediaUrls(info);
  return media.hasVideo || media.hasImage || media.audio.length > 0;
}

function dedupeByHeight(videos, max = 8) {
  const seen = new Set();
  const out = [];
  for (const v of videos) {
    const key = v.height || v.width || 0;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

function sanitizeFilename(name) {
  return (
    String(name || "seize")
      .replace(/[\/\\?%*:|"<>]/g, "")
      .replace(/[\r\n]/g, "")
      .trim()
      .slice(0, 100) || "seize"
  );
}

// ============================================================
// ERROR HANDLING
// ============================================================
function friendlyError(stderr = "") {
  const s = stderr.toLowerCase();

  if (
    s.includes("private") ||
    s.includes("protected") ||
    s.includes("login required")
  ) {
    return "This content is private. Try using cookies or a different method.";
  }
  if (s.includes("not found") || s.includes("404"))
    return "Content not found. Please check the URL.";
  if (s.includes("rate limit") || s.includes("429"))
    return "Rate limited. Please wait a few minutes.";
  if (s.includes("blocked") || s.includes("403"))
    return "Access blocked. Trying alternative methods...";
  if (s.includes("timeout") || s.includes("timed out") || s.includes("aborted"))
    return "Request timed out. Retrying...";
  if (s.includes("empty") || s.includes("no items")) return "No posts found.";
  if (s.includes("geo") || s.includes("country"))
    return "Content is region-locked.";
  if (s.includes("getaddrinfo") || s.includes("enotfound"))
    return "Could not reach the server. The URL may be invalid.";
  if (s.includes("ssl") || s.includes("certificate"))
    return "SSL error. Trying with relaxed security...";
  if (s.includes("invalid url"))
    return "Invalid URL format. Please check the URL.";
  if (s.includes("cooling down"))
    return "This link just failed — please wait a moment and try again.";

  return "Couldn't resolve this link. It may be blocked, deleted, or private.";
}

// ============================================================
// UPDATE YT-DLP
// ============================================================
function updateYtDlpBinary() {
  execFile(YT_DLP_BIN, ["-U"], { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.log("[seize] yt-dlp self-update skipped:", err.message);
      return;
    }
    const out = (stdout || stderr || "").trim();
    if (out) console.log("[seize] yt-dlp update check:", out.split("\n").pop());
  });
}

setTimeout(updateYtDlpBinary, 5000);
setInterval(updateYtDlpBinary, 6 * 60 * 60 * 1000).unref();

// ============================================================
// ROUTE: GET PLATFORMS
// ============================================================
router.get("/platforms", (req, res) => {
  res.json({
    platforms: getAllPlatforms(),
    count: getAllPlatforms().length,
  });
});

// ============================================================
// ROUTE: RESOLVE - MAIN
// ============================================================
router.post("/resolve", async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: "A URL is required" });

  url = sanitizeUrl(url);
  if (!url) return res.status(400).json({ error: "Invalid URL format" });

  // Resolve short links
  if (
    url.includes("vt.tiktok.com") ||
    url.includes("vm.tiktok.com") ||
    url.includes("pin.it") ||
    url.includes("fb.watch") ||
    url.includes("youtu.be")
  ) {
    try {
      const resolved = await resolveShortLink(url);
      if (resolved && resolved !== url) {
        url = resolved;
        console.log(`[seize] Resolved short link to: ${url}`);
      }
    } catch (err) {
      console.warn("[seize] Failed to resolve short link:", err.message);
    }
  }

  // Clean the URL
  url = cleanUrl(url);

  const platform = detectPlatform(url);
  if (!platform) {
    return res.status(400).json({
      error:
        "Unsupported platform. Supported platforms: " +
        getAllPlatforms().join(", "),
    });
  }

  try {
    console.log(`[seize] Resolving ${platform} URL: ${url}`);

    // Try direct extraction first
    const directResult = await universalDirectExtractor(url, platform);
    if (
      directResult &&
      (directResult.videos.length > 0 || directResult.images.length > 0)
    ) {
      return res.json({
        platform,
        title: directResult.title || `${platform} Post`,
        thumbnail: directResult.thumbnail
          ? cleanUrl(directResult.thumbnail)
          : null,
        uploader: directResult.uploader || "Unknown",
        contentType: directResult.hasVideo
          ? "video"
          : directResult.hasImage
            ? "image"
            : "unknown",
        hasVideo: directResult.hasVideo,
        hasImage: directResult.hasImage,
        isGif: false,
        media: {
          videos: (directResult.videos || []).map((v) => ({
            ...v,
            url: cleanUrl(v.url),
          })),
          images: (directResult.images || []).map((i) => ({
            ...i,
            url: cleanUrl(i.url),
          })),
          audio: directResult.audio || [],
        },
        formatsAvailable: directResult.hasVideo ? ["mp4"] : ["jpg"],
        duration: null,
        isImageOnly: !directResult.hasVideo && directResult.hasImage,
      });
    }

    // Fallback to yt-dlp
    const { info } = await resolveWithStrategies(
      url,
      platform,
      isUsableInfo,
      directResult,
    );
    const media = extractMediaUrls(info);

    let title = info.title || info.fulltitle || info.description || "Untitled";
    if (title.length > 200) title = title.substring(0, 200) + "...";

    let uploader =
      info.uploader ||
      info.channel ||
      info.author ||
      info.creator ||
      info.owner ||
      null;
    let contentType = media.hasVideo
      ? "video"
      : media.hasImage
        ? "image"
        : "unknown";
    if (media.isGif) contentType = "video";

    let thumbnail = media.thumbnail || "/icons/icon-192.png";
    if (thumbnail === "/icons/icon-192.png" && media.images.length > 0) {
      thumbnail = media.images[0].url;
    }

    const formatsAvailable = [];
    if (info.formats && Array.isArray(info.formats)) {
      const formatExts = info.formats.map((f) => f.ext).filter(Boolean);
      formatsAvailable.push(...new Set(formatExts));
    }
    if (media.hasVideo) formatsAvailable.push("mp4");
    if (media.hasImage) formatsAvailable.push("jpg");
    if (media.audio.length > 0) formatsAvailable.push("mp3");

    res.json({
      platform,
      title,
      thumbnail,
      uploader: uploader || "Unknown",
      contentType,
      hasVideo: media.hasVideo,
      hasImage: media.hasImage,
      isGif: media.isGif || false,
      media: {
        videos: dedupeByHeight(media.videos, 8),
        images: media.images.slice(0, 8),
        audio: media.audio.slice(0, 3),
      },
      formatsAvailable: [...new Set(formatsAvailable)],
      duration: info.duration || null,
      isImageOnly: contentType === "image",
    });
  } catch (err) {
    const stderr = err.stderr || err.message || "";
    console.error("[resolve] Failed:", stderr);

    const errorMsg = friendlyError(stderr);
    if (
      stderr.toLowerCase().includes("429") ||
      stderr.toLowerCase().includes("rate limit")
    ) {
      return res
        .status(429)
        .json({ error: `${platform} is rate limiting. Please wait.` });
    }
    res.status(502).json({ error: errorMsg });
  }
});

// ============================================================
// ROUTE: FETCH - DOWNLOAD
// ============================================================
router.post("/fetch", async (req, res) => {
  let { url, mode = "video", quality = "best" } = req.body;
  if (!url) return res.status(400).json({ error: "A URL is required" });

  url = sanitizeUrl(url);
  if (!url) return res.status(400).json({ error: "Invalid URL format" });

  // Resolve short links
  if (
    url.includes("vt.tiktok.com") ||
    url.includes("vm.tiktok.com") ||
    url.includes("pin.it") ||
    url.includes("fb.watch") ||
    url.includes("youtu.be")
  ) {
    try {
      const resolved = await resolveShortLink(url);
      if (resolved && resolved !== url) {
        url = resolved;
      }
    } catch (err) {
      console.warn("[seize] Failed to resolve short link:", err.message);
    }
  }

  // Clean the URL
  url = cleanUrl(url);

  const platform = detectPlatform(url);
  if (!platform) return res.status(400).json({ error: "Unsupported link." });

  const jobId = uuid();
  const ext = mode === "audio" ? "mp3" : mode === "image" ? "jpg" : "mp4";
  const outputPath = path.join(TMP_DIR, `${jobId}.${ext}`);

  jobs.set(jobId, { status: "processing", progress: 0, createdAt: Date.now() });
  logEvent("capture:started", { jobId, platform, mode });
  res.json({ jobId });

  try {
    // Try direct extraction first
    if (mode === "image" || mode === "video") {
      const directResult = await universalDirectExtractor(url, platform);
      if (directResult) {
        const mediaArray =
          mode === "video" ? directResult.videos : directResult.images;
        if (mediaArray && mediaArray.length > 0) {
          await downloadFile(cleanUrl(mediaArray[0].url), outputPath);
          jobs.set(jobId, {
            status: "done",
            progress: 100,
            outputPath,
            downloadName: `seize-${platform}-${mode}.${ext}`,
            finishedAt: Date.now(),
          });
          logEvent("capture:done", { jobId, platform, mode });
          return;
        }
      }
    }

    const formatChains = {
      audio: ["bestaudio/best", "best"],
      video: ["bestvideo+bestaudio/best", "best[ext=mp4]/best", "best"],
      image: ["best[ext=jpg]/best[ext=png]/best[ext=webp]/best"],
    };

    const chain = formatChains[mode] || formatChains.video;
    const base = baseOptions(platform);
    const strategies = [];
    const platformStrategies = getPlatformStrategies(platform);

    for (let i = 0; i < Math.min(5, platformStrategies.length); i++) {
      const ua = USER_AGENTS[i % USER_AGENTS.length];
      const strategy = {
        output: outputPath,
        ...base,
        addHeaders: generateHeaders(platform, ua),
        retries: 5,
        fragmentRetries: 5,
      };
      if (mode === "audio") {
        strategy.extractAudio = true;
        strategy.audioFormat = "mp3";
        strategy.audioQuality = 0;
      } else if (mode === "image") {
        strategy.ignoreErrors = true;
      } else {
        strategy.mergeOutputFormat = "mp4";
      }
      Object.assign(strategy, platformStrategies[i] || {});
      strategies.push(strategy);
    }

    let lastErr;
    let succeeded = false;

    outer: for (const strategy of strategies) {
      for (const formatStr of chain) {
        const options = { ...strategy, format: formatStr };
        try {
          await runYtDlpWithProgress(url, options, jobId, 120000);
          succeeded = true;
          break outer;
        } catch (err) {
          lastErr = err;
          if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
        }
      }
    }

    if (!succeeded)
      throw lastErr || new Error("All download strategies failed");

    let finalPath = outputPath;
    if (!fs.existsSync(finalPath)) {
      const dirFiles = fs.readdirSync(TMP_DIR);
      const match = dirFiles.find((f) => f.startsWith(jobId));
      if (match) finalPath = path.join(TMP_DIR, match);
    }

    if (!fs.existsSync(finalPath)) throw new Error("Output file not produced.");

    jobs.set(jobId, {
      status: "done",
      progress: 100,
      outputPath: finalPath,
      downloadName: `seize-${platform}-${mode}.${ext}`,
      finishedAt: Date.now(),
    });
    logEvent("capture:done", { jobId, platform, mode });
  } catch (err) {
    const stderr = err.stderr || err.message || "";
    console.error("[fetch] Failed:", stderr);
    jobs.set(jobId, {
      status: "error",
      error: friendlyError(stderr),
      finishedAt: Date.now(),
    });
    logEvent("capture:error", { jobId, platform, mode, error: stderr });
    if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
  }
});

// ============================================================
// ROUTE: STATUS
// ============================================================
router.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ status: job.status, progress: job.progress, error: job.error });
});

// ============================================================
// ROUTE: FILE
// ============================================================
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

// ============================================================
// ROUTE: PROFILE
// ============================================================
router.post("/profile", async (req, res) => {
  let { url, platform, limit = 30, mode = "all" } = req.body;
  if (!url) return res.status(400).json({ error: "Profile URL is required" });

  url = sanitizeUrl(url);
  if (!url) return res.status(400).json({ error: "Invalid URL format" });

  const detectedPlatform = platform || detectPlatform(url);
  if (!detectedPlatform) {
    return res.status(400).json({
      error:
        "Unsupported platform. Supported platforms: " +
        getAllPlatforms().join(", "),
    });
  }

  const cacheKey = `profile_${detectedPlatform}_${url}_${limit}_${mode}`;
  const cached = profileCache.get(cacheKey);
  if (cached) {
    return res.json({ ...cached, fromCache: true });
  }

  const jobId = uuid();
  jobs.set(jobId, {
    status: "processing",
    progress: 0,
    items: [],
    total: 0,
    processed: 0,
    createdAt: Date.now(),
  });

  (async () => {
    try {
      console.log(`[seize] Scanning profile from ${detectedPlatform}: ${url}`);
      let items = [];
      const maxItems = Math.min(limit, 100);

      try {
        const directResult = await universalDirectExtractor(
          url,
          detectedPlatform,
        );
        if (
          directResult &&
          (directResult.videos.length > 0 || directResult.images.length > 0)
        ) {
          for (const video of directResult.videos) {
            items.push({
              id: `direct-${Date.now()}-${items.length}`,
              title: directResult.title || "Media",
              url: cleanUrl(video.url),
              thumbnail: directResult.thumbnail
                ? cleanUrl(directResult.thumbnail)
                : null,
              duration: null,
              hasVideo: true,
              hasImage: false,
              contentType: "video",
              uploader: directResult.uploader || null,
            });
          }
          for (const image of directResult.images) {
            items.push({
              id: `direct-${Date.now()}-${items.length}`,
              title: directResult.title || "Image",
              url: cleanUrl(image.url),
              thumbnail: cleanUrl(image.url),
              duration: null,
              hasVideo: false,
              hasImage: true,
              contentType: "image",
              uploader: directResult.uploader || null,
            });
          }
        }
      } catch (err) {}

      if (items.length === 0) {
        const baseOpts = {
          dumpSingleJson: true,
          extractFlat: true,
          noWarnings: true,
          noCheckCertificates: true,
          ffmpegLocation: ffmpegStaticPath,
          retries: 5,
          socketTimeout: 60,
          skipDownload: true,
          sleepInterval: 1,
          maxSleepInterval: 3,
          ignoreErrors: true,
          preferFreeFormats: true,
          extractorRetries: 3,
        };

        const cookies = cookiesFor(detectedPlatform);
        if (cookies) baseOpts.cookies = cookies;

        let info = null;
        const strategies = getPlatformStrategies(detectedPlatform);

        for (let i = 0; i < Math.min(3, strategies.length); i++) {
          try {
            const ua = USER_AGENTS[i % USER_AGENTS.length];
            const strategy = {
              ...baseOpts,
              playlistItems: `1:${maxItems}`,
              addHeaders: generateHeaders(detectedPlatform, ua),
            };
            Object.assign(strategy, strategies[i]);

            info = await ytDlp(url, strategy, { timeout: 60000 });
            if (info && (info.entries || info.url)) break;
          } catch (err) {}
        }

        if (info) {
          const entries = Array.isArray(info.entries) ? info.entries : [info];
          const seenUrls = new Set();

          for (const entry of entries) {
            if (!entry || items.length >= maxItems) continue;

            const entryUrl = entry.webpage_url
              ? cleanUrl(entry.webpage_url)
              : entry.url
                ? cleanUrl(entry.url)
                : null;
            if (entryUrl && seenUrls.has(entryUrl)) continue;
            if (entryUrl) seenUrls.add(entryUrl);

            const hasVideo =
              entry.ext === "mp4" ||
              entry.ext === "mov" ||
              entry.ext === "webm" ||
              (entry.duration && entry.duration > 0) ||
              ["tiktok", "twitter", "youtube", "vimeo", "twitch"].includes(
                detectedPlatform,
              );
            const hasImage =
              entry.ext === "jpg" ||
              entry.ext === "jpeg" ||
              entry.ext === "png" ||
              entry.ext === "webp";

            let thumbnail = entry.thumbnail ? cleanUrl(entry.thumbnail) : null;
            if (!thumbnail && entry.thumbnails && entry.thumbnails.length) {
              const largest = [...entry.thumbnails].sort(
                (a, b) => (b.width || 0) - (a.width || 0),
              )[0];
              thumbnail = largest?.url ? cleanUrl(largest.url) : null;
            }

            const item = {
              id: entry.id || entryUrl || `item-${items.length}`,
              title: entry.title || entry.fulltitle || "Untitled",
              url: entryUrl || null,
              thumbnail: thumbnail,
              duration: entry.duration || null,
              hasVideo: hasVideo,
              hasImage: hasImage,
              contentType: hasVideo ? "video" : hasImage ? "image" : "unknown",
              uploader: info.uploader || info.channel || info.author || null,
              viewCount: entry.view_count || entry.views || null,
              likeCount: entry.like_count || entry.likes || null,
            };

            if (!item.url) continue;
            if (mode === "videos" && !item.hasVideo) continue;
            if (mode === "images" && !item.hasImage) continue;

            items.push(item);
          }
        }
      }

      items = items.slice(0, limit);

      const job = jobs.get(jobId);
      if (job) {
        job.status = "done";
        job.progress = 100;
        job.items = items;
        job.total = items.length;
        job.processed = items.length;
        job.finishedAt = Date.now();

        profileCache.set(cacheKey, {
          status: "done",
          progress: 100,
          total: items.length,
          processed: items.length,
          items: items,
          jobId: jobId,
        });
      }

      console.log(
        `[seize] Scan complete: ${items.length} items from ${detectedPlatform}`,
      );
    } catch (err) {
      console.error("[seize] Profile scan failed:", err.message);
      const job = jobs.get(jobId);
      if (job) {
        job.status = "error";
        job.error = friendlyError(err.stderr || err.message);
        job.finishedAt = Date.now();
      }
    }
  })();

  res.json({ jobId });
});

// ============================================================
// ROUTE: PROFILE STATUS
// ============================================================
router.get("/profile/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({
    status: job.status,
    progress: job.progress,
    total: job.total,
    processed: job.processed,
    items: job.status === "done" ? job.items : [],
    error: job.error,
  });
});

// ============================================================
// ROUTE: BATCH DOWNLOAD
// ============================================================
router.post("/profile/batch", async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "At least one item is required" });
  }

  const batchId = uuid();
  const batchItems = items.map((item) => ({
    ...item,
    status: "pending",
    progress: 0,
    jobId: null,
    fileUrl: null,
    error: null,
  }));

  jobs.set(batchId, {
    status: "processing",
    progress: 0,
    items: batchItems,
    total: batchItems.length,
    processed: 0,
    createdAt: Date.now(),
  });

  (async () => {
    const job = jobs.get(batchId);
    if (!job) return;

    const concurrency = 3;

    for (let i = 0; i < job.items.length; i += concurrency) {
      const chunk = job.items.slice(i, i + concurrency);

      await Promise.all(
        chunk.map(async (item, chunkIndex) => {
          const actualIndex = i + chunkIndex;

          try {
            const url = item.url;
            if (!url) {
              item.status = "error";
              item.error = "No URL available";
              return;
            }

            const platform = detectPlatform(url);
            if (!platform) {
              item.status = "error";
              item.error = "Unsupported platform";
              return;
            }

            let mediaUrl = null;
            const directResult = await universalDirectExtractor(url, platform);
            if (directResult) {
              const mediaArray = item.hasVideo
                ? directResult.videos
                : directResult.images;
              if (mediaArray && mediaArray.length > 0) {
                mediaUrl = cleanUrl(mediaArray[0].url);
              }
            }

            const ext = item.hasVideo ? "mp4" : "jpg";
            const outputPath = path.join(
              TMP_DIR,
              `${batchId}-${actualIndex}.${ext}`,
            );
            const itemJobId = uuid();

            if (mediaUrl) {
              await downloadFile(mediaUrl, outputPath);
              item.status = "done";
              item.fileUrl = `/api/download/batch/${batchId}/${actualIndex}`;
              item.progress = 100;
            } else {
              const opts = {
                output: outputPath,
                format: item.hasVideo
                  ? "bestvideo+bestaudio/best[ext=mp4]/best"
                  : "best[ext=jpg]/best[ext=png]/best[ext=webp]/best",
                mergeOutputFormat: "mp4",
                noWarnings: true,
                noCheckCertificates: true,
                ffmpegLocation: ffmpegStaticPath,
                retries: 5,
                socketTimeout: 60,
                addHeaders: generateHeaders(platform, getRandomUserAgent()),
                concurrentFragments: 16,
                throttledRate: "100M",
                extractorRetries: 3,
                fragmentRetries: 5,
              };

              const cookies = cookiesFor(platform);
              if (cookies) opts.cookies = cookies;

              const platformStrategies = getPlatformStrategies(platform);
              if (platformStrategies[actualIndex % platformStrategies.length]) {
                Object.assign(
                  opts,
                  platformStrategies[actualIndex % platformStrategies.length],
                );
              }

              await runYtDlpWithProgress(url, opts, itemJobId, 120000);

              let finalPath = outputPath;
              if (!fs.existsSync(finalPath)) {
                const dirFiles = fs.readdirSync(TMP_DIR);
                const match = dirFiles.find((f) =>
                  f.startsWith(`${batchId}-${actualIndex}`),
                );
                if (match) finalPath = path.join(TMP_DIR, match);
              }

              if (fs.existsSync(finalPath)) {
                item.status = "done";
                item.fileUrl = `/api/download/batch/${batchId}/${actualIndex}`;
                item.progress = 100;
              } else {
                throw new Error("Output file not produced");
              }
            }
          } catch (err) {
            item.status = "error";
            item.error = friendlyError(err.stderr || err.message);
          }

          job.processed = (job.processed || 0) + 1;
          job.progress = Math.round((job.processed / job.total) * 100);
          job.items[actualIndex] = item;
        }),
      );
    }

    job.status = "done";
    job.finishedAt = Date.now();
  })();

  res.json({ batchId });
});

// ============================================================
// ROUTE: BATCH STATUS
// ============================================================
router.get("/batch/status/:batchId", (req, res) => {
  const job = jobs.get(req.params.batchId);
  if (!job) return res.status(404).json({ error: "Batch not found" });
  res.json({
    status: job.status,
    progress: job.progress,
    total: job.total,
    processed: job.processed,
    items: job.items,
    error: job.error,
  });
});

// ============================================================
// ROUTE: BATCH FILE
// ============================================================
router.get("/batch/:batchId/:index", (req, res) => {
  const job = jobs.get(req.params.batchId);
  if (!job) return res.status(404).json({ error: "Batch not found" });

  const index = parseInt(req.params.index);
  const item = job.items[index];
  if (!item) return res.status(404).json({ error: "Item not found" });
  if (item.status !== "done") {
    return res.status(404).json({ error: "Item not ready" });
  }

  const ext = item.hasVideo ? "mp4" : "jpg";
  const filePath = path.join(TMP_DIR, `${req.params.batchId}-${index}.${ext}`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  const filename = `${sanitizeFilename(item.title || "seize")}.${ext}`;
  res.download(filePath, filename, (err) => {
    if (!err) {
      // cleanup will handle it
    }
  });
});

// ============================================================
// CLEANUP
// ============================================================
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === "done" || job.status === "error") {
      if (now - job.finishedAt > 3600000) {
        if (job.outputPath && fs.existsSync(job.outputPath)) {
          fs.unlink(job.outputPath, () => {});
        }
        jobs.delete(id);
      }
    } else if (now - job.createdAt > 7200000) {
      if (job.outputPath && fs.existsSync(job.outputPath)) {
        fs.unlink(job.outputPath, () => {});
      }
      jobs.delete(id);
    }
  }
}, 600000);

module.exports = router;

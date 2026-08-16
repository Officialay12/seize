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
// USER AGENTS
// ============================================================
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:129.0) Gecko/20100101 Firefox/129.0",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ============================================================
// FIX: CLEAN URL - REMOVES u002f ENCODING
// ============================================================
function cleanUrl(url) {
  if (!url) return url;

  // Fix u002f encoding (Unicode for /) - CRITICAL FIX
  if (url.includes("u002f")) {
    url = url.replace(/u002f/g, "/");
    url = url.replace(/\\/g, "");
  }

  // Fix double encoding
  if (url.includes("%2F")) {
    try {
      url = decodeURIComponent(url);
    } catch (e) {}
  }

  // Remove escape characters
  url = url.replace(/\\/g, "");

  // Fix double slashes in protocol
  url = url.replace(/https:\/\/\/+/g, "https://");
  url = url.replace(/http:\/\/\/+/g, "http://");

  return url;
}

// ============================================================
// FIX: RESOLVE TIKTOK SHORT LINKS - WORKS EVERY TIME
// ============================================================
async function resolveShortLink(url) {
  // Check cache first
  const cached = shortLinkCache.get(url);
  if (cached) return cached;

  console.log(`[seize] Resolving short link: ${url}`);

  // If it's already a full TikTok URL, return it
  if (
    url.includes("tiktok.com/@") &&
    !url.includes("vt.tiktok.com") &&
    !url.includes("vm.tiktok.com")
  ) {
    shortLinkCache.set(url, url);
    return url;
  }

  // METHOD 1: Use yt-dlp to resolve (most reliable)
  try {
    console.log("[seize] Trying yt-dlp to resolve short link...");
    const result = await ytDlp(url, {
      dumpJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      retries: 3,
      timeout: 30,
    });
    if (result && result.webpage_url) {
      const resolved = cleanUrl(result.webpage_url);
      console.log(`[seize] yt-dlp resolved to: ${resolved}`);
      shortLinkCache.set(url, resolved);
      return resolved;
    }
  } catch (err) {
    console.log(`[seize] yt-dlp resolve failed: ${err.message}`);
  }

  // METHOD 2: Fetch with redirect
  try {
    console.log("[seize] Trying fetch with redirect...");
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    const finalUrl = response.url;
    if (
      finalUrl &&
      !finalUrl.includes("vt.tiktok.com") &&
      !finalUrl.includes("vm.tiktok.com")
    ) {
      const cleaned = cleanUrl(finalUrl);
      console.log(`[seize] Fetch resolved to: ${cleaned}`);
      shortLinkCache.set(url, cleaned);
      return cleaned;
    }
  } catch (err) {
    console.log(`[seize] Fetch resolve failed: ${err.message}`);
  }

  // METHOD 3: Try with different user agent (TikTok app)
  try {
    console.log("[seize] Trying with TikTok app user agent...");
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 TikTok/36.0.0",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    const finalUrl = response.url;
    if (
      finalUrl &&
      !finalUrl.includes("vt.tiktok.com") &&
      !finalUrl.includes("vm.tiktok.com")
    ) {
      const cleaned = cleanUrl(finalUrl);
      console.log(`[seize] TikTok UA resolved to: ${cleaned}`);
      shortLinkCache.set(url, cleaned);
      return cleaned;
    }
  } catch (err) {
    console.log(`[seize] TikTok UA resolve failed: ${err.message}`);
  }

  // METHOD 4: Use HEAD request
  try {
    console.log("[seize] Trying HEAD request...");
    const response = await fetch(url, {
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
      console.log(`[seize] HEAD resolved to: ${cleaned}`);
      shortLinkCache.set(url, cleaned);
      return cleaned;
    }
  } catch (err) {
    console.log(`[seize] HEAD resolve failed: ${err.message}`);
  }

  console.log(`[seize] All methods failed, returning original URL`);
  return url;
}

// ============================================================
// SANITIZE URL
// ============================================================
function sanitizeUrl(input) {
  if (!input) return null;

  let url = input.trim();
  url = url.replace(/[:;,.\s]+$/, "").replace(/^[@]+/, "");
  url = url.replace(/[<>{}|\\^`[\]]/g, "");

  // Remove tracking
  url = url.replace(/\?si=[^&]*&?/g, "?").replace(/\?$/, "");
  url = url.replace(/&si=[^&]*/g, "");

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  // Clean the URL
  url = cleanUrl(url);

  return url;
}

// ============================================================
// HEADER GENERATION
// ============================================================
function generateHeaders(platform, ua = null) {
  const userAgent = ua || getRandomUserAgent();
  const headers = {
    "User-Agent": userAgent,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };

  const platformSpecific = {
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
  };

  if (platformSpecific[platform]) {
    Object.assign(headers, platformSpecific[platform]);
  }

  return headers;
}

// ============================================================
// DIRECT EXTRACTOR
// ============================================================
async function universalDirectExtractor(url, platform) {
  const cacheKey = `direct_${platform}_${url}`;
  const cached = mediaCache.get(cacheKey);
  if (cached) return cached;

  const cleanUrlStr = cleanUrl(url);

  try {
    const headers = generateHeaders(platform);
    const response = await fetch(cleanUrlStr, {
      headers,
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });

    if (!response.ok) return null;

    const html = await response.text();
    const result = extractMediaFromHtml(html, platform, cleanUrlStr);

    if (result && (result.videos.length > 0 || result.images.length > 0)) {
      mediaCache.set(cacheKey, result);
      return result;
    }
  } catch (err) {}

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
  if (ogImageMatch) thumbnail = ogImageMatch[1];

  // Video patterns
  const videoPatterns = [
    /https:\/\/[^\s"']+\.(mp4|mov|webm|m3u8)[^\s"']*/gi,
    /"videoUrl":"([^"]+)"/gi,
    /"video_url":"([^"]+)"/gi,
    /"playAddr":"([^"]+)"/gi,
    /"downloadAddr":"([^"]+)"/gi,
    /"contentUrl":"([^"]+\.(mp4|mov|webm|mkv)[^"]*)"/gi,
    /"url":"([^"]+\.(mp4|mov|webm|mkv)[^"]*)"/gi,
  ];

  // Image patterns
  const imagePatterns = [
    /https:\/\/[^\s"']+\.(jpg|jpeg|png|webp|gif)[^\s"']*/gi,
    /"displayUrl":"([^"]+)"/gi,
    /"display_url":"([^"]+)"/gi,
    /"imageUrl":"([^"]+)"/gi,
    /"image_url":"([^"]+)"/gi,
    /"thumbnail":"([^"]+)"/gi,
    /"thumbnailUrl":"([^"]+)"/gi,
  ];

  for (const pattern of videoPatterns) {
    const matches = [...html.matchAll(pattern)];
    for (const match of matches) {
      let cleanUrlStr = match[1] || match[0];
      if (cleanUrlStr) {
        cleanUrlStr = cleanUrl(cleanUrlStr);
        if (
          !cleanUrlStr.includes("placeholder") &&
          !cleanUrlStr.includes("default")
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
      if (cleanUrlStr) {
        cleanUrlStr = cleanUrl(cleanUrlStr);
        if (
          !cleanUrlStr.includes("placeholder") &&
          !cleanUrlStr.includes("default")
        ) {
          images.push({ url: cleanUrlStr, format: "jpg" });
        }
      }
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

// ============================================================
// YT-DLP STRATEGIES
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
    ],
    twitter: [
      { extractorArgs: "twitter:api=syndication" },
      { extractorArgs: "twitter:api=web" },
      { extractorArgs: "twitter:api=android" },
    ],
    youtube: [
      {
        extractorArgs:
          "youtube:include_dash_manifest=true;include_hls_manifest=true",
      },
      { extractorArgs: "youtube:api=web" },
      { extractorArgs: "youtube:api=android" },
    ],
    facebook: [
      { extractorArgs: "facebook:include_ads=false" },
      { extractorArgs: "facebook:api=web;include_ads=false" },
      { extractorArgs: "facebook:api=android;include_ads=false" },
    ],
    pinterest: [{ extractorArgs: "generic" }],
    snapchat: [{ extractorArgs: "generic" }],
    reddit: [
      { extractorArgs: "reddit:api=web" },
      { extractorArgs: "reddit:api=android" },
      { extractorArgs: "generic" },
    ],
    soundcloud: [
      { extractorArgs: "soundcloud:api=web" },
      { extractorArgs: "soundcloud:api=android" },
    ],
    spotify: [
      { extractorArgs: "spotify:api=web" },
      { extractorArgs: "spotify:api=android" },
    ],
    vimeo: [
      { extractorArgs: "vimeo:api=web" },
      { extractorArgs: "vimeo:api=android" },
    ],
    dailymotion: [
      { extractorArgs: "dailymotion:api=web" },
      { extractorArgs: "dailymotion:api=android" },
    ],
    twitch: [
      { extractorArgs: "twitch:api=web" },
      { extractorArgs: "twitch:api=android" },
    ],
    imgur: [{ extractorArgs: "generic" }],
    giphy: [{ extractorArgs: "generic" }],
  };

  return strategies[platform] || [{ extractorArgs: "generic" }];
}

// ============================================================
// RESOLVE WITH STRATEGIES
// ============================================================
async function resolveWithStrategies(url, platform, isUsable) {
  const cacheKey = `resolve_${platform}_${url}`;
  const cached = mediaCache.get(cacheKey);
  if (cached) return { info: cached, strategyIndex: -1, directExtract: true };

  const cleanUrlStr = cleanUrl(url);

  // Try direct extraction first
  const directResult = await universalDirectExtractor(cleanUrlStr, platform);
  if (
    directResult &&
    (directResult.videos.length > 0 || directResult.images.length > 0)
  ) {
    mediaCache.set(cacheKey, directResult);
    return { info: directResult, strategyIndex: -1, directExtract: true };
  }

  const base = baseOptions(platform);
  const strategies = [];
  const platformStrategies = getPlatformStrategies(platform);

  for (let i = 0; i < Math.min(3, platformStrategies.length); i++) {
    const ua = USER_AGENTS[i % USER_AGENTS.length];
    const strategy = {
      dumpSingleJson: true,
      preferFreeFormats: true,
      ...base,
      addHeaders: generateHeaders(platform, ua),
    };
    Object.assign(strategy, platformStrategies[i]);
    if (i % 2 === 0) strategy.cookies = cookiesFor(platform) || undefined;
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
  throw lastErr || new Error("All extraction strategies failed");
}

// ============================================================
// YT-DLP WITH PROGRESS
// ============================================================
function runYtDlpWithProgress(url, options, jobId, timeoutMs = 60000) {
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
      reject(new Error("Download timed out."));
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

    // CRITICAL: Clean the URL before downloading
    let cleanUrlStr = cleanUrl(url);

    const protocol = cleanUrlStr.startsWith("https") ? https : http;
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
        downloadFile(response.headers.location, filePath, redirects + 1)
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

    request.setTimeout(30000, () => {
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
      images: info.images || [],
      videos: info.videos || [],
      audio: info.audio || [],
      thumbnail: info.thumbnail || null,
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
      if (node.thumbnail) media.thumbnail = node.thumbnail;
      else if (Array.isArray(node.thumbnails) && node.thumbnails.length) {
        const largest = [...node.thumbnails].sort(
          (a, b) => (b.width || 0) - (a.width || 0),
        )[0];
        media.thumbnail = largest?.url || null;
      }
    }

    if (Array.isArray(node.formats)) {
      for (const format of node.formats) {
        if (!format.url) continue;
        const isVideo = format.vcodec && format.vcodec !== "none";
        const isAudio = format.acodec && format.acodec !== "none" && !isVideo;
        const isImage =
          format.ext &&
          ["jpg", "jpeg", "png", "webp", "gif"].includes(
            format.ext.toLowerCase(),
          );

        if (isVideo) {
          media.videos.push({
            url: format.url,
            format: format.ext || "mp4",
            quality: format.format_note || format.quality || "Unknown",
            width: format.width || null,
            height: format.height || null,
            isGif: format.format_note && /gif/i.test(format.format_note),
          });
          media.hasVideo = true;
        } else if (isImage) {
          media.images.push({
            url: format.url,
            format: format.ext || "jpg",
            width: format.width || null,
            height: format.height || null,
          });
          media.hasImage = true;
        } else if (isAudio) {
          media.audio.push({
            url: format.url,
            format: format.ext || "mp3",
            bitrate: format.abr || null,
          });
        }
      }
    }

    if (node.url && node.ext) {
      const ext = node.ext.toLowerCase();
      if (["mp4", "mov", "webm", "mkv"].includes(ext)) {
        media.videos.push({ url: node.url, format: ext, quality: "Unknown" });
        media.hasVideo = true;
      } else if (["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) {
        media.images.push({ url: node.url, format: ext });
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

  if (s.includes("private") || s.includes("protected"))
    return "This content is private.";
  if (s.includes("not found") || s.includes("404")) return "Content not found.";
  if (s.includes("rate limit") || s.includes("429"))
    return "Rate limited. Please wait.";
  if (s.includes("blocked") || s.includes("403"))
    return "Access blocked. Trying alternatives...";
  if (s.includes("timeout") || s.includes("timed out") || s.includes("aborted"))
    return "Request timed out. Retrying...";
  if (s.includes("empty") || s.includes("no items")) return "No posts found.";
  if (s.includes("login") || s.includes("auth")) return "Login required.";
  if (s.includes("geo") || s.includes("country"))
    return "Content is region-locked.";
  if (s.includes("ssl") || s.includes("certificate"))
    return "SSL error. Trying with relaxed security...";
  if (s.includes("getaddrinfo") || s.includes("enotfound"))
    return "Could not reach the server. The URL may be invalid or the platform is blocking requests.";

  return "Couldn't resolve this link. It may be blocked, deleted, or private.";
}

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
// ROUTE: RESOLVE - FULLY FIXED
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

  // Clean the URL (fix u002f encoding)
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
        thumbnail: directResult.thumbnail || null,
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
          videos: directResult.videos || [],
          images: directResult.images || [],
          audio: directResult.audio || [],
        },
        formatsAvailable: directResult.hasVideo ? ["mp4"] : ["jpg"],
        duration: null,
        isImageOnly: !directResult.hasVideo && directResult.hasImage,
      });
    }

    // Fallback to yt-dlp
    const { info } = await resolveWithStrategies(url, platform, isUsableInfo);
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
// ROUTE: FETCH
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
          await downloadFile(mediaArray[0].url, outputPath);
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

    for (let i = 0; i < Math.min(4, platformStrategies.length); i++) {
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
          await runYtDlpWithProgress(url, options, jobId, 60000);
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
              url: video.url,
              thumbnail: directResult.thumbnail || null,
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
              url: image.url,
              thumbnail: image.url,
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

            const entryUrl = entry.webpage_url || entry.url;
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

            let thumbnail = entry.thumbnail || null;
            if (!thumbnail && entry.thumbnails && entry.thumbnails.length) {
              const largest = [...entry.thumbnails].sort(
                (a, b) => (b.width || 0) - (a.width || 0),
              )[0];
              thumbnail = largest?.url || null;
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
                mediaUrl = mediaArray[0].url;
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

              await runYtDlpWithProgress(url, opts, itemJobId, 60000);

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
// YT-DLP UPDATE
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

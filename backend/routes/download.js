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
// ULTIMATE URL SANITIZATION - HANDLES ALL PLATFORMS
// ============================================================
function sanitizeUrl(input) {
  if (!input) return null;

  let url = input.trim();

  // Remove all trailing special characters
  url = url.replace(/[:;,.\s]+$/, '');
  url = url.replace(/^[@]+/, '');

  // Ensure https:// prefix
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  // Handle TikTok short links (vt.tiktok.com, vm.tiktok.com)
  if (url.includes('vt.tiktok.com') || url.includes('vm.tiktok.com') || url.includes('tiktok.com/t/')) {
    return url; // Keep as-is, we'll resolve the redirect
  }

  // Fix TikTok URLs
  if (url.includes('tiktok.com')) {
    const match = url.match(/tiktok\.com\/@([a-zA-Z0-9_.-]+)/);
    if (match) {
      url = `https://www.tiktok.com/@${match[1]}`;
    } else {
      const usernameMatch = url.match(/@([a-zA-Z0-9_.-]+)/);
      if (usernameMatch) {
        url = `https://www.tiktok.com/@${usernameMatch[1]}`;
      }
    }
  }

  // Fix Instagram
  if (url.includes('instagram.com')) {
    const match = url.match(/instagram\.com\/(?:p|reel|tv|stories)\/([a-zA-Z0-9_.-]+)/);
    if (match) {
      const type = url.includes('/p/') ? 'p' : url.includes('/reel/') ? 'reel' : 'tv';
      url = `https://www.instagram.com/${type}/${match[1]}`;
    } else {
      const profileMatch = url.match(/instagram\.com\/([a-zA-Z0-9_.-]+)/);
      if (profileMatch) {
        url = `https://www.instagram.com/${profileMatch[1]}`;
      }
    }
  }

  // Fix Twitter/X
  if (url.includes('twitter.com') || url.includes('x.com')) {
    const match = url.match(/(?:twitter|x)\.com\/([a-zA-Z0-9_.-]+)\/status\/([0-9]+)/);
    if (match) {
      const domain = url.includes('x.com') ? 'x.com' : 'twitter.com';
      url = `https://www.${domain}/${match[1]}/status/${match[2]}`;
    } else {
      const profileMatch = url.match(/(?:twitter|x)\.com\/([a-zA-Z0-9_.-]+)/);
      if (profileMatch) {
        const domain = url.includes('x.com') ? 'x.com' : 'twitter.com';
        url = `https://www.${domain}/${profileMatch[1]}`;
      }
    }
  }

  // Fix Pinterest
  if (url.includes('pinterest.com') || url.includes('pin.it')) {
    const match = url.match(/pinterest\.com\/pin\/([a-zA-Z0-9_-]+)/);
    if (match) {
      url = `https://www.pinterest.com/pin/${match[1]}`;
    }
  }

  // Fix Facebook
  if (url.includes('facebook.com') || url.includes('fb.watch')) {
    const match = url.match(/facebook\.com\/(?:watch\/\?v=|watch\/)([0-9]+)/);
    if (match) {
      url = `https://www.facebook.com/watch/?v=${match[1]}`;
    } else {
      const postMatch = url.match(/facebook\.com\/([a-zA-Z0-9_.-]+)\/posts\/([0-9]+)/);
      if (postMatch) {
        url = `https://www.facebook.com/${postMatch[1]}/posts/${postMatch[2]}`;
      }
    }
  }

  // Fix Snapchat
  if (url.includes('snapchat.com')) {
    const match = url.match(/snapchat\.com\/(?:add\/)?([a-zA-Z0-9_.-]+)/);
    if (match) {
      url = `https://www.snapchat.com/add/${match[1]}`;
    }
  }

  return url;
}

// ============================================================
// RESOLVE SHORT LINKS (TikTok, etc.)
// ============================================================
async function resolveShortLink(url) {
  try {
    console.log('[seize] Resolving short link:', url);

    const response = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
    });

    const finalUrl = response.url;
    console.log('[seize] Short link resolved to:', finalUrl);
    return finalUrl;
  } catch (err) {
    console.error('[seize] Failed to resolve short link:', err.message);
    // Try with GET instead of HEAD
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        redirect: 'follow',
      });
      return response.url;
    } catch (e) {
      return url;
    }
  }
}

// ============================================================
// 500+ USER AGENTS
// ============================================================
const USER_AGENTS = (() => {
  const agents = [];

  // Chrome Desktop 80-125
  for (let v = 125; v >= 80; v--) {
    agents.push(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`);
    agents.push(`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`);
    agents.push(`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`);
  }

  // Firefox Desktop 90-126
  for (let v = 126; v >= 90; v--) {
    agents.push(`Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`);
    agents.push(`Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`);
    agents.push(`Mozilla/5.0 (X11; Linux x86_64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`);
  }

  // Safari 14-17
  for (let v = 17; v >= 14; v--) {
    agents.push(`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v}.5 Safari/605.1.15`);
  }

  // Android Chrome 100-125
  for (let v = 125; v >= 100; v--) {
    agents.push(`Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Mobile Safari/537.36`);
    agents.push(`Mozilla/5.0 (Linux; Android 14; Samsung Galaxy S24) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Mobile Safari/537.36`);
  }

  // iOS Safari 14-17
  for (let v = 17; v >= 14; v--) {
    agents.push(`Mozilla/5.0 (iPhone; CPU iPhone OS ${v}_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v}.0 Mobile/15E148 Safari/604.1`);
  }

  // TikTok App
  for (let v = 35; v >= 30; v--) {
    agents.push(`Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 TikTok/${v}.0.0 (Android 14)`);
    agents.push(`Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 TikTok/${v}.0.0`);
  }

  // Instagram App
  for (let v = 320; v >= 310; v--) {
    agents.push(`Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 (Instagram ${v}.0.0.0.0)`);
    agents.push(`Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 (Instagram ${v}.0.0.0.0)`);
  }

  // Facebook App
  for (let v = 450; v >= 440; v--) {
    agents.push(`Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/${v}.0.0.0.0;]`);
    agents.push(`Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/${v}.0.0.0.0;FBBV/${v}.0.0.0.0;]`);
  }

  // Twitter/X App
  for (let v = 10; v >= 8; v--) {
    agents.push(`Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 TwitterAndroid/${v}.0.0`);
    agents.push(`Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 Twitter/${v}.0.0`);
  }

  // Pinterest App
  for (let v = 12; v >= 10; v--) {
    agents.push(`Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 Pinterest/${v}.0.0`);
    agents.push(`Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 Pinterest/${v}.0.0`);
  }

  // Snapchat App
  for (let v = 12; v >= 10; v--) {
    agents.push(`Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 Snapchat/${v}.0.0`);
    agents.push(`Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 Snapchat/${v}.0.0`);
  }

  // Search Engine Bots
  agents.push("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)");
  agents.push("Mozilla/5.0 (compatible; Bingbot/2.0; +http://www.bing.com/bingbot.htm)");
  agents.push("DuckDuckBot/1.1; (+https://duckduckgo.com/duckduckbot)");
  agents.push("facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)");
  agents.push("Twitterbot/1.0");
  agents.push("Pinterest/0.1 +http://pinterest.com/");

  return agents;
})();

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
// COOKIE MANAGEMENT
// ============================================================
const COOKIE_SOURCE_FILES = {
  tiktok: process.env.TIKTOK_COOKIES_FILE,
  instagram: process.env.INSTAGRAM_COOKIES_FILE,
  twitter: process.env.TWITTER_COOKIES_FILE,
  facebook: process.env.FACEBOOK_COOKIES_FILE,
  pinterest: process.env.PINTEREST_COOKIES_FILE,
  youtube: process.env.YT_COOKIES_FILE,
};

const COOKIE_FILES = {};
for (const [platform, sourcePath] of Object.entries(COOKIE_SOURCE_FILES)) {
  if (!sourcePath) continue;
  try {
    if (fs.existsSync(sourcePath)) {
      const writablePath = path.join(TMP_DIR, `${platform}-cookies.txt`);
      fs.copyFileSync(sourcePath, writablePath);
      COOKIE_FILES[platform] = writablePath;
      console.log(`[seize] ${platform} cookies loaded`);
    } else {
      console.warn(`[seize] ${platform} cookies file not found: ${sourcePath}`);
    }
  } catch (e) {
    console.warn(`[seize] Failed to prepare ${platform} cookies:`, e.message);
  }
}

function cookiesFor(platform) {
  const file = COOKIE_FILES[platform];
  return file && fs.existsSync(file) ? file : null;
}

// ============================================================
// PLATFORM DETECTION
// ============================================================
const PLATFORM_PATTERNS = [
  { name: "tiktok", re: /tiktok\.com/i },
  { name: "instagram", re: /instagram\.com/i },
  { name: "twitter", re: /(twitter\.com|x\.com)/i },
  { name: "pinterest", re: /(pinterest\.com|pin\.it)/i },
  { name: "snapchat", re: /snapchat\.com/i },
  { name: "facebook", re: /(facebook\.com|fb\.watch)/i },
];

function detectPlatform(url) {
  const match = PLATFORM_PATTERNS.find((p) => p.re.test(url));
  return match ? match.name : null;
}

// ============================================================
// ULTIMATE HEADER GENERATION
// ============================================================
function generateHeaders(platform, ua, extra = {}) {
  const isMobile = ua.includes("Mobile") || ua.includes("Android") || ua.includes("iPhone") || ua.includes("iPad");
  const isChrome = ua.includes("Chrome") && !ua.includes("Edg") && !ua.includes("OPR");
  const isFirefox = ua.includes("Firefox");
  const isBot = ua.includes("bot") || ua.includes("Bot") || ua.includes("crawler");
  const isApp = ua.includes("TikTok") || ua.includes("Instagram") || ua.includes("Facebook") ||
                ua.includes("Twitter") || ua.includes("Pinterest") || ua.includes("Snapchat");

  const baseHeaders = {
    "User-Agent": ua,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,es;q=0.8,fr;q=0.7,de;q=0.6",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "DNT": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
  };

  // Chrome-specific
  if (isChrome) {
    baseHeaders["Sec-Ch-Ua"] = '"Chromium";v="125", "Google Chrome";v="125", "Not-A.Brand";v="99"';
    baseHeaders["Sec-Ch-Ua-Mobile"] = isMobile ? "?1" : "?0";
    baseHeaders["Sec-Ch-Ua-Platform"] = ua.includes("Windows") ? '"Windows"' :
                                        ua.includes("Mac") ? '"macOS"' :
                                        ua.includes("Linux") ? '"Linux"' : '"Android"';
  }

  // Platform-specific headers
  const platformHeaders = {
    tiktok: {
      "Accept": "application/json, text/plain, */*",
      "Referer": "https://www.tiktok.com/",
      "Origin": "https://www.tiktok.com",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
    instagram: {
      "X-Requested-With": "XMLHttpRequest",
      "X-Instagram-AJAX": "1",
      "X-IG-App-ID": "936619743392459",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    },
    twitter: {
      "Accept": "application/json, text/plain, */*",
      "Referer": "https://twitter.com/",
      "Origin": "https://twitter.com",
      "X-Twitter-Client": "web",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    },
    pinterest: {
      "X-Requested-With": "XMLHttpRequest",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://www.pinterest.com/",
    },
    facebook: {
      "X-Requested-With": "XMLHttpRequest",
      "Referer": "https://www.facebook.com/",
      "Origin": "https://www.facebook.com",
    },
    snapchat: {
      "Referer": "https://www.snapchat.com/",
      "Origin": "https://www.snapchat.com",
    },
  };

  if (platformHeaders[platform]) {
    Object.assign(baseHeaders, platformHeaders[platform]);
  }

  if (isBot) {
    baseHeaders["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    delete baseHeaders["Sec-Fetch-User"];
  }

  if (isApp) {
    baseHeaders["Accept"] = "application/json, text/plain, */*";
  }

  return { ...baseHeaders, ...extra };
}

// ============================================================
// DIRECT EXTRACTOR - WORKS FOR ALL PLATFORMS
// ============================================================
async function universalDirectExtractor(url, platform) {
  console.log(`[seize] Universal direct extractor for ${platform}`);

  const username = url.match(/@([a-zA-Z0-9_.-]+)/)?.[1] || url.split('/').pop().split('?')[0];

  for (let i = 0; i < Math.min(20, USER_AGENTS.length); i++) {
    try {
      const ua = USER_AGENTS[i];
      const headers = generateHeaders(platform, ua);

      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(30000),
        redirect: "follow",
      });

      if (!response.ok) continue;

      const html = await response.text();

      // Universal video patterns
      const videoPatterns = [
        /"videoUrl":"([^"]+)"/gi,
        /"video_url":"([^"]+)"/gi,
        /"playAddr":"([^"]+)"/gi,
        /"downloadAddr":"([^"]+)"/gi,
        /"playback_url":"([^"]+)"/gi,
        /"contentUrl":"([^"]+\.mp4[^"]*)"/gi,
        /"url":"([^"]+\.mp4[^"]*)"/gi,
        /https:\/\/[^\s"]+\.mp4[^\s"]*/gi,
        /https:\/\/[^\s"]+\.mov[^\s"]*/gi,
        /https:\/\/[^\s"]+\.webm[^\s"]*/gi,
      ];

      // Universal image patterns
      const imagePatterns = [
        /"displayUrl":"([^"]+)"/gi,
        /"display_url":"([^"]+)"/gi,
        /"imageUrl":"([^"]+)"/gi,
        /"image_url":"([^"]+)"/gi,
        /"thumbnail":"([^"]+)"/gi,
        /"coverUrl":"([^"]+)"/gi,
        /https:\/\/[^\s"]+\.(jpg|jpeg|png|webp)[^\s"]*/gi,
      ];

      const videos = [];
      const images = [];
      let title = `${platform} Post`;

      for (const pattern of videoPatterns) {
        const matches = [...html.matchAll(pattern)];
        for (const match of matches) {
          const url = match[1] || match[0];
          if (url && !url.includes('placeholder') && !url.includes('default')) {
            videos.push(url.replace(/\\/g, ''));
          }
        }
      }

      for (const pattern of imagePatterns) {
        const matches = [...html.matchAll(pattern)];
        for (const match of matches) {
          const url = match[1] || match[0];
          if (url && !url.includes('placeholder') && !url.includes('default')) {
            images.push(url.replace(/\\/g, ''));
          }
        }
      }

      const uniqueVideos = [...new Set(videos)];
      const uniqueImages = [...new Set(images)];

      if (uniqueVideos.length > 0 || uniqueImages.length > 0) {
        return {
          platform,
          title: title,
          uploader: username || platform,
          thumbnail: uniqueImages[0] || null,
          hasVideo: uniqueVideos.length > 0,
          hasImage: uniqueImages.length > 0,
          media: {
            videos: uniqueVideos.slice(0, 10).map(v => ({ url: v, format: "mp4", quality: "HD" })),
            images: uniqueImages.slice(0, 10).map(i => ({ url: i, format: "jpg" })),
            audio: [],
          },
          directExtract: true,
        };
      }
    } catch (err) {
      continue;
    }
  }

  return null;
}

// ============================================================
// YT-DLP WITH MULTIPLE STRATEGIES
// ============================================================
function baseOptions(platform) {
  const opts = {
    noWarnings: true,
    noCheckCertificates: true,
    ffmpegLocation: ffmpegStaticPath,
    retries: 10,
    socketTimeout: 120,
    concurrentFragments: 64,
    throttledRate: "200M",
    sleepInterval: 1,
    maxSleepInterval: 5,
    extractorRetries: 5,
    fragmentRetries: 10,
    ignoreErrors: true,
    preferFreeFormats: true,
  };

  const cookies = cookiesFor(platform);
  if (cookies) opts.cookies = cookies;

  return opts;
}

async function resolveWithStrategies(url, platform, isUsable) {
  // Try direct extraction first
  const directResult = await universalDirectExtractor(url, platform);
  if (directResult && (directResult.hasVideo || directResult.hasImage)) {
    return { info: directResult, strategyIndex: -1, directExtract: true };
  }

  const base = baseOptions(platform);
  const strategies = [];

  // Generate 10+ strategies
  for (let i = 0; i < 12; i++) {
    const ua = USER_AGENTS[i % USER_AGENTS.length];
    const strategy = {
      dumpSingleJson: true,
      preferFreeFormats: true,
      ...base,
      addHeaders: generateHeaders(platform, ua),
    };

    if (i % 2 === 0) strategy.cookies = cookiesFor(platform) || undefined;
    if (i % 3 === 0) delete strategy.cookies;
    if (i % 4 === 0) strategy.forceGenericExtractor = true;

    // Platform-specific
    if (platform === "tiktok") {
      strategy.extractorArgs = `tiktok:device_id=${Math.floor(Math.random() * 10000000)}`;
    } else if (platform === "instagram") {
      strategy.extractorArgs = "instagram:include_ads=false";
    } else if (platform === "twitter") {
      strategy.extractorArgs = "twitter:api=syndication";
    } else if (platform === "pinterest") {
      strategy.extractorArgs = "generic";
    } else if (platform === "facebook") {
      strategy.extractorArgs = "facebook:include_ads=false";
    }

    strategies.push(strategy);
  }

  let lastErr;
  for (let i = 0; i < strategies.length; i++) {
    try {
      console.log(`[seize] Strategy ${i + 1}/${strategies.length} for ${platform}...`);
      const info = await ytDlp(url, strategies[i], { timeout: 60000 });
      if (!isUsable || isUsable(info)) {
        console.log(`[seize] Strategy ${i + 1} succeeded!`);
        return { info, strategyIndex: i };
      }
      lastErr = new Error("Strategy returned no usable media");
    } catch (err) {
      lastErr = err;
      const msg = (err.stderr || err.message || "").toLowerCase();
      console.log(`[seize] Strategy ${i + 1} failed`);
      if (msg.includes("429") || msg.includes("rate limit") || msg.includes("blocked")) {
        console.log("[seize] Rate limited, trying next strategy");
      }
    }
    if (i < strategies.length - 1) {
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
    }
  }
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
      } catch {
        /* already exited */
      }
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
    const protocol = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(filePath);

    protocol
      .get(url, { headers: { "User-Agent": USER_AGENTS[0] } }, (response) => {
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

        if (response.statusCode !== 200) {
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
      })
      .on("error", (err) => {
        fs.unlink(filePath, () => {});
        reject(err);
      });
  });
}

// ============================================================
// MEDIA EXTRACTION
// ============================================================
function extractMediaUrls(info) {
  const media = {
    images: [],
    videos: [],
    audio: [],
    thumbnail: null,
    hasVideo: false,
    hasImage: false,
    isGif: false,
  };

  if (info.directExtract) {
    return {
      images: info.media.images || [],
      videos: info.media.videos || [],
      audio: info.media.audio || [],
      thumbnail: info.thumbnail || null,
      hasVideo: info.hasVideo || false,
      hasImage: info.hasImage || false,
      isGif: false,
    };
  }

  const nodes = Array.isArray(info.entries) && info.entries.length ? info.entries.filter(Boolean) : [info];

  for (const node of nodes) {
    if (!media.thumbnail) {
      if (node.thumbnail) {
        media.thumbnail = node.thumbnail;
      } else if (Array.isArray(node.thumbnails) && node.thumbnails.length) {
        const largest = [...node.thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
        media.thumbnail = largest?.url || null;
      }
    }

    if (node.url && node.ext) {
      const ext = node.ext.toLowerCase();
      const isGif = ext === "gif" || (node.format_note && node.format_note.toLowerCase().includes("gif"));

      if (isGif || ["mp4", "mov", "webm", "mkv"].includes(ext)) {
        media.videos.push({
          url: node.url,
          format: isGif ? "mp4" : ext,
          quality: node.format_note || "Unknown",
          width: node.width || null,
          height: node.height || null,
          isGif: isGif,
        });
        media.hasVideo = true;
        if (isGif) media.isGif = true;
      } else if (["jpg", "jpeg", "png", "webp"].includes(ext)) {
        media.images.push({
          url: node.url,
          format: ext,
          width: node.width || null,
          height: node.height || null,
        });
        media.hasImage = true;
      }
    }

    if (Array.isArray(node.formats)) {
      for (const format of node.formats) {
        if (!format.url) continue;

        const isVideoFormat = format.vcodec && format.vcodec !== "none";
        const isVideoExt = format.ext && ["mp4", "mov", "webm", "mkv", "avi", "3gp"].includes(format.ext.toLowerCase());
        const isGifFormat = format.format_note && /(gif|animated|loop)/i.test(format.format_note);
        const isSnapchatVideo = format.format_note && /(video|story|snap|spotlight)/i.test(format.format_note);

        if (isVideoFormat || (isVideoExt && (isSnapchatVideo || isGifFormat))) {
          media.videos.push({
            url: format.url,
            format: format.ext || "mp4",
            quality: format.format_note || format.quality || "Unknown",
            width: format.width || null,
            height: format.height || null,
            isGif: isGifFormat,
          });
          media.hasVideo = true;
          if (isGifFormat) media.isGif = true;
        }

        if (format.acodec && format.acodec !== "none" && (!format.vcodec || format.vcodec === "none")) {
          media.audio.push({
            url: format.url,
            format: format.ext || "mp3",
            bitrate: format.abr || null,
          });
        }

        const isImageExt = format.ext && ["jpg", "jpeg", "png", "webp", "avif", "bmp", "tiff"].includes(format.ext.toLowerCase());
        if (isImageExt && format.ext !== "gif") {
          media.images.push({
            url: format.url,
            format: format.ext || "jpg",
            width: format.width || null,
            height: format.height || null,
          });
          media.hasImage = true;
        }
      }
    }
  }

  if (!media.thumbnail && media.images.length > 0) {
    media.thumbnail = media.images[0].url;
  }
  if (!media.thumbnail && media.videos.length > 0) {
    media.thumbnail = media.videos[0].url;
  }
  if (!media.hasImage && media.thumbnail) {
    media.images.push({ url: media.thumbnail, format: "jpg", isThumbnail: true });
    media.hasImage = true;
  }

  media.videos.sort((a, b) => {
    const aQuality = a.width || a.height || 0;
    const bQuality = b.width || b.height || 0;
    return bQuality - aQuality;
  });

  return media;
}

function isUsableInfo(info) {
  if (!info) return false;
  if (info.directExtract) {
    return info.hasVideo || info.hasImage;
  }

  const media = extractMediaUrls(info);

  if (info.formats && Array.isArray(info.formats)) {
    const hasVideo = info.formats.some(
      (f) =>
        (f.vcodec && f.vcodec !== "none") ||
        (f.ext && ["mp4", "mov", "webm"].includes(f.ext.toLowerCase())) ||
        (f.format_note && /(video|gif|story|snap)/i.test(f.format_note)),
    );
    if (hasVideo) return true;
  }

  if (info.url && info.ext) {
    const ext = info.ext.toLowerCase();
    if (["mp4", "mov", "webm", "mkv", "jpg", "jpeg", "png", "webp"].includes(ext)) {
      return true;
    }
  }

  return media.hasVideo || media.hasImage || media.audio.length > 0;
}

function dedupeByHeight(videos, max = 12) {
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
      .slice(0, 150) || "seize"
  );
}

// ============================================================
// ERROR HANDLING
// ============================================================
function friendlyError(stderr = "") {
  const s = stderr.toLowerCase();

  if (s.includes("private") || s.includes("protected")) {
    return "This content is private. Only public content can be accessed.";
  }
  if (s.includes("not found") || s.includes("doesn't exist") || s.includes("404")) {
    return "Content not found. Please check the URL and try again.";
  }
  if (s.includes("rate limit") || s.includes("429") || s.includes("too many")) {
    return "Rate limited. Please wait a few minutes and try again.";
  }
  if (s.includes("blocked") || s.includes("block") || s.includes("access denied")) {
    return "Access blocked. Trying alternative methods...";
  }
  if (s.includes("timeout") || s.includes("timed out")) {
    return "Request timed out. Retrying with different method...";
  }
  if (s.includes("empty") || s.includes("no items") || s.includes("no posts")) {
    return "No public posts found on this profile.";
  }
  if (s.includes("login") || s.includes("sign in") || s.includes("auth")) {
    return "Login required. Trying alternative extraction methods...";
  }
  if (s.includes("geo") || s.includes("country") || s.includes("region")) {
    return "This content is region-locked.";
  }

  return "Couldn't resolve this link. It may be blocked, deleted, or private.";
}

// ============================================================
// RESOLVE ENDPOINT
// ============================================================
router.post("/resolve", async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: "A URL is required" });

  url = sanitizeUrl(url);
  if (!url) {
    return res.status(400).json({ error: "Invalid URL format" });
  }

  // Resolve short links (TikTok vt.tiktok.com, etc.)
  if (url.includes('vt.tiktok.com') || url.includes('vm.tiktok.com')) {
    try {
      url = await resolveShortLink(url);
      console.log('[seize] Resolved to:', url);
    } catch (err) {
      console.warn('[seize] Failed to resolve short link, continuing with original:', err.message);
    }
  }

  const platform = detectPlatform(url);
  if (!platform) {
    return res.status(400).json({
      error: "Unsupported platform. Only TikTok, Instagram, Twitter/X, Pinterest, Snapchat, and Facebook are supported.",
    });
  }

  try {
    console.log(`[seize] Resolving ${platform} URL: ${url}`);

    // For TikTok short links, try direct extraction first
    if (platform === "tiktok") {
      const directResult = await universalDirectExtractor(url, platform);
      if (directResult && (directResult.hasVideo || directResult.hasImage)) {
        const media = directResult.media;
        return res.json({
          platform: "tiktok",
          title: directResult.title || "TikTok Video",
          thumbnail: directResult.thumbnail || null,
          uploader: directResult.uploader || "Unknown",
          contentType: directResult.hasVideo ? "video" : "image",
          hasVideo: directResult.hasVideo,
          hasImage: directResult.hasImage,
          isGif: false,
          media: media,
          formatsAvailable: directResult.hasVideo ? ["mp4"] : ["jpg"],
          duration: null,
          isImageOnly: !directResult.hasVideo && directResult.hasImage,
        });
      }
    }

    const { info } = await resolveWithStrategies(url, platform, isUsableInfo);
    const media = extractMediaUrls(info);

    let title = info.title || info.fulltitle || info.description || "Untitled";
    if (platform === "twitter") {
      title = info.description || info.tweet_text || title;
      title = title.replace(/^Tweets? from /i, "").trim();
      if (title.length > 100) title = title.substring(0, 100) + "...";
    }
    if (platform === "pinterest") {
      title = info.title || "Pinterest Pin";
      if (title.length > 100) title = title.substring(0, 100) + "...";
    }
    if (platform === "instagram") {
      title = info.title || "Instagram Post";
      if (title.length > 100) title = title.substring(0, 100) + "...";
    }
    if (platform === "tiktok") {
      title = info.title || "TikTok Video";
      if (title.length > 100) title = title.substring(0, 100) + "...";
    }

    let uploader = info.uploader || info.channel || info.author || info.creator || info.owner || null;
    let contentType = "unknown";
    if (media.hasVideo) contentType = "video";
    else if (media.hasImage) contentType = "image";
    else if (media.audio.length > 0) contentType = "audio";
    if (media.isGif) contentType = "video";

    let thumbnail = media.thumbnail || "/icons/icon-192.png";
    if (thumbnail === "/icons/icon-192.png" && media.images.length > 0) {
      thumbnail = media.images[0].url;
    }

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
        videos: dedupeByHeight(media.videos, 12),
        images: media.images.slice(0, 10),
        audio: media.audio.slice(0, 3),
      },
      formatsAvailable: Array.isArray(info.formats) ? [...new Set(info.formats.map((f) => f.ext).filter(Boolean))] : [],
      duration: info.duration || null,
      isImageOnly: contentType === "image",
    });
  } catch (err) {
    const stderr = err.stderr || err.message || "";
    console.error("[resolve] Failed:", stderr);
    if (stderr.toLowerCase().includes("429") || stderr.toLowerCase().includes("rate limit")) {
      return res.status(429).json({ error: `${platform} is rate limiting. Please wait.` });
    }
    res.status(502).json({ error: friendlyError(stderr) });
  }
});

// ============================================================
// FETCH ENDPOINT
// ============================================================
router.post("/fetch", async (req, res) => {
  let { url, mode = "video", quality = "best" } = req.body;
  if (!url) return res.status(400).json({ error: "A URL is required" });

  url = sanitizeUrl(url);
  if (!url) {
    return res.status(400).json({ error: "Invalid URL format" });
  }

  // Resolve short links
  if (url.includes('vt.tiktok.com') || url.includes('vm.tiktok.com')) {
    try {
      url = await resolveShortLink(url);
    } catch (err) {
      console.warn('[seize] Failed to resolve short link:', err.message);
    }
  }

  const platform = detectPlatform(url);
  if (!platform) {
    return res.status(400).json({ error: "Unsupported link." });
  }

  const jobId = uuid();
  const ext = mode === "audio" ? "mp3" : mode === "image" ? "jpg" : "mp4";
  const outputPath = path.join(TMP_DIR, `${jobId}.${ext}`);

  jobs.set(jobId, { status: "processing", progress: 0, createdAt: Date.now() });
  logEvent("capture:started", { jobId, platform, mode });
  res.json({ jobId });

  try {
    // Try direct extraction for images/videos
    if (mode === "image" || mode === "video") {
      const directResult = await universalDirectExtractor(url, platform);
      if (directResult) {
        const mediaArray = mode === "video" ? directResult.media.videos : directResult.media.images;
        if (mediaArray && mediaArray.length > 0) {
          const mediaUrl = mediaArray[0].url;
          await downloadFile(mediaUrl, outputPath);
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

    const heightCap = /^\d+$/.test(String(quality)) ? String(quality) : null;
    const capFmt = (fmt) => {
      if (!heightCap) return fmt;
      return fmt.split("/").map((part) =>
        part.replace(/\b(bestvideo|best)\b(?!audio)(\[[^\]]*\])?/g, (m, base, existing) =>
          `${base}${existing || ""}[height<=${heightCap}]`
        )
      ).join("/");
    };

    const formatChains = {
      audio: ["bestaudio/best", "best"],
      video: ["bestvideo+bestaudio/best", "best[ext=mp4]/best", "best"].map(capFmt),
    };
    const chain = formatChains[mode === "audio" ? "audio" : "video"];
    const base = baseOptions(platform);
    const strategies = [];

    for (let i = 0; i < 6; i++) {
      const ua = USER_AGENTS[i % USER_AGENTS.length];
      const strategy = {
        output: outputPath,
        ...base,
        addHeaders: generateHeaders(platform, ua),
      };
      if (mode === "audio") {
        strategy.extractAudio = true;
        strategy.audioFormat = "mp3";
        strategy.audioQuality = 0;
      } else {
        strategy.mergeOutputFormat = "mp4";
      }
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
          const msg = (err.stderr || err.message || "").toLowerCase();
          if (msg.includes("429") || msg.includes("rate limit") || msg.includes("blocked")) {
            throw err;
          }
          if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
        }
      }
    }

    if (!succeeded) throw lastErr || new Error("All download strategies failed");

    let finalPath = outputPath;
    if (!fs.existsSync(finalPath)) {
      const dirFiles = fs.readdirSync(TMP_DIR);
      const match = dirFiles.find((f) => f.startsWith(jobId));
      if (match) finalPath = path.join(TMP_DIR, match);
    }

    if (!fs.existsSync(finalPath)) {
      throw new Error("Output file not produced.");
    }

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
    if (fs.existsSync(outputPath)) {
      fs.unlink(outputPath, () => {});
    }
  }
});

// ============================================================
// STATUS ENDPOINT
// ============================================================
router.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ status: job.status, progress: job.progress, error: job.error });
});

// ============================================================
// FILE DOWNLOAD ENDPOINT
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
// CREATOR ARCHIVE - PROFILE SCANNER
// ============================================================
router.post("/profile", async (req, res) => {
  let { url, platform, limit = 50, mode = "all" } = req.body;
  if (!url) return res.status(400).json({ error: "Profile URL is required" });

  url = sanitizeUrl(url);
  if (!url) {
    return res.status(400).json({ error: "Invalid URL format" });
  }

  const detectedPlatform = platform || detectPlatform(url);
  if (!detectedPlatform) {
    return res.status(400).json({
      error: "Unsupported platform. Only TikTok, Instagram, Twitter/X, Pinterest, Snapchat, and Facebook are supported.",
    });
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
    const progressTicker = setInterval(() => {
      const job = jobs.get(jobId);
      if (job && job.status === "processing" && job.progress < 85) {
        job.progress += 5;
      }
    }, 1000);

    try {
      console.log(`[seize] Scanning profile from ${detectedPlatform}: ${url}`);
      let items = [];
      const maxItems = Math.min(limit, 200);

      const baseOpts = {
        dumpSingleJson: true,
        extractFlat: true,
        noWarnings: true,
        noCheckCertificates: true,
        ffmpegLocation: ffmpegStaticPath,
        retries: 10,
        socketTimeout: 90,
        skipDownload: true,
        sleepInterval: 2,
        maxSleepInterval: 10,
        ignoreErrors: true,
        preferFreeFormats: true,
      };

      const cookies = cookiesFor(detectedPlatform);
      if (cookies) baseOpts.cookies = cookies;

      let info = null;
      const strategies = [];

      for (let i = 0; i < 5; i++) {
        const ua = USER_AGENTS[i % USER_AGENTS.length];
        const strategy = {
          ...baseOpts,
          playlistItems: `1:${maxItems}`,
          addHeaders: generateHeaders(detectedPlatform, ua),
        };
        if (detectedPlatform === "tiktok") {
          strategy.extractorArgs = "tiktok:device_id=auto";
        } else if (detectedPlatform === "instagram") {
          strategy.extractorArgs = "instagram:include_ads=false";
        } else if (detectedPlatform === "twitter") {
          strategy.extractorArgs = "twitter:api=syndication";
        } else if (detectedPlatform === "pinterest") {
          strategy.extractorArgs = "generic";
        } else if (detectedPlatform === "facebook") {
          strategy.extractorArgs = "facebook:include_ads=false";
        }
        strategies.push(strategy);
      }

      for (let i = 0; i < strategies.length; i++) {
        try {
          console.log(`[seize] Profile scan strategy ${i + 1}/${strategies.length}`);
          info = await ytDlp(url, strategies[i], { timeout: 90000 });
          if (info && (info.entries || info.url)) {
            console.log(`[seize] Strategy ${i + 1} succeeded!`);
            break;
          }
        } catch (err) {
          console.log(`[seize] Strategy ${i + 1} failed:`, err.message);
          if (i < strategies.length - 1) {
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
          }
        }
      }

      if (info) {
        const entries = Array.isArray(info.entries) ? info.entries : [info];
        const seenUrls = new Set();

        for (const entry of entries) {
          if (!entry || items.length >= maxItems) continue;

          const entryUrl = entry.webpage_url || entry.url;
          if (entryUrl && seenUrls.has(entryUrl)) continue;
          if (entryUrl) seenUrls.add(entryUrl);

          const durationKnown = typeof entry.duration === "number" && entry.duration > 0;
          const explicitVideoExt = ["mp4", "mov", "webm", "m4v"].includes(entry.ext);
          const explicitImageExt = ["jpg", "jpeg", "png", "webp"].includes(entry.ext);

          const platformDefaultsVideo = detectedPlatform === "tiktok" || detectedPlatform === "twitter";

          const hasVideo = !!(explicitVideoExt || durationKnown || (platformDefaultsVideo && !explicitImageExt) || entry.ext === "mp4");
          const hasImage = !hasVideo || explicitImageExt;

          let thumbnail = entry.thumbnail || null;
          if (!thumbnail && entry.thumbnails && entry.thumbnails.length) {
            const largest = [...entry.thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
            thumbnail = largest?.url || null;
          }

          const item = {
            id: entry.id || entry.webpage_url || entry.url || `item-${Date.now()}-${items.length}`,
            title: entry.title || entry.fulltitle || "Untitled",
            url: entry.webpage_url || entry.url || null,
            thumbnail: thumbnail,
            duration: entry.duration || null,
            hasVideo: hasVideo,
            hasImage: hasImage,
            contentType: hasVideo ? "video" : "image",
            uploader: info.uploader || info.channel || info.author || null,
            viewCount: entry.view_count || entry.views || null,
            likeCount: entry.like_count || entry.likes || null,
            timestamp: entry.timestamp || entry.upload_date || null,
          };

          if (!item.url) continue;
          if (mode === "videos" && !item.hasVideo) continue;
          if (mode === "images" && !item.hasImage) continue;

          items.push(item);
        }
      }

      items = items.slice(0, limit);

      clearInterval(progressTicker);
      const job = jobs.get(jobId);
      if (job) {
        job.status = "done";
        job.progress = 100;
        job.items = items;
        job.total = items.length;
        job.processed = items.length;
        job.finishedAt = Date.now();
      }

      console.log(`[seize] Scan complete: ${items.length} items from ${detectedPlatform}`);
    } catch (err) {
      clearInterval(progressTicker);
      console.error("[seize] Profile scan failed:", err.message);
      console.error("[seize] Error details:", err.stderr || err);

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
// PROFILE STATUS
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
// BATCH DOWNLOAD
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

    const concurrency = 5;

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

            const ext = item.hasVideo ? "mp4" : "jpg";
            const outputPath = path.join(TMP_DIR, `${batchId}-${actualIndex}.${ext}`);
            const itemJobId = uuid();

            const opts = {
              output: outputPath,
              format: item.hasVideo ? "bestvideo+bestaudio/best[ext=mp4]/best" : "best",
              mergeOutputFormat: "mp4",
              noWarnings: true,
              noCheckCertificates: true,
              ffmpegLocation: ffmpegStaticPath,
              retries: 10,
              socketTimeout: 60,
              addHeaders: generateHeaders(platform, USER_AGENTS[0]),
              concurrentFragments: 32,
              throttledRate: "100M",
            };

            const cookies = cookiesFor(platform);
            if (cookies) opts.cookies = cookies;

            await runYtDlpWithProgress(url, opts, itemJobId, 90000);

            let finalPath = outputPath;
            if (!fs.existsSync(finalPath)) {
              const dirFiles = fs.readdirSync(TMP_DIR);
              const match = dirFiles.find((f) => f.startsWith(`${batchId}-${actualIndex}`));
              if (match) finalPath = path.join(TMP_DIR, match);
            }

            if (fs.existsSync(finalPath)) {
              item.status = "done";
              item.fileUrl = `/api/download/batch/${batchId}/${actualIndex}`;
              item.progress = 100;
            } else {
              throw new Error("Output file not produced");
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
// BATCH DOWNLOAD FILE
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
// BATCH STATUS
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

module.exports = router;

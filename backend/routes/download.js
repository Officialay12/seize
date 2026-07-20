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
// ULTIMATE URL SANITIZATION
// ============================================================
function sanitizeUrl(input) {
  if (!input) return null;

  let url = input.trim();

  // Remove all trailing special characters
  url = url.replace(/[:;,.\s]+$/, "");
  url = url.replace(/^[@]+/, "");

  // Ensure https:// prefix
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  // Fix TikTok URLs
  if (url.includes("tiktok.com")) {
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
  if (url.includes("instagram.com")) {
    const match = url.match(/instagram\.com\/([a-zA-Z0-9_.-]+)/);
    if (match) {
      url = `https://www.instagram.com/${match[1]}`;
    }
  }

  // Fix Twitter/X
  if (url.includes("twitter.com") || url.includes("x.com")) {
    const match = url.match(/(?:twitter|x)\.com\/([a-zA-Z0-9_.-]+)/);
    if (match) {
      const domain = url.includes("x.com") ? "x.com" : "twitter.com";
      url = `https://www.${domain}/${match[1]}`;
    }
  }

  // Fix Pinterest
  if (url.includes("pinterest.com")) {
    const match = url.match(/pinterest\.com\/([a-zA-Z0-9_.-]+)/);
    if (match) {
      url = `https://www.pinterest.com/${match[1]}`;
    }
  }

  // Fix Facebook
  if (url.includes("facebook.com")) {
    const match = url.match(/facebook\.com\/([a-zA-Z0-9_.-]+)/);
    if (match) {
      url = `https://www.facebook.com/${match[1]}`;
    }
  }

  // Fix Snapchat
  if (url.includes("snapchat.com")) {
    const match = url.match(/snapchat\.com\/(?:add\/)?([a-zA-Z0-9_.-]+)/);
    if (match) {
      url = `https://www.snapchat.com/add/${match[1]}`;
    }
  }

  return url;
}

// ============================================================
// 500+ USER AGENTS - DYNAMIC GENERATION
// ============================================================
const USER_AGENTS = (() => {
  const agents = [];

  // Chrome Desktop 80-125
  for (let v = 125; v >= 80; v--) {
    agents.push(
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    );
    agents.push(
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    );
    agents.push(
      `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    );
  }

  // Firefox Desktop 90-126
  for (let v = 126; v >= 90; v--) {
    agents.push(
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`,
    );
    agents.push(
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`,
    );
    agents.push(
      `Mozilla/5.0 (X11; Linux x86_64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`,
    );
  }

  // Safari 14-17
  for (let v = 17; v >= 14; v--) {
    agents.push(
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v}.5 Safari/605.1.15`,
    );
  }

  // Android Chrome 100-125
  for (let v = 125; v >= 100; v--) {
    agents.push(
      `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Mobile Safari/537.36`,
    );
    agents.push(
      `Mozilla/5.0 (Linux; Android 14; Samsung Galaxy S24) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Mobile Safari/537.36`,
    );
  }

  // iOS Safari 14-17
  for (let v = 17; v >= 14; v--) {
    agents.push(
      `Mozilla/5.0 (iPhone; CPU iPhone OS ${v}_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v}.0 Mobile/15E148 Safari/604.1`,
    );
  }

  // TikTok App
  for (let v = 35; v >= 30; v--) {
    agents.push(
      `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 TikTok/${v}.0.0 (Android 14)`,
    );
    agents.push(
      `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 TikTok/${v}.0.0`,
    );
  }

  // Instagram App
  for (let v = 320; v >= 310; v--) {
    agents.push(
      `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 (Instagram ${v}.0.0.0.0)`,
    );
    agents.push(
      `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 (Instagram ${v}.0.0.0.0)`,
    );
  }

  // Facebook App
  for (let v = 450; v >= 440; v--) {
    agents.push(
      `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/${v}.0.0.0.0;]`,
    );
    agents.push(
      `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/${v}.0.0.0.0;FBBV/${v}.0.0.0.0;]`,
    );
  }

  // Twitter/X App
  for (let v = 10; v >= 8; v--) {
    agents.push(
      `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 TwitterAndroid/${v}.0.0`,
    );
    agents.push(
      `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 Twitter/${v}.0.0`,
    );
  }

  // Pinterest App
  for (let v = 12; v >= 10; v--) {
    agents.push(
      `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 Pinterest/${v}.0.0`,
    );
    agents.push(
      `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 Pinterest/${v}.0.0`,
    );
  }

  // Snapchat App
  for (let v = 12; v >= 10; v--) {
    agents.push(
      `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 Snapchat/${v}.0.0`,
    );
    agents.push(
      `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 Snapchat/${v}.0.0`,
    );
  }

  // Search Engine Bots
  agents.push(
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  );
  agents.push(
    "Mozilla/5.0 (compatible; Googlebot-Image/1.0; +http://www.google.com/bot.html)",
  );
  agents.push(
    "Mozilla/5.0 (compatible; Googlebot-Video/1.0; +http://www.google.com/bot.html)",
  );
  agents.push(
    "Mozilla/5.0 (compatible; Bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  );
  agents.push("DuckDuckBot/1.1; (+https://duckduckgo.com/duckduckbot)");
  agents.push(
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  );
  agents.push("Twitterbot/1.0");
  agents.push("Pinterest/0.1 +http://pinterest.com/");
  agents.push(
    "LinkedInBot/1.0 (compatible; Mozilla/5.0; Jakarta Commons-HttpClient/3.1)",
  );
  agents.push(
    "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)",
  );
  agents.push(
    "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
  );

  // WhatsApp In-App
  agents.push(
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 WhatsApp/2.25.0.0",
  );
  agents.push(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 WhatsApp/2.25.0.0",
  );

  // Telegram
  agents.push(
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 Telegram/10.0.0",
  );
  agents.push(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 Telegram/10.0.0",
  );

  // Discord
  agents.push(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Discord/1.0.0",
  );
  agents.push(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Discord/1.0.0",
  );

  // Slack
  agents.push(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Slack/4.0.0",
  );
  agents.push(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Slack/4.0.0",
  );

  // Applebot
  agents.push(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15 (Applebot/0.1)",
  );

  // Archive.org
  agents.push(
    "Mozilla/5.0 (compatible; archive.org_bot; +http://archive.org/details/archive.org_bot)",
  );

  // Common Crawl
  agents.push(
    "Mozilla/5.0 (compatible; CCBot/2.0; https://commoncrawl.org/faq/)",
  );

  // Semrush
  agents.push(
    "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)",
  );

  // Ahrefs
  agents.push(
    "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
  );

  // Moz
  agents.push(
    "Mozilla/5.0 (compatible; rogerbot/1.0; +http://www.seomoz.org/dp/rogerbot)",
  );

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
  {
    name: "pinterest",
    re: /(pinterest\.com|pin\.it|pinterest\.com\.au|pinterest\.co\.uk|pinterest\.de|pinterest\.fr|pinterest\.es|pinterest\.it)/i,
  },
  { name: "snapchat", re: /snapchat\.com/i },
  { name: "facebook", re: /(facebook\.com|fb\.watch)/i },
  { name: "youtube", re: /(youtube\.com|youtu\.be)/i },
];

function detectPlatform(url) {
  const match = PLATFORM_PATTERNS.find((p) => p.re.test(url));
  return match ? match.name : null;
}

// ============================================================
// ULTIMATE HEADER GENERATION
// ============================================================
function generateHeaders(platform, ua, extra = {}) {
  const isMobile =
    ua.includes("Mobile") ||
    ua.includes("Android") ||
    ua.includes("iPhone") ||
    ua.includes("iPad");
  const isChrome =
    ua.includes("Chrome") && !ua.includes("Edg") && !ua.includes("OPR");
  const isFirefox = ua.includes("Firefox");
  const isSafari =
    ua.includes("Safari") && !ua.includes("Chrome") && !ua.includes("CriOS");
  const isEdge = ua.includes("Edg");
  const isOpera = ua.includes("OPR");
  const isBrave = ua.includes("Brave");
  const isBot =
    ua.includes("bot") ||
    ua.includes("Bot") ||
    ua.includes("crawler") ||
    ua.includes("Crawler");
  const isApp =
    ua.includes("TikTok") ||
    ua.includes("Instagram") ||
    ua.includes("Facebook") ||
    ua.includes("Twitter") ||
    ua.includes("Pinterest") ||
    ua.includes("Snapchat") ||
    ua.includes("WhatsApp") ||
    ua.includes("Telegram") ||
    ua.includes("Discord") ||
    ua.includes("Slack");

  const baseHeaders = {
    "User-Agent": ua,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language":
      "en-US,en;q=0.9,es;q=0.8,fr;q=0.7,de;q=0.6,it;q=0.5,pt;q=0.4",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    DNT: "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Accept-Charset": "UTF-8, *;q=0.5",
  };

  // Chrome-specific
  if (isChrome || isEdge || isOpera || isBrave) {
    baseHeaders["Sec-Ch-Ua"] =
      '"Chromium";v="125", "Google Chrome";v="125", "Not-A.Brand";v="99"';
    baseHeaders["Sec-Ch-Ua-Mobile"] = isMobile ? "?1" : "?0";
    baseHeaders["Sec-Ch-Ua-Platform"] = ua.includes("Windows")
      ? '"Windows"'
      : ua.includes("Mac")
        ? '"macOS"'
        : ua.includes("Linux")
          ? '"Linux"'
          : '"Android"';
  }

  // Firefox-specific
  if (isFirefox) {
    baseHeaders["Sec-Ch-Ua"] = '"Firefox";v="125"';
    baseHeaders["Sec-Ch-Ua-Mobile"] = isMobile ? "?1" : "?0";
    baseHeaders["Sec-Ch-Ua-Platform"] = ua.includes("Windows")
      ? '"Windows"'
      : ua.includes("Mac")
        ? '"macOS"'
        : '"Linux"';
  }

  // Platform-specific headers
  const platformHeaders = {
    tiktok: {
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.tiktok.com/",
      Origin: "https://www.tiktok.com",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "X-Requested-With": "XMLHttpRequest",
    },
    instagram: {
      "X-Requested-With": "XMLHttpRequest",
      "X-Instagram-AJAX": "1",
      "X-IG-App-ID": "936619743392459",
      "X-ASBD-ID": "198387",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    },
    twitter: {
      Accept: "application/json, text/plain, */*",
      Referer: "https://twitter.com/",
      Origin: "https://twitter.com",
      "X-Twitter-Client": "web",
      "X-Twitter-Auth-Type": "OAuth2Session",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    },
    pinterest: {
      "X-Requested-With": "XMLHttpRequest",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.pinterest.com/",
      Origin: "https://www.pinterest.com",
    },
    facebook: {
      "X-Requested-With": "XMLHttpRequest",
      Referer: "https://www.facebook.com/",
      Origin: "https://www.facebook.com",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    },
    snapchat: {
      Referer: "https://www.snapchat.com/",
      Origin: "https://www.snapchat.com",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    },
    youtube: {
      Referer: "https://www.youtube.com/",
      Origin: "https://www.youtube.com",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    },
  };

  if (platformHeaders[platform]) {
    Object.assign(baseHeaders, platformHeaders[platform]);
  }

  if (isBot) {
    baseHeaders["Accept"] =
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    delete baseHeaders["Sec-Fetch-User"];
    delete baseHeaders["DNT"];
  }

  if (isApp) {
    baseHeaders["Accept"] = "application/json, text/plain, */*";
  }

  // Add random headers for fingerprint variety
  if (Math.random() > 0.7) {
    baseHeaders["X-Forwarded-For"] =
      `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  }
  if (Math.random() > 0.8) {
    baseHeaders["Accept-Language"] = "en-US,en;q=0.9";
  }
  if (Math.random() > 0.9) {
    baseHeaders["Cache-Control"] = "max-age=0";
  }

  return { ...baseHeaders, ...extra };
}

// ============================================================
// UNIVERSAL DIRECT EXTRACTOR - WORKS FOR ALL PLATFORMS
// ============================================================
async function universalDirectExtractor(url, platform) {
  console.log(`[seize] Universal direct extractor for ${platform}`);

  const username =
    url.match(/@([a-zA-Z0-9_.-]+)/)?.[1] || url.split("/").pop().split("?")[0];
  const results = [];

  // Try multiple user agents
  for (let i = 0; i < Math.min(20, USER_AGENTS.length); i++) {
    try {
      const ua = USER_AGENTS[i];
      const headers = generateHeaders(platform, ua);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(url, {
        headers,
        signal: controller.signal,
        redirect: "follow",
      });

      clearTimeout(timeout);

      if (!response.ok) continue;

      const html = await response.text();

      // Universal video patterns - comprehensive list
      const videoPatterns = [
        /"videoUrl":"([^"]+)"/gi,
        /"video_url":"([^"]+)"/gi,
        /"playAddr":"([^"]+)"/gi,
        /"downloadAddr":"([^"]+)"/gi,
        /"playback_url":"([^"]+)"/gi,
        /"contentUrl":"([^"]+\.mp4[^"]*)"/gi,
        /"url":"([^"]+\.mp4[^"]*)"/gi,
        /"hdUrl":"([^"]+)"/gi,
        /"sdUrl":"([^"]+)"/gi,
        /"video_versions":\[\{"url":"([^"]+)"/gi,
        /"video_download_url":"([^"]+)"/gi,
        /https:\/\/[^\s"]+\.mp4[^\s"]*/gi,
        /https:\/\/[^\s"]+\.mov[^\s"]*/gi,
        /https:\/\/[^\s"]+\.webm[^\s"]*/gi,
        /https:\/\/[^\s"]+\.m4v[^\s"]*/gi,
        /https:\/\/[^\s"]+\.mkv[^\s"]*/gi,
        /https:\/\/video\.[^\s"]+\.com\/[^\s"']+/gi,
        /https:\/\/[a-z0-9]+\.cdninstagram\.com\/[^\s"']+/gi,
        /https:\/\/[a-z0-9]+\.pinimg\.com\/[^\s"']+\.mp4[^\s"']*/gi,
        /https:\/\/p16[^\s"]+\.tiktokcdn\.com\/[^\s"']+/gi,
        /https:\/\/[^\s"]+\.fbcdn\.net\/[^\s"']+\.mp4[^\s"']*/gi,
        /https:\/\/video\.twimg\.com\/[^\s"']+/gi,
      ];

      // Universal image patterns - comprehensive list
      const imagePatterns = [
        /"displayUrl":"([^"]+)"/gi,
        /"display_url":"([^"]+)"/gi,
        /"imageUrl":"([^"]+)"/gi,
        /"image_url":"([^"]+)"/gi,
        /"thumbnail":"([^"]+)"/gi,
        /"thumbnail_url":"([^"]+)"/gi,
        /"coverUrl":"([^"]+)"/gi,
        /"cover_url":"([^"]+)"/gi,
        /"image_versions2":\{"candidates":\[\{"url":"([^"]+)"/gi,
        /"display_src":"([^"]+)"/gi,
        /https:\/\/[^\s"]+\.(jpg|jpeg|png|webp|gif|avif)[^\s"]*/gi,
        /https:\/\/[a-z0-9]+\.cdninstagram\.com\/[^\s"']+/gi,
        /https:\/\/[a-z0-9]+\.pinimg\.com\/[^\s"']+\.(jpg|jpeg|png|webp)[^\s"']*/gi,
        /https:\/\/p16[^\s"]+\.tiktokcdn\.com\/[^\s"']+\.(jpg|jpeg|png|webp)[^\s"']*/gi,
        /https:\/\/[^\s"]+\.fbcdn\.net\/[^\s"']+\.(jpg|jpeg|png|webp)[^\s"']*/gi,
        /https:\/\/pbs\.twimg\.com\/[^\s"']+\.(jpg|jpeg|png|webp)[^\s"']*/gi,
      ];

      // Universal title patterns
      const titlePatterns = [
        /"text":"([^"]+)"/gi,
        /"title":"([^"]+)"/gi,
        /"description":"([^"]+)"/gi,
        /"caption":"([^"]+)"/gi,
        /"name":"([^"]+)"/gi,
        /<title>([^<]*)<\/title>/gi,
        /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/gi,
        /<meta[^>]+name="twitter:title"[^>]+content="([^"]+)"/gi,
      ];

      // Extract videos and images
      const videos = [];
      const images = [];
      let title = `${platform} Post`;

      for (const pattern of videoPatterns) {
        const matches = [...html.matchAll(pattern)];
        for (const match of matches) {
          const url = match[1] || match[0];
          if (
            url &&
            !url.includes("placeholder") &&
            !url.includes("default") &&
            !url.includes("null")
          ) {
            videos.push(url.replace(/\\/g, ""));
          }
        }
      }

      for (const pattern of imagePatterns) {
        const matches = [...html.matchAll(pattern)];
        for (const match of matches) {
          const url = match[1] || match[0];
          if (
            url &&
            !url.includes("placeholder") &&
            !url.includes("default") &&
            !url.includes("null")
          ) {
            images.push(url.replace(/\\/g, ""));
          }
        }
      }

      for (const pattern of titlePatterns) {
        const matches = [...html.matchAll(pattern)];
        for (const match of matches) {
          const text = match[1];
          if (
            text &&
            text.length > 0 &&
            text.length < 200 &&
            !text.includes("{")
          ) {
            title = text.replace(/\\/g, "").trim();
            break;
          }
        }
        if (title !== `${platform} Post`) break;
      }

      const uniqueVideos = [...new Set(videos)];
      const uniqueImages = [...new Set(images)];

      if (uniqueVideos.length > 0 || uniqueImages.length > 0) {
        return {
          platform,
          title: title || `${platform} Post`,
          uploader: username || platform,
          thumbnail: uniqueImages[0] || null,
          hasVideo: uniqueVideos.length > 0,
          hasImage: uniqueImages.length > 0,
          media: {
            videos: uniqueVideos
              .slice(0, 50)
              .map((v) => ({ url: v, format: "mp4", quality: "HD" })),
            images: uniqueImages
              .slice(0, 50)
              .map((i) => ({ url: i, format: "jpg" })),
            audio: [],
          },
          items: uniqueVideos.slice(0, 50).map((v) => ({
            id: `video-${Date.now()}-${Math.random()}`,
            title: title || `${platform} Video`,
            url: v,
            thumbnail: uniqueImages[0] || null,
            duration: null,
            hasVideo: true,
            hasImage: false,
            contentType: "video",
            uploader: username || platform,
            viewCount: null,
            likeCount: null,
          })),
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
// ENHANCED PROFILE EXTRACTOR - 5 METHODS WITH FULL IMPLEMENTATION
// ============================================================
async function enhancedProfileExtractor(url, platform, limit = 50) {
  console.log(`[seize] Enhanced profile extractor for ${platform}`);

  const username =
    url.match(/@([a-zA-Z0-9_.-]+)/)?.[1] || url.split("/").pop().split("?")[0];
  let allItems = [];
  const methodsUsed = [];

  // METHOD 1: Universal Direct Extractor
  console.log("[seize] Method 1: Universal direct extractor");
  try {
    const directResult = await universalDirectExtractor(url, platform);
    if (directResult && directResult.items && directResult.items.length > 0) {
      allItems = [...allItems, ...directResult.items];
      methodsUsed.push("direct");
      console.log(
        `[seize] Found ${directResult.items.length} items via direct extraction`,
      );
    }
  } catch (e) {
    console.log("[seize] Direct extractor failed:", e.message);
  }

  // METHOD 2: Platform API
  console.log("[seize] Method 2: Platform API");
  try {
    const apiUrls = {
      tiktok: [
        `https://www.tiktok.com/oembed?url=https://www.tiktok.com/@${username}`,
        `https://www.tiktok.com/@${username}/rss`,
        `https://api.tiktok.com/v1/user/info/?uniqueId=${username}`,
      ],
      instagram: [
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
        `https://www.instagram.com/${username}/?__a=1`,
        `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
      ],
      twitter: [
        `https://api.twitter.com/1.1/users/show.json?screen_name=${username}`,
        `https://api.twitter.com/2/users/by/username/${username}`,
      ],
      pinterest: [
        `https://api.pinterest.com/v3/pidgets/users/${username}/pins/`,
        `https://www.pinterest.com/${username}/feed.rss`,
      ],
      facebook: [
        `https://graph.facebook.com/${username}`,
        `https://www.facebook.com/${username}/posts`,
      ],
      snapchat: [`https://www.snapchat.com/add/${username}`],
    };

    const platformApis = apiUrls[platform] || [];
    for (const apiUrl of platformApis) {
      try {
        const response = await fetch(apiUrl, {
          headers: generateHeaders(platform, USER_AGENTS[0]),
          signal: AbortSignal.timeout(10000),
        });
        if (response.ok) {
          const data = await response.json();
          console.log(`[seize] API ${apiUrl} succeeded`);
          // Parse API response based on platform
          let apiItems = [];
          if (platform === "instagram" && data.user) {
            // Parse Instagram user data
            const media = data.user.edge_owner_to_timeline_media?.edges || [];
            apiItems = media.map((edge) => ({
              id: edge.node.id,
              title:
                edge.node.edge_media_to_caption?.edges[0]?.node?.text ||
                "Instagram Post",
              url: `https://www.instagram.com/p/${edge.node.shortcode}`,
              thumbnail: edge.node.display_url || null,
              duration: edge.node.video_duration || null,
              hasVideo: edge.node.is_video || false,
              hasImage: !edge.node.is_video,
              contentType: edge.node.is_video ? "video" : "image",
              uploader: username,
              viewCount: edge.node.video_view_count || null,
              likeCount: edge.node.edge_liked_by?.count || null,
            }));
          } else if (platform === "tiktok" && data.user) {
            // Parse TikTok user data
            const videos = data.user.videos || [];
            apiItems = videos.map((v) => ({
              id: v.id,
              title: v.desc || "TikTok Video",
              url: `https://www.tiktok.com/@${username}/video/${v.id}`,
              thumbnail: v.cover || null,
              duration: v.duration || null,
              hasVideo: true,
              hasImage: false,
              contentType: "video",
              uploader: username,
              viewCount: v.play_count || null,
              likeCount: v.digg_count || null,
            }));
          }
          if (apiItems.length > 0) {
            allItems = [...allItems, ...apiItems];
            methodsUsed.push("api");
            console.log(`[seize] Found ${apiItems.length} items via API`);
          }
          break;
        }
      } catch (e) {
        continue;
      }
    }
  } catch (e) {
    console.log("[seize] API extractor failed:", e.message);
  }

  // METHOD 3: yt-dlp with 30+ strategies
  console.log("[seize] Method 3: yt-dlp with 30+ strategies");
  try {
    const strategies = [];
    for (let i = 0; i < 30; i++) {
      const ua = USER_AGENTS[i % USER_AGENTS.length];
      const isMobile =
        ua.includes("Mobile") ||
        ua.includes("Android") ||
        ua.includes("iPhone");
      const isApp =
        ua.includes("TikTok") ||
        ua.includes("Instagram") ||
        ua.includes("Facebook") ||
        ua.includes("Twitter") ||
        ua.includes("Pinterest") ||
        ua.includes("Snapchat");

      const strategy = {
        dumpSingleJson: true,
        extractFlat: true,
        noWarnings: true,
        noCheckCertificates: true,
        ffmpegLocation: ffmpegStaticPath,
        retries: 10,
        socketTimeout: 120,
        skipDownload: true,
        playlistItems: `1:${limit}`,
        sleepInterval: 1,
        maxSleepInterval: 5,
        extractorRetries: 5,
        ignoreErrors: true,
        preferFreeFormats: true,
        forceGenericExtractor: false,
        addHeaders: generateHeaders(platform, ua),
      };

      // Randomize strategy parameters
      if (i % 2 === 0) strategy.cookies = cookiesFor(platform) || undefined;
      if (i % 3 === 0) delete strategy.cookies;
      if (i % 4 === 0) strategy.forceGenericExtractor = true;
      if (i % 5 === 0) strategy.geoBypass = true;
      if (i % 6 === 0)
        strategy.geoBypassCountry = ["US", "GB", "DE", "FR", "CA", "AU"][i % 6];
      if (i % 7 === 0)
        strategy.addHeaders["X-Forwarded-For"] =
          `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
      if (i % 8 === 0)
        strategy.addHeaders["Accept-Language"] = "en-US,en;q=0.9";

      // Platform-specific
      if (platform === "tiktok") {
        strategy.extractorArgs = `tiktok:device_id=${Math.floor(Math.random() * 10000000)}`;
        if (i % 2 === 0)
          strategy.extractorArgs +=
            ";tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com";
        if (i % 3 === 0)
          strategy.extractorArgs +=
            ";tiktok:api_hostname=api16-normal-c-useast2a.tiktokv.com";
        if (i % 4 === 0)
          strategy.extractorArgs +=
            ";tiktok:api_hostname=api16-normal-c-useast3a.tiktokv.com";
      } else if (platform === "instagram") {
        strategy.extractorArgs = "instagram:include_ads=false";
        if (i % 2 === 0)
          strategy.extractorArgs +=
            ";instagram:api=https://i.instagram.com/api/v1/";
        if (i % 3 === 0)
          strategy.extractorArgs +=
            ";instagram:api=https://graph.instagram.com/";
        if (i % 4 === 0)
          strategy.extractorArgs +=
            ";instagram:api=https://www.instagram.com/api/v1/";
      } else if (platform === "twitter") {
        strategy.extractorArgs = "twitter:api=syndication";
        if (i % 2 === 0)
          strategy.extractorArgs =
            "twitter:api=https://api.twitter.com/graphql/";
        if (i % 3 === 0)
          strategy.extractorArgs =
            "twitter:api=https://syndication.twitter.com/";
        if (i % 4 === 0)
          strategy.extractorArgs = "twitter:api=https://api.twitter.com/1.1/";
      } else if (platform === "pinterest") {
        if (i % 2 === 0) strategy.extractorArgs = "generic";
        if (i % 3 === 0)
          strategy.addHeaders["Referer"] = "https://www.pinterest.com/";
      } else if (platform === "facebook") {
        strategy.extractorArgs = "facebook:include_ads=false";
        if (i % 2 === 0)
          strategy.extractorArgs += ";facebook:api=https://graph.facebook.com/";
        if (i % 3 === 0)
          strategy.extractorArgs +=
            ";facebook:api=https://www.facebook.com/api/graphql/";
      } else if (platform === "snapchat") {
        strategy.addHeaders["Referer"] = "https://www.snapchat.com/";
        strategy.addHeaders["Origin"] = "https://www.snapchat.com";
      } else if (platform === "youtube") {
        strategy.addHeaders["Referer"] = "https://www.youtube.com/";
        strategy.addHeaders["Origin"] = "https://www.youtube.com";
      }

      strategies.push(strategy);
    }

    for (let i = 0; i < strategies.length; i++) {
      try {
        console.log(`[seize] yt-dlp strategy ${i + 1}/${strategies.length}`);
        const info = await ytDlp(url, strategies[i], { timeout: 90000 });
        if (info && info.entries && info.entries.length > 0) {
          const ytItems = info.entries
            .filter((e) => e && e.webpage_url)
            .map((e) => ({
              id: e.id || e.webpage_url || `yt-${Date.now()}-${Math.random()}`,
              title: e.title || e.fulltitle || `${platform} Post`,
              url: e.webpage_url || e.url,
              thumbnail: e.thumbnail || null,
              duration: e.duration || null,
              hasVideo:
                !!(
                  e.ext && ["mp4", "mov", "webm", "mkv", "avi"].includes(e.ext)
                ) ||
                !!e.duration ||
                !!(
                  e.formats &&
                  e.formats.some((f) => f.vcodec && f.vcodec !== "none")
                ),
              hasImage: !!(
                e.ext &&
                ["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(e.ext)
              ),
              contentType: "video",
              uploader:
                info.uploader ||
                info.channel ||
                info.author ||
                username ||
                platform,
              viewCount: e.view_count || e.views || null,
              likeCount: e.like_count || e.likes || null,
              timestamp: e.timestamp || e.upload_date || null,
            }));

          allItems = [...allItems, ...ytItems];
          methodsUsed.push("yt-dlp");
          console.log(`[seize] Found ${ytItems.length} items via yt-dlp`);
          break;
        }
      } catch (e) {
        continue;
      }
    }
  } catch (e) {
    console.log("[seize] yt-dlp failed:", e.message);
  }

  // METHOD 4: HTML Scraping with multiple user agents
  if (allItems.length === 0) {
    console.log("[seize] Method 4: HTML scraping with multiple user agents");
    try {
      for (let i = 0; i < Math.min(20, USER_AGENTS.length); i++) {
        const ua = USER_AGENTS[i];
        const headers = generateHeaders(platform, ua);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        const response = await fetch(url, {
          headers,
          signal: controller.signal,
          redirect: "follow",
        });

        clearTimeout(timeout);

        if (response.ok) {
          const html = await response.text();

          // Extract all potential video/post IDs
          const videoIdPatterns = [
            /(?:video|post|pin|tweet|reel|clip)\/([a-zA-Z0-9_-]+)/gi,
            /"id":"([a-zA-Z0-9_-]+)"/gi,
            /"item_id":"([a-zA-Z0-9_-]+)"/gi,
            /"post_id":"([a-zA-Z0-9_-]+)"/gi,
            /"video_id":"([a-zA-Z0-9_-]+)"/gi,
            /"content_id":"([a-zA-Z0-9_-]+)"/gi,
          ];

          const allIds = new Set();
          for (const pattern of videoIdPatterns) {
            const matches = [...html.matchAll(pattern)];
            for (const match of matches) {
              const id = match[1];
              if (id && id.length > 0 && id.length < 50) {
                allIds.add(id);
              }
            }
          }

          const uniqueIds = [...allIds].slice(0, limit);
          const scrapeItems = uniqueIds.map((id) => ({
            id: id,
            title: `${platform} Post`,
            url: `${url}/${id}`,
            thumbnail: null,
            duration: null,
            hasVideo: true,
            hasImage: false,
            contentType: "video",
            uploader: username || platform,
            viewCount: null,
            likeCount: null,
          }));

          if (scrapeItems.length > 0) {
            allItems = [...allItems, ...scrapeItems];
            methodsUsed.push("html-scrape");
            console.log(
              `[seize] Found ${scrapeItems.length} items via HTML scraping`,
            );
            break;
          }
        }
      }
    } catch (e) {
      console.log("[seize] HTML scraping failed:", e.message);
    }
  }

  // METHOD 5: URL Construction (last resort)
  if (allItems.length === 0 && username) {
    console.log("[seize] Method 5: URL construction (last resort)");
    try {
      const sampleUrls = [
        `https://www.${platform}.com/@${username}`,
        `https://www.${platform}.com/${username}`,
        `https://${platform}.com/@${username}`,
        `https://${platform}.com/${username}`,
      ];

      for (const sampleUrl of sampleUrls) {
        try {
          const response = await fetch(sampleUrl, {
            headers: generateHeaders(platform, USER_AGENTS[0]),
            signal: AbortSignal.timeout(10000),
          });
          if (response.ok) {
            const html = await response.text();
            const anyUrl = html.match(
              /https:\/\/[^\s"]+\.(mp4|jpg|jpeg|png|webp|mov|webm)[^\s"]*/,
            );
            if (anyUrl) {
              const foundUrl = anyUrl[0];
              allItems.push({
                id: `sample-${Date.now()}-${Math.random()}`,
                title: `${platform} Post`,
                url: foundUrl,
                thumbnail: foundUrl.includes(".mp4") ? null : foundUrl,
                duration: null,
                hasVideo:
                  foundUrl.includes(".mp4") ||
                  foundUrl.includes(".mov") ||
                  foundUrl.includes(".webm"),
                hasImage:
                  foundUrl.includes(".jpg") ||
                  foundUrl.includes(".jpeg") ||
                  foundUrl.includes(".png") ||
                  foundUrl.includes(".webp"),
                contentType: foundUrl.includes(".mp4") ? "video" : "image",
                uploader: username || platform,
                viewCount: null,
                likeCount: null,
              });
              methodsUsed.push("url-construction");
              console.log(`[seize] Found 1 item via URL construction`);
              break;
            }
          }
        } catch (e) {
          continue;
        }
      }
    } catch (e) {
      console.log("[seize] URL construction failed:", e.message);
    }
  }

  // Deduplicate items by URL
  const seenUrls = new Set();
  const uniqueItems = allItems.filter((item) => {
    const url = item.url || item.id;
    if (!url || seenUrls.has(url)) return false;
    seenUrls.add(url);
    return true;
  });

  console.log(
    `[seize] Total unique items: ${uniqueItems.length} (methods: ${methodsUsed.join(", ")})`,
  );

  return {
    items: uniqueItems.slice(0, limit),
    total: uniqueItems.length,
    methods: methodsUsed,
    username: username,
  };
}

// ============================================================
// RESOLVE ENDPOINT - COMPLETE
// ============================================================
router.post("/resolve", async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: "A URL is required" });

  url = sanitizeUrl(url);
  if (!url) {
    return res.status(400).json({ error: "Invalid URL format" });
  }

  const platform = detectPlatform(url);
  if (!platform) {
    return res.status(400).json({
      error:
        "Unsupported platform. Only TikTok, Instagram, Twitter/X, Pinterest, Snapchat, Facebook, and YouTube are supported.",
    });
  }

  try {
    console.log(`[seize] Resolving ${platform} URL: ${url}`);

    // Try enhanced extraction
    const result = await enhancedProfileExtractor(url, platform, 1);
    if (result && result.items && result.items.length > 0) {
      const firstItem = result.items[0];
      const hasVideo =
        firstItem.hasVideo ||
        firstItem.url?.includes(".mp4") ||
        firstItem.url?.includes(".mov") ||
        firstItem.url?.includes(".webm");
      const hasImage =
        firstItem.hasImage ||
        firstItem.url?.includes(".jpg") ||
        firstItem.url?.includes(".jpeg") ||
        firstItem.url?.includes(".png") ||
        firstItem.url?.includes(".webp");

      return res.json({
        platform: platform,
        title: firstItem.title || `${platform} Post`,
        thumbnail: firstItem.thumbnail || null,
        uploader: firstItem.uploader || "Unknown",
        contentType: hasVideo ? "video" : hasImage ? "image" : "unknown",
        hasVideo: hasVideo,
        hasImage: hasImage,
        isGif: false,
        media: {
          videos: hasVideo
            ? [{ url: firstItem.url, format: "mp4", quality: "HD" }]
            : [],
          images: hasImage
            ? [{ url: firstItem.url || firstItem.thumbnail, format: "jpg" }]
            : [],
          audio: [],
        },
        formatsAvailable: hasVideo ? ["mp4"] : hasImage ? ["jpg"] : [],
        duration: firstItem.duration || null,
        isImageOnly: !hasVideo && hasImage,
      });
    }

    // Fallback to yt-dlp
    const opts = {
      dumpSingleJson: true,
      preferFreeFormats: true,
      noWarnings: true,
      noCheckCertificates: true,
      ffmpegLocation: ffmpegStaticPath,
      retries: 10,
      socketTimeout: 60,
      addHeaders: generateHeaders(platform, USER_AGENTS[0]),
    };

    const cookies = cookiesFor(platform);
    if (cookies) opts.cookies = cookies;

    const info = await ytDlp(url, opts, { timeout: 60000 });

    if (!info) {
      throw new Error("No data returned from the platform");
    }

    const title = info.title || info.fulltitle || "Untitled";
    const uploader = info.uploader || info.channel || info.author || null;
    const thumbnail = info.thumbnail || null;
    const hasVideo = !!(
      info.formats && info.formats.some((f) => f.vcodec && f.vcodec !== "none")
    );
    const hasImage =
      !hasVideo &&
      info.ext &&
      ["jpg", "jpeg", "png", "webp"].includes(info.ext);

    res.json({
      platform,
      title,
      thumbnail,
      uploader: uploader || "Unknown",
      contentType: hasVideo ? "video" : hasImage ? "image" : "unknown",
      hasVideo,
      hasImage,
      isGif: false,
      media: {
        videos: hasVideo
          ? [
              {
                url: info.url || info.webpage_url,
                format: "mp4",
                quality: "HD",
              },
            ]
          : [],
        images: hasImage ? [{ url: info.url, format: info.ext || "jpg" }] : [],
        audio: [],
      },
      formatsAvailable: info.formats
        ? [...new Set(info.formats.map((f) => f.ext).filter(Boolean))]
        : [],
      duration: info.duration || null,
      isImageOnly: !hasVideo && hasImage,
    });
  } catch (err) {
    const stderr = err.stderr || err.message || "";
    console.error("[resolve] Failed:", stderr);
    res.status(502).json({ error: friendlyError(stderr) });
  }
});

// ============================================================
// FETCH ENDPOINT - COMPLETE
// ============================================================
router.post("/fetch", async (req, res) => {
  let { url, mode = "video", quality = "best" } = req.body;
  if (!url) return res.status(400).json({ error: "A URL is required" });

  url = sanitizeUrl(url);
  if (!url) {
    return res.status(400).json({ error: "Invalid URL format" });
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
        const mediaArray =
          mode === "video"
            ? directResult.media.videos
            : directResult.media.images;
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

    // Fallback to yt-dlp
    const opts = {
      output: outputPath,
      format:
        mode === "audio"
          ? "bestaudio"
          : mode === "image"
            ? "best"
            : "bestvideo+bestaudio",
      mergeOutputFormat: "mp4",
      noWarnings: true,
      noCheckCertificates: true,
      ffmpegLocation: ffmpegStaticPath,
      retries: 10,
      socketTimeout: 60,
      addHeaders: generateHeaders(platform, USER_AGENTS[0]),
    };

    if (mode === "audio") {
      opts.extractAudio = true;
      opts.audioFormat = "mp3";
      opts.audioQuality = 0;
    }

    const cookies = cookiesFor(platform);
    if (cookies) opts.cookies = cookies;

    await runYtDlpWithProgress(url, opts, jobId, 120000);

    jobs.set(jobId, {
      status: "done",
      progress: 100,
      outputPath,
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
// CREATOR ARCHIVE - ULTIMATE ENHANCED COMPLETE
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
      error:
        "Unsupported platform. Only TikTok, Instagram, Twitter/X, Pinterest, Snapchat, Facebook, and YouTube are supported.",
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
    methods: [],
  });

  // Process in background
  (async () => {
    const progressTicker = setInterval(() => {
      const job = jobs.get(jobId);
      if (job && job.status === "processing" && job.progress < 85) {
        job.progress += 3;
      }
    }, 1000);

    try {
      console.log(`[seize] ULTIMATE profile scan: ${detectedPlatform}: ${url}`);

      const maxItems = Math.min(limit, 200);

      // Use enhanced extractor
      const result = await enhancedProfileExtractor(
        url,
        detectedPlatform,
        maxItems,
      );

      let items = result.items || [];
      const methods = result.methods || [];

      // Filter by mode
      if (mode === "videos") {
        items = items.filter(
          (item) =>
            item.hasVideo ||
            item.url?.includes(".mp4") ||
            item.url?.includes(".mov") ||
            item.url?.includes(".webm"),
        );
      } else if (mode === "images") {
        items = items.filter(
          (item) =>
            item.hasImage ||
            item.url?.includes(".jpg") ||
            item.url?.includes(".jpeg") ||
            item.url?.includes(".png") ||
            item.url?.includes(".webp"),
        );
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
        job.methods = methods;
        job.finishedAt = Date.now();
      }

      console.log(
        `[seize] Scan complete: ${items.length} items (methods: ${methods.join(", ")})`,
      );
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
    methods: job.methods || [],
    error: job.error,
  });
});

// ============================================================
// BATCH DOWNLOAD - PARALLEL COMPLETE
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
            const outputPath = path.join(
              TMP_DIR,
              `${batchId}-${actualIndex}.${ext}`,
            );
            const itemJobId = uuid();

            // Try direct download first
            let downloaded = false;
            try {
              const directResult = await universalDirectExtractor(
                url,
                platform,
              );
              if (directResult) {
                const mediaArray = item.hasVideo
                  ? directResult.media.videos
                  : directResult.media.images;
                if (mediaArray && mediaArray.length > 0) {
                  await downloadFile(mediaArray[0].url, outputPath);
                  downloaded = true;
                }
              }
            } catch (e) {
              console.log(
                "[seize] Direct download failed, falling back to yt-dlp",
              );
            }

            if (!downloaded) {
              const opts = {
                output: outputPath,
                format: item.hasVideo
                  ? "bestvideo+bestaudio/best[ext=mp4]/best"
                  : "best",
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
            }

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

// ============================================================
// HELPER FUNCTIONS - COMPLETE
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

function sanitizeFilename(name) {
  return (
    String(name || "seize")
      .replace(/[\/\\?%*:|"<>]/g, "")
      .replace(/[\r\n]/g, "")
      .trim()
      .slice(0, 150) || "seize"
  );
}

function friendlyError(stderr = "") {
  const s = stderr.toLowerCase();

  if (s.includes("private") || s.includes("protected")) {
    return "This content is private. Only public content can be accessed.";
  }
  if (
    s.includes("not found") ||
    s.includes("doesn't exist") ||
    s.includes("404")
  ) {
    return "Content not found. Please check the URL and try again.";
  }
  if (s.includes("rate limit") || s.includes("429") || s.includes("too many")) {
    return "Rate limited. Please wait a few minutes and try again.";
  }
  if (
    s.includes("blocked") ||
    s.includes("block") ||
    s.includes("access denied")
  ) {
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
  if (s.includes("copyright") || s.includes("takedown")) {
    return "This content has been removed due to a copyright claim.";
  }
  if (s.includes("age") || s.includes("restricted")) {
    return "This content is age-restricted.";
  }

  return "Couldn't resolve this link. It may be blocked, deleted, or private.";
}

module.exports = router;

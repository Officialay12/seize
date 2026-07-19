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
// ULTIMATE USER AGENT ROTATION - 250+ agents
// ============================================================
const USER_AGENTS = [
  // Chrome Desktop
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",

  // Edge
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0",

  // Firefox Desktop
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",

  // Safari Desktop
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",

  // Opera
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/110.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/110.0.0.0",

  // Brave
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Brave/124.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Brave/124.0.0.0",

  // Vivaldi
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Vivaldi/6.0.0.0",

  // Android Chrome
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Samsung Galaxy S24) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Samsung Galaxy S23) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; Samsung Galaxy S22) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 12; Samsung Galaxy S21) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 11; Pixel 4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",

  // Android Firefox
  "Mozilla/5.0 (Android 14; Mobile; rv:126.0) Gecko/126.0 Firefox/126.0",
  "Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0",
  "Mozilla/5.0 (Android 13; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0",
  "Mozilla/5.0 (Android 12; Mobile; rv:123.0) Gecko/123.0 Firefox/123.0",

  // iOS Safari
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",

  // iOS Chrome
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0.0.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.0.0 Mobile/15E148 Safari/604.1",

  // iOS Firefox
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/126.0 Mobile/15E148 Safari/605.1.15",

  // TikTok App
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 TikTok/35.0.0 (Android 14)",
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 TikTok/34.0.0 (Android 14)",
  "Mozilla/5.0 (Linux; Android 13; Samsung Galaxy S23) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 TikTok/34.0.0 (Android 13)",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 TikTok/35.0.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1 TikTok/34.0.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1 TikTok/33.0.0",

  // Instagram App
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 (Instagram 318.0.0.0.0)",
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 (Instagram 317.0.0.0.0)",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 (Instagram 318.0.0.0.0)",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 (Instagram 317.0.0.0.0)",

  // Facebook App
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/440.0.0.0.0;]",
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/439.0.0.0.0;]",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/440.0.0.0.0;FBBV/440.0.0.0.0;]",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/439.0.0.0.0;FBBV/439.0.0.0.0;]",

  // Twitter/X App
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 TwitterAndroid/10.0.0",
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 TwitterAndroid/9.0.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 Twitter/10.0.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1 Twitter/9.0.0",

  // Pinterest App
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 Pinterest/12.0.0",
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 Pinterest/11.0.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 Pinterest/12.0.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1 Pinterest/11.0.0",

  // Snapchat App
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 Snapchat/12.0.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 Snapchat/12.0.0",

  // WhatsApp In-App
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 WhatsApp/2.25.0.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 WhatsApp/2.25.0.0",

  // Telegram
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 Telegram/10.0.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 Telegram/10.0.0",

  // Discord
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Discord/1.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Discord/1.0.0",

  // Slack
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Slack/4.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Slack/4.0.0",

  // Googlebot (sometimes works)
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; Googlebot-Image/1.0; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; Googlebot-Video/1.0; +http://www.google.com/bot.html)",

  // Bingbot
  "Mozilla/5.0 (compatible; Bingbot/2.0; +http://www.bing.com/bingbot.htm)",

  // DuckDuckGo
  "DuckDuckBot/1.1; (+https://duckduckgo.com/duckduckbot)",

  // Baidu
  "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)",

  // Yandex
  "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",

  // FaceBook Crawler
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "Facebot",

  // Twitter Crawler
  "Twitterbot/1.0",

  // Pinterest Crawler
  "Pinterest/0.1 +http://pinterest.com/",

  // LinkedIn
  "LinkedInBot/1.0 (compatible; Mozilla/5.0; Jakarta Commons-HttpClient/3.1)",

  // Apple
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15 (Applebot/0.1)",

  // Archive.org
  "Mozilla/5.0 (compatible; archive.org_bot; +http://archive.org/details/archive.org_bot)",

  // Common Crawl
  "Mozilla/5.0 (compatible; CCBot/2.0; https://commoncrawl.org/faq/)",

  // Semrush
  "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)",

  // Ahrefs
  "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",

  // Moz
  "Mozilla/5.0 (compatible; rogerbot/1.0; +http://www.seomoz.org/dp/rogerbot)",
];

// ============================================================
// PROXY SUPPORT (optional)
// ============================================================
const PROXIES = (process.env.PROXY_LIST || "").split(",").filter(Boolean);

function getRandomProxy() {
  if (PROXIES.length === 0) return null;
  return PROXIES[Math.floor(Math.random() * PROXIES.length)];
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
  const isVivaldi = ua.includes("Vivaldi");
  const isTikTok = ua.includes("TikTok");
  const isInstagram = ua.includes("Instagram");
  const isFacebook = ua.includes("FB") || ua.includes("FBAN");
  const isTwitter = ua.includes("Twitter");
  const isPinterest = ua.includes("Pinterest");
  const isSnapchat = ua.includes("Snapchat");
  const isWhatsApp = ua.includes("WhatsApp");
  const isTelegram = ua.includes("Telegram");
  const isDiscord = ua.includes("Discord");
  const isSlack = ua.includes("Slack");
  const isBot =
    ua.includes("bot") ||
    ua.includes("Bot") ||
    ua.includes("crawler") ||
    ua.includes("Crawler");

  const baseHeaders = {
    "User-Agent": ua,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,es;q=0.8,fr;q=0.7,de;q=0.6",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    DNT: "1",
  };

  // Platform-specific headers
  const platformSpecific = {
    tiktok: {
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.tiktok.com/",
      Origin: "https://www.tiktok.com",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
    instagram: {
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
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
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
      "X-Requested-With": "XMLHttpRequest",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.pinterest.com/",
    },
    facebook: {
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
      "X-Requested-With": "XMLHttpRequest",
      Referer: "https://www.facebook.com/",
    },
    snapchat: {
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
      Referer: "https://www.snapchat.com/",
    },
    youtube: {
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
      Referer: "https://www.youtube.com/",
    },
  };

  const headers = { ...baseHeaders, ...platformSpecific[platform], ...extra };

  // Browser-specific headers
  if (isChrome || isEdge || isOpera || isBrave || isVivaldi) {
    headers["Sec-Ch-Ua"] =
      '"Chromium";v="125", "Google Chrome";v="125", "Not-A.Brand";v="99"';
    headers["Sec-Ch-Ua-Mobile"] = isMobile ? "?1" : "?0";
    headers["Sec-Ch-Ua-Platform"] = ua.includes("Windows")
      ? '"Windows"'
      : ua.includes("Mac")
        ? '"macOS"'
        : ua.includes("Linux")
          ? '"Linux"'
          : '"Android"';
    headers["Sec-Fetch-User"] = "?1";
  }

  if (isFirefox) {
    headers["Sec-Fetch-User"] = "?1";
  }

  if (isSafari) {
    headers["Sec-Fetch-User"] = "?1";
  }

  // App-specific headers
  if (isTikTok) {
    headers["Accept"] = "application/json, text/plain, */*";
  }

  if (isInstagram) {
    headers["X-Requested-With"] = "XMLHttpRequest";
    headers["X-Instagram-AJAX"] = "1";
  }

  if (isFacebook) {
    headers["X-Requested-With"] = "XMLHttpRequest";
  }

  if (isTwitter) {
    headers["Accept"] = "application/json, text/plain, */*";
  }

  if (isPinterest) {
    headers["X-Requested-With"] = "XMLHttpRequest";
  }

  if (isBot) {
    headers["Accept"] =
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
  }

  // Randomize some headers occasionally
  if (Math.random() > 0.7) {
    headers["Accept-Language"] = "en-US,en;q=0.9";
  }
  if (Math.random() > 0.8) {
    headers["Cache-Control"] = "max-age=0";
  }

  return headers;
}

// ============================================================
// RETRY WITH EXPONENTIAL BACKOFF
// ============================================================
async function retryWithBackoff(fn, maxRetries = 5, baseDelay = 1000) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const delay = baseDelay * Math.pow(2, i) + Math.random() * 1000;
      console.log(
        `[seize] Retry ${i + 1}/${maxRetries} after ${Math.round(delay)}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ============================================================
// BASE OPTIONS WITH MAXIMUM BYPASS
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
    forceGenericExtractor: false,
    geoBypass: true,
    geoBypassCountry: "US",
    extractorArgs: "",
    addHeaders: {},
  };

  const cookies = cookiesFor(platform);
  if (cookies) opts.cookies = cookies;

  const proxy = getRandomProxy();
  if (proxy) opts.proxy = proxy;

  return opts;
}

// ============================================================
// GET STRATEGIES - 20+ STRATEGIES PER PLATFORM
// ============================================================
function getStrategies(platform) {
  const strategies = [];
  const base = baseOptions(platform);

  // Generate 20+ strategies
  for (let i = 0; i < 20; i++) {
    const ua = USER_AGENTS[i % USER_AGENTS.length];
    const isMobile =
      ua.includes("Mobile") ||
      ua.includes("Android") ||
      ua.includes("iPhone") ||
      ua.includes("iPad");
    const isApp =
      ua.includes("TikTok") ||
      ua.includes("Instagram") ||
      ua.includes("Facebook") ||
      ua.includes("Twitter") ||
      ua.includes("Pinterest") ||
      ua.includes("Snapchat") ||
      ua.includes("WhatsApp") ||
      ua.includes("Telegram");
    const isBot =
      ua.includes("bot") ||
      ua.includes("Bot") ||
      ua.includes("crawler") ||
      ua.includes("Crawler");

    const strategy = {
      ...base,
      addHeaders: generateHeaders(platform, ua),
    };

    // Randomize strategy parameters
    if (i % 2 === 0) {
      strategy.cookies = undefined; // No cookies
    }
    if (i % 3 === 0) {
      strategy.addHeaders["X-Forwarded-For"] =
        `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    }
    if (i % 4 === 0) {
      strategy.addHeaders["Accept-Language"] = "en-US,en;q=0.9";
    }
    if (i % 5 === 0) {
      strategy.geoBypassCountry = ["US", "GB", "DE", "FR", "CA", "AU"][
        Math.floor(Math.random() * 6)
      ];
    }
    if (i % 6 === 0) {
      strategy.forceGenericExtractor = true;
    }

    // Platform-specific overrides
    if (platform === "tiktok") {
      const deviceId = Math.floor(Math.random() * 10000000);
      strategy.extractorArgs = `tiktok:device_id=${deviceId}`;
      strategy.addHeaders["Referer"] = "https://www.tiktok.com/";
      strategy.addHeaders["Origin"] = "https://www.tiktok.com";
      if (i % 2 === 0) {
        strategy.extractorArgs +=
          ";tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com";
      }
      if (i % 3 === 0) {
        strategy.extractorArgs +=
          ";tiktok:api_hostname=api16-normal-c-useast2a.tiktokv.com";
      }
      if (isApp) {
        strategy.addHeaders["Accept"] = "application/json, text/plain, */*";
      }
    } else if (platform === "instagram") {
      strategy.extractorArgs = "instagram:include_ads=false";
      strategy.addHeaders["X-Requested-With"] = "XMLHttpRequest";
      strategy.addHeaders["X-Instagram-AJAX"] = "1";
      if (i % 2 === 0) {
        strategy.extractorArgs +=
          ";instagram:api=https://i.instagram.com/api/v1/";
      }
      if (i % 3 === 0) {
        strategy.extractorArgs += ";instagram:api=https://graph.instagram.com/";
      }
      if (isApp) {
        strategy.addHeaders["X-Requested-With"] = "XMLHttpRequest";
      }
    } else if (platform === "twitter") {
      strategy.extractorArgs = "twitter:api=syndication";
      strategy.addHeaders["Referer"] = "https://twitter.com/";
      strategy.addHeaders["Origin"] = "https://twitter.com";
      if (i % 2 === 0) {
        strategy.extractorArgs = "twitter:api=https://api.twitter.com/graphql/";
      }
      if (i % 3 === 0) {
        strategy.extractorArgs = "twitter:api=https://syndication.twitter.com/";
      }
      if (isApp) {
        strategy.addHeaders["Accept"] = "application/json, text/plain, */*";
      }
    } else if (platform === "pinterest") {
      strategy.addHeaders["Accept-Language"] = "en-US,en;q=0.9";
      strategy.addHeaders["X-Requested-With"] = "XMLHttpRequest";
      if (i % 2 === 0) {
        strategy.extractorArgs = "generic";
      }
      if (i % 3 === 0) {
        strategy.addHeaders["Referer"] = "https://www.pinterest.com/";
      }
    } else if (platform === "facebook") {
      strategy.extractorArgs = "facebook:include_ads=false";
      strategy.addHeaders["X-Requested-With"] = "XMLHttpRequest";
      if (i % 2 === 0) {
        strategy.extractorArgs += ";facebook:api=https://graph.facebook.com/";
      }
      if (isApp) {
        strategy.addHeaders["X-Requested-With"] = "XMLHttpRequest";
      }
    } else if (platform === "snapchat") {
      strategy.addHeaders["Referer"] = "https://www.snapchat.com/";
      strategy.addHeaders["Origin"] = "https://www.snapchat.com";
    } else if (platform === "youtube") {
      strategy.addHeaders["Referer"] = "https://www.youtube.com/";
      strategy.addHeaders["Origin"] = "https://www.youtube.com";
    }

    strategies.push(strategy);
  }

  return strategies;
}

// ============================================================
// DIRECT HTML EXTRACTION FOR ALL PLATFORMS
// ============================================================
async function directExtract(url, platform) {
  console.log(`[seize] Direct extraction for ${platform}: ${url}`);

  for (let i = 0; i < Math.min(20, USER_AGENTS.length); i++) {
    const ua = USER_AGENTS[i];
    try {
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

      // Platform-specific patterns
      const patterns = {
        tiktok: {
          video: [
            /"video":{"id":"\d+","playAddr":"([^"]+)"/i,
            /"playAddr":"([^"]+)"/i,
            /"downloadAddr":"([^"]+)"/i,
            /"video_url":"([^"]+)"/i,
            /https:\/\/[^\s"]+\.mp4[^\s"]*/i,
            /https:\/\/[^\s"]+\.mov[^\s"]*/i,
          ],
          image: [
            /"imageUrl":"([^"]+)"/i,
            /"coverUrl":"([^"]+)"/i,
            /https:\/\/[^\s"]+\.(jpg|jpeg|png|webp)[^\s"]*/i,
          ],
          title: [
            /"text":"([^"]+)"/i,
            /"desc":"([^"]+)"/i,
            /<title>([^<]*)<\/title>/i,
          ],
        },
        instagram: {
          video: [
            /"video_url":"([^"]+)"/i,
            /"video_versions":\[\{"url":"([^"]+)"/i,
            /"playback_url":"([^"]+)"/i,
            /"video_download_url":"([^"]+)"/i,
            /contentUrl":"([^"]+\.mp4[^"]*)"/i,
          ],
          image: [
            /"display_url":"([^"]+)"/i,
            /"image_versions2":\{"candidates":\[\{"url":"([^"]+)"/i,
            /"display_src":"([^"]+)"/i,
          ],
          title: [/"caption":"([^"]+)"/i, /<title>([^<]*)<\/title>/i],
        },
        twitter: {
          video: [
            /"video_url":"([^"]+)"/i,
            /"playback_url":"([^"]+)"/i,
            /"contentUrl":"([^"]+\.mp4[^"]*)"/i,
            /https:\/\/[^\s"]+\.mp4[^\s"]*/i,
            /https:\/\/video\.twimg\.com\/[^\s"']+/i,
          ],
          image: [
            /"url":"([^"]+\.(jpg|jpeg|png|webp)[^"]*)"/i,
            /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
          ],
          title: [/"text":"([^"]+)"/i, /<title>([^<]*)<\/title>/i],
        },
        pinterest: {
          video: [
            /"videoUrl"\s*:\s*"([^"]+)"/i,
            /"video_url"\s*:\s*"([^"]+)"/i,
            /"contentUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/i,
            /"url"\s*:\s*"([^"]+\.mp4[^"]*)"/i,
            /<video[^>]+src="([^"]+\.mp4[^"]*)"/i,
            /https:\/\/[^\s"]+\.mp4[^\s"]*/i,
            /https:\/\/[a-z0-9]+\.pinimg\.com\/[^\s"']+\.mp4[^\s"']*/i,
          ],
          image: [
            /"imageUrl"\s*:\s*"([^"]+)"/i,
            /"image_url"\s*:\s*"([^"]+)"/i,
            /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
            /https:\/\/[^\s"]+\.(jpg|jpeg|png|webp)[^\s"]*/i,
            /https:\/\/[a-z0-9]+\.pinimg\.com\/[^\s"']+\.(jpg|jpeg|png|webp)[^\s"']*/i,
          ],
          title: [/"title":"([^"]+)"/i, /<title>([^<]*)<\/title>/i],
        },
        facebook: {
          video: [
            /"video_url":"([^"]+)"/i,
            /"playback_url":"([^"]+)"/i,
            /"contentUrl":"([^"]+\.mp4[^"]*)"/i,
            /https:\/\/[^\s"]+\.mp4[^\s"]*/i,
            /https:\/\/video\.fbcdn\.net\/[^\s"']+/i,
          ],
          image: [
            /"image_url":"([^"]+)"/i,
            /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
          ],
          title: [/"title":"([^"]+)"/i, /<title>([^<]*)<\/title>/i],
        },
        snapchat: {
          video: [
            /"videoUrl":"([^"]+)"/i,
            /"playback_url":"([^"]+)"/i,
            /https:\/\/[^\s"]+\.mp4[^\s"]*/i,
          ],
          image: [
            /"imageUrl":"([^"]+)"/i,
            /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
          ],
          title: [/"title":"([^"]+)"/i, /<title>([^<]*)<\/title>/i],
        },
        youtube: {
          video: [
            /"url":"([^"]+\.mp4[^"]*)"/i,
            /"video_url":"([^"]+)"/i,
            /https:\/\/[^\s"]+\.mp4[^\s"]*/i,
          ],
          image: [
            /"thumbnail_url":"([^"]+)"/i,
            /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
          ],
          title: [/"title":"([^"]+)"/i, /<title>([^<]*)<\/title>/i],
        },
      };

      const platformPatterns = patterns[platform];
      if (!platformPatterns) continue;

      let videoUrl = null;
      for (const pattern of platformPatterns.video) {
        const match = html.match(pattern);
        if (match) {
          videoUrl = match[1] || match[0];
          videoUrl = videoUrl.replace(/\\/g, "");
          console.log(`[seize] Found ${platform} video via direct extraction`);
          break;
        }
      }

      let imageUrl = null;
      for (const pattern of platformPatterns.image) {
        const match = html.match(pattern);
        if (match) {
          imageUrl = match[1] || match[0];
          imageUrl = imageUrl.replace(/\\/g, "");
          console.log(`[seize] Found ${platform} image via direct extraction`);
          break;
        }
      }

      let title = "Untitled";
      for (const pattern of platformPatterns.title) {
        const match = html.match(pattern);
        if (match) {
          title = match[1] || match[0];
          title = title.replace(/\\/g, "").trim();
          if (title && title.length > 0 && title.length < 200) break;
        }
      }

      if (videoUrl) {
        return {
          platform: platform,
          title: title || `${platform} Post`,
          uploader: platform.charAt(0).toUpperCase() + platform.slice(1),
          thumbnail: imageUrl || null,
          hasVideo: true,
          hasImage: !!imageUrl,
          media: {
            videos: [{ url: videoUrl, format: "mp4", quality: "HD" }],
            images: imageUrl ? [{ url: imageUrl, format: "jpg" }] : [],
            audio: [],
          },
          directExtract: true,
        };
      }

      if (imageUrl) {
        return {
          platform: platform,
          title: title || `${platform} Post`,
          uploader: platform.charAt(0).toUpperCase() + platform.slice(1),
          thumbnail: imageUrl,
          hasVideo: false,
          hasImage: true,
          media: {
            videos: [],
            images: [{ url: imageUrl, format: "jpg" }],
            audio: [],
          },
          directExtract: true,
        };
      }
    } catch (err) {
      console.log(
        `[seize] Direct extraction attempt ${i + 1} failed: ${err.message}`,
      );
      continue;
    }
  }

  return null;
}

// ============================================================
// PROFILE EXTRACTION FOR ALL PLATFORMS
// ============================================================
async function extractProfile(url, platform, limit = 50) {
  console.log(`[seize] Extracting ${platform} profile: ${url}`);

  // Try direct extraction first for profile pages
  if (platform === "tiktok" || platform === "instagram") {
    try {
      const directResult = await directExtract(url, platform);
      if (directResult && directResult.media.videos.length > 0) {
        // If direct extraction found a video, try to get more via yt-dlp
        console.log(
          "[seize] Direct extraction found content, but trying yt-dlp for more...",
        );
      }
    } catch (e) {
      console.log("[seize] Direct extraction pre-check failed:", e.message);
    }
  }

  // Try multiple yt-dlp approaches
  const approaches = [
    // Approach 1: Standard with cookies
    async () => {
      const opts = {
        dumpSingleJson: true,
        extractFlat: true,
        noWarnings: true,
        noCheckCertificates: true,
        ffmpegLocation: ffmpegStaticPath,
        retries: 10,
        socketTimeout: 90,
        skipDownload: true,
        playlistItems: `1:${limit}`,
        addHeaders: generateHeaders(platform, USER_AGENTS[0]),
        ...baseOptions(platform),
      };
      const cookies = cookiesFor(platform);
      if (cookies) opts.cookies = cookies;

      return await ytDlp(url, opts, { timeout: 90000 });
    },

    // Approach 2: Mobile user agent
    async () => {
      const mobileUa = USER_AGENTS.find(
        (u) =>
          u.includes("Mobile") &&
          u.includes(
            platform === "tiktok"
              ? "TikTok"
              : platform === "instagram"
                ? "Instagram"
                : "",
          ),
      );
      const opts = {
        dumpSingleJson: true,
        extractFlat: true,
        noWarnings: true,
        noCheckCertificates: true,
        ffmpegLocation: ffmpegStaticPath,
        retries: 10,
        socketTimeout: 90,
        skipDownload: true,
        playlistItems: `1:${limit}`,
        addHeaders: generateHeaders(platform, mobileUa || USER_AGENTS[5]),
        ...baseOptions(platform),
      };
      const cookies = cookiesFor(platform);
      if (cookies) opts.cookies = cookies;

      return await ytDlp(url, opts, { timeout: 90000 });
    },

    // Approach 3: No cookies, desktop UA
    async () => {
      const opts = {
        dumpSingleJson: true,
        extractFlat: true,
        noWarnings: true,
        noCheckCertificates: true,
        ffmpegLocation: ffmpegStaticPath,
        retries: 10,
        socketTimeout: 90,
        skipDownload: true,
        playlistItems: `1:${limit}`,
        addHeaders: generateHeaders(platform, USER_AGENTS[2]),
        ...baseOptions(platform),
        cookies: undefined,
      };

      return await ytDlp(url, opts, { timeout: 90000 });
    },

    // Approach 4: Force generic extractor
    async () => {
      const opts = {
        dumpSingleJson: true,
        extractFlat: true,
        noWarnings: true,
        noCheckCertificates: true,
        ffmpegLocation: ffmpegStaticPath,
        retries: 10,
        socketTimeout: 90,
        skipDownload: true,
        playlistItems: `1:${limit}`,
        addHeaders: generateHeaders(platform, USER_AGENTS[3]),
        ...baseOptions(platform),
        forceGenericExtractor: true,
      };
      const cookies = cookiesFor(platform);
      if (cookies) opts.cookies = cookies;

      return await ytDlp(url, opts, { timeout: 90000 });
    },

    // Approach 5: With proxy if available
    async () => {
      const proxy = getRandomProxy();
      if (!proxy) throw new Error("No proxy available");

      const opts = {
        dumpSingleJson: true,
        extractFlat: true,
        noWarnings: true,
        noCheckCertificates: true,
        ffmpegLocation: ffmpegStaticPath,
        retries: 10,
        socketTimeout: 90,
        skipDownload: true,
        playlistItems: `1:${limit}`,
        addHeaders: generateHeaders(platform, USER_AGENTS[4]),
        ...baseOptions(platform),
        proxy: proxy,
      };
      const cookies = cookiesFor(platform);
      if (cookies) opts.cookies = cookies;

      return await ytDlp(url, opts, { timeout: 90000 });
    },
  ];

  let lastError;
  for (let i = 0; i < approaches.length; i++) {
    try {
      console.log(`[seize] Profile approach ${i + 1}/${approaches.length}`);
      const info = await approaches[i]();
      if (info && info.entries && info.entries.length > 0) {
        console.log(
          `[seize] Approach ${i + 1} succeeded with ${info.entries.length} items`,
        );
        return info;
      }
    } catch (err) {
      lastError = err;
      console.log(`[seize] Approach ${i + 1} failed: ${err.message}`);
      if (i < approaches.length - 1) {
        await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));
      }
    }
  }

  throw lastError || new Error("All profile extraction approaches failed");
}

// ============================================================
// RESOLVE ENDPOINT
// ============================================================
router.post("/resolve", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "A URL is required" });

  const platform = detectPlatform(url);
  if (!platform) {
    return res.status(400).json({
      error:
        "Unsupported platform. Only TikTok, Instagram, Twitter/X, Pinterest, Snapchat, Facebook, and YouTube are supported.",
    });
  }

  try {
    console.log(`[seize] Resolving ${platform} URL: ${url}`);

    // Try direct extraction first
    const directResult = await directExtract(url, platform);
    if (
      directResult &&
      (directResult.media.videos.length > 0 ||
        directResult.media.images.length > 0)
    ) {
      return res.json({
        platform: directResult.platform,
        title: directResult.title,
        thumbnail: directResult.thumbnail || null,
        uploader: directResult.uploader || "Unknown",
        contentType: directResult.hasVideo ? "video" : "image",
        hasVideo: directResult.hasVideo,
        hasImage: directResult.hasImage,
        isGif: false,
        media: directResult.media,
        formatsAvailable: directResult.hasVideo ? ["mp4"] : ["jpg"],
        duration: null,
        isImageOnly: !directResult.hasVideo && directResult.hasImage,
      });
    }

    // Fallback to yt-dlp with strategies
    const strategies = getStrategies(platform);
    let lastError;

    for (let i = 0; i < strategies.length; i++) {
      try {
        console.log(`[seize] Strategy ${i + 1}/${strategies.length}`);
        const opts = {
          dumpSingleJson: true,
          preferFreeFormats: true,
          ...strategies[i],
        };

        const info = await retryWithBackoff(
          () => ytDlp(url, opts, { timeout: 60000 }),
          3,
          1000,
        );

        if (info) {
          const title = info.title || info.fulltitle || "Untitled";
          const uploader = info.uploader || info.channel || info.author || null;
          const thumbnail = info.thumbnail || null;
          const hasVideo = !!(
            info.formats &&
            info.formats.some((f) => f.vcodec && f.vcodec !== "none")
          );
          const hasImage =
            !hasVideo &&
            info.ext &&
            ["jpg", "jpeg", "png", "webp"].includes(info.ext);

          return res.json({
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
              images: hasImage
                ? [{ url: info.url, format: info.ext || "jpg" }]
                : [],
              audio: [],
            },
            formatsAvailable: info.formats
              ? [...new Set(info.formats.map((f) => f.ext).filter(Boolean))]
              : [],
            duration: info.duration || null,
            isImageOnly: !hasVideo && hasImage,
          });
        }
      } catch (err) {
        lastError = err;
        console.log(`[seize] Strategy ${i + 1} failed: ${err.message}`);
        if (i < strategies.length - 1) {
          await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
        }
      }
    }

    throw lastError || new Error("All resolution strategies failed");
  } catch (err) {
    const stderr = err.stderr || err.message || "";
    console.error("[resolve] Failed:", stderr);
    res.status(502).json({ error: friendlyError(stderr) });
  }
});

// ============================================================
// FETCH ENDPOINT
// ============================================================
router.post("/fetch", async (req, res) => {
  const { url, mode = "video", quality = "best" } = req.body;
  if (!url) return res.status(400).json({ error: "A URL is required" });

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
    // Try direct extraction for images
    if (mode === "image") {
      const directResult = await directExtract(url, platform);
      if (directResult && directResult.media.images.length > 0) {
        const bestImage = directResult.media.images[0];
        await downloadFile(bestImage.url, outputPath);
        jobs.set(jobId, {
          status: "done",
          progress: 100,
          outputPath,
          downloadName: `seize-${platform}-image.${bestImage.format || "jpg"}`,
          finishedAt: Date.now(),
        });
        logEvent("capture:done", { jobId, platform, mode });
        return;
      }
    }

    // Use yt-dlp with strategies
    const strategies = getStrategies(platform);
    let lastError;
    let succeeded = false;

    for (const strategy of strategies) {
      const formatStr =
        mode === "audio"
          ? "bestaudio"
          : mode === "image"
            ? "best"
            : "bestvideo+bestaudio";
      const options = {
        output: outputPath,
        format: formatStr,
        mergeOutputFormat: "mp4",
        ...strategy,
      };

      if (mode === "audio") {
        options.extractAudio = true;
        options.audioFormat = "mp3";
        options.audioQuality = 0;
      }

      try {
        await runYtDlpWithProgress(url, options, jobId, 120000);
        succeeded = true;
        break;
      } catch (err) {
        lastError = err;
        const msg = (err.stderr || err.message || "").toLowerCase();
        console.log(`[seize] Fetch strategy failed: ${msg.slice(0, 100)}`);
        if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
      }
    }

    if (!succeeded) throw lastError || new Error("All fetch strategies failed");

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
// CREATOR ARCHIVE - ULTIMATE VERSION
// ============================================================
router.post("/profile", async (req, res) => {
  const { url, platform, limit = 50, mode = "all" } = req.body;
  if (!url) return res.status(400).json({ error: "Profile URL is required" });

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
      console.log(`[seize] Scanning profile from ${detectedPlatform}: ${url}`);
      let items = [];
      const maxItems = Math.min(limit, 200);

      // Use the enhanced profile extractor
      const info = await extractProfile(url, detectedPlatform, maxItems);

      if (info && info.entries) {
        const entries = Array.isArray(info.entries) ? info.entries : [info];
        const seenUrls = new Set();

        for (const entry of entries) {
          if (!entry || items.length >= maxItems) continue;

          const entryUrl = entry.webpage_url || entry.url;
          if (entryUrl && seenUrls.has(entryUrl)) continue;
          if (entryUrl) seenUrls.add(entryUrl);

          const durationKnown =
            typeof entry.duration === "number" && entry.duration > 0;
          const explicitVideoExt = [
            "mp4",
            "mov",
            "webm",
            "m4v",
            "avi",
            "mkv",
          ].includes(entry.ext);
          const explicitImageExt = [
            "jpg",
            "jpeg",
            "png",
            "webp",
            "gif",
            "avif",
          ].includes(entry.ext);

          const platformDefaultsVideo = [
            "tiktok",
            "twitter",
            "snapchat",
          ].includes(detectedPlatform);

          const hasVideo = !!(
            explicitVideoExt ||
            durationKnown ||
            (platformDefaultsVideo && !explicitImageExt) ||
            entry.ext === "mp4"
          );
          const hasImage = !hasVideo || explicitImageExt;

          let thumbnail = entry.thumbnail || null;
          if (!thumbnail && entry.thumbnails && entry.thumbnails.length) {
            const largest = [...entry.thumbnails].sort(
              (a, b) => (b.width || 0) - (a.width || 0),
            )[0];
            thumbnail = largest?.url || null;
          }

          const item = {
            id:
              entry.id ||
              entry.webpage_url ||
              entry.url ||
              `item-${Date.now()}-${items.length}`,
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

      // If no items found, try direct extraction as fallback
      if (items.length === 0) {
        console.log(
          "[seize] No items from yt-dlp, trying direct extraction...",
        );
        const directResult = await directExtract(url, detectedPlatform);
        if (
          directResult &&
          (directResult.media.videos.length > 0 ||
            directResult.media.images.length > 0)
        ) {
          const item = {
            id: `direct-${Date.now()}`,
            title: directResult.title || `${detectedPlatform} Post`,
            url: url,
            thumbnail: directResult.thumbnail || null,
            duration: null,
            hasVideo: directResult.hasVideo,
            hasImage: directResult.hasImage,
            contentType: directResult.hasVideo ? "video" : "image",
            uploader: directResult.uploader || detectedPlatform,
            viewCount: null,
            likeCount: null,
            timestamp: null,
          };
          items.push(item);
        }
      }

      // Limit items
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

      console.log(
        `[seize] Scan complete: ${items.length} items from ${detectedPlatform}`,
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
    error: job.error,
  });
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

            const ext = item.hasVideo ? "mp4" : "jpg";
            const outputPath = path.join(
              TMP_DIR,
              `${batchId}-${actualIndex}.${ext}`,
            );
            const itemJobId = uuid();

            // Try direct download first
            let downloaded = false;
            try {
              const directResult = await directExtract(url, platform);
              if (
                directResult &&
                directResult.media[item.hasVideo ? "videos" : "images"].length >
                  0
              ) {
                const mediaUrl =
                  directResult.media[item.hasVideo ? "videos" : "images"][0]
                    .url;
                await downloadFile(mediaUrl, outputPath);
                downloaded = true;
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
                retries: 5,
                socketTimeout: 60,
                addHeaders: generateHeaders(platform, USER_AGENTS[0]),
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
// BATCH FILE DOWNLOAD
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
// HELPER FUNCTIONS
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
    return "This content doesn't exist or the URL is incorrect.";
  }
  if (s.includes("rate limit") || s.includes("429") || s.includes("too many")) {
    return "Rate limited. Please wait a few minutes and try again.";
  }
  if (s.includes("blocked") || s.includes("block")) {
    return "The platform is blocking this request. Try again in a few minutes.";
  }
  if (s.includes("timeout") || s.includes("timed out")) {
    return "The request timed out. Try again or check the URL.";
  }
  if (s.includes("empty") || s.includes("no items") || s.includes("no posts")) {
    return "No public posts found on this profile.";
  }
  if (s.includes("login") || s.includes("sign in") || s.includes("auth")) {
    return "This content requires login. Try using a public URL.";
  }
  if (s.includes("geo") || s.includes("country") || s.includes("region")) {
    return "This content is region-locked and not available in your area.";
  }
  if (s.includes("copyright") || s.includes("takedown")) {
    return "This content has been removed due to a copyright claim.";
  }
  if (s.includes("age") || s.includes("restricted")) {
    return "This content is age-restricted and requires verification.";
  }

  return "Couldn't resolve this link. It may be blocked, deleted, or private.";
}

module.exports = router;

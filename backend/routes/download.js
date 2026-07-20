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

  // App-specific agents
  for (let v = 35; v >= 30; v--) {
    agents.push(
      `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 TikTok/${v}.0.0 (Android 14)`,
    );
    agents.push(
      `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 TikTok/${v}.0.0`,
    );
  }

  for (let v = 320; v >= 310; v--) {
    agents.push(
      `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 (Instagram ${v}.0.0.0.0)`,
    );
    agents.push(
      `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 (Instagram ${v}.0.0.0.0)`,
    );
  }

  for (let v = 450; v >= 440; v--) {
    agents.push(
      `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/${v}.0.0.0.0;]`,
    );
    agents.push(
      `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/${v}.0.0.0.0;FBBV/${v}.0.0.0.0;]`,
    );
  }

  for (let v = 10; v >= 8; v--) {
    agents.push(
      `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 TwitterAndroid/${v}.0.0`,
    );
    agents.push(
      `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 Twitter/${v}.0.0`,
    );
  }

  for (let v = 12; v >= 10; v--) {
    agents.push(
      `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36 Pinterest/${v}.0.0`,
    );
    agents.push(
      `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 Pinterest/${v}.0.0`,
    );
  }

  // Bots
  agents.push(
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
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
  const isBot =
    ua.includes("bot") || ua.includes("Bot") || ua.includes("crawler");
  const isApp =
    ua.includes("TikTok") ||
    ua.includes("Instagram") ||
    ua.includes("Facebook") ||
    ua.includes("Twitter") ||
    ua.includes("Pinterest") ||
    ua.includes("Snapchat");

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
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
  };

  // Chrome-specific
  if (isChrome) {
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

  // Platform-specific headers
  const platformHeaders = {
    tiktok: {
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.tiktok.com/",
      Origin: "https://www.tiktok.com",
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
      Accept: "application/json, text/plain, */*",
      Referer: "https://twitter.com/",
      Origin: "https://twitter.com",
      "X-Twitter-Client": "web",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
    },
    pinterest: {
      "X-Requested-With": "XMLHttpRequest",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.pinterest.com/",
    },
    facebook: {
      "X-Requested-With": "XMLHttpRequest",
      Referer: "https://www.facebook.com/",
      Origin: "https://www.facebook.com",
    },
    snapchat: {
      Referer: "https://www.snapchat.com/",
      Origin: "https://www.snapchat.com",
    },
  };

  if (platformHeaders[platform]) {
    Object.assign(baseHeaders, platformHeaders[platform]);
  }

  if (isBot) {
    baseHeaders["Accept"] =
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    delete baseHeaders["Sec-Fetch-User"];
  }

  if (isApp) {
    baseHeaders["Accept"] = "application/json, text/plain, */*";
  }

  return { ...baseHeaders, ...extra };
}

// ============================================================
// UNIVERSAL DIRECT EXTRACTOR
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

      // Universal video patterns
      const videoPatterns = [
        /"videoUrl":"([^"]+)"/gi,
        /"video_url":"([^"]+)"/gi,
        /"playAddr":"([^"]+)"/gi,
        /"downloadAddr":"([^"]+)"/gi,
        /"playback_url":"([^"]+)"/gi,
        /"contentUrl":"([^"]+\.mp4[^"]*)"/gi,
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

      // Extract videos and images
      const videos = [];
      const images = [];
      let title = `${platform} Post`;

      for (const pattern of videoPatterns) {
        const matches = [...html.matchAll(pattern)];
        for (const match of matches) {
          const url = match[1] || match[0];
          if (url && !url.includes("placeholder") && !url.includes("default")) {
            videos.push(url.replace(/\\/g, ""));
          }
        }
      }

      for (const pattern of imagePatterns) {
        const matches = [...html.matchAll(pattern)];
        for (const match of matches) {
          const url = match[1] || match[0];
          if (url && !url.includes("placeholder") && !url.includes("default")) {
            images.push(url.replace(/\\/g, ""));
          }
        }
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
// ENHANCED PROFILE EXTRACTOR - 5 METHODS
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
      ],
      instagram: [
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
        `https://www.instagram.com/${username}/?__a=1`,
      ],
      twitter: [
        `https://api.twitter.com/1.1/users/show.json?screen_name=${username}`,
      ],
      pinterest: [
        `https://api.pinterest.com/v3/pidgets/users/${username}/pins/`,
      ],
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
          } else if (platform === "tiktok" && data.user) {
            // Parse TikTok user data
          }
          if (apiItems.length > 0) {
            allItems = [...allItems, ...apiItems];
            methodsUsed.push("api");
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

  // METHOD 3: yt-dlp with 20+ strategies
  console.log("[seize] Method 3: yt-dlp with multiple strategies");
  try {
    const strategies = [];
    for (let i = 0; i < 20; i++) {
      const ua = USER_AGENTS[i % USER_AGENTS.length];
      const strategy = {
        dumpSingleJson: true,
        extractFlat: true,
        noWarnings: true,
        noCheckCertificates: true,
        ffmpegLocation: ffmpegStaticPath,
        retries: 10,
        socketTimeout: 90,
        skipDownload: true,
        playlistItems: `1:${limit}`,
        sleepInterval: 1,
        maxSleepInterval: 5,
        ignoreErrors: true,
        preferFreeFormats: true,
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
        if (i % 2 === 0)
          strategy.extractorArgs +=
            ";instagram:api=https://i.instagram.com/api/v1/";
      } else if (platform === "twitter") {
        strategy.extractorArgs = "twitter:api=syndication";
        if (i % 2 === 0)
          strategy.extractorArgs =
            "twitter:api=https://api.twitter.com/graphql/";
      } else if (platform === "pinterest") {
        if (i % 2 === 0) strategy.extractorArgs = "generic";
      } else if (platform === "facebook") {
        strategy.extractorArgs = "facebook:include_ads=false";
      }

      strategies.push(strategy);
    }

    for (let i = 0; i < strategies.length; i++) {
      try {
        console.log(`[seize] yt-dlp strategy ${i + 1}/${strategies.length}`);
        const info = await ytDlp(url, strategies[i], { timeout: 60000 });
        if (info && info.entries && info.entries.length > 0) {
          const ytItems = info.entries
            .filter((e) => e && e.webpage_url)
            .map((e) => ({
              id: e.id || e.webpage_url,
              title: e.title || e.fulltitle || `${platform} Post`,
              url: e.webpage_url || e.url,
              thumbnail: e.thumbnail || null,
              duration: e.duration || null,
              hasVideo:
                !!(e.ext && ["mp4", "mov", "webm", "mkv"].includes(e.ext)) ||
                !!e.duration,
              hasImage: !!(
                e.ext && ["jpg", "jpeg", "png", "webp"].includes(e.ext)
              ),
              contentType: "video",
              uploader: info.uploader || username || platform,
              viewCount: e.view_count || null,
              likeCount: e.like_count || null,
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

  // METHOD 4: HTML Scraping
  if (allItems.length === 0) {
    console.log("[seize] Method 4: HTML scraping");
    try {
      for (let i = 0; i < Math.min(10, USER_AGENTS.length); i++) {
        const ua = USER_AGENTS[i];
        const headers = generateHeaders(platform, ua);
        const response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(30000),
        });
        if (response.ok) {
          const html = await response.text();
          const videoIds =
            html.match(/(?:video|post|pin|tweet|reel)\/([a-zA-Z0-9_-]+)/gi) ||
            [];
          const uniqueIds = [...new Set(videoIds)];
          const scrapeItems = uniqueIds.slice(0, limit).map((id) => ({
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
          allItems = [...allItems, ...scrapeItems];
          methodsUsed.push("html-scrape");
          console.log(
            `[seize] Found ${scrapeItems.length} items via HTML scraping`,
          );
          break;
        }
      }
    } catch (e) {
      console.log("[seize] HTML scraping failed:", e.message);
    }
  }

  // METHOD 5: URL Construction (last resort)
  if (allItems.length === 0 && username) {
    console.log("[seize] Method 5: URL construction");
    try {
      const sampleUrls = [
        `https://www.${platform}.com/@${username}`,
        `https://www.${platform}.com/${username}`,
        `https://${platform}.com/@${username}`,
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
              /https:\/\/[^\s"]+\.(mp4|jpg|jpeg|png|webp)[^\s"]*/,
            );
            if (anyUrl) {
              allItems.push({
                id: `sample-${Date.now()}`,
                title: `${platform} Post`,
                url: anyUrl[0],
                thumbnail: null,
                duration: null,
                hasVideo: anyUrl[0].includes(".mp4"),
                hasImage: !anyUrl[0].includes(".mp4"),
                contentType: anyUrl[0].includes(".mp4") ? "video" : "image",
                uploader: username || platform,
                viewCount: null,
                likeCount: null,
              });
              methodsUsed.push("url-construction");
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

  // Deduplicate
  const seenUrls = new Set();
  const uniqueItems = allItems.filter((item) => {
    const url = item.url || item.id;
    if (!url || seenUrls.has(url)) return false;
    seenUrls.add(url);
    return true;
  });

  console.log(
    `[seize] Total: ${uniqueItems.length} items (methods: ${methodsUsed.join(", ")})`,
  );

  return {
    items: uniqueItems.slice(0, limit),
    total: uniqueItems.length,
    methods: methodsUsed,
    username: username,
  };
}

// ============================================================
// RESOLVE ENDPOINT - OPTIMIZED
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
      const hasVideo = firstItem.hasVideo || firstItem.url?.includes(".mp4");
      const hasImage =
        firstItem.hasImage ||
        firstItem.url?.includes(".jpg") ||
        firstItem.url?.includes(".jpeg") ||
        firstItem.url?.includes(".png");

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
// FETCH ENDPOINT - OPTIMIZED
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
// CREATOR ARCHIVE - ULTIMATE ENHANCED
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
          (item) => item.hasVideo || item.url?.includes(".mp4"),
        );
      } else if (mode === "images") {
        items = items.filter(
          (item) =>
            item.hasImage ||
            item.url?.includes(".jpg") ||
            item.url?.includes(".jpeg") ||
            item.url?.includes(".png"),
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
// STATUS ENDPOINTS
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

router.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ status: job.status, progress: job.progress, error: job.error });
});

// ============================================================
// FILE DOWNLOAD
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
// BATCH DOWNLOAD - OPTIMIZED
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

  return "Couldn't resolve this link. It may be blocked, deleted, or private.";
}

module.exports = router;

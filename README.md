# seize

Capture media from TikTok, Instagram, Twitter/X and YouTube, and convert between video and audio — clean, fast, installable as an app on both desktop and mobile.

---

## 1. What's in this project

```
seize/
├── backend/           Express API — conversion engine + capture engine
│   ├── server.js
│   ├── routes/
│   │   ├── convert.js     video↔audio conversion (ffmpeg)
│   │   └── download.js    TikTok/Instagram/Twitter/YouTube resolver + fetch (yt-dlp)
│   └── utils/ffmpeg.js
└── frontend/           Single static PWA — no build step required
    ├── index.html
    ├── style.css
    ├── app.js
    ├── manifest.json
    ├── sw.js
    └── icons/
```

The backend serves the frontend as static files too, so in production it's **one process, one deploy**.

---

## 2. Local setup

### Requirements
- Node.js 18+
- Python 3.8+ (yt-dlp dependency) — `yt-dlp-exec` downloads its own yt-dlp binary on first install
- ffmpeg is bundled automatically via `ffmpeg-static` / `ffprobe-static` — no system install needed

### Install & run

```bash
cd backend
npm install
cp .env.example .env
npm start
```

Visit `http://localhost:4000`. That's the whole app — frontend and API on one port.

For active development with auto-restart:
```bash
npm run dev
```

---

## 3. How the capture engine works (read this before your demo)

The `/api/download` routes use **yt-dlp**, the actively-maintained open-source tool that resolves a platform's original source media file rather than re-downloading whatever a platform's own app has re-encoded (which is where in-app watermarks usually get burned in). This is the same engine behind most reputable "no watermark" tools.

**Be upfront about the honest limits of this, especially for a live demo:**
- TikTok, Instagram, and Twitter/X change their site frequently. When they do, yt-dlp's maintainers ship a fix — sometimes within hours, sometimes it takes longer. If a specific link fails on demo day, that's the platform side breaking, not a bug in this codebase.
- Private posts, age-restricted content, and some region-locked videos won't resolve.
- This pulls **public** content only — there's no login flow, and it should stay that way.
- Respect the platforms' Terms of Service and the original creator's rights: this tool is best framed (and used) as a personal-use utility, not a redistribution service. Worth a line on this in your project writeup.

If yt-dlp ever falls behind on a specific platform, updating it is a one-line fix:
```bash
cd backend && npx yt-dlp-exec --update
```

---

## 4. Deploying it live (so your demo has a real URL)

Any Node host works since it's a single Express process. Fastest paths:

**Render / Railway / Fly.io** (recommended — simplest for a school deadline):
1. Push this repo to GitHub.
2. Create a new Web Service, root directory `backend`, build command `npm install`, start command `npm start`.
3. Set `ALLOWED_ORIGIN` env var to your deployed URL once you have it.

**Docker** (if your host wants a container):
```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install --production
COPY backend ./
COPY frontend ../frontend
EXPOSE 4000
CMD ["node", "server.js"]
```

Once deployed, the PWA is installable straight from the browser — "Add to Home Screen" on iOS Safari, or the install prompt on Android Chrome.

---

## 5. Getting native Android/iOS apps (your "eventually" goal)

The frontend is already structured as a static, single-origin PWA, which is exactly what Capacitor needs to wrap into a real native shell — same approach you used on STUDYTOOL. Steps when you're ready:

```bash
npm install -g @capacitor/cli
cd frontend
npm init -y
npm install @capacitor/core @capacitor/android @capacitor/ios
npx cap init seize com.ayocodes.seize --web-dir .
npx cap add android
npx cap add ios
npx cap sync
```

Then open in Android Studio (`npx cap open android`) or Xcode (`npx cap open ios`) to build signed installable app packages. Point `API_BASE` in `app.js` at your deployed backend URL before building, since the native shell won't have a same-origin backend to fall back on.

Note: publishing to the Play Store / App Store requires a developer account ($25 one-time for Google, $99/yr for Apple) and each store's review process — outside what any codebase can automate, but the app itself will be ready to submit.

---

## 6. Extending it

- **More formats**: add entries to `codecMap` in `backend/utils/ffmpeg.js`.
- **More platforms**: add a pattern to `PLATFORM_PATTERNS` in `backend/routes/download.js` — yt-dlp supports 1000+ sites, so most new platforms need zero backend code beyond the regex.
- **Persistent job queue**: the current in-memory `Map` for job tracking works for a single-instance demo. For real scale, swap it for Redis/BullMQ so jobs survive restarts and can run across multiple server instances.
- **File storage**: outputs currently live in `backend/tmp` and self-delete after download. For a production app expecting concurrent users, move this to S3/R2 with signed URLs instead of local disk.

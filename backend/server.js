require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const compression = require("compression");
const path = require("path");

// ===== Routes =====
const convertRoutes = require("./routes/convert");
const downloadRoutes = require("./routes/download");
const authRoutes = require("./routes/auth");
const collectionsRoutes = require("./routes/collections");
const adminRoutes = require("./routes/admin");
const pushRoutes = require("./routes/push");

// ===== Middleware =====
const { trackUser, adminRateLimit } = require("./utils/middleware");
const {
  requestLoggerMiddleware,
  flushPersistence,
} = require("./utils/activityLog");
const { startScheduler: startPushScheduler } = require("./utils/push");

const app = express();
const PORT = process.env.PORT || 4000;

app.set("trust proxy", 1);

// ============================================================
// CRASH GUARDS
// ============================================================
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
});

// ============================================================
// SECURITY HEADERS
// ============================================================
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:", "http:", "blob:"],
        connectSrc: [
          "'self'",
          "https://i.ytimg.com",
          "https://*.fbcdn.net",
          "https://*.cdninstagram.com",
          "https://p16-common-sign.tiktokcdn.com",
          "https://*.tiktokcdn.com",
          "https://*.tiktok.com",
          "https://*.twimg.com",
          "https://*.googleusercontent.com",
          "https://*.ggpht.com",
        ],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        mediaSrc: ["'self'", "data:", "https:", "http:"],
        fontSrc: ["'self'", "data:"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    frameguard: { action: "deny" },
    xssFilter: true,
    noSniff: true,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  }),
);

// ============================================================
// COMPRESSION
// ============================================================
app.use(compression());

// ============================================================
// CORS
// ============================================================
const allowedOrigins = (process.env.ALLOWED_ORIGIN || "*")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
const allowAllOrigins = allowedOrigins.includes("*");

app.use(
  cors({
    origin: allowAllOrigins ? true : allowedOrigins,
    credentials: true,
    optionsSuccessStatus: 200,
  }),
);

// ============================================================
// LOGGING
// ============================================================
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ============================================================
// REQUEST LOGGER (for admin dashboard)
// ============================================================
app.use(requestLoggerMiddleware);

// ============================================================
// BODY PARSERS
// ============================================================
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

// ============================================================
// RATE LIMITER
// ============================================================
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { error: "Too many requests, slow down and try again shortly." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", globalLimiter);

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/api/health", (req, res) =>
  res.json({
    ok: true,
    service: "seize-backend",
    version: "3.0.0",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }),
);

app.get("/api/status", (req, res) => {
  res.json({
    name: "seize-backend",
    version: "3.1.0",
    status: "online",
    endpoints: {
      health: "/api/health",
      resolve: "/api/download/resolve",
      convert: "/api/convert/video-to-audio",
      auth: "/api/auth/login",
      collections: "/api/collections",
    },
  });
});

// ============================================================
// AUTH ROUTES
// ============================================================
app.use("/api/auth", authRoutes);

// ============================================================
// ADMIN ROUTES
// ============================================================
app.use("/api/admin", adminRoutes);

// ============================================================
// MAIN APP ROUTES
// ============================================================
app.use("/api/convert", trackUser, adminRateLimit(200), convertRoutes);
app.use("/api/download", trackUser, adminRateLimit(200), downloadRoutes);
app.use("/api/collections", trackUser, collectionsRoutes);
app.use("/api/push", trackUser, pushRoutes);

// ============================================================
// SHARE HANDLER
// ============================================================
app.get("/share-handler", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "share-handler.html"));
});

app.post("/share-handler", (req, res) => {
  const { url, text, title } = req.body;
  const shareUrl = url || text || "";
  res.redirect(
    `/?share_url=${encodeURIComponent(shareUrl)}&share_title=${encodeURIComponent(title || "")}`,
  );
});

// ============================================================
// STATIC FILES
// ============================================================
// admin.html and admin-login.html were getting the same 1-day cache as
// every other static file. fine for icons/style.css, not fine for a page
// you're actively redeploying — browser just keeps serving the stale
// version for 24h with zero indication anything's wrong. force these two
// to always be fresh
app.use(
  express.static(path.join(__dirname, "..", "frontend"), {
    maxAge: process.env.NODE_ENV === "production" ? "1d" : 0,
    etag: true,
    setHeaders: (res, filePath) => {
      if (
        filePath.endsWith("admin.html") ||
        filePath.endsWith("admin-login.html")
      ) {
        res.setHeader(
          "Cache-Control",
          "no-store, no-cache, must-revalidate, proxy-revalidate",
        );
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
    },
  }),
);

// ============================================================
// 404 & ERROR HANDLERS
// ============================================================
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err, req, res, next) => {
  console.error("[ERROR]", err);

  if (err.code === "LIMIT_FILE_SIZE") {
    return res
      .status(413)
      .json({ error: "File too large. Maximum size is 500MB." });
  }

  if (err.code === "ENOENT") {
    return res.status(404).json({ error: "File not found" });
  }

  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

// ============================================================
// START SERVER
// ============================================================
const server = app.listen(PORT, () => {
  console.log("\n" + "=".repeat(60));
  console.log("🚀 seize backend running on http://localhost:" + PORT);
  console.log("=".repeat(60));
  console.log("📱 Main App:      http://localhost:" + PORT);
  console.log("🔗 API Base:      http://localhost:" + PORT + "/api");
  console.log(
    "📊 Admin:         http://localhost:" + PORT + "/admin-login.html",
  );
  console.log("=".repeat(60) + "\n");
});

// Server timeouts for long-running requests
server.timeout = 120000;
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;

// kicks off the "come back and use seize" sweep — reads real subscriber
// activity, no-ops if nobody's subscribed yet
startPushScheduler();

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
function shutdown(signal) {
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
  flushPersistence();
  server.close(() => {
    console.log("✅ Server closed.");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

module.exports = app;

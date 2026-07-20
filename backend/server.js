require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const compression = require("compression");
const path = require("path");
const fs = require("fs");

// ===== Routes =====
const convertRoutes = require("./routes/convert");
const downloadRoutes = require("./routes/download");
const authRoutes = require("./routes/auth");
const collectionsRoutes = require("./routes/collections");
const adminRoutes = require("./routes/admin");

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
// ENSURE REQUIRED DIRECTORIES EXIST
// ============================================================
const REQUIRED_DIRS = [
  path.join(__dirname, "data"),
  path.join(__dirname, "tmp"),
  path.join(__dirname, "cookies"),
];

for (const dir of REQUIRED_DIRS) {
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`[seize] Created directory: ${dir}`);
    } catch (err) {
      console.warn(`[seize] Could not create ${dir}:`, err.message);
    }
  }
}

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
// CORS - FIXED FOR RENDER
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
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
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
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(cookieParser());

// ============================================================
// RATE LIMITER - LESS STRICT
// ============================================================
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
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
    memory: process.memoryUsage(),
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

// ============================================================
// PUSH ROUTES - SAFELY LOADED
// ============================================================
try {
  const pushRoutes = require("./routes/push_routes");
  app.use("/api/push", trackUser, pushRoutes);
} catch (err) {
  console.warn("[seize] Push routes not found, skipping:", err.message);
  // Create a fallback route
  const fallbackRouter = express.Router();
  fallbackRouter.get("/public-key", (req, res) => {
    res.json({ publicKey: null });
  });
  fallbackRouter.post("/subscribe", (req, res) => {
    res.json({ message: "Push not available" });
  });
  fallbackRouter.post("/ping", (req, res) => {
    res.json({ ok: true });
  });
  app.use("/api/push", trackUser, fallbackRouter);
}

// ============================================================
// SHARE HANDLER
// ============================================================
const shareHandlerPath = path.join(
  __dirname,
  "..",
  "frontend",
  "share-handler.html",
);
if (fs.existsSync(shareHandlerPath)) {
  app.get("/share-handler", (req, res) => {
    res.sendFile(shareHandlerPath);
  });
} else {
  app.get("/share-handler", (req, res) => {
    res.status(404).json({ error: "Share handler not found" });
  });
}

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
const frontendPath = path.join(__dirname, "..", "frontend");
if (fs.existsSync(frontendPath)) {
  app.use(
    express.static(frontendPath, {
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
} else {
  console.warn("[seize] Frontend directory not found:", frontendPath);
}

// ============================================================
// CATCH-ALL FOR SPA ROUTING
// ============================================================
app.get("*", (req, res) => {
  const indexPath = path.join(__dirname, "..", "frontend", "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: "Not found" });
  }
});

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
const server = app.listen(PORT, "0.0.0.0", () => {
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

// ============================================================
// PUSH SCHEDULER - SAFELY STARTED
// ============================================================
try {
  startPushScheduler();
  console.log("[seize] Push scheduler started");
} catch (err) {
  console.warn("[seize] Push scheduler failed to start:", err.message);
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
function shutdown(signal) {
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
  try {
    flushPersistence();
  } catch (err) {
    console.warn("[seize] Failed to flush persistence:", err.message);
  }
  server.close(() => {
    console.log("✅ Server closed.");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

module.exports = app;

const express = require("express");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { requireAdmin } = require("./auth");
const {
  getRecentEvents,
  queryEvents,
  getCounters,
  getRequestStats,
  getActiveJobCounts,
  getPlatformBreakdown,
  getPlatformHealth,
  getHeatmap,
  getBreakdowns,
  clearLogs,
  exportSnapshot,
  eventsToCsv,
  getLoginHistory,
  getSessions,
  revokeSession,
  addSseClient,
  removeSseClient,
  checkMemoryAlert,
  logEvent,
  flushPersistence,
} = require("../utils/activityLog");
const { isAvailable: ffmpegAvailable } = require("../utils/ffmpeg");
const { isConfigured: songIdConfigured } = require("../utils/songid");

let dbHealthCheck = () => ({ ok: true, note: "no db module wired up" });
try {
  const db = require("../utils/db");
  if (typeof db.getAdminAuth === "function") {
    dbHealthCheck = () => {
      db.getAdminAuth();
      return { ok: true };
    };
  }
} catch {
  // fine, just means "not wired up" instead of crashing the dashboard
}

const router = express.Router();
const TMP_DIR = path.join(__dirname, "..", "tmp");

// ============================================================
// OPTIONAL IP ALLOWLIST
// ============================================================
function ipAllowlist(req, res, next) {
  const raw = process.env.ADMIN_ALLOWED_IPS;
  if (!raw) return next();
  const allowed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ip = req.ip || req.connection?.remoteAddress || "";
  if (allowed.includes(ip)) return next();
  logEvent("admin:blocked-ip", { ip });
  return res
    .status(403)
    .json({ error: "Your IP isn't on the admin allowlist." });
}

router.use(ipAllowlist);

// EventSource (used by /live) can't set an Authorization header
router.use((req, res, next) => {
  if (req.path === "/live" && req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
});

router.use(requireAdmin);

const serverStartedAt = Date.now();

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return { days: d, hours: h, minutes: m, totalSeconds: seconds };
}

function readTempDirStats() {
  try {
    if (!fs.existsSync(TMP_DIR))
      return { exists: false, fileCount: 0, totalMb: 0 };
    const files = fs.readdirSync(TMP_DIR);
    let totalBytes = 0;
    for (const f of files) {
      try {
        totalBytes += fs.statSync(path.join(TMP_DIR, f)).size;
      } catch {
        // deleted mid-scan by the scheduled cleanup, ignore
      }
    }
    return {
      exists: true,
      fileCount: files.length,
      totalMb: Math.round((totalBytes / 1024 / 1024) * 10) / 10,
    };
  } catch (err) {
    return { exists: false, fileCount: 0, totalMb: 0, error: err.message };
  }
}

// ============================================================
// GET /api/admin/stats
// ============================================================
router.get("/stats", (req, res) => {
  const counters = getCounters();
  const requestStats = getRequestStats();
  const active = getActiveJobCounts();

  res.json({
    uptime: formatUptime(Math.floor((Date.now() - serverStartedAt) / 1000)),
    requests: requestStats,
    jobs: {
      conversions: counters.conversions,
      captures: counters.captures,
      activeTotal: active.conversions + active.captures,
      active,
    },
  });
});

// ============================================================
// GET /api/admin/platforms
// ============================================================
router.get("/platforms", (req, res) => {
  res.json({ platforms: getPlatformBreakdown() });
});

// ============================================================
// GET /api/admin/platforms/health
// ============================================================
router.get("/platforms/health", (req, res) => {
  res.json({ platforms: getPlatformHealth() });
});

// ============================================================
// GET /api/admin/heatmap
// ============================================================
router.get("/heatmap", (req, res) => {
  res.json({ heatmap: getHeatmap() });
});

// ============================================================
// GET /api/admin/breakdowns
// ============================================================
router.get("/breakdowns", (req, res) => {
  res.json(getBreakdowns());
});

// ============================================================
// GET /api/admin/health
// ============================================================
router.get("/health", (req, res) => {
  const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
  const freeMemMb = Math.round(os.freemem() / 1024 / 1024);
  const memUsedPct = Math.round(((totalMemMb - freeMemMb) / totalMemMb) * 100);
  checkMemoryAlert(memUsedPct);

  let db;
  try {
    db = dbHealthCheck();
  } catch (err) {
    db = { ok: false, error: err.message };
  }

  res.json({
    ffmpeg: { ok: ffmpegAvailable() },
    songId: { configured: songIdConfigured() },
    tempDir: readTempDirStats(),
    memory: { totalMb: totalMemMb, freeMb: freeMemMb, usedPct: memUsedPct },
    database: db,
    system: {
      nodeVersion: process.version,
      platform: os.platform(),
      cpuCount: os.cpus()?.length || 1,
      loadAvg: os.loadavg(),
    },
  });
});

// ============================================================
// GET /api/admin/activity — quick recent feed
// ============================================================
router.get("/activity", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  res.json({ events: getRecentEvents(limit) });
});

// ============================================================
// GET /api/admin/logs — filter/search/export
// ============================================================
router.get("/logs", (req, res) => {
  const { type, q, from, to, format } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 200, 2000);

  const results = queryEvents({
    type: type || undefined,
    q: q || undefined,
    from: from ? Number(from) : undefined,
    to: to ? Number(to) : undefined,
    limit,
  });

  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="seize-logs-${Date.now()}.csv"`,
    );
    return res.send(eventsToCsv(results));
  }

  res.json({ events: results, count: results.length });
});

// ============================================================
// GET /api/admin/live — Server-Sent Events stream
// ============================================================
router.get("/live", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(
    `data: ${JSON.stringify({ type: "connected", timestamp: Date.now() })}\n\n`,
  );

  addSseClient(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeSseClient(res);
  });
});

// ============================================================
// LOGIN HISTORY + SESSIONS
// ============================================================
router.get("/login-history", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 300);
  res.json({ history: getLoginHistory(limit) });
});

router.get("/sessions", (req, res) => {
  res.json({ sessions: getSessions() });
});

router.post("/sessions/:jti/revoke", (req, res) => {
  const ok = revokeSession(req.params.jti);
  if (!ok) return res.status(404).json({ error: "Session not found." });
  res.json({ message: "Session revoked." });
});

// ============================================================
// ADMIN ACTIONS
// ============================================================
router.post("/actions/clear-logs", (req, res) => {
  const result = clearLogs();
  logEvent("admin:clear-logs", { by: req.admin?.sub, ...result });
  res.json({ message: "Logs cleared.", ...result });
});

router.post("/actions/cleanup-temp", (req, res) => {
  if (!fs.existsSync(TMP_DIR)) {
    return res.json({
      message: "Nothing to clean — temp dir doesn't exist yet.",
      removed: 0,
    });
  }
  const maxAgeMs = 60 * 60 * 1000;
  const now = Date.now();
  let removed = 0;
  let skipped = 0;

  for (const file of fs.readdirSync(TMP_DIR)) {
    const filePath = path.join(TMP_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        removed++;
      } else {
        skipped++;
      }
    } catch {
      // already gone, fine
    }
  }

  logEvent("admin:cleanup-temp", { by: req.admin?.sub, removed, skipped });
  res.json({ message: `Removed ${removed} file(s).`, removed, skipped });
});

router.post("/actions/update-ytdlp", (req, res) => {
  const ytDlpExec = require("yt-dlp-exec");
  const bin =
    (ytDlpExec && ytDlpExec.binPath) ||
    path.join(
      process.cwd(),
      "node_modules",
      "yt-dlp-exec",
      "bin",
      process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
    );

  execFile(bin, ["-U"], { timeout: 30000 }, (err, stdout, stderr) => {
    const output = (stdout || stderr || "").trim();
    logEvent("admin:update-ytdlp", {
      by: req.admin?.sub,
      ok: !err,
      output: output.slice(0, 300),
    });
    if (err) return res.status(500).json({ error: err.message, output });
    res.json({ message: "yt-dlp update check complete.", output });
  });
});

let cacheBustVersion = Date.now();
router.post("/actions/clear-cache", (req, res) => {
  cacheBustVersion = Date.now();
  logEvent("admin:clear-cache", {
    by: req.admin?.sub,
    version: cacheBustVersion,
  });
  res.json({
    message: "Cache-bust version updated.",
    version: cacheBustVersion,
  });
});

router.get("/cache-version", (req, res) => {
  res.json({ version: cacheBustVersion });
});

router.post("/actions/restart-server", (req, res) => {
  logEvent("admin:restart-server", { by: req.admin?.sub });
  flushPersistence();
  res.json({ message: "Restarting…" });
  setTimeout(() => process.exit(1), 300);
});

router.get("/export", (req, res) => {
  const snapshot = exportSnapshot();
  logEvent("admin:export", { by: req.admin?.sub });
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="seize-admin-export-${Date.now()}.json"`,
  );
  res.json(snapshot);
});

module.exports = router;

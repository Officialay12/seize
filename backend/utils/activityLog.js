const geoip = require("geoip-lite");
const { parseUserAgent } = require("./parseUserAgent");
const { loadStore, scheduleSave, flushSave } = require("./persistence");

// ============================================================
// IN-MEMORY STORE
// ============================================================

const MAX_EVENTS = 2000;
const events = [];

const counters = {
  conversions: { started: 0, done: 0, error: 0 },
  captures: { started: 0, done: 0, error: 0 },
};

let requestsTotal = 0;
const requestsByDay = new Map();
const MAX_TRACKED_IPS = 5000;
const ipsAllTime = new Set();
const ipsByDay = new Map();

const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));

const deviceCounts = {};
const browserCounts = {};
const osCounts = {};
const geoCounts = {};

const MAX_LOGIN_HISTORY = 300;
const loginHistory = [];

const sessions = new Map();
const sseClients = new Set();

const alertConfig = {
  errorRatePct: 25,
  errorRateWindow: 20,
  memoryUsedPct: 90,
};
let lastAlertCheck = { errorSpike: false, memoryHigh: false };

// ============================================================
// RESTORE FROM DISK
// ============================================================
function hydrateFromDisk() {
  const saved = loadStore();
  if (!saved) return;
  try {
    if (saved.counters) {
      for (const cat of ["conversions", "captures"]) {
        if (saved.counters[cat])
          Object.assign(counters[cat], saved.counters[cat]);
      }
    }
    if (typeof saved.requestsTotal === "number")
      requestsTotal = saved.requestsTotal;
    if (Array.isArray(saved.requestsByDay)) {
      for (const [day, count] of saved.requestsByDay)
        requestsByDay.set(day, count);
    }
    if (Array.isArray(saved.ipsAllTime)) {
      for (const ip of saved.ipsAllTime) {
        if (ipsAllTime.size < MAX_TRACKED_IPS) ipsAllTime.add(ip);
      }
    }
    if (Array.isArray(saved.ipsByDay)) {
      for (const [day, ips] of saved.ipsByDay) ipsByDay.set(day, new Set(ips));
    }
    if (Array.isArray(saved.heatmap) && saved.heatmap.length === 7) {
      for (let d = 0; d < 7; d++) {
        for (let h = 0; h < 24; h++) {
          heatmap[d][h] = saved.heatmap[d]?.[h] || 0;
        }
      }
    }
    if (saved.deviceCounts) Object.assign(deviceCounts, saved.deviceCounts);
    if (saved.browserCounts) Object.assign(browserCounts, saved.browserCounts);
    if (saved.osCounts) Object.assign(osCounts, saved.osCounts);
    if (saved.geoCounts) Object.assign(geoCounts, saved.geoCounts);
    if (Array.isArray(saved.loginHistory)) {
      loginHistory.push(...saved.loginHistory.slice(0, MAX_LOGIN_HISTORY));
    }
    if (Array.isArray(saved.sessions)) {
      for (const [jti, s] of saved.sessions) sessions.set(jti, s);
    }
    if (Array.isArray(saved.recentEvents)) {
      events.push(...saved.recentEvents.slice(0, MAX_EVENTS));
    }
    console.log(`[activityLog] Restored from disk (${events.length} events)`);
  } catch (err) {
    console.warn("[activityLog] Failed to hydrate:", err.message);
  }
}
hydrateFromDisk();

// ============================================================
// PERSISTENCE
// ============================================================
function persistState() {
  return {
    version: 1,
    savedAt: Date.now(),
    counters: getCounters(),
    requestsTotal,
    requestsByDay: [...requestsByDay.entries()],
    ipsAllTime: [...ipsAllTime],
    ipsByDay: [...ipsByDay.entries()].map(([day, set]) => [day, [...set]]),
    heatmap,
    deviceCounts,
    browserCounts,
    osCounts,
    geoCounts,
    loginHistory: loginHistory.slice(0, MAX_LOGIN_HISTORY),
    sessions: [...sessions.entries()],
    recentEvents: events.slice(0, 500),
  };
}

function persistNow() {
  scheduleSave(persistState);
}

function flushPersistence() {
  flushSave(persistState);
}

setInterval(() => scheduleSave(persistState), 30000).unref();

// ============================================================
// CORE FUNCTIONS
// ============================================================
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function broadcast(type, payload) {
  const line = `data: ${JSON.stringify({ type, payload, timestamp: Date.now() })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      sseClients.delete(res);
    }
  }
}

function addSseClient(res) {
  sseClients.add(res);
}

function removeSseClient(res) {
  sseClients.delete(res);
}

// ============================================================
// LOG EVENT — THIS IS THE FIXED VERSION
// ============================================================
function logEvent(type, detail = {}) {
  // Create the event
  const event = { type, detail, timestamp: Date.now() };

  // Add to events array (newest first)
  events.unshift(event);

  // Keep only MAX_EVENTS
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;

  // Update counters
  const [category, stage] = type.split(":");
  if (category === "conversion" && counters.conversions[stage] !== undefined) {
    counters.conversions[stage]++;
  }
  if (category === "capture" && counters.captures[stage] !== undefined) {
    counters.captures[stage]++;
  }

  // Broadcast to SSE clients
  broadcast("event", event);

  // Check alerts
  checkAlerts();

  // Save to disk
  persistNow();

  // Log to console for debugging
  console.log(`[activityLog] ${type}`, detail);
}

function recordRequest(ip, userAgent = "") {
  requestsTotal++;
  const day = todayKey();
  requestsByDay.set(day, (requestsByDay.get(day) || 0) + 1);

  const now = new Date();
  heatmap[now.getDay()][now.getHours()]++;

  if (ip) {
    if (ipsAllTime.size < MAX_TRACKED_IPS) ipsAllTime.add(ip);
    if (!ipsByDay.has(day)) ipsByDay.set(day, new Set());
    const daySet = ipsByDay.get(day);
    if (daySet.size < MAX_TRACKED_IPS) daySet.add(ip);

    try {
      const geo = geoip.lookup(ip);
      if (geo?.country)
        geoCounts[geo.country] = (geoCounts[geo.country] || 0) + 1;
    } catch {
      // skip
    }
  }

  if (userAgent) {
    const { device, browser, os } = parseUserAgent(userAgent);
    deviceCounts[device] = (deviceCounts[device] || 0) + 1;
    browserCounts[browser] = (browserCounts[browser] || 0) + 1;
    osCounts[os] = (osCounts[os] || 0) + 1;
  }

  if (requestsByDay.size > 90) {
    const oldestKey = [...requestsByDay.keys()].sort()[0];
    requestsByDay.delete(oldestKey);
    ipsByDay.delete(oldestKey);
  }

  broadcast("request", { total: requestsTotal, today: requestsByDay.get(day) });
  persistNow();
}

function requestLoggerMiddleware(req, res, next) {
  const ip =
    req.ip ||
    req.connection?.remoteAddress ||
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    "unknown";
  recordRequest(ip, req.headers["user-agent"]);
  next();
}

// ============================================================
// ALERTS
// ============================================================
function checkAlerts() {
  const recent = events.slice(0, alertConfig.errorRateWindow);
  const relevant = recent.filter(
    (e) => e.type.endsWith(":done") || e.type.endsWith(":error"),
  );
  const errorCount = relevant.filter((e) => e.type.endsWith(":error")).length;
  const errorRatePct = relevant.length
    ? Math.round((errorCount / relevant.length) * 100)
    : 0;

  const errorSpike =
    relevant.length >= 5 && errorRatePct >= alertConfig.errorRateWindow;
  if (errorSpike && !lastAlertCheck.errorSpike) {
    broadcast("alert", {
      level: "warning",
      message: `Error rate spiked to ${errorRatePct}% over the last ${relevant.length} jobs.`,
    });
  }
  lastAlertCheck.errorSpike = errorSpike;
}

function checkMemoryAlert(usedPct) {
  const high = usedPct >= alertConfig.memoryUsedPct;
  if (high && !lastAlertCheck.memoryHigh) {
    broadcast("alert", {
      level: "critical",
      message: `Memory usage at ${usedPct}%.`,
    });
  }
  lastAlertCheck.memoryHigh = high;
}

// ============================================================
// LOGIN HISTORY + SESSIONS
// ============================================================
function recordLogin({ username, ip, userAgent, success }) {
  const entry = { username, ip, userAgent, success, timestamp: Date.now() };
  loginHistory.unshift(entry);
  if (loginHistory.length > MAX_LOGIN_HISTORY)
    loginHistory.length = MAX_LOGIN_HISTORY;
  logEvent(success ? "auth:login-success" : "auth:login-failed", {
    username,
    ip,
  });
  return entry;
}

function getLoginHistory(limit = 50) {
  return loginHistory.slice(0, limit);
}

function registerSession(jti, { sub, ip, userAgent }) {
  sessions.set(jti, {
    sub,
    ip,
    userAgent,
    issuedAt: Date.now(),
    revoked: false,
  });
  logEvent("session:created", { sub, ip });
  persistNow();
}

function isSessionRevoked(jti) {
  const s = sessions.get(jti);
  return s ? s.revoked : false;
}

function revokeSession(jti) {
  const s = sessions.get(jti);
  if (!s) return false;
  s.revoked = true;
  logEvent("admin:session-revoked", { jti, sub: s.sub });
  persistNow();
  return true;
}

function getSessions() {
  return [...sessions.entries()].map(([jti, s]) => ({ jti, ...s }));
}

// ============================================================
// QUERY FUNCTIONS
// ============================================================
function getRecentEvents(limit = 50) {
  return events.slice(0, limit);
}

function queryEvents({ type, q, from, to, limit = 200 } = {}) {
  let out = events;
  if (type) out = out.filter((e) => e.type.includes(type));
  if (from) out = out.filter((e) => e.timestamp >= from);
  if (to) out = out.filter((e) => e.timestamp <= to);
  if (q) {
    const needle = q.toLowerCase();
    out = out.filter((e) => JSON.stringify(e).toLowerCase().includes(needle));
  }
  return out.slice(0, limit);
}

function getCounters() {
  return JSON.parse(JSON.stringify(counters));
}

function getActiveJobCounts() {
  const c = counters;
  return {
    conversions: Math.max(
      0,
      c.conversions.started - c.conversions.done - c.conversions.error,
    ),
    captures: Math.max(
      0,
      c.captures.started - c.captures.done - c.captures.error,
    ),
  };
}

function getPlatformBreakdown() {
  const counts = {};
  for (const e of events) {
    if (e.type === "capture:started" && e.detail?.platform) {
      counts[e.detail.platform] = (counts[e.detail.platform] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .map(([platform, count]) => ({ platform, count }))
    .sort((a, b) => b.count - a.count);
}

function getPlatformHealth() {
  const stats = {};
  for (const e of events) {
    if (!e.type.startsWith("capture:") || !e.detail?.platform) continue;
    const p = e.detail.platform;
    if (!stats[p]) stats[p] = { started: 0, done: 0, error: 0 };
    const stage = e.type.split(":")[1];
    if (stats[p][stage] !== undefined) stats[p][stage]++;
  }
  return Object.entries(stats).map(([platform, s]) => ({
    platform,
    ...s,
    successRatePct:
      s.done + s.error > 0
        ? Math.round((s.done / (s.done + s.error)) * 100)
        : null,
  }));
}

function getRequestStats() {
  const day = todayKey();
  return {
    total: requestsTotal,
    today: requestsByDay.get(day) || 0,
    uniqueVisitorsTotal: ipsAllTime.size,
    uniqueVisitorsToday: (ipsByDay.get(day) || new Set()).size,
  };
}

function getHeatmap() {
  return heatmap;
}

function getBreakdowns() {
  const toSorted = (obj) =>
    Object.entries(obj)
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
  return {
    devices: toSorted(deviceCounts),
    browsers: toSorted(browserCounts),
    os: toSorted(osCounts),
    countries: toSorted(geoCounts),
  };
}

function clearLogs() {
  const removed = events.length;
  events.length = 0;
  persistNow();
  return { removedEvents: removed };
}

function exportSnapshot() {
  return {
    exportedAt: new Date().toISOString(),
    counters: getCounters(),
    requestStats: getRequestStats(),
    activeJobs: getActiveJobCounts(),
    platformBreakdown: getPlatformBreakdown(),
    platformHealth: getPlatformHealth(),
    breakdowns: getBreakdowns(),
    heatmap: getHeatmap(),
    loginHistory: getLoginHistory(300),
    recentEvents: getRecentEvents(2000),
  };
}

function eventsToCsv(list) {
  const header = "timestamp,iso,type,detail";
  const rows = list.map((e) => {
    const iso = new Date(e.timestamp).toISOString();
    const detail = JSON.stringify(e.detail || {}).replace(/"/g, '""');
    return `${e.timestamp},${iso},"${e.type}","${detail}"`;
  });
  return [header, ...rows].join("\n");
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  logEvent,
  recordRequest,
  requestLoggerMiddleware,
  getRecentEvents,
  queryEvents,
  getCounters,
  getActiveJobCounts,
  getRequestStats,
  getPlatformBreakdown,
  getPlatformHealth,
  getHeatmap,
  getBreakdowns,
  clearLogs,
  exportSnapshot,
  eventsToCsv,
  recordLogin,
  getLoginHistory,
  registerSession,
  isSessionRevoked,
  revokeSession,
  getSessions,
  addSseClient,
  removeSseClient,
  checkMemoryAlert,
  alertConfig,
  flushPersistence,
};

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getAdminAuth, setAdminAuth } = require("../utils/db");
const {
  sendLoginAlert,
  sendSuspiciousActivityAlert,
  sendPasswordChangeAlert,
} = require("../utils/email");
const { recordLogin, registerSession } = require("../utils/activityLog");

const router = express.Router();

// ============================================================
// CREDENTIALS — MUST come from .env, NO DEFAULTS
// ============================================================
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const JWT_SECRET = process.env.JWT_SECRET;

if (!ADMIN_USERNAME) {
  console.error("❌ ADMIN_USERNAME not set in .env — admin logins will fail.");
}
if (!JWT_SECRET) {
  console.error("❌ JWT_SECRET not set in .env — sessions will fail.");
}

// ============================================================
// GET PASSWORD HASH — only from .env or database
// ============================================================
async function getCurrentPasswordHash() {
  // Check if password already stored in database (persisted after first boot)
  const stored = getAdminAuth();
  if (stored?.passwordHash) return stored.passwordHash;

  // Only use ADMIN_PASSWORD from .env — NO fallback defaults
  if (process.env.ADMIN_PASSWORD) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    setAdminAuth(hash);
    return hash;
  }

  console.error(
    "❌ ADMIN_PASSWORD not set in .env — no admin credentials available.",
  );
  return null;
}

// ============================================================
// BRUTE-FORCE PROTECTION
// ============================================================
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map();

setInterval(
  () => {
    const now = Date.now();
    for (const [ip, rec] of attempts) {
      if (now > rec.resetAt) attempts.delete(ip);
    }
  },
  5 * 60 * 1000,
).unref();

function isLocked(ip) {
  const rec = attempts.get(ip);
  return !!rec && rec.count >= MAX_ATTEMPTS && Date.now() < rec.resetAt;
}

function recordFailure(ip) {
  const now = Date.now();
  let rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) rec = { count: 0, resetAt: now + WINDOW_MS };
  rec.count++;
  attempts.set(ip, rec);
  return rec;
}

function clearFailures(ip) {
  attempts.delete(ip);
}

// ============================================================
// LOGIN ENDPOINT
// ============================================================
router.post("/login", async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const userAgent = req.headers["user-agent"] || "unknown";
  const { username, password } = req.body || {};

  // Validate input
  if (!username || !password) {
    recordLogin({ username, ip, userAgent, success: false });
    return res.status(400).json({ error: "Username and password required" });
  }

  // Check rate limiting
  if (isLocked(ip)) {
    recordLogin({ username, ip, userAgent, success: false });
    return res.status(429).json({
      error: "Too many failed attempts. Try again in a few minutes.",
    });
  }

  // Get password hash from database or .env
  const passwordHash = await getCurrentPasswordHash();

  // Validate credentials
  if (!passwordHash || username !== ADMIN_USERNAME) {
    recordFailure(ip);
    recordLogin({ username, ip, userAgent, success: false });
    return res.status(401).json({ error: "Invalid credentials" });
  }

  // Verify password
  const valid = await bcrypt.compare(password, passwordHash);
  if (!valid) {
    const rec = recordFailure(ip);
    recordLogin({ username, ip, userAgent, success: false });

    // Alert on repeated failures
    if (rec.count === MAX_ATTEMPTS) {
      sendSuspiciousActivityAlert(
        null,
        username,
        ip,
        "repeated failed logins",
        { attempts: rec.count },
      ).catch(() => {});
    }
    return res.status(401).json({ error: "Invalid credentials" });
  }

  // Success — clear failures
  clearFailures(ip);

  // Generate JWT with jti for session tracking
  const jti = crypto.randomBytes(16).toString("hex");
  const token = jwt.sign({ sub: username, role: "admin", jti }, JWT_SECRET, {
    expiresIn: "7d",
  });

  // Register session in activity log
  registerSession(jti, {
    sub: username,
    ip: ip,
    userAgent: userAgent,
  });

  // Record successful login
  recordLogin({ username, ip, userAgent, success: true });

  // Send email alert
  sendLoginAlert(null, username, ip, userAgent).catch(() => {});

  res.json({
    token,
    user: {
      id: 1,
      username,
      role: "admin",
      status: "active",
    },
  });
});

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function requireAdmin(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ============================================================
// GET CURRENT USER
// ============================================================
router.get("/me", requireAdmin, (req, res) => {
  res.json({
    id: 1,
    username: req.admin.sub,
    role: "admin",
    status: "active",
  });
});

// ============================================================
// LOGOUT
// ============================================================
router.post("/logout", (req, res) => {
  // JWTs are stateless — client discards the token
  res.json({ message: "Logged out successfully" });
});

// ============================================================
// CHANGE PASSWORD
// ============================================================
router.post("/change-password", requireAdmin, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      error: "Current and new password required",
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({
      error: "Password must be at least 8 characters",
    });
  }

  // Verify current password
  const currentHash = await getCurrentPasswordHash();
  const valid =
    currentHash && (await bcrypt.compare(currentPassword, currentHash));

  if (!valid) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }

  // Hash and save new password
  const newHash = await bcrypt.hash(newPassword, 12);
  setAdminAuth(newHash);

  // Send email alert
  sendPasswordChangeAlert(
    null,
    req.admin.sub,
    req.ip || req.connection.remoteAddress || "unknown",
  ).catch(() => {});

  res.json({ message: "Password changed successfully" });
});

// ============================================================
// EXPORTS
// ============================================================
module.exports = router;
module.exports.requireAdmin = requireAdmin;

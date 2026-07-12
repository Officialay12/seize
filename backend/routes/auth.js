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

const router = express.Router();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";

// Falls back to a random per-process secret so the app still boots without
// config, but warns loudly — without JWT_SECRET set, sessions won't
// survive a restart/redeploy.
if (!process.env.JWT_SECRET) {
  console.warn(
    "⚠️  JWT_SECRET is not set. Using a temporary secret for this run only — " +
      "all admin sessions will be invalidated on restart. Set JWT_SECRET in your environment.",
  );
}
const SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");

async function getCurrentPasswordHash() {
  const stored = getAdminAuth();
  if (stored?.passwordHash) return stored.passwordHash;

  if (process.env.ADMIN_PASSWORD_HASH) return process.env.ADMIN_PASSWORD_HASH;

  if (process.env.ADMIN_PASSWORD) {
    // First-boot convenience: hash the plaintext env password once and
    // persist the hash so we never compare against plaintext again.
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    setAdminAuth(hash);
    return hash;
  }

  return null;
}

// --- Self-cleaning brute-force tracker, keyed by IP ---
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map();

setInterval(
  () => {
    const now = Date.now();
    for (const [ip, rec] of attempts)
      if (now > rec.resetAt) attempts.delete(ip);
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
// LOGIN
// ============================================================
router.post("/login", async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  if (isLocked(ip)) {
    return res
      .status(429)
      .json({ error: "Too many failed attempts. Try again in a few minutes." });
  }

  const passwordHash = await getCurrentPasswordHash();

  if (!passwordHash || username !== ADMIN_USERNAME) {
    recordFailure(ip);
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const valid = await bcrypt.compare(password, passwordHash);
  if (!valid) {
    const rec = recordFailure(ip);
    if (rec.count === MAX_ATTEMPTS) {
      sendSuspiciousActivityAlert(
        null,
        username,
        ip,
        "repeated failed logins",
        {
          attempts: rec.count,
        },
      ).catch(() => {});
    }
    return res.status(401).json({ error: "Invalid credentials" });
  }

  clearFailures(ip);

  const token = jwt.sign({ sub: username, role: "admin" }, SECRET, {
    expiresIn: "7d",
  });

  sendLoginAlert(
    null,
    username,
    ip,
    req.headers["user-agent"] || "unknown",
  ).catch(() => {});

  res.json({
    token,
    user: { id: 1, username, role: "admin", status: "active" },
  });
});

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function requireAdmin(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) return res.status(401).json({ error: "Not authenticated" });

  try {
    req.admin = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ============================================================
// CURRENT USER
// ============================================================
router.get("/me", requireAdmin, (req, res) => {
  res.json({ id: 1, username: req.admin.sub, role: "admin", status: "active" });
});

// ============================================================
// LOGOUT
// ============================================================
router.post("/logout", (req, res) => {
  // Tokens are stateless JWTs, so "logout" is a client-side discard.
  // Nothing server-side to invalidate unless a session store is added.
  res.json({ message: "Logged out successfully" });
});

// ============================================================
// CHANGE PASSWORD (now actually verifies + persists)
// ============================================================
router.post("/change-password", requireAdmin, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current and new password required" });
  }
  if (newPassword.length < 8) {
    return res
      .status(400)
      .json({ error: "Password must be at least 8 characters" });
  }

  const currentHash = await getCurrentPasswordHash();
  const valid =
    currentHash && (await bcrypt.compare(currentPassword, currentHash));
  if (!valid) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }

  const newHash = await bcrypt.hash(newPassword, 12);
  setAdminAuth(newHash);

  sendPasswordChangeAlert(
    null,
    req.admin.sub,
    req.ip || req.connection.remoteAddress || "unknown",
  ).catch(() => {});

  res.json({ message: "Password changed successfully" });
});

module.exports = router;
module.exports.requireAdmin = requireAdmin;

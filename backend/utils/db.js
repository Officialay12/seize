const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "seize.json");

// Ensure data directory exists
const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Initialize database with default structure
let db = {
  users: [],
  activity_logs: [],
  admin_sessions: [],
  moderation_queue: [],
  security_alerts: [],
  settings: [],
  feature_flags: [
    {
      flag_key: "youtube_download",
      flag_value: 1,
      description: "Enable YouTube downloads",
    },
    {
      flag_key: "tiktok_download",
      flag_value: 1,
      description: "Enable TikTok downloads",
    },
    {
      flag_key: "instagram_download",
      flag_value: 1,
      description: "Enable Instagram downloads",
    },
    {
      flag_key: "twitter_download",
      flag_value: 1,
      description: "Enable Twitter/X downloads",
    },
    {
      flag_key: "video_to_audio",
      flag_value: 1,
      description: "Enable video to audio conversion",
    },
    {
      flag_key: "audio_to_video",
      flag_value: 1,
      description: "Enable audio to video conversion",
    },
    {
      flag_key: "user_registration",
      flag_value: 1,
      description: "Allow new user registration",
    },
    {
      flag_key: "guest_access",
      flag_value: 1,
      description: "Allow guest users to use the platform",
    },
  ],
  access_rules: [],
  adminAuth: null, // { passwordHash, updatedAt } — persists a changed admin password across restarts
};

// Load existing data if it exists
if (fs.existsSync(DB_PATH)) {
  try {
    const data = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(data);
    // Merge with defaults to ensure all keys exist
    db = { ...db, ...parsed };
    console.log("✅ Database loaded successfully");
  } catch (err) {
    console.error("❌ Failed to load database:", err.message);
    // Create a fresh database file
    saveDB();
  }
} else {
  // Create initial database file
  saveDB();
  console.log("✅ New database created");
}

// ===== Save function =====
function saveDB() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    return true;
  } catch (err) {
    console.error("❌ Failed to save database:", err.message);
    return false;
  }
}

// ============================================================
// USER FUNCTIONS
// ============================================================

function getUserByUsername(username) {
  return db.users.find((u) => u.username === username) || null;
}

function getUserByIp(ip) {
  return db.users.find((u) => u.ip_address === ip) || null;
}

function getUserById(id) {
  return db.users.find((u) => u.id === id) || null;
}

function createUser(
  username,
  passwordHash,
  email = null,
  ip = null,
  userAgent = null,
  fingerprint = null,
) {
  const user = {
    id: db.users.length + 1,
    username,
    password_hash: passwordHash,
    email,
    ip_address: ip,
    user_agent: userAgent,
    device_fingerprint: fingerprint,
    role: "user",
    status: "active",
    created_at: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    last_login_ip: ip,
    last_login_time: new Date().toISOString(),
    login_attempts: 0,
    locked_until: null,
    totp_secret: null,
    totp_enabled: 0,
    two_factor_backup_codes: null,
    total_requests: 0,
    banned_at: null,
    whitelisted_at: null,
    notes: null,
    password_changed_at: new Date().toISOString(),
    requires_password_change: 0,
  };
  db.users.push(user);
  saveDB();
  return { lastInsertRowid: user.id };
}

function updateUserPassword(userId, passwordHash) {
  const user = getUserById(userId);
  if (user) {
    user.password_hash = passwordHash;
    user.password_changed_at = new Date().toISOString();
    user.requires_password_change = 0;
    saveDB();
    return true;
  }
  return false;
}

function updateUserLoginInfo(userId, ip, userAgent, fingerprint) {
  const user = getUserById(userId);
  if (user) {
    user.last_seen = new Date().toISOString();
    user.last_login_ip = ip;
    user.last_login_time = new Date().toISOString();
    user.ip_address = ip || user.ip_address;
    user.user_agent = userAgent || user.user_agent;
    user.device_fingerprint = fingerprint || user.device_fingerprint;
    user.login_attempts = 0;
    user.locked_until = null;
    saveDB();
    return true;
  }
  return false;
}

function updateUserStats(userId) {
  const user = getUserById(userId);
  if (user) {
    user.total_requests = (user.total_requests || 0) + 1;
    user.last_seen = new Date().toISOString();
    saveDB();
    return true;
  }
  return false;
}

function incrementLoginAttempts(username, ip) {
  const user = getUserByUsername(username);
  if (user) {
    user.login_attempts = (user.login_attempts || 0) + 1;
    if (user.login_attempts >= 5) {
      user.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    }
    saveDB();
    return true;
  }
  return false;
}

function isUserLocked(username) {
  const user = getUserByUsername(username);
  if (!user) return false;
  if (!user.locked_until) return false;
  return new Date(user.locked_until) > new Date();
}

function resetLoginAttempts(username) {
  const user = getUserByUsername(username);
  if (user) {
    user.login_attempts = 0;
    user.locked_until = null;
    saveDB();
    return true;
  }
  return false;
}

// ============================================================
// TOTP FUNCTIONS
// ============================================================

function enableTOTP(userId, secret, backupCodes) {
  const user = getUserById(userId);
  if (user) {
    user.totp_secret = secret;
    user.totp_enabled = 1;
    user.two_factor_backup_codes = JSON.stringify(backupCodes);
    saveDB();
    return true;
  }
  return false;
}

function disableTOTP(userId) {
  const user = getUserById(userId);
  if (user) {
    user.totp_secret = null;
    user.totp_enabled = 0;
    user.two_factor_backup_codes = null;
    saveDB();
    return true;
  }
  return false;
}

function getUserTOTP(userId) {
  const user = getUserById(userId);
  if (!user) return null;
  return {
    totp_secret: user.totp_secret,
    totp_enabled: user.totp_enabled,
    two_factor_backup_codes: user.two_factor_backup_codes,
  };
}

function useBackupCode(userId, code) {
  const user = getUserById(userId);
  if (!user || !user.two_factor_backup_codes) return false;

  const codes = JSON.parse(user.two_factor_backup_codes);
  const index = codes.indexOf(code);
  if (index === -1) return false;

  codes.splice(index, 1);
  user.two_factor_backup_codes = JSON.stringify(codes);
  saveDB();
  return true;
}

// ============================================================
// ADMIN SESSION FUNCTIONS
// ============================================================

function createAdminSession(
  userId,
  token,
  ip,
  userAgent,
  fingerprint,
  expiresIn = "7 days",
) {
  const session = {
    id: db.admin_sessions.length + 1,
    user_id: userId,
    session_token: token,
    ip_address: ip,
    user_agent: userAgent,
    device_fingerprint: fingerprint,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    last_activity: new Date().toISOString(),
    is_active: 1,
  };
  db.admin_sessions.push(session);
  saveDB();
  return { lastInsertRowid: session.id };
}

function getAdminSession(token) {
  return (
    db.admin_sessions.find(
      (s) =>
        s.session_token === token &&
        s.is_active === 1 &&
        new Date(s.expires_at) > new Date(),
    ) || null
  );
}

function updateAdminSessionActivity(token) {
  const session = getAdminSession(token);
  if (session) {
    session.last_activity = new Date().toISOString();
    saveDB();
    return true;
  }
  return false;
}

function deleteAdminSession(token) {
  const session = db.admin_sessions.find((s) => s.session_token === token);
  if (session) {
    session.is_active = 0;
    saveDB();
    return true;
  }
  return false;
}

function deleteAllUserSessions(userId) {
  db.admin_sessions
    .filter((s) => s.user_id === userId)
    .forEach((s) => (s.is_active = 0));
  saveDB();
  return true;
}

// ============================================================
// ACTIVITY LOGGING
// ============================================================

function logActivity(
  userId,
  ip,
  userAgent,
  fingerprint,
  platform,
  action,
  url,
  status,
  error = null,
  details = null,
) {
  const log = {
    id: db.activity_logs.length + 1,
    user_id: userId,
    ip_address: ip,
    user_agent: userAgent,
    device_fingerprint: fingerprint,
    platform: platform,
    action: action,
    url: url,
    status: status,
    error: error,
    details: details,
    created_at: new Date().toISOString(),
  };
  db.activity_logs.push(log);
  saveDB();
  return { lastInsertRowid: log.id };
}

// ============================================================
// SECURITY ALERTS
// ============================================================

function createSecurityAlert(
  type,
  severity,
  message,
  ip,
  userId = null,
  details = null,
) {
  const alert = {
    id: db.security_alerts.length + 1,
    type: type,
    severity: severity,
    message: message,
    ip_address: ip,
    user_id: userId,
    details: details ? JSON.stringify(details) : null,
    resolved: 0,
    created_at: new Date().toISOString(),
  };
  db.security_alerts.push(alert);
  saveDB();
  return { lastInsertRowid: alert.id };
}

function getSecurityAlerts(limit = 50, resolved = 0) {
  return db.security_alerts
    .filter((a) => a.resolved === resolved)
    .slice(-limit)
    .reverse();
}

function resolveSecurityAlert(id) {
  const alert = db.security_alerts.find((a) => a.id === id);
  if (alert) {
    alert.resolved = 1;
    saveDB();
    return true;
  }
  return false;
}

// ============================================================
// STATS FUNCTIONS
// ============================================================

function getStats() {
  const now = new Date();
  const today = now.toISOString().split("T")[0];

  return {
    totalUsers: db.users.length,
    activeUsers: db.users.filter(
      (u) => new Date(u.last_seen) > new Date(Date.now() - 3600000),
    ).length,
    totalRequests: db.activity_logs.length,
    todayRequests: db.activity_logs.filter((l) =>
      l.created_at.startsWith(today),
    ).length,
    bannedUsers: db.users.filter((u) => u.status === "banned").length,
    whitelistedUsers: db.users.filter((u) => u.status === "whitelisted").length,
    securityAlerts: db.security_alerts.filter((a) => a.resolved === 0).length,
    activeSessions: db.admin_sessions.filter(
      (s) => s.is_active === 1 && new Date(s.expires_at) > new Date(),
    ).length,
    pendingModeration: db.moderation_queue.filter((m) => m.status === "pending")
      .length,
  };
}

function getRecentActivity(limit = 50) {
  return db.activity_logs.slice(-limit).reverse();
}

function getUsersWithStats(limit = 50, offset = 0) {
  const start = offset;
  const end = offset + limit;
  return db.users.slice(start, end).map((u) => {
    const userLogs = db.activity_logs.filter((l) => l.user_id === u.id);
    return {
      ...u,
      request_count: userLogs.length,
      today_requests: userLogs.filter((l) =>
        l.created_at.startsWith(new Date().toISOString().split("T")[0]),
      ).length,
    };
  });
}

// ============================================================
// USER MANAGEMENT
// ============================================================

function banUser(userId, reason = null, adminId = null) {
  const user = getUserById(userId);
  if (user) {
    user.status = "banned";
    user.banned_at = new Date().toISOString();
    user.notes = reason || "Banned by admin";
    deleteAllUserSessions(userId);
    saveDB();
    return true;
  }
  return false;
}

function unbanUser(userId) {
  const user = getUserById(userId);
  if (user) {
    user.status = "active";
    user.banned_at = null;
    saveDB();
    return true;
  }
  return false;
}

function whitelistUser(userId, adminId = null) {
  const user = getUserById(userId);
  if (user) {
    user.status = "whitelisted";
    user.whitelisted_at = new Date().toISOString();
    saveDB();
    return true;
  }
  return false;
}

function removeWhitelist(userId) {
  const user = getUserById(userId);
  if (user) {
    user.status = "active";
    user.whitelisted_at = null;
    saveDB();
    return true;
  }
  return false;
}

function deleteUser(userId) {
  const index = db.users.findIndex((u) => u.id === userId);
  if (index === -1) return false;
  db.users.splice(index, 1);
  // Remove related activity logs
  db.activity_logs = db.activity_logs.filter((l) => l.user_id !== userId);
  // Remove related sessions
  db.admin_sessions = db.admin_sessions.filter((s) => s.user_id !== userId);
  saveDB();
  return true;
}

// ============================================================
// ACCESS RULES
// ============================================================

function createAccessRule(type, value, ruleType, reason, createdBy) {
  const rule = {
    id: db.access_rules.length + 1,
    type: type,
    value: value,
    rule_type: ruleType,
    reason: reason,
    created_by: createdBy,
    created_at: new Date().toISOString(),
    expires_at: null,
    is_active: 1,
  };
  db.access_rules.push(rule);
  saveDB();
  return { lastInsertRowid: rule.id };
}

function deleteAccessRule(id) {
  const index = db.access_rules.findIndex((r) => r.id === id);
  if (index === -1) return false;
  db.access_rules.splice(index, 1);
  saveDB();
  return true;
}

function getAccessRules() {
  return db.access_rules
    .filter((r) => r.is_active === 1)
    .map((r) => {
      const creator = getUserById(r.created_by);
      return {
        ...r,
        created_by_username: creator ? creator.username : null,
      };
    });
}

function isBlacklisted(ip, username = null) {
  // Check IP blacklist
  const ipRule = db.access_rules.find(
    (r) =>
      r.type === "blacklist" &&
      r.rule_type === "ip" &&
      r.value === ip &&
      r.is_active === 1 &&
      (!r.expires_at || new Date(r.expires_at) > new Date()),
  );
  if (ipRule) return ipRule;

  // Check username blacklist
  if (username) {
    const userRule = db.access_rules.find(
      (r) =>
        r.type === "blacklist" &&
        r.rule_type === "username" &&
        r.value === username &&
        r.is_active === 1 &&
        (!r.expires_at || new Date(r.expires_at) > new Date()),
    );
    if (userRule) return userRule;
  }

  return null;
}

function isWhitelisted(ip, username = null) {
  // Check IP whitelist
  const ipRule = db.access_rules.find(
    (r) =>
      r.type === "whitelist" &&
      r.rule_type === "ip" &&
      r.value === ip &&
      r.is_active === 1 &&
      (!r.expires_at || new Date(r.expires_at) > new Date()),
  );
  if (ipRule) return ipRule;

  // Check username whitelist
  if (username) {
    const userRule = db.access_rules.find(
      (r) =>
        r.type === "whitelist" &&
        r.rule_type === "username" &&
        r.value === username &&
        r.is_active === 1 &&
        (!r.expires_at || new Date(r.expires_at) > new Date()),
    );
    if (userRule) return userRule;
  }

  return null;
}

// ============================================================
// MODERATION QUEUE
// ============================================================

function getModerationQueue(status = "pending", limit = 50) {
  const items = db.moderation_queue
    .filter((m) => m.status === status)
    .slice(0, limit);
  return items.map((m) => {
    const user = getUserById(m.user_id);
    const reporter = getUserById(m.reported_by);
    return {
      ...m,
      user_name: user ? user.username : "Unknown",
      reported_by_name: reporter ? reporter.username : "System",
    };
  });
}

function addToModerationQueue(
  contentType,
  contentUrl,
  userId,
  reportedBy,
  reason,
) {
  const item = {
    id: db.moderation_queue.length + 1,
    content_type: contentType,
    content_url: contentUrl,
    user_id: userId,
    reported_by: reportedBy,
    reason: reason,
    status: "pending",
    created_at: new Date().toISOString(),
    resolved_at: null,
    resolved_by: null,
    notes: null,
  };
  db.moderation_queue.push(item);
  saveDB();
  return { lastInsertRowid: item.id };
}

function resolveModerationQueue(id, status, resolvedBy, notes) {
  const item = db.moderation_queue.find((m) => m.id === id);
  if (item) {
    item.status = status;
    item.resolved_at = new Date().toISOString();
    item.resolved_by = resolvedBy;
    item.notes = notes || "Resolved by admin";
    saveDB();
    return true;
  }
  return false;
}

// ============================================================
// SETTINGS FUNCTIONS
// ============================================================

function getSetting(key) {
  const setting = db.settings.find((s) => s.setting_key === key);
  return setting ? setting.setting_value : null;
}

function setSetting(key, value, group, description, updatedBy) {
  const existing = db.settings.find((s) => s.setting_key === key);
  if (existing) {
    existing.setting_value = value;
    existing.setting_group = group || existing.setting_group;
    existing.description = description || existing.description;
    existing.updated_at = new Date().toISOString();
    existing.updated_by = updatedBy;
  } else {
    db.settings.push({
      id: db.settings.length + 1,
      setting_key: key,
      setting_value: value,
      setting_group: group || "General",
      description: description || "",
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    });
  }
  saveDB();
  return true;
}

function getAllSettings() {
  return db.settings;
}

// ============================================================
// FEATURE FLAGS
// ============================================================

function getFeatureFlag(key) {
  const flag = db.feature_flags.find((f) => f.flag_key === key);
  return flag ? flag.flag_value : 1;
}

function setFeatureFlag(key, value, description) {
  const existing = db.feature_flags.find((f) => f.flag_key === key);
  if (existing) {
    existing.flag_value = value;
    existing.description = description || existing.description;
    existing.updated_at = new Date().toISOString();
  } else {
    db.feature_flags.push({
      id: db.feature_flags.length + 1,
      flag_key: key,
      flag_value: value,
      description: description || "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  saveDB();
  return true;
}

function getAllFeatureFlags() {
  return db.feature_flags;
}

// ============================================================
// ADMIN AUTH (persisted password override)
// ============================================================

function getAdminAuth() {
  return db.adminAuth || null;
}

function setAdminAuth(passwordHash) {
  db.adminAuth = { passwordHash, updatedAt: new Date().toISOString() };
  saveDB();
  return true;
}

// ============================================================
// ADMIN RATE LIMITING
// ============================================================

// Simple in-memory rate limiting (not persisted)
const rateLimitStore = {};

function checkAdminRateLimit(ip, action, limit = 5, windowMs = 60 * 60 * 1000) {
  const key = `${ip}:${action}`;
  const now = Date.now();

  if (!rateLimitStore[key]) {
    rateLimitStore[key] = { count: 1, resetAt: now + windowMs };
    return { allowed: true, remaining: limit - 1 };
  }

  const record = rateLimitStore[key];
  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + windowMs;
    return { allowed: true, remaining: limit - 1 };
  }

  if (record.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: new Date(record.resetAt).toISOString(),
    };
  }

  record.count++;
  return { allowed: true, remaining: limit - record.count };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  db,
  saveDB,
  getUserByUsername,
  getUserByIp,
  getUserById,
  createUser,
  updateUserPassword,
  updateUserLoginInfo,
  updateUserStats,
  incrementLoginAttempts,
  isUserLocked,
  resetLoginAttempts,
  enableTOTP,
  disableTOTP,
  getUserTOTP,
  useBackupCode,
  createAdminSession,
  getAdminSession,
  updateAdminSessionActivity,
  deleteAdminSession,
  deleteAllUserSessions,
  logActivity,
  createSecurityAlert,
  getSecurityAlerts,
  resolveSecurityAlert,
  getStats,
  getRecentActivity,
  getUsersWithStats,
  banUser,
  unbanUser,
  whitelistUser,
  removeWhitelist,
  deleteUser,
  createAccessRule,
  deleteAccessRule,
  getAccessRules,
  isBlacklisted,
  isWhitelisted,
  getModerationQueue,
  addToModerationQueue,
  resolveModerationQueue,
  getSetting,
  setSetting,
  getAllSettings,
  getFeatureFlag,
  setFeatureFlag,
  getAllFeatureFlags,
  checkAdminRateLimit,
  getAdminAuth,
  setAdminAuth,
};

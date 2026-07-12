// ============================================================
// MIDDLEWARE
// ============================================================

function trackUser(req, res, next) {
  req.clientIp = req.ip || req.connection.remoteAddress || "unknown";
  req.userAgent = req.headers["user-agent"] || "unknown";
  next();
}

function adminRateLimit(limit = 100, windowMs = 60000) {
  const requests = new Map();

  // Periodically drop expired entries so this Map doesn't grow forever
  // on a long-running server (was a memory leak before).
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of requests) {
      if (now > record.resetAt) requests.delete(key);
    }
  }, windowMs);
  sweep.unref();

  return function (req, res, next) {
    const ip = req.ip || req.connection.remoteAddress || "unknown";
    const key = `${ip}:${req.path}`;

    const now = Date.now();
    const record = requests.get(key) || { count: 0, resetAt: now + windowMs };

    if (now > record.resetAt) {
      record.count = 0;
      record.resetAt = now + windowMs;
    }

    record.count++;
    requests.set(key, record);

    if (record.count > limit) {
      return res
        .status(429)
        .json({ error: "Rate limit exceeded. Please try again later." });
    }

    next();
  };
}

module.exports = { trackUser, adminRateLimit };

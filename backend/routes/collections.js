const express = require("express");
const {
  createCollection,
  getCollection,
  deleteCollection,
} = require("../utils/db");

const router = express.Router();

// Basic per-IP rate limit on creation only — reading/deleting existing
// collections isn't rate limited here (deletion requires the owner token
// anyway, which acts as its own gate).
const CREATE_LIMIT = 20;
const CREATE_WINDOW_MS = 60 * 60 * 1000;
const createAttempts = new Map();

setInterval(
  () => {
    const now = Date.now();
    for (const [ip, rec] of createAttempts) {
      if (now > rec.resetAt) createAttempts.delete(ip);
    }
  },
  10 * 60 * 1000,
).unref();

function rateLimitCreate(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const now = Date.now();
  let rec = createAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + CREATE_WINDOW_MS };
  }
  rec.count++;
  createAttempts.set(ip, rec);

  if (rec.count > CREATE_LIMIT) {
    return res
      .status(429)
      .json({ error: "Too many collections created. Try again later." });
  }
  next();
}

// ============================================================
// CREATE
// ============================================================
router.post("/", rateLimitCreate, (req, res) => {
  const { items, name } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "At least one item is required." });
  }

  const result = createCollection(items, name);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  res.json({
    id: result.id,
    ownerToken: result.ownerToken,
  });
});

// ============================================================
// READ
// ============================================================
router.get("/:id", (req, res) => {
  const collection = getCollection(req.params.id);
  if (!collection) {
    return res
      .status(404)
      .json({ error: "This collection doesn't exist or has expired." });
  }
  res.json(collection);
});

// ============================================================
// DELETE
// ============================================================
router.delete("/:id", (req, res) => {
  const { ownerToken } = req.body || {};
  if (!ownerToken) {
    return res.status(400).json({ error: "Owner token is required." });
  }

  const deleted = deleteCollection(req.params.id, ownerToken);
  if (!deleted) {
    return res
      .status(404)
      .json({ error: "Collection not found, or the owner token is wrong." });
  }

  res.json({ message: "Collection deleted." });
});

module.exports = router;

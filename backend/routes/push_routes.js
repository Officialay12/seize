const express = require("express");
const {
  getPublicKey,
  saveSubscription,
  touchSubscription,
  removeSubscription,
} = require("../utils/push");

const router = express.Router();

router.get("/public-key", (req, res) => {
  res.json({ publicKey: getPublicKey() });
});

router.post("/subscribe", (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription?.endpoint) {
    return res
      .status(400)
      .json({ error: "A valid push subscription is required." });
  }
  saveSubscription(subscription);
  res.json({ message: "Subscribed." });
});

router.post("/unsubscribe", (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint)
    return res.status(400).json({ error: "endpoint is required." });
  removeSubscription(endpoint);
  res.json({ message: "Unsubscribed." });
});

// called once per app open to mark "still an active user" — keeps the
// re-engagement sweep from nagging someone who was just here yesterday
router.post("/ping", (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint)
    return res.status(400).json({ error: "endpoint is required." });
  touchSubscription(endpoint);
  res.json({ ok: true });
});

module.exports = router;

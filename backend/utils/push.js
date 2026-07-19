const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

// ============================================================
// PUSH NOTIFICATIONS — subscriptions + the "come back" scheduler
// ============================================================
// this is real Web Push (the kind that shows up outside the browser tab,
// even if seize isn't open) — not the in-app "your job's done" toasts
// that already existed. needs its own VAPID identity + a place to keep
// track of who's subscribed and when we last poked them.

const DATA_DIR = path.join(__dirname, "..", "data");
const VAPID_PATH = path.join(DATA_DIR, "vapid-keys.json");
const SUBS_PATH = path.join(DATA_DIR, "push-subscriptions.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// same write-to-temp-then-rename trick as persistence.js — don't want a
// crash mid-write turning either of these files into unreadable garbage
function atomicWrite(filePath, data) {
  try {
    ensureDataDir();
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    console.warn(
      `[push] failed to write ${path.basename(filePath)}:`,
      err.message,
    );
  }
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

// ---------- VAPID identity ----------
// generated once and kept forever — regenerating these would silently
// break every subscription anyone's ever made, since the public key has
// to match the one the browser subscribed against
let vapidKeys = readJson(VAPID_PATH, null);
if (!vapidKeys || !vapidKeys.publicKey || !vapidKeys.privateKey) {
  vapidKeys = webpush.generateVAPIDKeys();
  atomicWrite(VAPID_PATH, vapidKeys);
  console.log("[push] generated a new VAPID keypair (first boot)");
}

const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT || "mailto:ayomide0001111@gmail.com";
webpush.setVapidDetails(
  VAPID_SUBJECT,
  vapidKeys.publicKey,
  vapidKeys.privateKey,
);

function getPublicKey() {
  return vapidKeys.publicKey;
}

// ---------- subscriptions ----------
// keyed by endpoint since that's the one thing guaranteed unique per
// subscription. lastSeenAt tracks real app opens (bumped by /ping),
// lastNotifiedAt stops the scheduler from double-messaging someone
let subscriptions = readJson(SUBS_PATH, {});

function persistSubs() {
  atomicWrite(SUBS_PATH, subscriptions);
}

function saveSubscription(sub) {
  if (!sub?.endpoint) return false;
  const existing = subscriptions[sub.endpoint];
  subscriptions[sub.endpoint] = {
    subscription: sub,
    subscribedAt: existing?.subscribedAt || Date.now(),
    lastSeenAt: Date.now(),
    lastNotifiedAt: existing?.lastNotifiedAt || 0,
    msgIndex: existing?.msgIndex || 0,
  };
  persistSubs();
  return true;
}

function touchSubscription(endpoint) {
  if (!subscriptions[endpoint]) return false;
  subscriptions[endpoint].lastSeenAt = Date.now();
  persistSubs();
  return true;
}

function removeSubscription(endpoint) {
  if (!subscriptions[endpoint]) return false;
  delete subscriptions[endpoint];
  persistSubs();
  return true;
}

function subscriptionCount() {
  return Object.keys(subscriptions).length;
}

// ---------- the actual re-engagement messages ----------
const REMINDER_MESSAGES = [
  {
    title: "seize",
    body: "Use seize to grab your next video, audio, or image.",
  },
  {
    title: "It's been a while 👋",
    body: "Download your media with seize — fast, clean, no watermark.",
  },
  {
    title: "Got something to convert?",
    body: "Don't you have a video you want as audio (or the other way round)? Use seize now.",
  },
  { title: "seize", body: "From the builders of fetch." },
];

const INACTIVITY_THRESHOLD_MS = 48 * 60 * 60 * 1000; // nudge after 48h quiet
const RENOTIFY_COOLDOWN_MS = 48 * 60 * 60 * 1000; // never more than one nudge per 48h
const SCHEDULER_TICK_MS = 3 * 60 * 60 * 1000; // check every 3h

async function sendPush(endpoint, payload) {
  const record = subscriptions[endpoint];
  if (!record) return false;
  try {
    await webpush.sendNotification(
      record.subscription,
      JSON.stringify(payload),
    );
    return true;
  } catch (err) {
    // 404/410 means the browser dropped the subscription (uninstalled,
    // cleared data, expired) — no point holding onto a dead endpoint
    if (err.statusCode === 404 || err.statusCode === 410) {
      removeSubscription(endpoint);
    } else {
      console.warn("[push] send failed:", err.statusCode || err.message);
    }
    return false;
  }
}

async function runReengagementSweep() {
  const now = Date.now();
  const endpoints = Object.keys(subscriptions);
  let sent = 0;

  for (const endpoint of endpoints) {
    const record = subscriptions[endpoint];
    const quietFor = now - record.lastSeenAt;
    const sinceLastNudge = now - record.lastNotifiedAt;
    if (quietFor < INACTIVITY_THRESHOLD_MS) continue;
    if (sinceLastNudge < RENOTIFY_COOLDOWN_MS) continue;

    const msg = REMINDER_MESSAGES[record.msgIndex % REMINDER_MESSAGES.length];
    const ok = await sendPush(endpoint, { ...msg, url: "/" });
    if (ok) {
      record.lastNotifiedAt = now;
      record.msgIndex = (record.msgIndex + 1) % REMINDER_MESSAGES.length;
      sent++;
    }
  }

  if (sent > 0) persistSubs();
  if (sent > 0)
    console.log(`[push] re-engagement sweep sent ${sent} notification(s)`);
}

function startScheduler() {
  setInterval(() => {
    runReengagementSweep().catch((err) =>
      console.warn("[push] sweep failed:", err.message),
    );
  }, SCHEDULER_TICK_MS).unref();
}

module.exports = {
  getPublicKey,
  saveSubscription,
  touchSubscription,
  removeSubscription,
  subscriptionCount,
  sendPush,
  runReengagementSweep,
  startScheduler,
};

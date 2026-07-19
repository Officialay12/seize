const fs = require("fs");
const path = require("path");

// ============================================================
// FILE-BASED PERSISTENCE FOR ANALYTICS STATE
// ============================================================
// activityLog.js used to keep everything — request counters, login
// history, sessions, heatmap, all of it — in plain in-memory vars. so
// every restart/redeploy/crash just quietly wiped "344 requests today"
// back to 0, no trace it ever happened. this gives that stuff somewhere
// to actually live.
//
// heads up: this only survives a restart if the disk survives the
// restart. normal server/VPS, or render with a persistent disk = fine.
// plain render with no disk add-on = filesystem gets nuked on redeploy,
// so this still helps with crashes/simple restarts but not a fresh
// deploy. if that ends up mattering, swap this for real hosted storage
// (postgres, whatever) instead.

const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_PATH = path.join(DATA_DIR, "analytics-store.json");
const SAVE_DEBOUNCE_MS = 5000;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// reads whatever got saved, once, at startup. any failure here — missing
// file, corrupt json, permissions weirdness — just means start fresh.
// this should never be able to crash the server
function loadStore() {
  try {
    ensureDataDir();
    if (!fs.existsSync(STORE_PATH)) return null;
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn(
      "[persistence] Couldn't load analytics store, starting fresh:",
      err.message,
    );
    return null;
  }
}

// writes to a temp file then renames it over the real one instead of
// writing straight to STORE_PATH. if the process dies mid-write
// (crash, power loss, whatever) a direct write leaves you a half-written
// corrupt json file that just fails to load next time. rename is atomic
// on the same filesystem so you never see a half-finished file
function saveStoreSync(data) {
  if (!data) return;
  try {
    ensureDataDir();
    const tmpPath = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, STORE_PATH);
  } catch (err) {
    console.warn("[persistence] Failed to save analytics store:", err.message);
  }
}

// debounced save — activityLog.js can call this on literally every
// event (every request, every job update) without hammering the disk,
// since it just batches everything into one write every SAVE_DEBOUNCE_MS
let saveTimer = null;
let latestGetState = null;

function scheduleSave(getStateFn) {
  latestGetState = getStateFn;
  if (saveTimer) return; // already got one queued, this just updates what'll get saved
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (latestGetState) saveStoreSync(latestGetState());
  }, SAVE_DEBOUNCE_MS);
  if (saveTimer.unref) saveTimer.unref();
}

// skips the debounce and just saves right now. used on shutdown
// (SIGINT/SIGTERM) and before a manual admin restart so we're not
// losing the last few seconds to the debounce window
function flushSave(getStateFn) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const fn = getStateFn || latestGetState;
  if (fn) saveStoreSync(fn());
}

module.exports = {
  loadStore,
  saveStoreSync,
  scheduleSave,
  flushSave,
  STORE_PATH,
  DATA_DIR,
};

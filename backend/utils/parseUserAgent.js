// ============================================================
// dumb little UA parser. not trying to be exhaustive — just
// enough to bucket "who's using this thing" into something
// readable on a chart. good enough for internal stats, not a
// replacement for a real UA database.
// ============================================================

function parseUserAgent(ua = "") {
  const s = ua.toLowerCase();

  let device = "desktop";
  if (/ipad/.test(s)) device = "tablet";
  else if (/iphone|ipod/.test(s)) device = "ios";
  else if (/android/.test(s)) device = /mobile/.test(s) ? "android" : "tablet";
  else if (/mobile/.test(s)) device = "mobile-other";

  let browser = "other";
  if (/edg\//.test(s)) browser = "edge";
  else if (/opr\/|opera/.test(s)) browser = "opera";
  else if (/firefox\//.test(s)) browser = "firefox";
  else if (/crios\//.test(s)) browser = "chrome-ios";
  else if (/fxios\//.test(s)) browser = "firefox-ios";
  else if (/chrome\//.test(s) && !/chromium/.test(s)) browser = "chrome";
  else if (/safari\//.test(s) && !/chrome\//.test(s)) browser = "safari";

  let os = "other";
  if (/windows/.test(s)) os = "windows";
  else if (/mac os x/.test(s) && !/iphone|ipad/.test(s)) os = "macos";
  else if (/android/.test(s)) os = "android";
  else if (/iphone|ipad|ipod/.test(s)) os = "ios";
  else if (/linux/.test(s)) os = "linux";

  return { device, browser, os };
}

module.exports = { parseUserAgent };

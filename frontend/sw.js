const CACHE_NAME = "seize-shell-v9";
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/share-handler.html",
  "/admin.html",
  "/style.css",
  "/app.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        console.log("📦 Caching shell assets");
        // cache.addAll is all-or-nothing — one 404 kills the whole
        // precache, so add each asset separately instead
        return Promise.all(
          SHELL_ASSETS.map((url) =>
            cache.add(url).catch((err) => {
              console.warn(`⚠️ Failed to cache "${url}":`, err.message);
            }),
          ),
        );
      })
      .then(() => {
        console.log("✅ Install complete");
        return self.skipWaiting();
      }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        return Promise.all(
          keys
            .filter((k) => k !== CACHE_NAME)
            .map((k) => {
              console.log("🗑️ Deleting old cache:", k);
              return caches.delete(k);
            }),
        );
      })
      .then(() => {
        console.log("✅ Activation complete");
        return self.clients.claim();
      }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) return client.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow("/");
      }),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // skip anything that's not http/https (chrome-extension:// etc)
  if (!url.protocol.startsWith("http")) {
    return;
  }

  // domains that just cause CSP headaches, skip 'em
  const externalDomains = [
    "chat.deepseek.com",
    "deepseek.com",
    "chrome-extension",
    "chrome-devtools",
    "localhost:4000",
  ];

  if (externalDomains.some((domain) => url.hostname.includes(domain))) {
    return;
  }

  // api calls: network first, always
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ error: "Offline" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    return;
  }

  // admin pages: no cache, straight to network
  if (url.pathname === "/admin.html" || url.pathname === "/admin-login.html") {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response("Page not available offline", {
          status: 503,
          headers: { "Content-Type": "text/html" },
        });
      }),
    );
    return;
  }

  // share handler: never cache this one
  if (
    url.pathname === "/share-handler.html" ||
    url.pathname === "/share-handler" ||
    url.pathname === "/share-handler/"
  ) {
    event.respondWith(fetch(event.request));
    return;
  }

  // external images: network first, no-cors
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    if (
      url.pathname.match(/\.(jpg|jpeg|png|gif|webp|svg|avif)$/i) ||
      url.pathname.includes("/img/") ||
      url.pathname.includes("/image/") ||
      url.pathname.includes("thumbnail")
    ) {
      event.respondWith(
        fetch(event.request, {
          mode: "no-cors",
          cache: "default",
        })
          .then((response) => {
            // only cache valid responses
            if (response && response.ok && response.type === "basic") {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => {
                try {
                  cache.put(event.request, clone);
                } catch (e) {
                  // some responses just refuse to be cached
                }
              });
            }
            return response;
          })
          .catch(() => {
            return caches.match(event.request);
          }),
      );
      return;
    }
  }

  // everything else: network first (so deploys show up immediately),
  // cache as a fallback for offline use only. The old cache-first
  // approach meant the install-time precache (index.html, app.js,
  // style.css, manifest.json) could get stuck serving a stale version
  // indefinitely — production runtime never re-populated the cache here
  // (that branch below only fires for localhost), so once something was
  // precached, only a sw.js byte-change (i.e. remembering to bump
  // CACHE_NAME) would ever refresh it. Network-first removes that trap.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (
          response &&
          response.ok &&
          (url.hostname === "localhost" || url.hostname === "127.0.0.1")
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            try {
              cache.put(event.request, clone);
            } catch (e) {
              // some responses just refuse to be cached
            }
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          // offline fallback
          if (url.pathname.endsWith(".html")) {
            return new Response("Page not available offline", {
              status: 503,
              headers: { "Content-Type": "text/html" },
            });
          }
          return new Response("Offline", { status: 503 });
        });
      }),
  );
});

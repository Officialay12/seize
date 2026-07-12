const CACHE_NAME = "seize-shell-v5";
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
        // cache.addAll() is all-or-nothing: one 404'ing asset silently
        // fails the ENTIRE precache. Cache each asset independently so
        // a single missing file doesn't take the rest down with it.
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

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // ============================================
  // CRITICAL FIX: Skip ALL non-http/https requests
  // This includes chrome-extension, chrome-devtools, etc.
  // ============================================
  if (!url.protocol.startsWith("http")) {
    return;
  }

  // ============================================
  // Skip external domains that cause CSP issues
  // ============================================
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

  // ============================================
  // API calls: network first
  // ============================================
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

  // ============================================
  // Admin pages: network first (no cache)
  // ============================================
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

  // ============================================
  // Share handler: always network
  // ============================================
  if (url.pathname === "/share-handler" || url.pathname === "/share-handler/") {
    event.respondWith(fetch(event.request));
    return;
  }

  // ============================================
  // External images: network first with no-cors
  // ============================================
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
            // Only cache if it's a valid response
            if (response && response.ok && response.type === "basic") {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => {
                try {
                  cache.put(event.request, clone);
                } catch (e) {
                  // Some responses can't be cached
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

  // ============================================
  // Everything else: cache first, fallback to network
  // ============================================
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(event.request)
        .then((response) => {
          // Only cache successful responses for local assets
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
                // Some responses can't be cached
              }
            });
          }
          return response;
        })
        .catch(() => {
          // Return offline fallback
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

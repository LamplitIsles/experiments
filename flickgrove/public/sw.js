const VERSION = "flickgrove-v1";
self.addEventListener("install", (event) =>
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      const response = await fetch("/");
      const html = await response.clone().text();
      await cache.put("/", response);
      const builtAssets = /* BUILD_ASSETS */ [];
      const assets = [
        ...html.matchAll(/(?:src|href)="(\/assets\/[^"#]+)"/g),
      ].map((match) => match[1]);
      await cache.addAll([
        ...new Set([
          ...builtAssets,
          ...assets,
          "/icon.svg",
          "/manifest.webmanifest",
        ]),
      ]);
      await self.skipWaiting();
    })(),
  ),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith("flickgrove-") && name !== VERSION)
          await caches.delete(name);
      await self.clients.claim();
    })(),
  ),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/preview/") ||
    event.request.method !== "GET"
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      try {
        const response = await fetch(event.request);
        if (response.ok) await cache.put(event.request, response.clone());
        return response;
      } catch {
        return (
          (await cache.match(event.request)) ??
          (event.request.mode === "navigate"
            ? await cache.match("/")
            : undefined) ??
          Response.error()
        );
      }
    })(),
  );
});

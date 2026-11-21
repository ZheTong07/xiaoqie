/**
 * 企鹅小窝 Service Worker
 *
 * 只缓存应用外壳（HTML / CSS / JS / 图片），不缓存云端返回的记录与媒体。
 * 修改静态资源后，请把 CACHE_NAME 的版本号 +1，否则旧缓存会继续生效。
 */

const CACHE_NAME = "qixiaowo-shell-v6";

const ASSETS = [
  // serve 会把 /index.html 重定向到 /index，这里直接缓存根路径的应用外壳
  "/",
  "/styles.css",
  "/app.js",
  "/ui.js",
  "/lightbox.js",
  "/uuid.js",
  "/manifest.json",
  "/lib/supabaseClient.js",
  "/data/repository.js",
  "/data/notesRepository.js",
  "/data/settingsStore.js",
  "/storage/mediaStore.js",
  "/images/dog-empty.png",
  "/images/dog-footer.png",
  "/images/dog-success.png",
  "/images/icon-192.png",
  "/images/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // 只处理同源 GET 请求；Supabase 的数据请求是跨源 POST/GET，天然不会被缓存。
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // /api/* 是云端数据与媒体的同源反代，绝不进应用外壳缓存：
  // 缓存会让记录过期，也会让视频的 Range 请求命中整段缓存而无法拖动进度。
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return;

  // 页面导航：优先网络，断网时回退到缓存的应用外壳
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match("/")),
    );
    return;
  }

  // 静态资源：优先缓存，未命中时请求网络并写入缓存
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request).then((response) => {
        if (!response || response.status !== 200 || response.type !== "basic") {
          return response;
        }

        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    }),
  );
});

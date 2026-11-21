/**
 * Cloudflare Pages Function：Supabase 同源反向代理。
 *
 *   https://<pages 域名>/api/*  →  https://udvqgljundygfjizmpcw.supabase.co/*
 *
 * 手机移动网络直连 supabase.co 很不稳定，前端（lib/supabaseClient.js）在非 localhost
 * 环境统一把请求打到 /api，由这里转发。
 *
 * 安全约定：上游域名写死为常量，绝不从请求 URL / query / header 里读取目标地址，
 * 避免变成开放代理。RLS / key 策略保持不变。
 */

/** 上游地址：唯一事实来源，硬编码常量，禁止动态拼接。 */
const UPSTREAM_ORIGIN = "https://udvqgljundygfjizmpcw.supabase.co";
const API_PREFIX = "/api";

/** 逐跳头只属于当前这一跳，不能透传给上游或客户端。 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * 只缓存公开桶的 GET 响应。数据接口（/rest/v1/*）与登录接口（/auth/v1/*）
 * 必须实时，且可能含隐私，严禁进入缓存。
 */
const CACHEABLE_PATH_PREFIX = "/api/storage/v1/object/public/";
/** 缓存时长上限（秒）：即使上游说一年，也最多缓存 1 小时。 */
const MAX_CACHE_SECONDS = 3600;

export async function onRequest(context) {
  const { request } = context;

  // 同源请求不会触发预检；保留标准响应，兼容以后可能出现的跨域调用。
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { Allow: "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS" },
    });
  }

  try {
    return await proxy(request, context);
  } catch (err) {
    console.error("Supabase 反代失败", err);
    return jsonError(502, "无法连接云端服务，请稍后重试。");
  }
}

async function proxy(request, context) {
  const url = new URL(request.url);
  const upstreamUrl = `${UPSTREAM_ORIGIN}${toUpstreamPath(url.pathname)}${url.search}`;

  // 仅公开桶 GET（无 Range）走缓存；键为完整 URL。
  const cacheKey = cacheKeyFor(request, url);
  const cache = cacheKey ? getCache() : null;

  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return withCacheStatus(cached, "HIT");
    } catch (err) {
      console.warn("读取反代缓存失败", err);
    }
  }

  // 透传请求头（host / cf-* / 逐跳头除外），
  // 包含 Authorization、apikey、Prefer、Content-Type、Accept、Range 等。
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (lower === "host" || lower.startsWith("cf-")) continue;
    if (HOP_BY_HOP.has(lower)) continue;
    headers.append(name, value);
  }

  // Accept-Encoding 也原样透传。Workers 的约定是：只要不提前读 body、
  // 并原样保留 Content-Encoding，压缩数据会直接透传，不会解压后重压。
  // 视频 / 图片通常是 identity，JSON 可能是 br / gzip，两种都由浏览器按头解码。

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  let upstream;
  try {
    // redirect: follow —— 上游若返回 3xx，由 Worker 在服务端跟随，
    // 浏览器不会看到直连 supabase.co 的 Location。
    upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "follow",
    });
  } catch (err) {
    console.error("Supabase 反代请求失败", upstreamUrl, err);
    return jsonError(502, "云端服务暂时不可用，请稍后重试。");
  }

  // 透传状态码与响应头（Content-Type / Content-Range / Accept-Ranges /
  // ETag / Cache-Control 等），body 直接接流，不读进内存：
  // 大图与视频依赖流式返回，206 部分响应也必须原样保留。
  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    responseHeaders.append(name, value);
  }

  const response = new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });

  if (cache && upstream.status === 200) {
    const ttl = sharedCacheTTL(responseHeaders);
    if (ttl > 0 && isCacheableResponse(responseHeaders)) {
      // 客户端与边缘缓存都按上限值走，避免上游一年缓存把删除后的图片留住
      response.headers.set("cache-control", `public, max-age=${ttl}`);

      const copy = response.clone();
      const store = cache
        .put(cacheKey, copy)
        .catch((err) => console.warn("写入反代缓存失败", err));

      if (typeof context?.waitUntil === "function") context.waitUntil(store);
      else void store;
    }
  }

  if (cacheKey) response.headers.set("x-cache", "MISS");
  return response;
}

// ---------- 缓存 ----------

/** 完整 URL 作键；只缓存公开桶 GET，Range 请求一律绕过。 */
function cacheKeyFor(request, url) {
  if (request.method !== "GET") return null;
  if (request.headers.has("range")) return null;
  if (!url.pathname.startsWith(CACHEABLE_PATH_PREFIX)) return null;
  return new Request(url.origin + url.pathname + url.search, { method: "GET" });
}

function getCache() {
  try {
    return globalThis.caches?.default ?? null;
  } catch {
    return null;
  }
}

/** 取上游 Cache-Control 的共享缓存时长，上限 3600 秒；不可缓存时返回 0。 */
function sharedCacheTTL(headers) {
  const value = headers.get("cache-control") ?? "";
  if (!value) return 0;
  if (/(?:^|,)\s*(?:no-store|no-cache|private)\b/i.test(value)) return 0;

  const shared = /(?:^|,)\s*s-maxage\s*=\s*(\d+)/i.exec(value);
  const maxAge = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(value);
  const seconds = Number(shared?.[1] ?? maxAge?.[1] ?? 0);

  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(seconds, MAX_CACHE_SECONDS);
}

/** Cache API 不接受的响应（带 Set-Cookie / Vary: *）不写入。 */
function isCacheableResponse(headers) {
  if (headers.has("set-cookie")) return false;
  const vary = headers.get("vary");
  if (vary && vary.trim() === "*") return false;
  return true;
}

function withCacheStatus(response, value) {
  const headers = new Headers(response.headers);
  headers.set("x-cache", value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * /api/storage/v1/... → /storage/v1/...
 * 始终拼在上游域名之后；合并重复斜杠，避免路径被解释成协议相对地址（//host）。
 */
function toUpstreamPath(pathname) {
  let path = pathname;

  if (path === API_PREFIX) {
    path = "/";
  } else if (path.startsWith(`${API_PREFIX}/`)) {
    path = path.slice(API_PREFIX.length);
  }

  if (!path.startsWith("/")) path = `/${path}`;
  return path.replace(/\/{2,}/g, "/");
}

/** 结构化错误，避免把 Cloudflare 默认错误页直接抛给前端。 */
function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

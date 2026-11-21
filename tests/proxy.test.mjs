/**
 * 反向代理测试：不连真实网络，用注入的 fetch 捕获出站请求。
 * 覆盖路径映射、header、流式/206、OPTIONS、错误、缓存与局域网判定。
 */

import { createChecker } from "./helpers/check.mjs";

const { check, finish } = createChecker();

const PROXY_URL = new URL("../functions/api/[[path]].js", import.meta.url);
const CLIENT_URL = new URL("../lib/supabaseClient.js", import.meta.url);
const { onRequest } = await import(PROXY_URL.href);

const UPSTREAM = "https://udvqgljundygfjizmpcw.supabase.co";
const PAGE = "https://xiaoqie.pages.dev";

/** 每次测试覆盖 fetch 实现，并记录 proxy 实际发出的请求。 */
let fetchImpl = () => new Response("ok");
let calls = [];

globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? await new Response(init.body).text() : null;
  calls.push({ url, init, body });
  return fetchImpl(url, init, calls.length);
};

function resetFetch(impl) {
  calls = [];
  fetchImpl = impl;
}

/** 运行一次 Function；waitUntil 里的缓存写入会在这里被等待完成。 */
async function run(request, cache = null) {
  const pending = [];

  if (cache) globalThis.caches = { default: cache };
  else delete globalThis.caches;

  try {
    const response = await onRequest({
      request,
      waitUntil: (promise) => pending.push(promise),
    });
    await Promise.all(pending);
    return response;
  } finally {
    delete globalThis.caches;
  }
}

function fakeCache() {
  const store = new Map();
  return {
    puts: [],
    async match(request) {
      const hit = store.get(request.url);
      if (!hit) return undefined;
      return new Response(hit.body, {
        status: hit.status,
        headers: hit.headers,
      });
    },
    async put(request, response) {
      const body = await response.arrayBuffer();
      this.puts.push(request.url);
      store.set(request.url, {
        body,
        status: response.status,
        headers: [...response.headers],
      });
    },
  };
}

// ---------- 路径与 header ----------

resetFetch(() => new Response("ok", { status: 200 }));
let response = await run(
  new Request(`${PAGE}/api/rest/v1/entries?select=*`),
);
check(
  "路径映射：/api/rest/v1 去掉 /api 后拼到上游",
  calls[0]?.url === `${UPSTREAM}/rest/v1/entries?select=*`,
  calls[0]?.url,
);

calls = [];
response = await run(
  new Request(`${PAGE}/api/rest/v1/entries`, {
    headers: {
      apikey: "pub-key",
      authorization: "Bearer token",
      prefer: "return=representation",
      "content-type": "application/json",
      accept: "application/json",
      range: "bytes=0-10",
      "x-custom": "keep-me",
      "cf-connecting-ip": "1.2.3.4",
      connection: "keep-alive",
      te: "trailers",
      host: "xiaoqie.pages.dev",
    },
  }),
);
const sent = calls[0]?.init.headers;
check("透传 apikey", sent?.get("apikey") === "pub-key");
check("透传 Authorization", sent?.get("authorization") === "Bearer token");
check("透传 Prefer", sent?.get("prefer") === "return=representation");
check("透传 Content-Type", sent?.get("content-type") === "application/json");
check("透传 Accept", sent?.get("accept") === "application/json");
check("透传 Range", sent?.get("range") === "bytes=0-10");
check("透传自定义 header", sent?.get("x-custom") === "keep-me");
check("剔除 host", !sent?.has("host"));
check("剔除 cf-*", !sent?.has("cf-connecting-ip"));
check("剔除逐跳头 connection", !sent?.has("connection"));
check("剔除逐跳头 te", !sent?.has("te"));

// ---------- POST body ----------

calls = [];
resetFetch(() => new Response("created", { status: 201 }));
const payload = JSON.stringify({ title: "hi" });
response = await run(
  new Request(`${PAGE}/api/rest/v1/entries`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: payload,
  }),
);
check("透传 POST method", calls[0]?.init.method === "POST");
check("透传 POST body", calls[0]?.body === payload, calls[0]?.body);
check("透传 POST 响应状态", response.status === 201);

// ---------- 206 / Range ----------

calls = [];
resetFetch(
  () =>
    new Response("part", {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Range": "bytes 0-3/100",
        "Accept-Ranges": "bytes",
        ETag: '"abc"',
        "Cache-Control": "max-age=3600",
      },
    }),
);
response = await run(
  new Request(`${PAGE}/api/storage/v1/object/public/media/cloud-rel-1/v.mp4`, {
    headers: { Range: "bytes=0-3" },
  }),
);
check("206 状态透传", response.status === 206);
check(
  "Content-Range 透传",
  response.headers.get("content-range") === "bytes 0-3/100",
);
check(
  "Accept-Ranges 透传",
  response.headers.get("accept-ranges") === "bytes",
);
check("ETag 透传", response.headers.get("etag") === '"abc"');
check("流式 body 可用", (await response.text()) === "part");

// ---------- OPTIONS ----------

response = await run(
  new Request(`${PAGE}/api/rest/v1/entries`, { method: "OPTIONS" }),
);
check("OPTIONS 返回 204", response.status === 204);
check(
  "OPTIONS 声明 Allow",
  (response.headers.get("allow") ?? "").includes("GET"),
);

// ---------- 开放代理防护 ----------

calls = [];
resetFetch(() => new Response("ok"));
await run(
  new Request(`${PAGE}/api//evil.example.com/x?host=evil.example.com`, {
    headers: { "x-forwarded-host": "evil.example.com" },
  }),
);
check(
  "//host 不能改变上游域名",
  new URL(calls[0].url).origin === UPSTREAM,
  calls[0]?.url,
);
check(
  "请求 header / query 不能改变上游域名",
  calls[0].url.startsWith(`${UPSTREAM}/evil.example.com/x`),
  calls[0]?.url,
);

// ---------- 上游失败 ----------

resetFetch(() => {
  throw new TypeError("network down");
});
response = await run(new Request(`${PAGE}/api/rest/v1/entries`));
const errorBody = await response.json();
check("上游失败返回 502", response.status === 502);
check(
  "上游失败返回结构化错误",
  typeof errorBody.error === "string" && errorBody.error.includes("云端"),
  JSON.stringify(errorBody),
);

// ---------- 缓存 ----------

const STORAGE = `${PAGE}/api/storage/v1/object/public/media/cloud-rel-1/a.jpg`;

calls = [];
const cache = fakeCache();
resetFetch(
  () =>
    new Response("image-bytes", {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=7200",
      },
    }),
);
const first = await run(new Request(STORAGE), cache);
check("首次请求标记 MISS", first.headers.get("x-cache") === "MISS");
check("首次请求回源", calls.length === 1);
check(
  "缓存时长上限 3600 秒",
  first.headers.get("cache-control") === "public, max-age=3600",
  first.headers.get("cache-control"),
);
check("首次请求写入缓存", cache.puts.length === 1);

const second = await run(new Request(STORAGE), cache);
check("第二次请求命中缓存", second.headers.get("x-cache") === "HIT");
check("命中后不再回源", calls.length === 1);
check("缓存响应 body 正确", (await second.text()) === "image-bytes");

calls = [];
const restCache = fakeCache();
resetFetch(() => new Response("[]", { status: 200, headers: { "Cache-Control": "max-age=3600" } }));
await run(new Request(`${PAGE}/api/rest/v1/entries`), restCache);
await run(new Request(`${PAGE}/api/rest/v1/entries`), restCache);
check("/rest/v1 永不缓存", calls.length === 2 && restCache.puts.length === 0);

calls = [];
const authCache = fakeCache();
resetFetch(() => new Response("{}", { status: 200, headers: { "Cache-Control": "max-age=3600" } }));
await run(new Request(`${PAGE}/api/auth/v1/token`), authCache);
check("/auth/v1 永不缓存", authCache.puts.length === 0);

calls = [];
const rangeCache = fakeCache();
resetFetch(
  () =>
    new Response("part", {
      status: 206,
      headers: { "Content-Range": "bytes 0-3/100", "Accept-Ranges": "bytes" },
    }),
);
await run(
  new Request(STORAGE, { headers: { Range: "bytes=0-3" } }),
  rangeCache,
);
check("Range 请求绕过缓存", rangeCache.puts.length === 0);
await run(new Request(STORAGE), rangeCache);
check("Range 请求不污染完整请求缓存", calls.length === 2);

calls = [];
const noStoreCache = fakeCache();
resetFetch(
  () =>
    new Response("secret", {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    }),
);
await run(new Request(STORAGE), noStoreCache);
check("no-store 不写缓存", noStoreCache.puts.length === 0);

// ---------- 局域网 / 本地直连判定 ----------

delete globalThis.location;
async function baseFor(hostname, protocol = "http:") {
  globalThis.location = {
    hostname,
    protocol,
    origin: `${protocol}//${hostname}`,
  };
  const module = await import(
    `${CLIENT_URL.href}?case=${encodeURIComponent(protocol + hostname)}`
  );
  return module.getStoragePublicURL("cloud-rel-1/a.jpg");
}

check("localhost 直连", (await baseFor("localhost")).startsWith(UPSTREAM));
check("127.0.0.1 直连", (await baseFor("127.0.0.1")).startsWith(UPSTREAM));
check("192.168.x.x 直连", (await baseFor("192.168.1.23")).startsWith(UPSTREAM));
check("10.x.x.x 直连", (await baseFor("10.0.0.8")).startsWith(UPSTREAM));
check("172.16.x.x 直连", (await baseFor("172.16.0.1")).startsWith(UPSTREAM));
check("172.31.x.x 直连", (await baseFor("172.31.255.254")).startsWith(UPSTREAM));
const nonPrivate = await baseFor("172.32.0.1");
check(
  "172.32.x.x 不属于私有网段，走 /api",
  nonPrivate.includes("/api/storage/") && !nonPrivate.startsWith(UPSTREAM),
  nonPrivate,
);
check(
  "公网域名走 /api",
  (await baseFor("xiaoqie.pages.dev", "https:")).startsWith(`${PAGE}/api/`),
);
delete globalThis.location;

finish();

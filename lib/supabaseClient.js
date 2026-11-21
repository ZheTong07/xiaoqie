/**
 * 云端连接层：repository / mediaStore 共用的唯一 Supabase 客户端。
 *
 * - 只放「连接 + 常量 + 错误翻译」，不含任何业务查询。
 * - 依赖方向：repository → 本模块、mediaStore → 本模块；
 *   repository ↔ mediaStore 之间不通过本模块耦合，也不互相绕过。
 * - publishable key 是设计上可公开的客户端密钥，真正的访问控制靠 RLS 策略
 *   （见 supabase/schema.sql）。切勿把 service_role key 放进前端。
 */

/**
 * Supabase 客户端的 base URL 不带 /rest/v1。
 * 后台给的 Project URL 可能带 /rest/v1/ 后缀，这里统一去掉。
 *
 * 线上（xiaoqie.pages.dev）统一走同源反向代理：移动网络直连 supabase.co 很不稳定，
 * 由 Cloudflare Pages Function（functions/api/[[path]].js）转发到同一个上游。
 * 本地开发（localhost / 127.0.0.1）仍直连上游，不依赖 Functions 运行时。
 * 反代上游域名的唯一事实来源是 functions/api/[[path]].js 里的常量，这里只写 /api 前缀。
 */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * 私有 IPv4 网段：局域网调试时（手机连同一 WiFi 访问 192.168.x.x:端口），
 * 本机没有 Cloudflare Functions，必须直连上游，不能打到 /api。
 * 覆盖 10.0.0.0/8、172.16.0.0/12、192.168.0.0/16。
 */
function isPrivateIPv4(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(
    String(hostname ?? ""),
  );
  if (!match) return false;

  const octets = match.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return false;

  const [a, b] = octets;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

const HOSTNAME = globalThis.location?.hostname ?? "";
const IS_LOCAL_DEV =
  LOCAL_HOSTNAMES.has(HOSTNAME) ||
  isPrivateIPv4(HOSTNAME) ||
  globalThis.location?.protocol === "file:";

const RAW_PROJECT_URL = IS_LOCAL_DEV
  ? "https://udvqgljundygfjizmpcw.supabase.co/rest/v1/"
  : `${globalThis.location.origin}/api`;

const PROJECT_URL = RAW_PROJECT_URL.replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, "");

const PUBLISHABLE_KEY = "sb_publishable_Rw0k_xl4kvE0h1fx5owlyA_nzfa-PUu";

/** 存储桶名，与 Supabase Storage 里创建的桶保持一致。 */
export const BUCKET = "media";

/**
 * 由桶内路径现拼公开访问地址。
 *
 * 媒体读取一律走这里，不直接信任 media.url 列里存死的历史地址：
 * 反代上线前写入的 url 是直连 supabase.co 的，移动网络下不可用；
 * 而 storage_path 始终是桶内路径，现拼后线上自动落到同源 /api 下。
 *
 * @param {string} storagePath 例如 "cloud-rel-1/a9f0....jpg"
 * @returns {string} 线上为 `${location.origin}/api/storage/v1/object/public/media/...`
 */
export function getStoragePublicURL(storagePath) {
  const path = String(storagePath ?? "").replace(/^\/+/, "");
  if (!path) return "";

  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `${PROJECT_URL}/storage/v1/object/public/${BUCKET}/${encoded}`;
}

/** 表名常量，避免散落在各处的魔法字符串。 */
export const TABLES = Object.freeze({
  entries: "entries",
  media: "media",
  notes: "notes",
});

/**
 * v1 固定云端范围：还没有登录，所有数据都属于同一段关系。
 * 未来接入 Supabase Auth 后，这里改为从会话注入。
 */
export const CLOUD_SCOPE = Object.freeze({
  ownerId: "local-user",
  relationshipId: "cloud-rel-1",
});

let client = null;

/**
 * 取 Supabase 客户端（懒初始化）。
 * SDK 由 index.html 里的 CDN <script> 注入到 window.supabase。
 * @returns {import("@supabase/supabase-js").SupabaseClient}
 */
export function getClient() {
  if (client) return client;

  const sdk = globalThis.supabase;
  if (!sdk || typeof sdk.createClient !== "function") {
    throw new Error(
      "Supabase SDK 未加载：请确认能访问 cdn.jsdelivr.net（离线或被拦截时会出现此错误），然后刷新页面。",
    );
  }

  client = sdk.createClient(PROJECT_URL, PUBLISHABLE_KEY, {
    auth: {
      // v1 没有登录，不落任何会话，也不在后台刷新 token
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return client;
}

const GRANT_HINT =
  "云端拒绝了访问（权限不足）：请在 Supabase Dashboard → SQL Editor 里执行 supabase/schema.sql 中的授权与 RLS 策略语句。";

/**
 * 把 Supabase / PostgREST / Storage 返回的错误对象翻译成用户看得懂的中文错误。
 * 仓储层与媒体层都只把 Error 抛给页面层，页面层拿到的永远是可展示的 message。
 * @param {unknown} error
 * @param {string} fallback
 * @returns {Error}
 */
export function toAppError(error, fallback = "云端操作失败") {
  const message = String(error?.message ?? error ?? "").trim();
  const code = String(error?.code ?? error?.statusCode ?? "").trim();

  if (code === "42501" || /permission denied/i.test(message)) {
    return new Error(GRANT_HINT);
  }

  if (/bucket not found/i.test(message)) {
    return new Error(
      "云端存储桶 media 不存在：请先在 Supabase Storage 创建名为 media 的存储桶（supabase/schema.sql 里有对应语句）。",
    );
  }

  if (
    code === "413" ||
    /maximum allowed size|payload too large|exceeded the maximum/i.test(message)
  ) {
    return new Error(
      "云端拒收这个文件：超过存储桶的单文件大小上限（单个视频建议不超过 100MB）。",
    );
  }

  if (
    code === "PGRST205" ||
    code === "42P01" ||
    /could not find the table|relation .* does not exist/i.test(message)
  ) {
    return new Error(
      "云端缺少数据表：请在 Supabase SQL Editor 执行 supabase/schema.sql 创建 entries / media / notes 表。",
    );
  }

  if (
    code === "PGRST204" ||
    code === "42703" ||
    /column .* does not exist/i.test(message)
  ) {
    return new Error(
      `云端表结构与前端不一致：${message}。请执行 supabase/schema.sql 对齐字段。`,
    );
  }

  if (/row-level security policy/i.test(message)) {
    return new Error(
      "云端 RLS 策略拒绝了这次读写：请执行 supabase/schema.sql 里 entries / media 表与 storage.objects 的策略语句。",
    );
  }

  if (code === "23505" || /duplicate key/i.test(message)) {
    return new Error("云端已存在同 id 的数据，请刷新后重试。");
  }

  if (
    /failed to fetch|networkerror|load failed|network request failed/i.test(
      message,
    )
  ) {
    return new Error("无法连接云端，请检查网络后重试。");
  }

  if (!message) return new Error(fallback);
  return new Error(`${fallback}：${message}`);
}

/** 数字毫秒或 ISO 时间字符串都转成毫秒，兼容列类型被建成 timestamptz 的情况。 */
export function toMillis(value) {
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) return num;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

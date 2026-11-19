/**
 * 媒体存取抽象层：照片 / 视频的唯一进出口。
 *
 * v2 起媒体二进制放在 Supabase Storage 的 media 桶，元数据放在 public.media 表，
 * 对外函数签名与本地版保持一致；页面层拿到的 url 可以直接塞给 <img>/<video>。
 *
 * 约定：
 * - 页面层不得直接调用 Supabase Storage，只调用本文件导出的函数。
 * - 照片保存前压缩到长边 1920px（等比缩放，输出 JPEG，质量 0.85）；视频不压缩。
 * - 上传前做一次大小预检（单文件 100MB），真正的上限由存储桶配置决定。
 * - 媒体记录同样自动补 ownerId / relationshipId。
 * - 本模块只依赖 lib/supabaseClient.js，不得反向依赖 repository。
 */

import { generateUUID } from "../uuid.js";
import {
  BUCKET,
  CLOUD_SCOPE,
  TABLES,
  getClient,
  toAppError,
  toMillis,
} from "../lib/supabaseClient.js";

const TABLE = TABLES.media;

const MAX_IMAGE_EDGE = 1920;
const JPEG_QUALITY = 0.85;
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const VIDEO_SIZE_HINT = "单个视频建议不超过 100MB";

// ---------- 字段映射：前端 camelCase ↔ 云端 snake_case ----------

function fromRow(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    relationshipId: row.relationship_id,
    entryId: row.entry_id ?? null,

    kind: row.kind,
    mimeType: row.mime_type,
    size: Number(row.size) || 0,
    fileName: row.file_name ?? "",

    /** 桶内路径，删除对象时用；getPublicUrl 拼出的公开地址存在 url 列。 */
    storagePath: row.storage_path ?? "",
    url: row.url ?? "",

    createdAt: toMillis(row.created_at),
  };
}

function toRow(record) {
  return {
    id: record.id,
    owner_id: record.ownerId,
    relationship_id: record.relationshipId,
    entry_id: record.entryId ?? null,

    kind: record.kind,
    mime_type: record.mimeType,
    size: record.size,
    file_name: record.fileName ?? "",

    storage_path: record.storagePath ?? "",
    url: record.url ?? "",

    created_at: record.createdAt,
  };
}

/** 对外只交出不含内部路径的元数据。 */
function toMeta(record) {
  return {
    id: record.id,
    ownerId: record.ownerId,
    relationshipId: record.relationshipId,
    entryId: record.entryId,
    kind: record.kind,
    mimeType: record.mimeType,
    size: record.size,
    fileName: record.fileName,
    url: record.url,
    createdAt: record.createdAt,
  };
}

// ---------- 写 ----------

/**
 * 保存一个媒体文件。
 * 照片会被压缩；视频原样上传。返回含 url 的元数据。
 * @param {File|Blob} file
 * @param {{ entryId?: string }} [options]
 * @returns {Promise<object>}
 */
export async function saveMedia(file, options = {}) {
  if (!(file instanceof Blob)) throw new Error("无效的文件");

  const kind = detectKind(file);
  if (!kind) {
    throw new Error(`不支持的文件类型：${file.name || file.type || "未知文件"}`);
  }

  const prepared =
    kind === "image"
      ? await prepareImage(file)
      : {
          blob: file,
          mimeType: file.type || guessMime(file.name),
          fileName: file.name || "video",
        };

  assertFileSize(prepared.blob.size, kind);

  const supabase = getClient();
  const id = generateUUID();

  // 路径带上 relationshipId，未来多段关系共用同一个桶时天然分目录。
  const path = objectPath(id, prepared.mimeType);
  const uploaded = await uploadBlob(supabase, path, prepared.blob, prepared.mimeType, {
    upsert: false,
  });

  const record = {
    id,
    ownerId: CLOUD_SCOPE.ownerId,
    relationshipId: CLOUD_SCOPE.relationshipId,
    entryId: options.entryId ?? null,

    kind,
    mimeType: prepared.mimeType,
    size: prepared.blob.size,
    fileName: prepared.fileName,

    storagePath: uploaded.path,
    url: uploaded.url,

    createdAt: Date.now(),
  };

  const { data, error } = await supabase
    .from(TABLE)
    .insert(toRow(record))
    .select("*")
    .single();

  if (error) {
    // 元数据写不进去就把刚上传的对象删掉，避免桶里留下孤儿文件
    try {
      await supabase.storage.from(BUCKET).remove([uploaded.path]);
    } catch (cleanupErr) {
      console.warn("清理已上传的媒体文件失败", cleanupErr);
    }
    throw toAppError(error, "媒体信息写入失败");
  }

  return toMeta(fromRow(data));
}

/**
 * 读取媒体的二进制本体（备份导出、下载等场景使用）。
 * @param {string} id
 * @returns {Promise<Blob|null>}
 */
export async function getMediaBlob(id) {
  const supabase = getClient();
  const { data: row, error } = await supabase
    .from(TABLE)
    .select("url, storage_path")
    .eq("id", id)
    .maybeSingle();

  if (error) throw toAppError(error, "读取媒体失败");
  if (!row) return null;

  if (row.storage_path) {
    const { data: blob, error: downloadError } = await supabase.storage
      .from(BUCKET)
      .download(row.storage_path);

    if (!downloadError && blob) return blob;
  }

  if (!row.url) return null;

  try {
    const response = await fetch(row.url);
    return response.ok ? await response.blob() : null;
  } catch {
    return null;
  }
}

/**
 * 取媒体可直接用于 <img>/<video> 的地址。
 * 云端模式下就是媒体记录里存的公开 URL，无需释放。
 * @param {string} id
 * @returns {Promise<string>}
 */
export async function getMediaURL(id) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from(TABLE)
    .select("url")
    .eq("id", id)
    .maybeSingle();

  if (error) throw toAppError(error, "读取媒体失败");
  if (!data?.url) throw new Error("媒体不存在或已被删除");
  return data.url;
}

/**
 * 批量读取媒体元数据与地址（列表渲染用，一次请求）。
 * 返回的 url 是公开地址，revokeMediaURL 对它不做任何事。
 * 不存在的媒体会被静默跳过。
 * @param {string[]} ids
 * @returns {Promise<Array<{ id: string, kind: string, mimeType: string, url: string }>>}
 */
export async function getMediaURLs(ids) {
  const list = Array.isArray(ids)
    ? [...new Set(ids.map((id) => String(id ?? "").trim()).filter(Boolean))]
    : [];
  if (!list.length) return [];

  const supabase = getClient();
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, kind, mime_type, url")
    .in("id", list);

  if (error) throw toAppError(error, "读取媒体失败");

  const byId = new Map((data ?? []).map((row) => [row.id, row]));
  const views = [];
  for (const id of list) {
    const row = byId.get(id);
    if (!row?.url) continue;
    views.push({
      id: row.id,
      kind: row.kind,
      mimeType: row.mime_type,
      url: row.url,
    });
  }
  return views;
}

/**
 * 释放由 getMediaURL / getMediaURLs 生成的地址。
 * 云端返回的是 https 地址，不做释放；只有未来回落成本地 blob URL 时才需要。
 * @param {string} url
 */
export function revokeMediaURL(url) {
  if (typeof url === "string" && url.startsWith("blob:")) {
    URL.revokeObjectURL(url);
  }
}

/**
 * 删除单个媒体：先删桶内对象，再删元数据行。
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteMedia(id) {
  const supabase = getClient();
  const { data: row, error } = await supabase
    .from(TABLE)
    .select("id, storage_path")
    .eq("id", id)
    .maybeSingle();

  if (error) throw toAppError(error, "删除媒体失败");
  if (!row) return false;

  if (row.storage_path) {
    try {
      await supabase.storage.from(BUCKET).remove([row.storage_path]);
    } catch (err) {
      // 对象删不掉也继续删行：否则列表里永远删不掉这条媒体
      console.warn("删除桶内媒体文件失败", err);
    }
  }

  const { error: deleteError } = await supabase
    .from(TABLE)
    .delete()
    .eq("id", id);

  if (deleteError) throw toAppError(deleteError, "删除媒体失败");
  return true;
}

/**
 * 批量删除媒体（供 repository 删除记录时级联调用）。
 * @param {string[]} ids
 * @returns {Promise<number>} 实际删除的数量
 */
export async function deleteMany(ids) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  let deleted = 0;
  for (const id of list) {
    if (await deleteMedia(id)) deleted += 1;
  }
  return deleted;
}

/**
 * 把已保存的媒体绑定到宿主记录（表单先存媒体、后建记录，故需后置绑定）。
 * 只修改 entryId 元数据，不动文件。
 * @param {string[]} ids
 * @param {string} entryId
 * @returns {Promise<number>} 实际绑定的数量
 */
export async function linkToEntry(ids, entryId) {
  const list = Array.isArray(ids)
    ? [...new Set(ids.map((id) => String(id ?? "").trim()).filter(Boolean))]
    : [];
  if (!list.length) return 0;

  const supabase = getClient();
  const { data, error } = await supabase
    .from(TABLE)
    .update({ entry_id: entryId })
    .in("id", list)
    .select("id");

  if (error) throw toAppError(error, "媒体绑定失败");
  return data?.length ?? 0;
}

/**
 * 导出全部媒体记录（含 Blob），供数据备份使用。
 * Blob 从云端拉取，媒体较多时会有明显耗时。
 * @returns {Promise<object[]>}
 */
export async function exportAllMedia() {
  const supabase = getClient();
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("relationship_id", CLOUD_SCOPE.relationshipId);

  if (error) throw toAppError(error, "导出媒体失败");

  const records = [];
  for (const row of data ?? []) {
    let blob = null;
    try {
      blob = await getMediaBlob(row.id);
    } catch (err) {
      console.warn("导出时读取媒体失败", row.id, err);
    }
    if (!blob) continue;
    records.push({ ...fromRow(row), blob });
  }
  return records;
}

/**
 * 从备份导入媒体：上传文件到桶，再按 id 覆盖写入元数据行。
 * @param {object[]} records 每条需带 id 与 blob
 * @returns {Promise<number>} 实际写入的条数
 */
export async function importMedia(records) {
  const list = (Array.isArray(records) ? records : []).filter(
    (record) =>
      record && typeof record === "object" && typeof record.id === "string" &&
      record.blob instanceof Blob,
  );

  if (!list.length) return 0;

  const supabase = getClient();
  const rows = [];

  for (const record of list) {
    const mimeType = record.mimeType || record.blob.type || "application/octet-stream";
    const kind = record.kind === "video" || record.kind === "image"
      ? record.kind
      : detectKind({ type: mimeType, name: record.fileName ?? "" }) ?? "image";

    const path = objectPath(record.id, mimeType);
    const uploaded = await uploadBlob(supabase, path, record.blob, mimeType, {
      upsert: true,
    });

    rows.push(
      toRow({
        id: record.id,
        ownerId: record.ownerId ?? CLOUD_SCOPE.ownerId,
        relationshipId: record.relationshipId ?? CLOUD_SCOPE.relationshipId,
        entryId: record.entryId ?? null,
        kind,
        mimeType,
        size: Number(record.size) || record.blob.size,
        fileName: record.fileName ?? "",
        storagePath: uploaded.path,
        url: uploaded.url,
        createdAt: Number(record.createdAt) || Date.now(),
      }),
    );
  }

  const { error } = await supabase.from(TABLE).upsert(rows, { onConflict: "id" });
  if (error) throw toAppError(error, "导入媒体失败");

  return rows.length;
}

// ---------- 上传 ----------

async function uploadBlob(supabase, path, blob, contentType, { upsert = false } = {}) {
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType,
    cacheControl: "31536000", // 媒体 ID 即 UUID，内容不会变，可长期缓存
    upsert,
  });

  if (error) throw toAppError(error, "媒体上传失败");

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return { path, url: data?.publicUrl ?? "" };
}

/** 桶内路径：关系目录 / 媒体 id.扩展名 */
function objectPath(id, mimeType) {
  return `${CLOUD_SCOPE.relationshipId}/${id}.${extensionOf(mimeType)}`;
}

function extensionOf(mimeType) {
  const type = String(mimeType ?? "").toLowerCase();
  const map = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/avif": "avif",
    "image/heic": "heic",
    "image/heif": "heif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/ogg": "ogv",
    "video/x-matroska": "mkv",
  };
  return map[type] ?? "bin";
}

// ---------- 图片压缩 ----------

async function prepareImage(file) {
  let source;
  try {
    source = await decodeImage(file);
  } catch {
    throw new Error(
      `无法读取图片「${file.name || "未知文件"}」，可能是浏览器不支持的格式（如 HEIC）。`,
    );
  }

  try {
    const width = source.naturalWidth || source.width || 0;
    const height = source.naturalHeight || source.height || 0;
    if (!width || !height) throw new Error("图片尺寸无效");

    const scale =
      Math.max(width, height) > MAX_IMAGE_EDGE
        ? MAX_IMAGE_EDGE / Math.max(width, height)
        : 1;
    const outWidth = Math.max(1, Math.round(width * scale));
    const outHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = outWidth;
    canvas.height = outHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前浏览器不支持图片压缩");

    // JPEG 没有透明通道，先铺白底，避免透明 PNG 变黑
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outWidth, outHeight);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, outWidth, outHeight);

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
    if (!blob) throw new Error("图片压缩失败");

    return {
      blob,
      mimeType: "image/jpeg",
      fileName: replaceExt(file.name, "jpg"),
    };
  } finally {
    source.close?.();
  }
}

async function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // 某些浏览器 / 格式不支持，走 <img> 兜底
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("图片解码失败"));
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- 大小预检 ----------

function assertFileSize(size, kind) {
  if (size <= MAX_FILE_SIZE) return;

  const hint = kind === "video" ? `；${VIDEO_SIZE_HINT}` : "";
  throw new Error(
    `文件太大：这个文件有 ${formatBytes(size)}，超过单文件上限 ${formatBytes(
      MAX_FILE_SIZE,
    )}${hint}。请压缩后再上传。`,
  );
}

// ---------- 工具 ----------

const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "bmp",
  "avif",
  "heic",
  "heif",
]);

const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "webm", "mov", "ogv", "mkv"]);

function extOf(name) {
  const match = /\.([^./\\]+)$/.exec(String(name ?? ""));
  return match ? match[1].toLowerCase() : "";
}

function detectKind(file) {
  const type = String(file.type ?? "");
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";

  const ext = extOf(file.name);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return null;
}

function guessMime(name) {
  const ext = extOf(name);
  const map = {
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    ogv: "video/ogg",
    mkv: "video/x-matroska",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
  };
  return map[ext] ?? "application/octet-stream";
}

function replaceExt(name, ext) {
  const base = String(name || "image").replace(/\.[^./\\]+$/, "");
  return `${base || "image"}.${ext}`;
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(bytes) || 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const rounded = index === 0 || value >= 10 ? Math.round(value) : value.toFixed(1);
  return `${rounded} ${units[index]}`;
}

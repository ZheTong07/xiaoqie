/**
 * 记录仓储层：entry 的唯一读写入口。
 *
 * v2 起数据存放在 Supabase（public.entries），页面层依旧只调用本文件导出的函数，
 * 函数签名与本地版保持一致；「驼峰 ↔ 下划线」的字段转换全部收在本层内部。
 *
 * - 页面层禁止直接调用 Supabase，所有读写都走这里。
 * - 对外只返回普通 JS 对象，不泄漏 PostgREST 的响应结构。
 * - 未来接登录后，只需把 CLOUD_SCOPE 换成会话里的真实值。
 */

import { deleteMany, linkToEntry } from "../storage/mediaStore.js";
import { generateUUID } from "../uuid.js";
import {
  CLOUD_SCOPE,
  TABLES,
  toAppError,
  toMillis,
  getClient,
} from "../lib/supabaseClient.js";

const TABLE = TABLES.entries;

const ATTRIBUTIONS = new Set(["me", "ta", "both"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** upsert / in 列表分批，避免一次请求过大。 */
const BATCH_SIZE = 200;

// ---------- 字段映射：前端 camelCase ↔ 云端 snake_case ----------

/**
 * 一条 entries 行 → 前端 entry 对象。
 * 所有缺省值都在这里补齐，页面层不需要再做兜底。
 */
function fromRow(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    relationshipId: row.relationship_id,

    occurredAt: String(row.occurred_at ?? "").slice(0, 10),
    title: row.title ?? "",
    content: row.content ?? "",

    place: row.place ?? "",
    moodTags: Array.isArray(row.mood_tags) ? row.mood_tags : [],
    isMilestone: Boolean(row.is_milestone),
    attribution: row.attribution ?? "both",

    mediaIds: Array.isArray(row.media_ids) ? row.media_ids : [],
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

/** 前端 entry 对象 → entries 行。只做映射，不做业务校验。 */
function toRow(entry) {
  return {
    id: entry.id,
    owner_id: entry.ownerId,
    relationship_id: entry.relationshipId,

    occurred_at: entry.occurredAt,
    title: entry.title,
    content: entry.content ?? "",

    place: entry.place ?? "",
    mood_tags: Array.isArray(entry.moodTags) ? entry.moodTags : [],
    is_milestone: Boolean(entry.isMilestone),
    attribution: entry.attribution ?? "both",

    media_ids: Array.isArray(entry.mediaIds) ? entry.mediaIds : [],
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
  };
}

// ---------- 读 ----------

/**
 * 列出记录。
 * @param {{ from?: string, to?: string, mood?: string,
 *           attribution?: "me"|"ta"|"both", milestoneOnly?: boolean }} [filters]
 * @returns {Promise<object[]>} 按 occurredAt 降序，同一天按 createdAt 降序
 */
export async function listEntries(filters = {}) {
  const { from, to, mood, attribution, milestoneOnly } = filters;
  const supabase = getClient();

  let query = supabase
    .from(TABLE)
    .select("*")
    .eq("relationship_id", CLOUD_SCOPE.relationshipId);

  if (from) query = query.gte("occurred_at", from);
  if (to) query = query.lte("occurred_at", to);
  if (mood) query = query.contains("mood_tags", [mood]);
  if (attribution) query = query.eq("attribution", attribution);
  if (milestoneOnly) query = query.eq("is_milestone", true);

  const { data, error } = await query
    .order("occurred_at", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) throw toAppError(error, "读取记录失败");

  // 云端已排好序，这里再排一次兜底（列类型不是 date 时排序行为可能不同）
  return (data ?? []).map(fromRow).sort(compareEntries);
}

/** 排序规则：occurredAt 降序；同一天按 createdAt 降序。 */
function compareEntries(a, b) {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? 1 : -1;
  return (b.createdAt ?? 0) - (a.createdAt ?? 0);
}

export async function getEntry(id) {
  const supabase = getClient();
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw toAppError(error, "读取记录失败");
  return data ? fromRow(data) : null;
}

// ---------- 写 ----------

/**
 * 新建一条记录。id / ownerId / relationshipId / 时间戳由本层生成，
 * 不接受调用方传入。
 */
export async function createEntry(draft = {}) {
  const now = Date.now();
  const entry = {
    id: generateUUID(),
    ownerId: CLOUD_SCOPE.ownerId,
    relationshipId: CLOUD_SCOPE.relationshipId,

    occurredAt: normalizeDate(draft.occurredAt),
    title: normalizeTitle(draft.title),
    content: String(draft.content ?? "").trim(),

    place: String(draft.place ?? "").trim(),
    moodTags: normalizeTags(draft.moodTags),
    isMilestone: Boolean(draft.isMilestone),
    attribution: normalizeAttribution(draft.attribution),

    mediaIds: normalizeMediaIds(draft.mediaIds),
    createdAt: now,
    updatedAt: now,
  };

  const supabase = getClient();
  const { data, error } = await supabase
    .from(TABLE)
    .insert(toRow(entry))
    .select("*")
    .single();

  if (error) throw toAppError(error, "保存记录失败");

  const saved = fromRow(data);

  if (saved.mediaIds.length) {
    // 表单流程是先存媒体、后建记录，这里补上媒体 → 记录的宿主绑定。
    // 绑定只影响元数据，失败不影响列表展示（列表按 entry.mediaIds 找媒体）。
    try {
      await linkToEntry(saved.mediaIds, saved.id);
    } catch (err) {
      console.warn("媒体绑定 entryId 失败", err);
    }
  }

  return saved;
}

/**
 * 更新记录的可编辑字段，自动刷新 updatedAt。
 * mediaIds 不在这里改，属于媒体层的职责。
 */
export async function updateEntry(id, patch = {}) {
  const existing = await getEntry(id);
  if (!existing) throw new Error("记录不存在");

  const next = { ...existing, updatedAt: Date.now() };

  if ("occurredAt" in patch) next.occurredAt = normalizeDate(patch.occurredAt);
  if ("title" in patch) next.title = normalizeTitle(patch.title);
  if ("content" in patch) next.content = String(patch.content ?? "").trim();
  if ("place" in patch) next.place = String(patch.place ?? "").trim();
  if ("moodTags" in patch) next.moodTags = normalizeTags(patch.moodTags);
  if ("isMilestone" in patch) next.isMilestone = Boolean(patch.isMilestone);
  if ("attribution" in patch)
    next.attribution = normalizeAttribution(patch.attribution);

  const row = toRow(next);
  delete row.id; // 不把主键写回 update 语句

  const supabase = getClient();
  const { data, error } = await supabase
    .from(TABLE)
    .update(row)
    .eq("id", id)
    .eq("relationship_id", CLOUD_SCOPE.relationshipId)
    .select("*")
    .single();

  if (error) throw toAppError(error, "更新记录失败");
  return fromRow(data);
}

/**
 * v1 真删除：先删关联媒体，再删记录。
 * 顺序是先媒体后记录 —— 中途失败时记录仍在，重试即可；不会留下「记录没了但文件还在桶里」的孤儿。
 * v2 要多端同步时，改成软删除 + 墓碑（deletedAt）。
 */
export async function deleteEntry(id) {
  const entry = await getEntry(id);
  if (!entry) return false;

  const mediaIds = entry.mediaIds ?? [];
  if (mediaIds.length) {
    await deleteMany(mediaIds);
  }

  const supabase = getClient();
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq("id", id)
    .eq("relationship_id", CLOUD_SCOPE.relationshipId);

  if (error) throw toAppError(error, "删除记录失败");
  return true;
}

/**
 * 从备份导入记录：按 id 覆盖写入（upsert），不删除现有记录。
 * @param {object[]} entries
 * @returns {Promise<number>} 实际写入的条数
 */
export async function importEntries(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(
    (raw) => raw && typeof raw === "object" && typeof raw.id === "string",
  );
  if (!list.length) return 0;

  const rows = list.map((raw) =>
    toRow({
      ...raw,
      ownerId: raw.ownerId ?? CLOUD_SCOPE.ownerId,
      relationshipId: raw.relationshipId ?? CLOUD_SCOPE.relationshipId,
      mediaIds: Array.isArray(raw.mediaIds) ? raw.mediaIds : [],
    }),
  );

  const supabase = getClient();
  let count = 0;

  for (const chunk of chunked(rows, BATCH_SIZE)) {
    const { error } = await supabase
      .from(TABLE)
      .upsert(chunk, { onConflict: "id" });
    if (error) throw toAppError(error, "导入记录失败");
    count += chunk.length;
  }

  return count;
}

// ---------- 校验 ----------

function normalizeDate(value) {
  const str = String(value ?? "").trim();
  if (!DATE_RE.test(str)) throw new Error("日期格式应为 YYYY-MM-DD");

  const [year, month, day] = str.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new Error(`日期不存在：${str}`);
  }
  return str;
}

function normalizeTitle(value) {
  const title = String(value ?? "").trim();
  if (!title) throw new Error("标题不能为空");
  return title;
}

function normalizeTags(value) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const tags = [];

  for (const raw of list) {
    const tag = String(raw ?? "").trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

function normalizeAttribution(value) {
  return ATTRIBUTIONS.has(value) ? value : "both";
}

function normalizeMediaIds(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map((id) => String(id ?? "").trim()).filter(Boolean))];
}

function chunked(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

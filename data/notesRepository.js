/**
 * 小纸条仓储层：notes 表的唯一读写入口。
 *
 * 与 repository.js 同属仓储层（页面层只调用这里，不直接碰 Supabase），
 * 但只管「悄悄话小纸条」这一件事，不与 entry / media 的表结构耦合。
 *
 * 表结构见 supabase/schema.sql「悄悄话小纸条」一节。
 */

import { generateUUID } from "../uuid.js";
import {
  CLOUD_SCOPE,
  TABLES,
  getClient,
  toAppError,
  toMillis,
} from "../lib/supabaseClient.js";

const TABLE = TABLES.notes;
const MAX_NOTE_LENGTH = 200;

/** 云端行 → 前端对象（snake_case → camelCase）。 */
function fromRow(row) {
  return {
    id: row.id,
    relationshipId: row.relationship_id,
    content: row.content ?? "",
    createdAt: toMillis(row.created_at),
  };
}

/**
 * 读取全部小纸条，按时间倒序。
 * @returns {Promise<Array<{ id: string, relationshipId: string, content: string, createdAt: number }>>}
 */
export async function listNotes() {
  const supabase = getClient();
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("relationship_id", CLOUD_SCOPE.relationshipId)
    .order("created_at", { ascending: false });

  if (error) throw toAppError(error, "读取小纸条失败");
  return (data ?? []).map(fromRow);
}

/**
 * 发一张小纸条。id / relationshipId / createdAt 由本层生成。
 * @param {string} content
 * @returns {Promise<object>} 新建的纸条
 */
export async function createNote(content) {
  const text = String(content ?? "").trim();
  if (!text) throw new Error("纸条内容不能为空");
  if (text.length > MAX_NOTE_LENGTH) {
    throw new Error(`纸条最多 ${MAX_NOTE_LENGTH} 个字`);
  }

  const note = {
    id: generateUUID(),
    relationshipId: CLOUD_SCOPE.relationshipId,
    content: text,
    createdAt: Date.now(),
  };

  const supabase = getClient();
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      id: note.id,
      relationship_id: note.relationshipId,
      content: note.content,
      created_at: note.createdAt,
    })
    .select("*")
    .single();

  if (error) throw toAppError(error, "发送纸条失败");
  return fromRow(data);
}

/**
 * 删除一张小纸条（真删除；后续做多端同步时再改软删除）。
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function deleteNote(id) {
  const supabase = getClient();
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq("id", id)
    .eq("relationship_id", CLOUD_SCOPE.relationshipId);

  if (error) throw toAppError(error, "删除纸条失败");
  return true;
}

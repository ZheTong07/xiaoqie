/** 测试替身：媒体层。行为由测试用例通过 globalThis.__xiaoqieTest 注入。 */

function state() {
  const value = globalThis.__xiaoqieTest;
  if (!value) throw new Error("测试状态未初始化：请先设置 globalThis.__xiaoqieTest");
  return value;
}

export async function getMediaURLs(ids) {
  return state().getMediaURLs(ids);
}

export async function getMediaURL() {
  return state().getMediaURL();
}

export function revokeMediaURL() {}

export async function saveMedia() {
  throw new Error("saveMedia 不应在降级测试中调用");
}

export async function deleteMany() {
  return 0;
}

export async function deleteMedia() {
  return false;
}

export async function exportAllMedia() {
  return [];
}

export async function importMedia() {
  return 0;
}

export async function getMediaBlob() {
  return null;
}

export async function linkToEntry() {
  return 0;
}

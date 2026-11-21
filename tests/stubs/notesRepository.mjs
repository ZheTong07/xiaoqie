/** 测试替身：小纸条仓储层，降级测试不会走到这里。 */

export async function listNotes() {
  return [];
}

export async function createNote() {
  throw new Error("createNote 不应在降级测试中调用");
}

export async function deleteNote() {
  throw new Error("deleteNote 不应在降级测试中调用");
}

/** 测试替身：记录仓储层。行为由测试用例通过 globalThis.__xiaoqieTest 注入。 */

function state() {
  const value = globalThis.__xiaoqieTest;
  if (!value) throw new Error("测试状态未初始化：请先设置 globalThis.__xiaoqieTest");
  return value;
}

export async function listEntries(filters) {
  return state().listEntries(filters);
}

function unused(name) {
  return async () => {
    throw new Error(`${name} 不应在降级测试中调用`);
  };
}

export const createEntry = unused("createEntry");
export const updateEntry = unused("updateEntry");
export const deleteEntry = unused("deleteEntry");
export const importEntries = unused("importEntries");

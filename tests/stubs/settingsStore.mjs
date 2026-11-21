/** 测试替身：设置存储，只提供 Header 渲染所需的默认值。 */

const DEFAULTS = {
  appTitle: "测试小窝",
  anniversaryPrefix: "在一起",
  anniversaryDate: "",
};

export function getSettings() {
  return { ...DEFAULTS, ...(globalThis.__xiaoqieTest?.settings ?? {}) };
}

export function saveSettings() {}

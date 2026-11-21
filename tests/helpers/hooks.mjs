/**
 * ESM 解析钩子：把页面模块依赖的云端层替换成 tests/stubs 下的替身，
 * 让 ui.js / app.js 能在纯 Node、零网络的环境里跑。
 * 只在测试进程里通过 module.register 加载。
 */

const STUB_DIR = new URL("../stubs/", import.meta.url);

const RULES = [
  { pattern: /\/storage\/mediaStore\.js$/, stub: "mediaStore.mjs" },
  { pattern: /\/data\/repository\.js$/, stub: "repository.mjs" },
  { pattern: /\/data\/notesRepository\.js$/, stub: "notesRepository.mjs" },
  { pattern: /\/data\/settingsStore\.js$/, stub: "settingsStore.mjs" },
  { pattern: /\/lightbox\.js$/, stub: "lightbox.mjs" },
];

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);

  // 替身自身不再改写，避免递归
  if (resolved.url.includes("/tests/stubs/")) return resolved;

  for (const rule of RULES) {
    if (rule.pattern.test(resolved.url)) {
      return {
        url: new URL(rule.stub, STUB_DIR).href,
        shortCircuit: true,
        format: "module",
      };
    }
  }

  return resolved;
}

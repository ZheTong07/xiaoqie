/**
 * 一次跑完全部测试：node tests/run.mjs
 * 每个测试文件在独立子进程中运行，避免全局 fetch / DOM 互相污染。
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const files = ["proxy.test.mjs", "degrade.test.mjs"];

let passed = 0;
let failed = 0;

for (const file of files) {
  console.log(`\n# ${file}`);

  const result = spawnSync(process.execPath, [join(here, file)], {
    encoding: "utf8",
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  if (stdout) {
    process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
  }

  const match = /RESULT (\d+) (\d+)/.exec(stdout);
  if (!match) {
    failed += 1;
    console.log(`FAIL ${file} 未输出 RESULT（退出码 ${result.status}）`);
    if (stderr) process.stderr.write(stderr);
    continue;
  }

  passed += Number(match[1]);
  failed += Number(match[2]);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

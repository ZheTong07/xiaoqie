/** 极简断言输出：每个用例一行 PASS / FAIL，末尾给 run.mjs 汇总用。 */

export function createChecker() {
  let passed = 0;
  let failed = 0;

  function check(name, ok, detail = "") {
    if (ok) {
      passed += 1;
      console.log(`PASS ${name}`);
      return;
    }

    failed += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }

  function finish() {
    console.log(`RESULT ${passed} ${failed}`);
    process.exitCode = failed > 0 ? 1 : 0;
  }

  return { check, finish };
}

export function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(10);
  }
  return predicate();
}

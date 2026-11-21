/**
 * 媒体降级测试：用极简 DOM + 依赖替身，在纯 Node 下验证
 * 「文字优先、媒体失败只降级、只有 listEntries 失败才整页报错」。
 */

import { register } from "node:module";
import { createChecker, wait, waitFor } from "./helpers/check.mjs";
import {
  createAppDocument,
  createDocument,
  findAllByClass,
  findAllByTag,
} from "./helpers/dom.mjs";

register("./helpers/hooks.mjs", import.meta.url);

const { check, finish } = createChecker();

// 预期内的失败会打 console.error / warn，测试时静音，保持输出干净
const realError = console.error;
const realWarn = console.warn;
console.error = () => {};
console.warn = () => {};

globalThis.window = {
  confirm: () => true,
  matchMedia: () => ({ matches: true }),
};
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);

const ENTRY = {
  id: "e1",
  ownerId: "local-user",
  relationshipId: "cloud-rel-1",
  occurredAt: "2026-11-20",
  title: "文字标题",
  content: "正文不能被媒体拖垮",
  place: "",
  moodTags: [],
  isMilestone: false,
  attribution: "both",
  mediaIds: ["m1"],
  createdAt: 1731916800000,
  updatedAt: 1731916800000,
};

const state = {
  mediaMode: "fail",
  mediaRows: [],
  mediaCalls: 0,
  settings: {},
  listEntries: async () => [],
};

state.getMediaURLs = async () => {
  state.mediaCalls += 1;
  if (state.mediaMode === "fail") throw new Error("mock media down");
  return state.mediaRows;
};
state.getMediaURL = async () => "";

globalThis.__xiaoqieTest = state;

const ui = await import(new URL("../ui.js", import.meta.url).href);

// ---------- 1. 媒体查询整体失败 ----------

state.mediaMode = "fail";
let doc = createDocument();
globalThis.document = doc;
let view = ui.renderTimeline([{ ...ENTRY }]);
doc.body.append(view.element);
await view.loadMedia();

check(
  "媒体查询失败时文字仍渲染",
  view.element.textContent.includes(ENTRY.title) &&
    view.element.textContent.includes(ENTRY.content),
);
check(
  "媒体查询失败显示可重试占位块",
  findAllByClass(view.element, "media-fallback").length === 1,
);
check(
  "媒体查询失败出现顶部轻提示",
  findAllByClass(doc.body, "media-notice").length === 1,
);
check(
  "媒体查询失败不触发整页错误",
  !doc.body.textContent.includes("打不开数据"),
);

view.dispose();
check(
  "dispose 移除轻提示",
  findAllByClass(doc.body, "media-notice").length === 0,
);

// ---------- 2. 单张图片失败 ----------

state.mediaMode = "ok";
state.mediaRows = [
  { id: "m1", kind: "image", mimeType: "image/jpeg", url: "data:image/png;base64,Zm9v" },
  { id: "m2", kind: "image", mimeType: "image/jpeg", url: "data:image/png;base64,Zm9v" },
];

doc = createDocument();
globalThis.document = doc;
view = ui.renderTimeline([{ ...ENTRY, mediaIds: ["m1", "m2"] }]);
doc.body.append(view.element);
await view.loadMedia();

const thumbs = findAllByClass(view.element, "media-thumb");
check("渲染出两张图片", thumbs.length === 2, `实际 ${thumbs.length}`);

const failedImage = findAllByTag(thumbs[0], "img")[0];
failedImage.dispatch("error");

check(
  "单图失败只影响该图",
  findAllByClass(thumbs[0], "media-fallback-text").length === 1 &&
    findAllByClass(thumbs[1], "media-fallback-text").length === 0,
);
check(
  "单图失败文字仍在",
  view.element.textContent.includes(ENTRY.title) &&
    view.element.textContent.includes(ENTRY.content),
);
check(
  "单图失败出现顶部轻提示",
  findAllByClass(doc.body, "media-notice").length === 1,
);

const callsBeforeRetry = state.mediaCalls;
thumbs[0].click();
await wait(20);
check(
  "失败图片点击可重试",
  state.mediaCalls > callsBeforeRetry,
  `${callsBeforeRetry} → ${state.mediaCalls}`,
);

view.dispose();

// ---------- 3. 只有 listEntries 失败才整页报错 ----------

// 3a：记录读取成功、媒体失败 → 文字上屏，不出现整页错误
state.mediaMode = "fail";
state.listEntries = async () => [{ ...ENTRY, title: "云端文字标题" }];
const app = createAppDocument();
globalThis.document = app.doc;

await import(new URL("../app.js?case=mediafail", import.meta.url).href);
const textShown = await waitFor(
  () => app.view.textContent.includes("云端文字标题"),
  1000,
);

check("记录成功时 app 渲染文字", textShown);
check(
  "媒体失败不触发 app 整页错误",
  !app.view.textContent.includes("打不开数据"),
);
check(
  "媒体失败时 app 显示占位块",
  findAllByClass(app.view, "media-fallback").length === 1,
);

// 3b：listEntries 失败 → 才允许整页错误
state.listEntries = async () => {
  throw new Error("mock entries down");
};
const failing = createAppDocument();
globalThis.document = failing.doc;

await import(new URL("../app.js?case=entryfail", import.meta.url).href);
const fatalShown = await waitFor(
  () => failing.view.textContent.includes("打不开数据"),
  1000,
);

check("listEntries 失败时整页报错", fatalShown);
check(
  "listEntries 失败时不渲染时间线",
  findAllByClass(failing.view, "timeline").length === 0,
);

console.error = realError;
console.warn = realWarn;
finish();

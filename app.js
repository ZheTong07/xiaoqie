/**
 * 入口：管理当前视图（列表 / 表单 / 设置）、把用户操作转交给
 * repository / mediaStore / settingsStore，把数据交给 ui 渲染。
 * 本文件不直接访问 Supabase，所有云端读写都经过下面两层。
 */

import {
  listEntries,
  createEntry,
  updateEntry,
  deleteEntry,
  importEntries,
} from "./data/repository.js";
import {
  listNotes,
  createNote,
  deleteNote,
} from "./data/notesRepository.js";
import {
  saveMedia,
  deleteMany,
  exportAllMedia,
  importMedia,
} from "./storage/mediaStore.js";
import {
  getSettings,
  saveSettings,
} from "./data/settingsStore.js";
import {
  renderTimeline,
  renderEntryForm,
  renderSettingsView,
  renderNotesView,
  openEntryPreview,
  formHasUnsavedChanges,
  animateOut,
  showToast,
} from "./ui.js";

const viewEl = document.getElementById("view");
const newBtn = document.getElementById("new-entry-btn");
const randomBtn = document.getElementById("random-btn");
const notesBtn = document.getElementById("notes-btn");
const settingsBtn = document.getElementById("settings-btn");
const daysEl = document.getElementById("together-days");
const titleEl = document.querySelector(".app-header h1");
const daysBanner = document.querySelector(".days-banner");
const bottomNav = document.querySelector(".bottom-nav");

/** 当前列表视图持有其 objectURL，切走前必须 dispose，避免内存泄漏。 */
let currentView = null;
/** 防止过期的异步渲染结果覆盖新视图。 */
let renderToken = 0;
/** 非空时表示当前表单处于编辑模式。 */
let editingEntry = null;
/** 表单是否已打开（防止重复点击“记一笔”丢弃已填内容）。 */
let formOpen = false;
/** 表单是否正在提交（提交期间不允许离开）。 */
let formSaving = false;
/** 设置视图是否已打开。 */
let settingsOpen = false;
/** 小纸条视图是否已打开（同一按钮再点一次返回时间线）。 */
let notesOpen = false;

newBtn.addEventListener("click", () => showForm());
randomBtn.addEventListener("click", showRandomReview);
notesBtn?.addEventListener("click", () => showNotes());
settingsBtn.addEventListener("click", showSettingsView);

function disposeCurrentView() {
  currentView?.dispose?.();
  currentView = null;
}

/** 根据设置同步 Header 标题和纪念日区域。 */
function applySettingsToHeader() {
  const settings = getSettings();

  if (titleEl) titleEl.textContent = settings.appTitle;
  if (!daysBanner || !daysEl) return;

  if (!settings.anniversaryDate) {
    // 未设置纪念日：整块（含下方横线）隐藏
    daysBanner.hidden = true;
    daysEl.textContent = "";
    return;
  }

  daysBanner.hidden = false;
  const days = Math.max(0, daysTogether(settings.anniversaryDate));
  daysEl.textContent = `${settings.anniversaryPrefix} ${days} 天`;
}

async function showList() {
  const token = ++renderToken;
  editingEntry = null;
  formOpen = false;
  settingsOpen = false;
  notesOpen = false;
  notesBtn?.setAttribute("aria-pressed", "false");

  // 只有「记录本身读不出来」才允许整页报错；媒体失败一律降级处理。
  let entries;
  try {
    entries = await listEntries();
  } catch (err) {
    if (token !== renderToken) return;
    showFatal(err);
    return;
  }

  if (token !== renderToken) return;

  let view;
  try {
    // 同步渲染文字，媒体只留占位；不再等媒体请求。
    view = renderTimeline(entries, {
      onEdit: (entry) => showForm(entry),
      onDelete: handleDelete,
    });
  } catch (err) {
    console.error("渲染时间线失败", err);
    showToast("页面渲染失败，请刷新后重试");
    return;
  }

  if (token !== renderToken) {
    // 渲染期间用户已切走，丢弃这次结果
    view.dispose();
    return;
  }

  disposeCurrentView();
  viewEl.replaceChildren(view.element);
  currentView = view;

  // 视图切换完成后再恢复全局按钮，避免设置页 / 表单页出现闪烁
  if (settingsBtn) settingsBtn.hidden = false;
  if (bottomNav) bottomNav.hidden = false;

  // 文字已经上屏，媒体在后台逐个加载；失败只影响对应占位块。
  Promise.resolve(view.loadMedia?.()).catch((err) => {
    console.warn("媒体后台加载失败", err);
  });
}

function showForm(entry = null) {
  if (formOpen) {
    if (formSaving) return;

    if (formHasUnsavedChanges()) {
      const confirmed = window.confirm("有未保存的修改，确定要离开吗？");
      if (!confirmed) return;
    }

    // 用户确认离开，允许重新渲染一个新表单
    formOpen = false;
  }

  formOpen = true;
  formSaving = false;
  settingsOpen = false;
  notesOpen = false;
  notesBtn?.setAttribute("aria-pressed", "false");
  renderToken += 1;
  disposeCurrentView();
  if (settingsBtn) settingsBtn.hidden = true;
  editingEntry = entry ?? null;

  let form = null;

  form = renderEntryForm({
    entry: editingEntry,
    onSubmit: async (draft, { setStatus }) => {
      formSaving = true;

      try {
        const { files = [], ...fields } = draft;

        if (editingEntry) {
          setStatus("保存中…");
          await updateEntry(editingEntry.id, fields);

          await new Promise((resolve) => animateOut(form, resolve));
          await showList();
          showToast("已更新");
          return;
        }

        const mediaIds = [];

        try {
          for (let i = 0; i < files.length; i += 1) {
            // 真正的网络上传，可能耗时较久，明确告诉用户别关页面
            setStatus(
              files.length > 1
                ? `上传媒体中，请稍候...（${i + 1}/${files.length}）`
                : "上传媒体中，请稍候...",
            );
            const meta = await saveMedia(files[i]);
            mediaIds.push(meta.id);
          }

          setStatus("保存记录…");
          await createEntry({ ...fields, mediaIds });
        } catch (err) {
          // 记录没建成，把已经写入的媒体回滚掉，避免留下孤儿 blob
          if (mediaIds.length) {
            try {
              await deleteMany(mediaIds);
            } catch (cleanupErr) {
              console.warn("回滚已保存的媒体失败", cleanupErr);
            }
          }
          throw err;
        }

        // 保存成功后让表单 150ms 淡出，再切回列表
        await new Promise((resolve) => animateOut(form, resolve));
        await showList();
        showToast("已记录");
      } finally {
        formSaving = false;
      }
    },
    onCancel: showList,
  });

  viewEl.replaceChildren(form);
  form.querySelector("#f-title")?.focus();
}

function showSettingsView() {
  if (settingsOpen || formOpen) return;

  settingsOpen = true;
  notesOpen = false;
  notesBtn?.setAttribute("aria-pressed", "false");
  renderToken += 1;
  disposeCurrentView();
  if (settingsBtn) settingsBtn.hidden = true;
  if (bottomNav) bottomNav.hidden = true;

  const view = renderSettingsView({
    settings: getSettings(),
    onSave: (values) => {
      saveSettings(values);
      applySettingsToHeader();
      exitSettingsView();
    },
    onBack: exitSettingsView,
    onExport: exportData,
    onImport: importData,
  });

  viewEl.replaceChildren(view);
}

function exitSettingsView() {
  settingsOpen = false;
  showList();
}

// ---------- 悄悄话小纸条 ----------

async function showNotes() {
  // 正在编辑且有未保存内容：先确认，避免点一下标签页就丢草稿
  if (formOpen) {
    if (formSaving) return;
    if (formHasUnsavedChanges()) {
      const confirmed = window.confirm("有未保存的修改，确定要离开吗？");
      if (!confirmed) return;
    }
    formOpen = false;
  }

  // 再点一次「小纸条」回到时间线（当作 Tab 切换）
  if (notesOpen) {
    showList();
    return;
  }

  const token = ++renderToken;
  notesOpen = true;
  settingsOpen = false;
  editingEntry = null;
  disposeCurrentView();

  notesBtn?.setAttribute("aria-pressed", "true");
  if (settingsBtn) settingsBtn.hidden = false;
  if (bottomNav) bottomNav.hidden = false;

  const view = renderNotesView({
    onSend: (text) => createNote(text),
    onDelete: async (note) => {
      const confirmed = window.confirm("删除这张小纸条？删除后不可恢复");
      if (!confirmed) return false;

      await deleteNote(note.id);
      showToast("已删除");
      return true;
    },
  });

  viewEl.replaceChildren(view.element);
  currentView = { dispose: () => view.dispose?.() };

  try {
    const notes = await listNotes();
    if (token !== renderToken) return;
    view.setNotes(notes);
  } catch (err) {
    if (token !== renderToken) return;
    console.error(err);
    view.setNotes([]);
    view.setError(err?.message || "读取小纸条失败");
  }
}

async function handleDelete(entry) {
  const confirmed = window.confirm("确定要删除这条回忆吗？删除后不可恢复");
  if (!confirmed) return;

  try {
    await deleteEntry(entry.id);
    await showList();
  } catch (err) {
    console.error(err);
    showToast("删除失败，请重试");
  }
}

async function showRandomReview() {
  try {
    // 优先抽里程碑；没有里程碑则从全部记录里随机
    const milestones = await listEntries({ milestoneOnly: true });
    const pool = milestones.length ? milestones : await listEntries();

    if (!pool.length) {
      showToast("还没有可以回顾的记录");
      return;
    }

    const entry = pool[Math.floor(Math.random() * pool.length)];
    openEntryPreview(entry);
  } catch (err) {
    console.error(err);
    showToast("回顾失败，请重试");
  }
}

// ---------- 数据备份 ----------

async function exportData() {
  const entries = await listEntries();
  const mediaRecords = await exportAllMedia();
  const settings = getSettings();

  const media = [];
  for (const record of mediaRecords) {
    if (!record?.blob) continue;
    const { blob, ...meta } = record;
    media.push({ ...meta, dataUrl: await blobToDataURL(blob) });
  }

  const payload = {
    app: "xiaoqie",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    entries,
    media,
  };

  const blob = new Blob([JSON.stringify(payload)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = `xiaoqie-backup-${todayISO()}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  showToast("已导出");
}

async function importData(file) {
  const text = await file.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("备份文件不是有效的 JSON");
  }

  if (!data || data.app !== "xiaoqie" || !Array.isArray(data.entries)) {
    throw new Error("备份文件格式不正确");
  }

  if (data.settings && typeof data.settings === "object") {
    saveSettings(data.settings);
  }

  const mediaRecords = [];
  for (const item of Array.isArray(data.media) ? data.media : []) {
    if (!item || typeof item !== "object" || !item.id || !item.dataUrl) {
      continue;
    }

    const blob = await dataURLToBlob(item.dataUrl);
    const { dataUrl, ...meta } = item;
    mediaRecords.push({ ...meta, blob });
  }

  const mediaCount = await importMedia(mediaRecords);
  const entryCount = await importEntries(data.entries);

  applySettingsToHeader();
  exitSettingsView();
  showToast(`导入完成：${entryCount} 条记录、${mediaCount} 个媒体`);
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error("读取媒体失败"));
    reader.readAsDataURL(blob);
  });
}

async function dataURLToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

// ---------- 日期计算 ----------

function todayISO() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 包含起始日当天：纪念日当天是第 1 天。用 UTC 计算避免夏令时误差。 */
function daysTogether(startIso) {
  const [year, month, day] = startIso.split("-").map(Number);
  const start = Date.UTC(year, month - 1, day);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((today - start) / 86400000) + 1;
}

function showFatal(err) {
  console.error(err);
  formOpen = false;
  settingsOpen = false;
  notesOpen = false;
  notesBtn?.setAttribute("aria-pressed", "false");
  if (settingsBtn) settingsBtn.hidden = false;
  if (bottomNav) bottomNav.hidden = false;
  disposeCurrentView();

  const box = document.createElement("div");
  box.className = "empty-state";

  const title = document.createElement("h2");
  title.textContent = "打不开数据";

  const hint = document.createElement("p");
  hint.textContent =
    "数据现在来自云端：请检查网络后重试；若一直失败，确认 Supabase 项目可用，并已在 SQL Editor 执行 supabase/schema.sql。" +
    (err?.message ? `（${err.message}）` : "");

  box.append(title, hint);
  viewEl.replaceChildren(box);
}

applySettingsToHeader();
showList();

// ---------- PWA ----------

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((err) => {
    console.warn("Service Worker 注册失败（需要 HTTPS 或 localhost）", err);
  });
}

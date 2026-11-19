/**
 * 视图层：只负责把数据渲染成 DOM，以及把表单交互收集成 draft。
 * 不直接接触云端；媒体一律通过 storage/mediaStore.js。
 */

import { getMediaURLs, revokeMediaURL } from "./storage/mediaStore.js";
import { openLightbox } from "./lightbox.js";

const MOOD_PRESETS = [
  "开心",
  "心动",
  "平静",
  "治愈",
  "想念",
  "委屈",
  "吵架",
  "和好",
];

const ATTRIBUTION_OPTIONS = [
  { value: "me", label: "我" },
  { value: "ta", label: "ta" },
  { value: "both", label: "共同" },
];

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const MAX_IMAGE_THUMBS = 4;

let activeFormIsDirty = null;

/** 当前打开的表单是否有未保存内容（供入口层做离开确认）。 */
export function formHasUnsavedChanges() {
  return typeof activeFormIsDirty === "function" ? activeFormIsDirty() : false;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function field(id, labelText, control) {
  const wrap = el("div", "field");
  const label = el("label", "", labelText);
  label.htmlFor = id;
  control.id = id;
  wrap.append(label, control);
  return wrap;
}

function formatDate(iso) {
  const [year, month, day] = String(iso).split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return `${year}年${month}月${day}日 ${WEEKDAYS[date.getDay()] ?? ""}`.trim();
}

function todayISO() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function attributionLabel(value) {
  return ATTRIBUTION_OPTIONS.find((opt) => opt.value === value)?.label ?? "";
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(bytes) || 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const rounded = index === 0 || value >= 10 ? Math.round(value) : value.toFixed(1);
  return `${rounded} ${units[index]}`;
}

/**
 * 时间线（已由 repository 排好序）。
 * 异步渲染媒体，返回 { element, dispose }；dispose 会释放本轮所有 objectURL，
 * 调用方在切换视图 / 重新渲染前必须调用它。
 */
export async function renderTimeline(entries, handlers = {}) {
  const urls = [];
  const dispose = () => {
    for (const url of urls) revokeMediaURL(url);
    urls.length = 0;
  };

  try {
    if (!entries.length) {
      const empty = el("div", "empty-state");

      const dog = document.createElement("img");
      dog.src = "./images/dog-empty.png";
      dog.alt = "";
      dog.className = "empty-dog";

      empty.append(
        dog,
        el("h2", "", "还没有记录"),
        el("p", "", "去记录第一段回忆吧"),
      );
      return { element: empty, dispose };
    }

    const list = el("ul", "timeline");
    for (const entry of entries) {
      const card = renderCard(entry);
      const media = await renderMedia(entry, urls);
      if (media) card.append(media);
      if (handlers.onEdit || handlers.onDelete) {
        card.append(renderEntryActions(entry, handlers));
      }
      list.append(card);
    }

    // 列表结束的小狗标记放在时间线下方，不占用卡片之间的 32px 间距
    const wrap = el("div", "timeline-wrap");
    wrap.append(list, renderTimelineEnd());

    return { element: wrap, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}

function renderCard(entry) {
  const card = el("article", "entry-card");

  const meta = el("div", "entry-meta");
  const time = el("time", "", formatDate(entry.occurredAt));
  time.dateTime = entry.occurredAt;
  meta.append(time, el("span", "entry-attr", attributionLabel(entry.attribution)));

  const title = el("h2", "entry-title");

  if (entry.isMilestone) {
    const star = el("span", "entry-star", "★");
    star.setAttribute("role", "img");
    star.setAttribute("aria-label", "里程碑");
    title.append(star);
  }

  title.append(document.createTextNode(entry.title));
  card.append(meta, title);

  if (entry.content) {
    card.append(el("p", "entry-content", entry.content));
  }

  if (Array.isArray(entry.moodTags) && entry.moodTags.length) {
    const tags = el("ul", "tag-list");
    for (const tag of entry.moodTags) tags.append(el("li", "tag", tag));
    card.append(tags);
  }

  return card;
}

/** 卡片右下角的编辑 / 删除入口。 */
function renderEntryActions(entry, handlers) {
  const actions = el("div", "entry-actions");

  if (handlers.onEdit) {
    const editBtn = el("button", "entry-action", "编辑");
    editBtn.type = "button";
    editBtn.addEventListener("click", () => handlers.onEdit(entry));
    actions.append(editBtn);
  }

  if (handlers.onDelete) {
    const deleteBtn = el("button", "entry-action entry-action-danger", "删除");
    deleteBtn.type = "button";
    deleteBtn.addEventListener("click", () => handlers.onDelete(entry));
    actions.append(deleteBtn);
  }

  return actions;
}

/**
 * 渲染一条记录的媒体区块，生成的 objectURL 收集进 urls，
 * 由 renderTimeline 的 dispose 统一释放。
 * interactive = false 时（如随机回顾预览）不挂灯箱点击。
 */
async function renderMedia(entry, urls, { interactive = true } = {}) {
  const ids = Array.isArray(entry.mediaIds) ? entry.mediaIds : [];
  if (!ids.length) return null;

  let views;
  try {
    views = await getMediaURLs(ids);
  } catch (err) {
    console.warn("读取媒体失败", entry.id, err);
    return null;
  }
  if (!views.length) return null;

  const block = el("div", "media-block");
  const images = views.filter((view) => view.kind === "image");
  const videos = views.filter((view) => view.kind === "video");

  const shownImages = images.slice(0, MAX_IMAGE_THUMBS);
  for (const image of shownImages) urls.push(image.url);
  for (const video of videos) urls.push(video.url);

  // 超出 4 张的图片不展示，立刻释放它们的 objectURL，避免白占内存
  for (const image of images.slice(MAX_IMAGE_THUMBS)) {
    revokeMediaURL(image.url);
  }

  const imageItems = images.map((image) => ({ id: image.id, kind: "image" }));

  if (shownImages.length) {
    block.append(
      renderImageGrid(shownImages, imageItems, entry.title, interactive),
    );
  }
  for (const video of videos) {
    block.append(renderVideo(video, entry.title, interactive));
  }

  return block;
}

function renderImageGrid(images, items, title, interactive = true) {
  const grid = el("div", "media-grid");

  images.forEach((image, index) => {
    const thumb = interactive
      ? el("button", "media-thumb")
      : el("div", "media-thumb is-static");

    if (interactive) {
      thumb.type = "button";
      thumb.setAttribute("aria-label", `查看第 ${index + 1} 张照片`);
      thumb.addEventListener("click", () => {
        openLightbox({ items, startIndex: index });
      });
    }

    const img = document.createElement("img");
    img.src = image.url;
    img.alt = title ? `${title} 的照片` : "照片";
    img.loading = "lazy";
    thumb.append(img);

    grid.append(thumb);
  });

  const extra = items.length - images.length;
  if (extra > 0) {
    const more = interactive
      ? el("button", "media-more", `+${extra}`)
      : el("div", "media-more is-static", `+${extra}`);

    if (interactive) {
      more.type = "button";
      more.setAttribute("aria-label", `查看其余 ${extra} 张照片`);
      more.addEventListener("click", () => {
        openLightbox({ items, startIndex: images.length });
      });
    }

    grid.append(more);
  }

  return grid;
}

function renderVideo(media, title, interactive = true) {
  const wrap = el("div", "media-video");
  const video = document.createElement("video");
  video.src = media.url;
  video.controls = true;
  video.preload = "metadata";
  video.playsInline = true;
  video.title = interactive ? "点击画面放大" : "";
  video.setAttribute("aria-label", title ? `${title} 的视频` : "视频");

  if (interactive) {
    video.addEventListener("click", (event) => {
      const rect = video.getBoundingClientRect();
      const clickedY = event.clientY - rect.top;
      // 底部约 48px 是原生控制条区域，交给原生控件（播放 / 暂停 / 进度条）
      if (clickedY > rect.height - 48) return;

      // 阻止浏览器“点击视频画面即播放”的默认行为，避免列表视频在灯箱后面继续响
      event.preventDefault();
      event.stopPropagation();

      // 先记录进度和播放状态，再暂停列表视频
      const startTime = video.ended ? 0 : video.currentTime;
      const wasPlaying = !video.paused && !video.ended;

      try {
        video.pause();
      } catch {
        /* 忽略 */
      }

      openLightbox({
        items: [{ id: media.id, kind: "video" }],
        startIndex: 0,
        startTime,
        wasPlaying,
        // 关闭灯箱时把进度写回列表里的这个视频（保持暂停，不自动续播）
        onClose: (state) => {
          if (!state || !video.isConnected) return;
          try {
            const duration = video.duration;
            const target =
              Number.isFinite(duration) && duration > 0
                ? Math.min(state.time, duration)
                : state.time;
            video.currentTime = target;
          } catch {
            /* 列表视频已被回收或没有可用的源，忽略 */
          }
        },
      });
    });
  }

  wrap.append(video);
  return wrap;
}

/**
 * 记录表单。传入 entry 时进入编辑模式并回填；否则为新建。
 * @param {{
 *   entry?: object|null,
 *   onSubmit: (draft: object, helpers: { setStatus: (text: string) => void }) => Promise<void>,
 *   onCancel: () => void,
 * }} handlers
 */
export function renderEntryForm({ entry = null, onSubmit, onCancel }) {
  const form = el("form", "entry-form");
  form.noValidate = true;

  if (entry) {
    form.append(el("h2", "form-title", "编辑回忆"));
  }

  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.required = true;
  dateInput.value = entry?.occurredAt ?? todayISO();

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.placeholder = "比如：第一次一起看雪";
  titleInput.maxLength = 80;
  titleInput.value = entry?.title ?? "";

  const contentInput = document.createElement("textarea");
  contentInput.rows = 5;
  contentInput.placeholder = "想对 ta 说的话…";
  contentInput.value = entry?.content ?? "";

  const placeInput = document.createElement("input");
  placeInput.type = "text";
  placeInput.placeholder = "比如：哈尔滨";
  placeInput.maxLength = 40;
  placeInput.value = entry?.place ?? "";

  form.append(
    field("f-occurredAt", "日期", dateInput),
    field("f-title", "标题", titleInput),
    field("f-content", "想说的话（可留空）", contentInput),
    field("f-place", "地点（可留空）", placeInput),
  );

  // ---------- 照片 / 视频 ----------
  const selectedFiles = [];

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*,video/*";
  fileInput.multiple = true;

  const fileList = el("ul", "file-list");
  fileList.hidden = true;

  const renderFileList = () => {
    fileList.replaceChildren();

    selectedFiles.forEach((file, index) => {
      const item = el("li", "file-item");
      const name = el("span", "file-name", file.name || "未命名文件");
      const size = el("span", "file-size", formatBytes(file.size));

      const remove = el("button", "file-remove", "移除");
      remove.type = "button";
      remove.addEventListener("click", () => {
        selectedFiles.splice(index, 1);
        renderFileList();
      });

      item.append(name, size, remove);
      fileList.append(item);
    });

    fileList.hidden = selectedFiles.length === 0;
  };

  fileInput.addEventListener("change", () => {
    for (const file of fileInput.files) selectedFiles.push(file);
    fileInput.value = "";
    renderFileList();
  });

  const fileField = el("fieldset", "field");
  fileField.append(
    el("legend", "", "照片 / 视频（可多选）"),
    fileInput,
    el(
      "p",
      "file-hint",
      "照片会自动压缩到长边 1920；视频不压缩，单个视频建议不超过 100MB。",
    ),
    fileList,
  );

  if (entry) {
    // 编辑模式本轮不改动媒体，避免误删已有附件
    form.append(el("p", "file-hint", "编辑时不会修改已有的照片和视频。"));
  } else {
    form.append(fileField);
  }

  // ---------- 情绪标签 ----------
  const selectedMoods = new Set();
  const moodRow = el("div", "chip-row");
  for (const mood of MOOD_PRESETS) moodRow.append(createMoodChip(mood, selectedMoods));

  const customInput = document.createElement("input");
  customInput.type = "text";
  customInput.placeholder = "添加自己的标签";
  customInput.maxLength = 12;

  const addBtn = el("button", "btn", "添加");
  addBtn.type = "button";

  const findMoodChip = (name) =>
    [...moodRow.querySelectorAll(".chip")].find(
      (node) => node.dataset.mood === name,
    );

  const ensureMoodChip = (name) => {
    const existing = findMoodChip(name);
    if (existing) return existing;

    const chip = createMoodChip(name, selectedMoods);
    moodRow.append(chip);
    return chip;
  };

  const addCustom = () => {
    const name = customInput.value.trim();
    if (!name) return;

    setChipState(ensureMoodChip(name), true, selectedMoods);
    customInput.value = "";
    customInput.focus();
  };

  // 编辑模式：回填已选中的标签（含自定义标签）
  if (entry) {
    for (const tag of entry.moodTags ?? []) {
      setChipState(ensureMoodChip(tag), true, selectedMoods);
    }
  }

  addBtn.addEventListener("click", addCustom);
  customInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addCustom();
    }
  });

  const tagAdd = el("div", "tag-add");
  tagAdd.append(customInput, addBtn);

  const moodField = el("fieldset", "field");
  moodField.append(el("legend", "", "情绪"), moodRow, tagAdd);
  form.append(moodField);

  // ---------- 里程碑 ----------
  let isMilestone = Boolean(entry?.isMilestone);

  const milestoneField = el("fieldset", "field");
  milestoneField.append(el("legend", "", "里程碑"));

  const milestoneBtn = el("button", "chip milestone-chip");
  milestoneBtn.type = "button";

  const renderMilestone = () => {
    milestoneBtn.setAttribute("aria-pressed", String(isMilestone));
    milestoneBtn.textContent = isMilestone ? "★ 里程碑" : "☆ 设为里程碑";
  };

  renderMilestone();
  milestoneBtn.addEventListener("click", () => {
    isMilestone = !isMilestone;
    renderMilestone();
  });

  milestoneField.append(milestoneBtn);
  form.append(milestoneField);

  // ---------- 归属 ----------
  let attribution = entry?.attribution ?? "both";
  const attrRow = el("div", "chip-row");
  const attrButtons = ATTRIBUTION_OPTIONS.map((option) => {
    const btn = el("button", "chip", option.label);
    btn.type = "button";
    btn.dataset.attr = option.value;
    btn.setAttribute("aria-pressed", String(option.value === attribution));

    btn.addEventListener("click", () => {
      attribution = option.value;
      for (const other of attrButtons) {
        other.setAttribute("aria-pressed", String(other.dataset.attr === attribution));
      }
    });

    attrRow.append(btn);
    return btn;
  });

  const attrField = el("fieldset", "field");
  attrField.append(el("legend", "", "归属"), attrRow);
  form.append(attrField);

  // ---------- 未保存修改检测 ----------
  const baseline = {
    occurredAt: dateInput.value,
    title: titleInput.value,
    content: contentInput.value,
    place: placeInput.value,
    attribution,
    isMilestone,
    moods: [...selectedMoods].sort().join("|"),
  };

  function isDirty() {
    return (
      dateInput.value !== baseline.occurredAt ||
      titleInput.value !== baseline.title ||
      contentInput.value !== baseline.content ||
      placeInput.value !== baseline.place ||
      attribution !== baseline.attribution ||
      isMilestone !== baseline.isMilestone ||
      customInput.value.trim() !== "" ||
      selectedFiles.length > 0 ||
      [...selectedMoods].sort().join("|") !== baseline.moods
    );
  }

  activeFormIsDirty = isDirty;

  // ---------- 错误与操作 ----------
  const errorEl = el("p", "form-error");
  errorEl.hidden = true;
  errorEl.setAttribute("role", "alert");

  const cancelBtn = el("button", "btn", "取消");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", () => {
    if (isDirty()) {
      const confirmed = window.confirm("有未保存的修改，确定要离开吗？");
      if (!confirmed) return;
    }

    animateOut(form, onCancel);
  });

  const submitBtn = el("button", "btn btn-primary", "保存");
  submitBtn.type = "submit";

  const actions = el("div", "form-actions");
  actions.append(cancelBtn, submitBtn);

  form.append(errorEl, actions);

  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.hidden = false;
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.hidden = true;

    const draft = {
      occurredAt: dateInput.value,
      title: titleInput.value.trim(),
      content: contentInput.value,
      place: placeInput.value,
      moodTags: [...selectedMoods],
      isMilestone,
      attribution,
      files: [...selectedFiles],
    };

    if (!draft.occurredAt) return showError("请选择日期");
    if (!draft.title) return showError("请填写标题");

    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    submitBtn.textContent = "保存中…";

    try {
      await onSubmit(draft, {
        setStatus: (text) => {
          submitBtn.textContent = text;
        },
      });
    } catch (err) {
      console.error(err);
      showError(err?.message || "保存失败，请重试");
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
      submitBtn.textContent = "保存";
    }
  });

  return form;
}

function createMoodChip(name, selectedSet) {
  const chip = el("button", "chip", name);
  chip.type = "button";
  chip.dataset.mood = name;
  chip.setAttribute("aria-pressed", "false");

  chip.addEventListener("click", () => {
    setChipState(chip, chip.getAttribute("aria-pressed") !== "true", selectedSet);
  });

  return chip;
}

function setChipState(chip, pressed, selectedSet) {
  chip.setAttribute("aria-pressed", String(pressed));
  if (pressed) selectedSet.add(chip.dataset.mood);
  else selectedSet.delete(chip.dataset.mood);
}

// ---------- 列表结尾 ----------

/** 时间线下方的小狗结尾标记（图片由用户提供）。 */
function renderTimelineEnd() {
  const footer = el("div", "timeline-end");
  footer.setAttribute("aria-hidden", "true");

  const img = document.createElement("img");
  img.src = "./images/dog-footer.png";
  img.alt = "";
  img.className = "timeline-end-img";

  footer.append(img);
  return footer;
}

// ---------- 随机回顾 / 纪念日设置 ----------

let entryPreviewOpen = false;

/** 只读卡片弹窗（随机回顾用），媒体只展示不可点开灯箱。 */
export function openEntryPreview(entry) {
  if (!entry || entryPreviewOpen) return;
  entryPreviewOpen = true;

  const urls = [];
  let closed = false;
  const previousFocus = document.activeElement;

  const overlay = el("div", "entry-modal");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "回忆回顾");

  const closeBtn = el("button", "lightbox-close", "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "关闭");

  const scroll = el("div", "entry-modal-scroll");
  const card = renderCard(entry);
  scroll.append(card);
  overlay.append(closeBtn, scroll);

  const revokeAll = () => {
    for (const url of urls) revokeMediaURL(url);
    urls.length = 0;
  };

  const finishClose = () => {
    entryPreviewOpen = false;

    // 关闭前先停掉预览内的视频，避免音频在弹窗消失后继续播放
    for (const video of overlay.querySelectorAll("video")) {
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        /* 忽略 */
      }
    }

    revokeAll();
    overlay.remove();
    document.removeEventListener("keydown", onKeyDown);

    if (!document.querySelector(".lightbox")) {
      document.body.classList.remove("lightbox-open");
    }

    if (previousFocus && previousFocus.isConnected) {
      try {
        previousFocus.focus();
      } catch {
        /* 忽略焦点恢复失败 */
      }
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    animateOut(overlay, finishClose);
  };

  const onKeyDown = (event) => {
    if (event.key !== "Escape") return;
    // 灯箱盖在回顾卡片上时，Esc 只关灯箱
    if (document.querySelector(".lightbox")) return;

    event.preventDefault();
    close();
  };

  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", onKeyDown);
  document.body.classList.add("lightbox-open");
  document.body.append(overlay);
  closeBtn.focus();

  // 与时间线一致：图片 / 视频可点开灯箱，灯箱使用自己的 objectURL
  renderMedia(entry, urls)
    .then((media) => {
      if (closed) {
        // 关闭期间才加载完，立即释放这之后创建的 URL
        revokeAll();
        return;
      }
      if (media) card.append(media);
    })
    .catch((err) => {
      console.warn("回顾媒体加载失败", err);
      revokeAll();
    });
}

/**
 * 设置视图（整页，不是模态）。
 * @param {{
 *   settings: { appTitle: string, anniversaryPrefix: string, anniversaryDate: string },
 *   onSave: (values: object) => void|Promise<void>,
 *   onBack: () => void,
 *   onExport: () => Promise<void>,
 *   onImport: (file: File) => Promise<void>,
 * }} options
 */
export function renderSettingsView({
  settings,
  onSave,
  onBack,
  onExport,
  onImport,
} = {}) {
  const form = el("form", "entry-form settings-view");
  form.noValidate = true;

  // ---------- 顶部：返回 / 标题 / 保存 ----------
  const head = el("div", "settings-head");

  const backBtn = el("button", "btn btn-text", "← 返回");
  backBtn.type = "button";
  backBtn.addEventListener("click", () => onBack?.());

  const heading = el("h2", "settings-title", "设置");

  const saveBtn = el("button", "btn btn-primary", "保存");
  saveBtn.type = "submit";

  head.append(backBtn, heading, saveBtn);
  form.append(head);

  // ---------- 基础设置 ----------
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.maxLength = 20;
  titleInput.value = settings?.appTitle ?? "";

  const prefixInput = document.createElement("input");
  prefixInput.type = "text";
  prefixInput.maxLength = 12;
  prefixInput.value = settings?.anniversaryPrefix ?? "";

  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.max = todayISO();
  dateInput.value = settings?.anniversaryDate ?? "";

  form.append(
    field("settings-app-title", "软件标题", titleInput),
    field("settings-prefix", "纪念日前缀", prefixInput),
    field("settings-date", "纪念日", dateInput),
  );

  const errorEl = el("p", "form-error");
  errorEl.hidden = true;
  errorEl.setAttribute("role", "alert");
  form.append(errorEl);

  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.hidden = false;
  };

  // ---------- 数据备份 ----------
  const backup = el("section", "settings-backup");
  backup.append(
    el("h3", "settings-section-title", "数据备份"),
    el(
      "p",
      "file-hint",
      "导出包含所有记录、照片 / 视频和设置；导入按 ID 覆盖同一条数据，不会删除现有记录。媒体较多时文件会比较大。",
    ),
  );

  const backupActions = el("div", "settings-backup-actions");

  const exportBtn = el("button", "btn", "导出数据");
  exportBtn.type = "button";

  const importBtn = el("button", "btn", "导入数据");
  importBtn.type = "button";

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "application/json,.json";
  fileInput.hidden = true;

  backupActions.append(exportBtn, importBtn, fileInput);
  backup.append(backupActions);
  form.append(backup);

  // ---------- 交互 ----------
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.hidden = true;

    const appTitle = titleInput.value.trim();
    const anniversaryPrefix = prefixInput.value.trim();

    if (!appTitle) {
      showError("软件标题不能为空");
      titleInput.focus();
      return;
    }
    if (!anniversaryPrefix) {
      showError("纪念日前缀不能为空");
      prefixInput.focus();
      return;
    }
    if (dateInput.value && dateInput.value > todayISO()) {
      showError("纪念日不能晚于今天");
      dateInput.focus();
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "保存中…";

    try {
      await onSave?.({
        appTitle,
        anniversaryPrefix,
        anniversaryDate: dateInput.value,
      });
    } catch (err) {
      console.error(err);
      showError(err?.message || "保存失败，请重试");
      saveBtn.disabled = false;
      saveBtn.textContent = "保存";
    }
  });

  exportBtn.addEventListener("click", async () => {
    errorEl.hidden = true;
    exportBtn.disabled = true;
    exportBtn.textContent = "导出中…";

    try {
      await onExport?.();
    } catch (err) {
      console.error(err);
      showError(err?.message || "导出失败，请重试");
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = "导出数据";
    }
  });

  importBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;

    errorEl.hidden = true;
    importBtn.disabled = true;
    importBtn.textContent = "导入中…";

    try {
      await onImport?.(file);
    } catch (err) {
      console.error(err);
      showError(err?.message || "导入失败，请重试");
    } finally {
      importBtn.disabled = false;
      importBtn.textContent = "导入数据";
    }
  });

  titleInput.focus();
  return form;
}

// ---------- 动效与提示 ----------

/** 给元素加退场动画，动画结束（或兜底超时）后执行 done。 */
export function animateOut(element, done) {
  if (element.dataset.leaving === "true") return;
  element.dataset.leaving = "true";

  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    done();
    return;
  }

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    element.removeEventListener("animationend", onAnimationEnd);
    done();
  };
  const onAnimationEnd = (event) => {
    if (event.target === element) finish();
  };

  element.classList.add("is-closing");
  element.addEventListener("animationend", onAnimationEnd);
  setTimeout(finish, 220);
}

/** 顶部极简 Toast：小狗图片 + 文案，白底黑框，淡入淡出。 */
export function showToast(message = "已记录", duration = 2000) {
  document.querySelector(".toast")?.remove();

  const toast = el("div", "toast");
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");

  const dog = document.createElement("img");
  dog.src = "./images/dog-success.png";
  dog.alt = "";
  dog.className = "toast-dog";

  toast.append(dog, el("span", "toast-text", message));
  document.body.append(toast);

  // 下一帧再加类，确保过渡能够触发
  requestAnimationFrame(() => toast.classList.add("is-visible"));

  setTimeout(() => toast.classList.remove("is-visible"), duration);
  setTimeout(() => toast.remove(), duration + 200);
}

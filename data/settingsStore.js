/**
 * 设置存储层（v1 用 localStorage）。
 *
 * 与 entry 模型分离：标题、纪念日前缀、纪念日日期都不写进记录。
 * 旧版本只用 xiaoqie.relationshipStart 存纪念日，这里做了兼容读取。
 */

const SETTINGS_KEY = "xiaoqie.settings";
const LEGACY_START_KEY = "xiaoqie.relationshipStart";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULTS = Object.freeze({
  appTitle: "企鹅小窝",
  anniversaryPrefix: "在一起",
  anniversaryDate: "",
});

/** 读取全部设置；缺失或损坏时回退默认值。 */
export function getSettings() {
  const settings = { ...DEFAULTS };

  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    let hasStoredSettings = false;

    if (raw) {
      hasStoredSettings = true;

      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (isNonEmptyString(parsed.appTitle)) {
          settings.appTitle = parsed.appTitle.trim();
        }
        if (isNonEmptyString(parsed.anniversaryPrefix)) {
          settings.anniversaryPrefix = parsed.anniversaryPrefix.trim();
        }
        if (isValidDate(parsed.anniversaryDate)) {
          settings.anniversaryDate = parsed.anniversaryDate;
        }
      }
    }

    // 只在从未保存过新设置时，才兼容旧版本只存纪念日的结构。
    // 否则用户清空纪念日后会被旧值“复活”。
    if (!hasStoredSettings) {
      const legacy = localStorage.getItem(LEGACY_START_KEY);
      if (isValidDate(legacy)) settings.anniversaryDate = legacy;
    }
  } catch {
    /* localStorage 不可用时使用默认设置 */
  }

  return settings;
}

/** 保存设置；空标题 / 空前缀回退到默认文案。 */
export function saveSettings(input = {}) {
  const next = {
    appTitle: normalizeText(input.appTitle, DEFAULTS.appTitle),
    anniversaryPrefix: normalizeText(
      input.anniversaryPrefix,
      DEFAULTS.anniversaryPrefix,
    ),
    anniversaryDate: normalizeDate(input.anniversaryDate),
  };

  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

function normalizeText(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function normalizeDate(value) {
  if (value === "" || value === null || value === undefined) return "";
  return isValidDate(value) ? value : "";
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isValidDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

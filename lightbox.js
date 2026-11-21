/**
 * 全屏灯箱：查看图片 / 视频。
 *
 * 媒体地址从 mediaStore 取（云端公开 URL），关闭 / 切换时调用 revokeMediaURL
 * 统一走同一套释放逻辑；云端 URL 上是空操作，未来回落成本地 blob 时无需改这里。
 */

import { getMediaURL, revokeMediaURL } from "./storage/mediaStore.js";

let isOpen = false;

/**
 * 打开灯箱。
 * @param {{
 *   items: Array<{ id: string, kind: "image"|"video" }>,
 *   startIndex?: number,
 *   startTime?: number,     // 视频起始进度（秒），从列表视频接续
 *   wasPlaying?: boolean,   // 列表视频打开前是否在播放，用于自动续播
 *   onClose?: (state: { time: number, wasPlaying: boolean }) => void,
 *                          // 关闭时回调当前灯箱视频的进度，用于写回列表视频
 * }} options
 */
export function openLightbox({
  items,
  startIndex = 0,
  startTime = 0,
  wasPlaying = false,
  onClose = null,
} = {}) {
  const mediaItems = (Array.isArray(items) ? items : []).filter(
    (item) => item && item.id,
  );
  if (!mediaItems.length || isOpen) return;

  isOpen = true;

  // 打开前先暂停页面上的列表视频，避免和灯箱抢播放 / 声音
  pausePageVideos();

  const total = mediaItems.length;
  let index = normalizeIndex(startIndex, total);
  let currentUrl = null;
  let loadToken = 0;
  let closed = false;

  const previousFocus = document.activeElement;

  // ---------- DOM ----------
  const overlay = el("div", "lightbox");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "媒体预览");

  const closeBtn = el("button", "lightbox-close", "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "关闭");

  const prevBtn = el("button", "lightbox-nav lightbox-prev", "‹");
  prevBtn.type = "button";
  prevBtn.setAttribute("aria-label", "上一张");

  const nextBtn = el("button", "lightbox-nav lightbox-next", "›");
  nextBtn.type = "button";
  nextBtn.setAttribute("aria-label", "下一张");

  const stage = el("div", "lightbox-stage");

  const counter = el("p", "lightbox-counter", `${index + 1} / ${total}`);
  counter.setAttribute("aria-live", "polite");

  const hasMultiple = total > 1;
  prevBtn.hidden = !hasMultiple;
  nextBtn.hidden = !hasMultiple;
  counter.hidden = !hasMultiple;

  overlay.append(closeBtn, prevBtn, nextBtn, stage, counter);

  // ---------- 渲染 ----------
  /**
   * @param {number} nextIndex
   * @param {{ startTime: number, wasPlaying: boolean }|null} initialPlayback
   *        只在首次打开时传入，用于接续列表视频的进度
   */
  async function show(nextIndex, initialPlayback = null) {
    index = normalizeIndex(nextIndex, total);
    counter.textContent = `${index + 1} / ${total}`;

    const item = mediaItems[index];
    const token = ++loadToken;

    stopStageVideo();
    stage.replaceChildren(el("p", "lightbox-status", "加载中…"));

    let url;
    try {
      url = await getMediaURL(item.id);
    } catch (err) {
      if (token !== loadToken || closed) return;
      console.error("灯箱加载媒体失败", err);
      replaceCurrentUrl(null);
      stage.replaceChildren(el("p", "lightbox-status", "媒体加载失败"));
      return;
    }

    if (token !== loadToken || closed) {
      // 已被后来的切换 / 关闭取代，立即释放这张的 URL
      revokeMediaURL(url);
      return;
    }

    replaceCurrentUrl(url);

    const element = buildMedia(item, url);
    stage.replaceChildren(element);

    // 先插入 DOM 再应用进度，autoplay 在已挂载的元素上更可靠
    if (initialPlayback && element.tagName === "VIDEO") {
      applyInitialPlayback(element, initialPlayback);
    }
  }

  function replaceCurrentUrl(nextUrl) {
    if (currentUrl) revokeMediaURL(currentUrl);
    currentUrl = nextUrl;
  }

  /** 读取灯箱当前视频的进度；没有视频或元数据未就绪时返回 null。 */
  function readStageVideoState() {
    const video = stage.querySelector("video");
    if (!video || video.readyState < 1) return null;

    return {
      time: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      wasPlaying: !video.paused && !video.ended,
    };
  }

  /** 暂停并重置灯箱当前展示的视频；切换、关闭时调用。 */
  function stopStageVideo() {
    const video = stage.querySelector("video");
    if (!video) return;

    try {
      video.pause();
      video.currentTime = 0;
    } catch {
      /* 元数据未就绪时设置 currentTime 可能抛错，忽略 */
    }

    video.removeAttribute("src");
    try {
      video.load();
    } catch {
      /* 忽略 */
    }
  }

  // ---------- 关闭 ----------
  function close() {
    if (closed) return;
    closed = true;
    loadToken += 1;

    // 必须在 stopStageVideo 把 currentTime 归零之前读取
    const finalState = readStageVideoState();

    stopStageVideo();
    replaceCurrentUrl(null);
    document.removeEventListener("keydown", onKeyDown);

    // 如果是叠在回顾卡片上打开的灯箱，关闭后卡片仍需要锁定页面滚动
    if (!document.querySelector(".entry-modal")) {
      document.body.classList.remove("lightbox-open");
    }

    if (finalState && typeof onClose === "function") {
      try {
        onClose(finalState);
      } catch (err) {
        console.warn("灯箱关闭回调失败", err);
      }
    }

    const finishClose = () => {
      isOpen = false;
      overlay.remove();

      if (previousFocus && previousFocus.isConnected) {
        try {
          previousFocus.focus();
        } catch {
          /* 忽略焦点恢复失败 */
        }
      }
    };

    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reducedMotion) {
      finishClose();
      return;
    }

    // 150ms 反向淡出 + 下移，动画结束后再移除节点
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      overlay.removeEventListener("animationend", onAnimationEnd);
      finishClose();
    };
    const onAnimationEnd = (event) => {
      if (event.target === overlay) finish();
    };

    overlay.classList.add("is-closing");
    overlay.addEventListener("animationend", onAnimationEnd);
    setTimeout(finish, 220);
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (total < 2) return;

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      show(index - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      show(index + 1);
    }
  }

  // ---------- 事件 ----------
  closeBtn.addEventListener("click", close);

  prevBtn.addEventListener("click", () => {
    show(index - 1);
  });

  nextBtn.addEventListener("click", () => {
    show(index + 1);
  });

  overlay.addEventListener("click", (event) => {
    // 点背景（而不是图片 / 按钮）关闭
    if (event.target === overlay) close();
  });

  document.addEventListener("keydown", onKeyDown);
  document.body.classList.add("lightbox-open");
  document.body.append(overlay);
  closeBtn.focus();

  // 浏览器的“点击视频切换播放”默认行为在事件派发后才执行，
  // 这里在下一轮事件循环再兜底暂停一次列表视频。
  setTimeout(pausePageVideos, 0);

  show(index, { startTime, wasPlaying });
}

/** 暂停页面上所有不在灯箱里的 <video>（列表卡片中的视频）。 */
function pausePageVideos() {
  for (const video of document.querySelectorAll("video")) {
    if (video.closest(".lightbox")) continue;
    try {
      if (!video.paused) video.pause();
    } catch {
      /* 忽略 */
    }
  }
}

// ---------- 工具 ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function normalizeIndex(value, total) {
  const number = Number(value) || 0;
  return ((number % total) + total) % total;
}

/**
 * 灯箱视频接续列表视频的进度：
 * metadata 就绪后 seek 到 startTime；如果打开前在播放，再尝试自动续播。
 * 自动播放若被浏览器拦截，视频会停在 startTime，等用户点击。
 */
function applyInitialPlayback(video, { startTime, wasPlaying }) {
  const safeStart =
    Number.isFinite(startTime) && startTime > 0 ? startTime : 0;

  const begin = () => {
    if (safeStart > 0) {
      try {
        video.currentTime = safeStart;
      } catch {
        /* 极少见：元数据刚就绪时设置失败，忽略，从头播放 */
      }
    }

    if (wasPlaying) {
      const attempt = video.play();
      if (attempt && typeof attempt.catch === "function") {
        attempt.catch(() => {
          /* 自动续播被拦截，保持暂停，用户可手动播放 */
        });
      }
    }
  };

  if (video.readyState >= 1) begin();
  else video.addEventListener("loadedmetadata", begin, { once: true });
}

function buildMedia(item, url) {
  if (item.kind === "video") {
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.preload = "auto";
    video.playsInline = true;
    video.setAttribute("controls", "");
    video.setAttribute("playsinline", "");
    video.setAttribute("aria-label", "视频");
    // 部分浏览器在元素插入 DOM 前不会自动加载 blob，显式 load 一次
    video.load();
    return video;
  }

  const img = document.createElement("img");
  img.src = url;
  img.alt = "";
  return img;
}

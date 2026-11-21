/**
 * 极简 DOM 替身：只实现 ui.js / app.js 在测试路径上用到的那部分 API。
 * 不追求标准完整性，目的是让降级逻辑能在纯 Node 下验证。
 */

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this._text = String(text ?? "");
    this.parentNode = null;
  }

  get textContent() {
    return this._text;
  }

  set textContent(value) {
    this._text = String(value ?? "");
  }
}

export class FakeNode {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.id = "";
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = { cssText: "" };
    this.className = "";
    this._text = "";
    this._listeners = new Map();
    this.hidden = false;
  }

  get textContent() {
    return (
      this._text + this.children.map((child) => child.textContent ?? "").join("")
    );
  }

  set textContent(value) {
    this._text = String(value ?? "");
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }

  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === "string" ? new FakeText(node) : node;
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.children.push(child);
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    if (node.parentNode === this) node.parentNode = null;
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }

  getAttribute(name) {
    const key = String(name);
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(String(name));
  }

  addEventListener(type, listener, options = {}) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push({
      listener,
      once: Boolean(options?.once),
    });
  }

  removeEventListener(type, listener) {
    const list = this._listeners.get(type);
    if (!list) return;
    this._listeners.set(
      type,
      list.filter((entry) => entry.listener !== listener),
    );
  }

  dispatch(type, event = {}) {
    const list = this._listeners.get(type);
    if (!list) return;

    const payload = {
      type,
      target: this,
      currentTarget: this,
      preventDefault() {},
      stopPropagation() {},
      ...event,
    };

    for (const entry of [...list]) {
      entry.listener(payload);
      if (entry.once) this.removeEventListener(type, entry.listener);
    }
  }

  click() {
    this.dispatch("click");
  }

  focus() {}

  matches(selector) {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) {
      const wanted = selector.slice(1).split(".");
      const own = String(this.className).split(/\s+/).filter(Boolean);
      return wanted.every((name) => own.includes(name));
    }
    return this.tagName === String(selector).toUpperCase();
  }

  querySelectorAll(selector) {
    const out = [];
    walk(this, (node) => {
      if (node.matches(selector)) out.push(node);
    });
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  get isConnected() {
    let node = this;
    while (node) {
      if (node === globalThis.document?.body) return true;
      node = node.parentNode;
    }
    return false;
  }
}

/** 深度优先遍历所有元素子节点（不含 root 自身）。 */
export function walk(root, visit) {
  for (const child of root.children) {
    if (child.nodeType !== 1) continue;
    visit(child);
    walk(child, visit);
  }
}

export function findAllByClass(root, className) {
  const out = [];
  walk(root, (node) => {
    const own = String(node.className).split(/\s+/).filter(Boolean);
    if (own.includes(className)) out.push(node);
  });
  return out;
}

export function findAllByTag(root, tagName) {
  const out = [];
  walk(root, (node) => {
    if (node.tagName === String(tagName).toUpperCase()) out.push(node);
  });
  return out;
}

/** 每个场景一个全新的 document，避免测试之间互相污染。 */
export function createDocument() {
  const doc = {
    body: new FakeNode("body"),
    documentElement: new FakeNode("html"),
    _byId: new Map(),
    _selectors: new Map(),
    createElement(tag) {
      return new FakeNode(tag);
    },
    createTextNode(text) {
      return new FakeText(text);
    },
    getElementById(id) {
      return this._byId.get(String(id)) ?? null;
    },
    querySelector(selector) {
      if (this._selectors.has(selector)) return this._selectors.get(selector);
      return this.querySelectorAll(selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      if (this._selectors.has(selector)) return [this._selectors.get(selector)];
      return this.documentElement.querySelectorAll(selector);
    },
    addEventListener() {},
    removeEventListener() {},
  };

  doc.body.parentNode = doc.documentElement;
  return doc;
}

/** 构造 app.js 启动所需的最小页面骨架。 */
export function createAppDocument() {
  const doc = createDocument();

  const make = (tag, { id, className, text } = {}) => {
    const node = doc.createElement(tag);
    if (id) {
      node.id = id;
      doc._byId.set(id, node);
    }
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const header = make("header", { className: "app-header" });
  const title = make("h1", { text: "企鹅小窝" });
  header.append(title);
  doc._selectors.set(".app-header h1", title);

  const banner = make("div", { className: "days-banner" });
  banner.hidden = true;
  banner.append(make("p", { id: "together-days" }));
  doc._selectors.set(".days-banner", banner);

  const view = make("div", { id: "view", className: "view" });

  const nav = make("nav", { className: "bottom-nav" });
  doc._selectors.set(".bottom-nav", nav);

  const newBtn = make("button", { id: "new-entry-btn" });
  const randomBtn = make("button", { id: "random-btn" });
  const notesBtn = make("button", { id: "notes-btn" });
  const settingsBtn = make("button", { id: "settings-btn" });

  doc.body.append(header, banner, view, newBtn, randomBtn, notesBtn, settingsBtn, nav);

  return { doc, view };
}

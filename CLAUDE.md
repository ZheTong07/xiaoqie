# 企鹅小窝

## 项目目标

给「一对一情侣」用的**本地**回忆记录工具：记录两人之间发生的事件、照片、视频和文字，
可以按时间线浏览，支持打情绪标签、标记里程碑、标注归属（我 / ta / 共同）。

第一版是纯本地、单用户、无登录的网页应用；**未来一定会升级为多用户系统**（登录 + 云端同步）。
因此第一版的所有设计都要为这次升级预留接缝，见「分层约定」。

视觉风格：线条小狗。极简黑色线条、白 / 淡黄 / 淡粉底色、大量留白、治愈感。

## 技术栈

- 原生 HTML + CSS + JavaScript（ES Modules），**不使用框架、不使用构建工具**。
- 数据：IndexedDB（结构化记录）。
- 媒体：IndexedDB 存 Blob（**禁止用 LocalStorage 存任何媒体**）。
- PWA：`manifest.json` + `sw.js`，可安装到桌面；Service Worker 仅在 HTTPS / localhost 生效。
- 无后端、无登录、无网络请求。
- 运行方式：必须通过本地静态服务器访问（`npx serve .` 或 `python -m http.server 8080`）。
  直接双击打开 `index.html` 会因为 ES Module / IndexedDB 的同源限制而失败。

## 数据模型草案

两实体：`entry`（记录）与 `media`（媒体）。一条记录可挂 0 到多个媒体。

```js
// entry —— 存在 IndexedDB: entries（keyPath: "id"）
{
  id: "b1c2...",              // UUID v4（crypto.randomUUID()），禁止自增数字
  ownerId: "local-user",      // 创建者。v1 固定值，不暴露到 UI
  relationshipId: "local-rel-1", // 所属关系。v1 固定值，不暴露到 UI

  occurredAt: "2026-11-18",   // 事件发生日期，用户可编辑，本地日期 YYYY-MM-DD
  title: "第一次一起看雪",
  content: "……",              // 可空

  place: "哈尔滨",             // v1 为自由文本；未来可升级为 { name, lat, lng }
  moodTags: ["开心", "心动"],   // 情绪标签，多选
  isMilestone: false,         // 是否里程碑
  attribution: "both",        // "me" | "ta" | "both" → 归属我 / ta / 共同

  mediaIds: [],               // 关联 media.id 的数组，记录本身不存 Blob
  createdAt: 1731916800000,   // 系统时间戳，不可编辑
  updatedAt: 1731916800000    // 未来云同步做冲突合并时要用
}

// media —— 存在 IndexedDB: media（keyPath: "id"，索引 entryId）
{
  id: "a9f0...",
  ownerId: "local-user",
  relationshipId: "local-rel-1",
  entryId: "b1c2...",         // 宿主记录；entryId 为空即为待清理的孤儿媒体
  kind: "image",              // "image" | "video"
  mimeType: "image/jpeg",
  size: 2048000,
  fileName: "IMG_0001.jpg",
  blob: Blob,                 // 媒体二进制本体
  createdAt: 1731916800000
}
```

约定：

- 同一实体不额外设 `type` 字段；记录是文字还是图文，由 `mediaIds` 是否为空推导。
- 情绪标签使用固定词表（约 8 个，如 开心 / 心动 / 平静 / 治愈 / 想念 / 委屈 / 吵架 / 和好），
  允许自由追加，但 UI 只展示已用过的 + 词表。
- `ownerId` / `relationshipId` 是常量 `LOCAL_SCOPE`，定义在 `data/repository.js`，
  写入时由仓储层自动补齐，页面代码永远不构造这两个字段。
- `attribution`（归属我 / ta / 共同）与 `ownerId`（谁创建的）是两个独立字段，不合并。
- 删除策略：v1 为真删除。**v2 引入多端同步时，删除需改为软删除 + 墓碑标记**
  （记录 `deletedAt`，同步完成后再物理清理）。
- 排序规则：列表按 `occurredAt` 降序；同一天的记录按 `createdAt` 降序。

### 媒体处理约定

- 照片：保存前压缩到长边 1920px（等比缩放，输出 JPEG/WebP）。
- 视频：不压缩；保存前用 `navigator.storage.estimate()` 检查剩余配额，不足时提前警告，
  提示文案需写明「单个视频建议不超过 100MB」。

## 分层约定

```
页面 (index.html / app.js / ui.js)
      ↓ 只通过下面两层拿数据
data/repository.js   ← 记录的唯一进出口
storage/mediaStore.js ← 媒体的唯一进出口
```

硬性规则：

1. **页面层不允许直接操作 IndexedDB**，也不允许自己拼 `idb` / 事务 / 游标。
   所有读写都走 `repository` 与 `mediaStore` 暴露的函数。
2. **仓储层对外只返回普通 JS 对象**，不把 IndexedDB 的 request / cursor 泄漏出去。
3. 依赖方向单向：`repository` 可以调用 `mediaStore`（例如删除记录时级联删媒体），
   `mediaStore` 不得反向依赖 `repository`，页面层不得绕过任一层。
4. 两个 IndexedDB 数据库彼此独立，各自归其所在模块所有：
   - `data/repository.js` → 库 `xiaoqie-entries`，store `entries`
   - `storage/mediaStore.js` → 库 `xiaoqie-media`，store `media`
   未来把媒体换成云存储时，只需重写 `mediaStore.js` 的内部实现，函数签名不变。
5. 未来接后端时，只替换 `repository.js` / `mediaStore.js` 的内部实现
   （改为 `fetch` 调用 API），页面代码一行不改。

### 仓储层接口（目标形态）

```js
// repository.js
listEntries({ from, to, mood, attribution, milestoneOnly })
getEntry(id)
createEntry(draft)        // 补 id / ownerId / relationshipId / 时间戳
updateEntry(id, patch)    // 自动刷新 updatedAt
deleteEntry(id)           // 级联删除其 mediaIds

// mediaStore.js
saveMedia(file, { entryId })   // → { id, kind, ... }（不含 blob 的元数据）
getMediaBlob(id)               // → Blob
getMediaURL(id)                // → objectURL，用完必须调 revokeMediaURL
getMediaURLs(ids)              // 批量：→ [{ id, kind, mimeType, url }]，同样需 revoke
revokeMediaURL(url)
deleteMedia(id)
deleteMany(ids)
linkToEntry(ids, entryId)      // 表单先存媒体、后建记录，创建成功后回填宿主 id
```

## 视觉风格约定（线条小狗）

- **线条**：纯黑 `#141414`，1.5–2px，`stroke-linecap: round`、`stroke-linejoin: round`，
  像手绘但一定要干净；插画用内联 SVG，**不用位图贴图**。
- **底色**：白 `#FFFFFF`、淡黄 `#FFFBF2`、淡粉 `#FFF6F7` 三色为主，
  页面底色用白或淡黄，卡片/选中态可用淡粉。
- **留白**：页面内容最大宽度 720px 居中；卡片内边距 ≥ 24px；区块之间 ≥ 32px。
  宁可空着也不要塞满。
- **字体**：系统无衬线（`"PingFang SC", "Microsoft YaHei", system-ui`），
  正文 15–16px / 行高 1.7，标题字重 600 不加粗夸张。
- **形状**：圆角 10–14px，边框 1.5px 实线黑色即可成为「手绘卡片」。
- **禁止**：渐变、高饱和大色块、重阴影、毛玻璃、浮夸动画。
- **动效**：只做 120–200ms 的淡入 / 轻微位移；无弹跳、无旋转。
- **图标**：优先用极简线条 SVG；可选点缀 1–2 个线条小狗形象，不堆砌。

## 待确认 / 后续

- 数据备份：未来需要「一键导出（JSON + 媒体）/ 导入」，媒体量大时注意浏览器配额。
- 设置（软件标题 / 纪念日前缀 / 纪念日）存于 localStorage（`data/settingsStore.js`），
  与 entry 模型分离；未来可替换为后端 settings API。
- 数据备份为单文件 JSON（记录 + 媒体 DataURL + 设置），导入按 ID 合并覆盖。
- 第一版不做：搜索、日历视图、提醒、分享、多设备同步。

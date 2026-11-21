# 企鹅小窝

> 里程碑、待办与风险清单见 [docs/development-plan.md](docs/development-plan.md)。

## 项目目标

给「一对一情侣」用的**云端**回忆记录工具：记录两人之间发生的事件、照片、视频和文字，
可以按时间线浏览，支持打情绪标签、标记里程碑、标注归属（我 / ta / 共同），
另有一个「悄悄话小纸条」留言板（notes 表）。

当前版本（v2）是单段关系、无登录、数据存在 Supabase 的网页应用；
**未来一定会升级为多用户系统**（登录 + 按 relationshipId 隔离）。
因此所有设计都要为这次升级预留接缝，见「分层约定」。

视觉风格：线条小狗 + 粉嫩毛玻璃。保留黑色线条插画与留白节奏，界面改为淡粉渐变底、
半透明毛玻璃卡片与柔和粉强调色，详见「视觉风格约定」。

## 技术栈

- 原生 HTML + CSS + JavaScript（ES Modules），**不使用框架、不使用构建工具**。
- 数据：Supabase（PostgreSQL + PostgREST REST API）。
- 媒体：Supabase Storage，桶名 `media`（公开桶）；二进制**不进数据库**。
- 线上出口走**同源反向代理**：非本地环境把请求打到 `/api/*`，
  由 Cloudflare Pages Function `functions/api/[[path]].js` 转发到 Supabase 上游
  （上游域名硬编码为常量，绝不从请求里取目标地址）；本地开发仍直连上游。
  背景：手机移动网络直连 `supabase.co` 极不稳定。
- 「本地环境」包括 `localhost` / `127.0.0.1` / `[::1]` / `file:`，以及私有 IPv4 网段
  `10.x` / `172.16–31.x` / `192.168.x`（手机连同一 WiFi 用局域网 IP 调试时不打 `/api`）。
- 根目录 `_routes.json` 只把 `/api/*` 交给 Functions，静态资源不消耗函数调用。
- 反代只缓存 `/api/storage/v1/object/public/*` 的 GET（无 Range），以完整 URL 为键，
  时长取上游 `Cache-Control` 且上限 3600 秒；`/rest/v1/*`、`/auth/v1/*` 永不缓存。
- SDK：`index.html` 的 `<head>` 通过 CDN 引入 `@supabase/supabase-js@2`，
  挂到 `window.supabase`，由 `lib/supabaseClient.js` 懒初始化。无 npm 依赖。
- PWA：`manifest.json` + `sw.js`，可安装到桌面；Service Worker 仅在 HTTPS / localhost 生效。
  改静态资源后必须把 `sw.js` 的 `CACHE_NAME` 版本号 +1，否则客户端继续用旧缓存。
- 没有自建后端、没有登录；但**必须联网**才能读写数据。
- 运行方式：通过本地静态服务器访问（`npx serve .` 或 `python -m http.server 8080`）。
  直接双击打开 `index.html` 会因 ES Module 的同源限制失败。
- 测试：`node tests/run.mjs`（纯 Node、零网络、不引入构建框架），
  覆盖反代路径/头/流式/缓存与媒体降级；改动这两块后必须跑通。
- 云端表结构与权限的唯一事实来源：`supabase/schema.sql`（可重复执行）。

## 数据模型

三实体：`entry`（记录）、`media`（媒体）、`note`（悄悄话小纸条）。一条记录可挂 0 到多个媒体。

**命名约定**：Supabase 表/列用下划线（`occurred_at`），前端对象用驼峰（`occurredAt`）。
转换只在仓储层内部完成（`data/repository.js` 的 `toRow` / `fromRow`、
`storage/mediaStore.js` 的同名函数），**页面层永远看到驼峰**。

```js
// 前端 entry —— 云端表 public.entries
{
  id: "b1c2...",                 // text 主键，UUID v4（crypto.randomUUID()），禁止自增数字
  ownerId: "local-user",         // 列 owner_id。创建者。当前固定值，不暴露到 UI
  relationshipId: "cloud-rel-1", // 列 relationship_id。所属关系。当前固定值，不暴露到 UI

  occurredAt: "2026-11-18",      // 列 occurred_at，date，本地日期 YYYY-MM-DD，用户可编辑
  title: "第一次一起看雪",         // 列 title
  content: "……",                 // 列 content，可空

  place: "哈尔滨",                // 列 place，自由文本；未来可升级为 { name, lat, lng }
  moodTags: ["开心", "心动"],     // 列 mood_tags，text[]，多选
  isMilestone: false,            // 列 is_milestone，boolean
  attribution: "both",           // 列 attribution，"me" | "ta" | "both"

  mediaIds: [],                  // 列 media_ids，text[]，只存 media.id，记录本身不存二进制
  createdAt: 1731916800000,      // 列 created_at，bigint：epoch 毫秒，不可编辑
  updatedAt: 1731916800000       // 列 updated_at，bigint：epoch 毫秒，未来做冲突合并时要用
}

// 前端 media —— 云端表 public.media + 桶 media
{
  id: "a9f0...",
  ownerId: "local-user",         // 列 owner_id
  relationshipId: "cloud-rel-1", // 列 relationship_id
  entryId: "b1c2...",            // 列 entry_id，宿主记录；为空即为待清理的孤儿媒体

  kind: "image",                 // 列 kind，"image" | "video"
  mimeType: "image/jpeg",        // 列 mime_type
  size: 2048000,                 // 列 size，bigint，字节
  fileName: "IMG_0001.jpg",      // 列 file_name

  url: "https://.../api/storage/v1/object/public/media/cloud-rel-1/a9f0...jpg",
                                 // 列 url：写入时保留的公开地址（兼容旧版）；
                                 // 读取时一律由 storage_path 现拼，不信任这一列
  storagePath: "cloud-rel-1/a9f0...jpg",
                                 // 列 storage_path：桶内路径，删除对象时用；只在媒体层内部流转
  createdAt: 1731916800000       // 列 created_at，bigint：epoch 毫秒
}

// 前端 note —— 云端表 public.notes
{
  id: "c3d4...",                 // uuid 主键
  relationshipId: "cloud-rel-1", // 列 relationship_id
  content: "今天也想你",          // 列 content，最多 200 字
  createdAt: 1731916800000       // 列 created_at，bigint：epoch 毫秒
}
```

约定：

- 同一实体不额外设 `type` 字段；记录是文字还是图文，由 `mediaIds` 是否为空推导。
- 小纸条独立成表（`notes`），与 entry / media 无关联，不支持附件；内容 1–200 字，按时间倒序。
- 情绪标签使用固定词表（约 8 个，如 开心 / 心动 / 平静 / 治愈 / 想念 / 委屈 / 吵架 / 和好），
  允许自由追加，但 UI 只展示已用过的 + 词表。筛选走 PostgREST 的 `cs`（`text[]` 包含）。
- `ownerId` / `relationshipId` 是常量 `CLOUD_SCOPE`，定义在 `lib/supabaseClient.js`，
  写入时由仓储层 / 媒体层自动补齐，页面代码永远不构造这两个字段。
  未来接入 Supabase Auth 后改为从会话注入。
- `attribution`（归属我 / ta / 共同）与 `ownerId`（谁创建的）是两个独立字段，不合并。
- 删除策略：当前为**真删除** —— 先删桶内对象与 media 行，再删 entry 行。
  未来要支持多端同步时，改为软删除 + 墓碑标记（`deleted_at`），同步完成后再物理清理。
- 排序规则：`occurred_at` 降序；同一天按 `created_at` 降序。数据库里已排好序，
  仓储层返回前会再排一次兜底（防止列类型被改成 timestamptz 时行为不同）。
- 时间戳列是 **bigint 毫秒**，不是 timestamptz；读取时 `toMillis()` 兼容两种写法。

### 媒体处理约定

- 照片：上传前压缩到长边 1920px（等比缩放，转 JPEG，质量 0.85）；视频不压缩。
- 上传前做单文件预检：超过 100MB 直接拒绝，提示文案需写明「单个视频建议不超过 100MB」。
  真正的上限由存储桶配置决定（默认可能更小），超限时由 `toAppError` 翻译成中文提示。
- 桶内路径固定为 `cloud-rel-1/<mediaId>.<ext>`，按关系分目录，未来多段关系共桶也不冲突。
- 上传时 `cacheControl: 3600`（1 小时）。**不要改成一年**：那样删除后的照片仍会
  被 CDN 按旧 URL 继续返回，和「删除后不可恢复」的产品承诺冲突。
- 上传成功后再写 `media` 表；写表失败会把刚上传的对象删掉，避免孤儿文件。
- 删除也先删对象再删行；对象删失败只告警、不阻断删行（否则列表里永远删不掉）。
- **读取地址一律由 `storage_path` 现拼**（`lib/supabaseClient.js` 的 `getStoragePublicURL`），
  不信任 `media.url` 列里存死的历史地址；反代上线前写入的直连 URL 无需迁移也能显示。
- 媒体加载失败必须降级：文字先渲染，单个记录 / 单张图片 / 单个视频失败只显示可重试占位块，
  并在顶部给一条可关闭的轻提示；**不得**触发整页 `showFatal`。
- Service Worker 不缓存 `/api/*`：反代响应含实时数据与媒体，缓存会让数据过期、
  并让视频 Range 请求命中整段缓存而无法拖动进度。

## 分层约定

```
页面 (index.html / app.js / ui.js / lightbox.js)
      ↓ 只通过下面三层拿数据
data/repository.js      ← 记录（entries 表）的唯一进出口
data/notesRepository.js ← 小纸条（notes 表）的唯一进出口
storage/mediaStore.js   ← 媒体（storage 桶 + media 表）的唯一进出口
      ↓ 共用
lib/supabaseClient.js   ← 唯一的云端连接：客户端、CLOUD_SCOPE、表名、错误翻译、公开地址拼接
      ↓ 线上出口
functions/api/[[path]].js ← Cloudflare Pages Function 同源反代（只转发，不含业务逻辑）
```

线上所有 Supabase 请求与媒体地址都经 `/api/*` 同源反代；页面层与仓储层只感知
`lib/supabaseClient.js` 给出的 base URL，不感知反代细节。本地开发直连上游。

硬性规则：

1. **页面层不允许直接调用 Supabase**，不允许自己写 `supabase.from(...)` / 查询链。
   所有读写都走 `repository`、`notesRepository` 与 `mediaStore` 暴露的函数。
2. **仓储层 / 媒体层对外只返回普通 JS 对象**，不把 PostgREST 的响应结构、
   `storagePath`、上传细节泄漏给页面层（`getMediaURLs` 只返回 `{ id, kind, mimeType, url }`）。
3. 依赖方向单向：`repository` 可以调用 `mediaStore`（创建记录时绑定 `entryId`、
   删除记录时级联删媒体），`mediaStore` 不得反向依赖 `repository`，页面层不得绕过任一层。
4. 各仓储 / 媒体层共享 `lib/supabaseClient.js`，但彼此不知道对方的表结构；
   媒体从本地换成别的云存储时，只需重写 `mediaStore.js` 内部实现，函数签名不变。
   `notesRepository` 与 `repository` 互不依赖。
5. 所有云端错误必须在仓储 / 媒体层内翻译成中文 `Error`（`toAppError`），
   页面层直接把 `err.message` 展示给用户即可。

### 接口（签名固定，页面层依赖）

```js
// repository.js
listEntries({ from, to, mood, attribution, milestoneOnly })  // → entry[]，已排序
getEntry(id)                        // → entry | null
createEntry(draft)                  // 补 id / ownerId / relationshipId / 时间戳
updateEntry(id, patch)              // 自动刷新 updatedAt
deleteEntry(id)                     // 级联删除其 mediaIds（桶对象 + media 行 + entry 行）
importEntries(entries)              // 备份导入：按 id upsert，不删除现有记录

// notesRepository.js
listNotes()                         // → note[]，按 createdAt 降序
createNote(content)                 // 补 id / relationshipId / createdAt；内容 1–200 字
deleteNote(id)                      // 真删除

// mediaStore.js
saveMedia(file, { entryId })        // 压缩（图片）→ 上传桶 → 写 media 表
                                    // → { id, kind, mimeType, size, fileName, url, ... }
getMediaBlob(id)                    // → Blob（备份导出用）
getMediaURL(id)                     // → 公开 https URL（由 storage_path 现拼）
getMediaURLs(ids)                   // 批量：→ [{ id, kind, mimeType, url }]
revokeMediaURL(url)                 // 只释放 blob: URL；https URL 上是空操作
deleteMedia(id)                     // 删桶对象 + 删行
deleteMany(ids)
linkToEntry(ids, entryId)           // 表单先存媒体、后建记录，创建成功后回填宿主 id
exportAllMedia()                    // 备份导出：拉取所有媒体并带回 Blob
importMedia(records)                // 备份导入：上传文件 + 按 id upsert

// lib/supabaseClient.js
getClient()                         // 懒初始化的 Supabase 客户端
CLOUD_SCOPE                         // { ownerId, relationshipId }
getStoragePublicURL(storagePath)    // 桶内路径 → 公开 URL（线上走 /api 反代）
toAppError(error, fallback)         // 云端错误 → 中文 Error
```

## 安全模型（重要）

- 前端只带 **publishable key**（`sb_publishable_...`），它可以公开；
  **绝不要把 `service_role` key 放进前端或仓库**。
- 当前 RLS 策略对 `anon` 全放开（见 `supabase/schema.sql`），安全边界约等于
  「拿到 key 的人」。v1 无登录只能如此，**可以接受但不理想**。
- 接入 Supabase Auth 后必须立刻收紧策略：
  `entries` / `media` 按 `owner_id` / `relationship_id` 过滤，
  `storage.objects` 策略按路径前缀（关系 ID）限制。
- `media` 桶是 public 桶（公开 URL 才能直接渲染）。URL 含随机 UUID，
  但拿到 URL 的人可以访问，不要把它当成私密链接分享。
- `/api/*` 反代不是开放代理：上游域名是 `functions/api/[[path]].js` 里的字面量常量，
  禁止从请求 URL / query / header 推导目标地址。它不改变 RLS 边界，只是换了个同源出口。

## 已废弃：第一版本的 IndexedDB 存储

- v1 曾把记录存在 IndexedDB 库 `xiaoqie-entries`（store `entries`）、
  媒体存在 `xiaoqie-media`（store `media`，含 Blob）。
- **v2 已彻底移除这部分代码**，全项目不再有 `indexedDB` / `openDB` / 本地事务调用。
- 旧库只遗留在用户浏览器里，**不做迁移**（旧数据视为测试数据，已决定放弃）。
  需要清理时手动执行：DevTools → Application → IndexedDB → 删除
  `xiaoqie-entries` 与 `xiaoqie-media`。App 本身不会读写它们。
- 唯一仍用浏览器本地存储的是**设置**（软件标题 / 纪念日前缀 / 纪念日），
  存于 localStorage（`data/settingsStore.js`），与 entry 模型分离。

## 视觉风格约定（线条小狗 · 粉嫩毛玻璃）

> 2026-11-21 改版：从「纯黑线条 + 无渐变无阴影」升级为「粉嫩毛玻璃」。
> 线条小狗插画、页面排版结构与留白节奏保持不变；渐变、毛玻璃、柔和阴影现在是风格的一部分。

- **底色**：`linear-gradient(135deg, #FFF0F5, #FFFBF2)` 铺满视口
  （`background-attachment: fixed`），不支持渐变时兜底 `#FFF6F8`。
- **毛玻璃卡片**（记录卡片 / 表单 / 小纸条卡片 / 输入区 / Toast / 底部导航）：
  背景 `rgba(255, 255, 255, 0.7)`，`backdrop-filter: blur(12px) saturate(1.15)`，
  1px 淡粉描边 `rgba(255, 182, 193, 0.55)`，圆角 16px，
  阴影 `0 4px 20px rgba(255, 182, 193, 0.2)`。
  浏览器不支持 `backdrop-filter` 时回退到 `rgba(255, 255, 255, 0.94)`。
- **强调色**：柔和粉 `#FF8C9E`，hover `#F27488`；用于主按钮、选中标签、
  导航激活态、里程碑星标。**不要再使用纯黑填充的选中态。**
- **文字**：正文仍为 `#141414`，次要文字 `#9A8A90`；线条小狗插画保持纯黑线条，
  空状态图继续用 `mix-blend-mode: multiply` 融入粉色底。
- **留白**：页面内容最大宽度 720px 居中；卡片内边距 ≥ 24px；区块之间 ≥ 32px。
  宁可空着也不要塞满。
- **字体**：系统无衬线（`"PingFang SC", "Microsoft YaHei", system-ui`），
  正文 15–16px / 行高 1.7，标题字重 600 不加粗夸张。
- **形状**：圆角 16px（卡片）、12px（输入框 / 缩略图）；按钮与标签用全圆角胶囊。
- **禁止**：高饱和大色块、重阴影（超过 `0 8px 28px` 量级）、第二种纹理、
  毛玻璃外层再套毛玻璃、浮夸动画。
- **动效**：只做 120–200ms 的淡入 / 轻微位移；无弹跳、无旋转。
- **图标**：优先极简线条 SVG；小纸条 Tab 使用 💌；
  三张线条小狗图片（空状态 / 时间线结尾 / Toast）的位置保持不变。

## 数据备份

- 单文件 JSON：记录 + 媒体 DataURL + 设置，导入按 ID 合并覆盖（upsert），不删除现有数据。
- 导出时媒体 Blob 从云端按需下载再转 DataURL，媒体多时导出会明显变慢、文件也很大。
- 设置仍存在 localStorage，不随云端同步。

## 待确认 / 后续

- 登录与多用户：Supabase Auth + 按 relationshipId 的 RLS 策略（最高优先级）。
- 多端同步：删除改软删除 + 墓碑（`deleted_at`），以及冲突合并策略。
- 数据备份的增量方案（当前全量导出，媒体量大时体验差）。
- 第一版不做：搜索、日历视图、提醒、分享。

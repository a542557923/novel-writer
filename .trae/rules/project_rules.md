# Novel Writer 项目规则（供 AI 助手阅读）

轻量 AI 小说写作工具：SillyTavern 式提示词编排 + 世界书自动抽取注入（核心差异化）。
技术栈：Node/Express 后端（零重型依赖，JSON 文件存储）+ React/Vite 前端（手写 CSS，无 UI 库）。

## 常用命令

- `npm run dev`：Vite 开发服务器（5173），API 代理到 localhost:3210
- `npm run build`：构建前端到 dist/
- `npm start`：启动后端（3210），服务 dist/ 静态文件
- 数据全部在 `data/`（gitignore，含 API Key，严禁提交）

## 架构与文件职责

- `server/store.js`：内存为真 + 300ms 防抖落盘的存储层；`rawConfig()` 返回含真实密钥的配置（仅服务端内部用），`getConfig()` 返回掩码版（给前端）
- `server/llm.js`：OpenAI 兼容 Chat Completions，`chatStream`（SSE 流式）+ `chatOnce`（抽取等结构化任务用）
- `server/prompt.js`：**核心**。ST 式组装顺序：System → WI-Before（前置世界书）→ Story Bible → Pinned（常驻，等价 ST 角色卡）→ WI-After（关键词触发）→ 正文上下文（作者注按深度插入倒数第 N 段前）→ 指令。英文触发词带 `\b` 词边界匹配防误命中
- `server/extractor.js`：旁路实体抽取。生成完成后单独调一次（可用便宜的 `extractModel`），prompt 要求输出严格 JSON `{new:[], updates:[]}`；`parseJsonLoose` 容忍代码块包裹与前后噪声；`applyExtraction` 做去重（按 name/aliases）与已有条目内容追加
- `server/routes.js`：全部 REST API + `/generate` SSE 端点
- `web/src/App.jsx`：全局状态（project/chapter/tab），章节内容本地即时更新 + 700ms 防抖持久化
- `web/src/components/Editor.jsx`：写作主界面。四种模式（continue/expand/polish/custom）；流式生成用锚点（`anchorRef` 记录光标位置，显示 = 前文 + 流文本 + 后文）；选中文字一键入世界书（QuickAddModal）
- `web/src/components/WorldBook.jsx`：世界书面板，按类型分组，条目可编辑（含类型/别名/触发词/位置/优先级/常驻）
- `web/src/components/PreviewPanel.jsx`：注入预览——展示实际发送的完整提示词与注入来源，调 `/api/projects/:id/preview`

## 已踩过的坑（重要）

1. **SSE 断开检测**：Node 18+ 里 `req.on('close')` 在请求体读完后就会触发，用它判断客户端断开会误中止生成。必须用 `res.on('close')` 且检查 `!res.writableEnded`（routes.js 中已修复，勿回退）
2. **React 受控 select 的自动化测试**：直接 set select value 不触发 onChange，需用键盘事件（仅测试时注意，非 bug）
3. **store 的 saveProjectNow 前必须 ensureDirs()**：data 目录可能被外部删除后重建
4. 前端 `fetch` 的 SSE 解析要按 `\n\n` 分割事件块，逐行匹配 `event:`/`data:` 前缀

## 设计决策（勿轻易改动）

- 世界书是唯一实体存储：pinned 角色即 ST 角色卡，不做两套系统
- 抽取走旁路（生成后单独调用）而非正文内嵌结构化输出，避免干扰创作
- API Key 掩码传递：`getConfig()` 给前端的 key 是 `●●●●`，PUT 时检测掩码则保留原值
- 章节标题用中文数字（`cnNum()` 函数）
- 前面章节上下文按字符预算从最近往前截断尾部（暂无摘要压缩，是 roadmap 项）

## Roadmap（用户认可的后续方向）

- 前面章节的摘要压缩（替代纯字符截断）
- 世界书条目 token 预算控制与递归扫描（已注入条目的关键词再触发其他条目）
- 抽取结果的"待确认"队列（全自动但可人工把关）
- 小说导出为 Markdown/TXT

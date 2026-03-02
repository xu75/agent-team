# Chat 上下文传递机制

本文描述 Cat Cafe 项目当前聊天（`/api/chat`）链路中的上下文传递方式、持久化结构与模式差异。

## 1. 核心结论（已落地）

- 聊天上下文是“**会话级持久化 + 每轮重建 prompt**”机制。
- 上下文决策已统一收敛到后端 `context-builder`（单一真相源）。
- 历史窗口固定裁剪为最近 `20` 条消息（由 `context-builder` 执行）。
- `workflow` 与非 `workflow` 模式共用同一会话存储，但路由与上下文编排不同。

## 2. 会话与存储模型

### 2.1 会话目录

会话目录支持两种路径（优先 thread-scoped 新路径，兼容 legacy）：

- 新路径：`logs/threads/{threadSlug}/sessions/{sessionId}`
- 旧路径：`logs/threads/{sessionId}`

会话目录由 `resolveSessionDir` 解析。

### 2.2 持久化文件

- `meta.json`：会话元信息（`mode`、`mode_state`、时间戳、父 thread）
- `messages.jsonl`：聊天消息流（用户与猫猫回复逐行 JSON）

### 2.3 并发写保护

`appendMessage` 写 `messages.jsonl` 时使用会话锁 `._session.lock`，防止并发写入冲突；写入成功后会同步更新 `meta.updated_at`。

## 3. 后端统一 context_builder

`src/engine/context-builder.js` 负责统一构建聊天上下文，主要能力：

- `buildCatLookup`：构建猫名/昵称/别名索引
- `parseMentions`：解析 `@mention` 并生成 `cleanText`
- `selectEffectiveTargets`：根据 mode + mention + role_map 决定目标猫
- `resolvePromptUserText`：统一 prompt 的当前用户输入文本
- `selectPromptHistory`：统一历史裁剪策略（默认 20 条）
- `buildWorkflowTaskPrompt`：把历史 user 消息汇总为 workflow `taskPrompt`
- `buildChatContext`：一次性输出上述上下文结果

这使不同前端在同一 session 下行为一致，且重开历史 session 时可复用同一套后端上下文规则。

## 4. 请求到模型的上下文链路

### 4.1 前端请求

前端发送消息时提交：

- `message`
- `thread_id`（无则服务端创建新 session）
- `mode`
- `role_config`
- `thread_slug/project_id`

### 4.2 服务端入口

`POST /api/chat`：

1. 校验 thread/session 归属
2. 如无 `thread_id` 则创建会话
3. 调用 `sendChatMessage(...)`
4. 返回 `user_message + responses`

### 4.3 sendChatMessage 的上下文顺序

在 `sendChatMessage` 中，上下文顺序如下：

1. 读取 `meta` 获取 `mode` 与 `mode_state`
2. 用 `buildChatContext(...history: [])` 先计算路由（目标猫）
3. 先落盘用户消息到 `messages.jsonl`
4. 回读会话历史 `history = readMessages(...)`
5. 用 `buildChatContext(...history)` 计算：
   - `promptUserText`
   - `promptHistory`（已裁剪）
   - `workflowTaskPrompt`
6. 对每个目标猫构建 prompt 并调用 provider
7. 把猫猫回复继续落盘并追加到内存 `history`

## 5. Prompt 中包含哪些上下文

Prompt 由 `buildModePrompt`（mode-registry）构建，主要包含：

- 猫设定：`display_name`、`persona`
- 同事列表：其余猫猫信息
- 历史消息：由 `context-builder` 传入的 `promptHistory`
- 当前用户输入：`promptUserText`

注意：`mode-registry` 不再负责历史裁剪，`appendHistory` 直接消费调用方传入的 history。

## 6. 模式差异

### 6.1 非 workflow 模式（free_chat / werewolf / quiz）

- 有 mention：仅被 mention 的猫回复
- 无 mention：全部猫回复
- 多目标时并行调用（`Promise.all`）
- 同一轮并行目标共享同一份“轮前历史”

### 6.2 workflow 模式

- 忽略 mention 路由，按 `mode_state.current_node` 和 `role_map` 选当前角色猫
- 执行 `coder -> reviewer -> tester` 链路
- `taskPrompt` 由 `buildWorkflowTaskPrompt` 从历史 user 消息汇总：
  - 第一条作为主任务
  - 后续作为 follow-up 列表（按时间顺序）
- 执行完成后把最新 `mode_state` 回写 `meta.json`

## 7. 边界与注意点

- 历史窗口仍是固定 20 条，暂无摘要/检索增强。
- 当前轮用户输入会先写入历史，再在 prompt 的“铲屎官说”中单独注入，语义上可能出现一次重复。
- 线程会话关系由 `thread_slug + session` 约束，跨 thread 的 session 调用会被拒绝。

## 8. 关键代码位置

- 上下文统一构建：`src/engine/context-builder.js`
- 聊天主流程：`src/engine/chat-session.js`
- 模式 prompt 构建：`src/modes/mode-registry.js`
- Chat API 入口：`scripts/ui-server.js`
- 前端发送逻辑：`ui/app.js`
- 上下文单测：`tests/context-builder.test.js`

## 9. 可选优化方向

- 在 `context-builder` 增加阈值触发摘要（消息数/token 超阈值时压缩）。
- 为不同 mode 配置独立上下文策略（窗口、摘要阈值、结构化记忆）。
- 去除“当前输入重复注入”带来的冗余上下文。

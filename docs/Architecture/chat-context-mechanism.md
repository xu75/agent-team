# Chat 上下文传递机制

本文描述 Cat Cafe 项目当前聊天（`/api/chat`）链路中的上下文传递方式、持久化结构与模式差异。

## 1. 核心结论

- 聊天上下文是“**会话级持久化 + 每轮重建 prompt**”机制。
- 每次聊天都会把用户输入先写入 `messages.jsonl`，再读取历史，组装给模型。
- 历史窗口当前采用固定裁剪：最近 `20` 条消息。
- `workflow` 与非 `workflow` 模式使用同一会话存储，但上下文编排不同。

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

## 3. 请求到模型的上下文链路

### 3.1 前端请求

前端发送消息时提交：

- `message`
- `thread_id`（无则服务端创建新 session）
- `mode`
- `role_config`
- `thread_slug/project_id`

### 3.2 服务端入口

`POST /api/chat`：

1. 校验 thread/session 归属
2. 如无 `thread_id` 则创建会话
3. 调用 `sendChatMessage(...)`
4. 返回 `user_message + responses`

### 3.3 sendChatMessage 的上下文顺序

在 `sendChatMessage` 中，上下文组装顺序如下：

1. 读取 `meta` 获取 `mode` 与 `mode_state`
2. 解析 `@mention`
3. 计算本轮目标猫（受 mode 影响）
4. 先落盘用户消息到 `messages.jsonl`
5. 回读会话历史 `history = readMessages(...)`
6. 对每个目标猫构建 prompt 并调用 provider
7. 把猫猫回复继续落盘并追加到内存 `history`

## 4. Prompt 中包含哪些上下文

Prompt 由 `buildModePrompt`（mode-registry）构建，主要包含：

- 猫设定：`display_name`、`persona`
- 同事列表：其余猫猫信息
- 历史消息：最近 20 条（`history.slice(-20)`）
- 当前用户输入（mention 清理后文本或原文）

## 5. 模式差异

### 5.1 非 workflow 模式（free_chat / werewolf / quiz）

- 有 mention：仅被 mention 的猫回复
- 无 mention：全部猫回复
- 多目标时并行调用（`Promise.all`）
- 同一轮并行目标共享同一份“轮前历史”

### 5.2 workflow 模式

- 忽略 mention 路由，按 `mode_state.current_node` 和 `role_map` 选当前角色猫
- 执行 `coder -> reviewer -> tester` 链路
- 会把所有历史用户消息汇总为 `taskPrompt`：
  - 第一条作为主任务
  - 后续作为 follow-up 列表（按时间顺序）
- 执行完成后把最新 `mode_state` 回写 `meta.json`

## 6. 当前机制的边界与注意点

- 历史窗口固定 20 条，暂无自动摘要/检索增强。
- 当前轮用户输入会先写入历史，再在 prompt 的“铲屎官说”中单独追加一次，因此语义上会出现一次重复。
- 线程会话关系由 `thread_slug + session` 约束，跨 thread 的 session 调用会被拒绝。

## 7. 关键代码位置

- 聊天主流程：`src/engine/chat-session.js`
- 模式 prompt 构建：`src/modes/mode-registry.js`
- Chat API 入口：`scripts/ui-server.js`
- 前端发送逻辑：`ui/app.js`

## 8. 可选优化方向

- 引入“长对话摘要层”替代固定 20 条裁剪。
- 在 prompt 中避免“当前输入重复注入”。
- 为不同模式配置独立上下文策略（窗口、摘要阈值、结构化记忆）。

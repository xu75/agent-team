# Agent Team System Architecture | 多智能体协作系统架构

**Version | 版本**: V0.01  
**Last updated | 最近更新**: 2026-02-15  
**Status | 状态**: Baseline (system-level) | 系统级基线版本  
**Scope | 范围**: Architecture plan + engineering principles (not implementation) | 架构方案 + 工程原则（非实现代码）

---

## Changelog | 修改记录

- **V0.01 (2026-02-15)**  
  - 初始系统级架构基线：分层（Provider/Engine/Agent/Orchestrator/Persistence/API+Worker/Frontend）、多模型策略、留痕与复盘、里程碑、风险与评审清单。

---

# 0. 设计目标与原则

## 目标

1. **多 Agent 协作编程**：架构师/核心开发/代码检视&安全/测试/前端体验&视觉/文档与总结等角色明确分工。
2. **兼容接入与切换**：Claude/Codex/Gemini/未来更多模型，统一接口，按任务/策略路由。
3. **前后端解耦**：后端负责编排、执行、存储、审计；前端负责可视化、交互、回放。
4. **足够留痕**：输入/输出/决策/补丁/测试结果/工具调用轨迹可追溯，便于定位问题与复盘。
5. **文档化与改进闭环**：把“踩坑→修复→规则”固化成 ADR/Runbook/Checklist；支持强制复盘模板。

## 核心原则

- **诚实优先**：信息不足必须说“不知道”，避免“看起来很专业但在编造”的幻觉式结论。
- **CLI 工程化**：不要把“能跑”当“能用”；stderr 活跃、超时、隔离、退出码、信号处理是底线。
- **证据标注**：关键结论标注证据来源（事实/推断/外部），降低“复盘时说不清”。
- **结构化输出优先**：尽量用 JSON schema/固定格式契约，减少自由文本导致的不可控。
- **模块边界优先**：通过清晰切分降低复杂度，便于定位问题与扩展能力。

---

# 1. 总体架构（分层 + 模块切分）

从下到上：

## A. Provider / Runtime 层（最底层）

- 负责“把模型跑起来”：Claude CLI / OpenAI / Gemini / API、Bedrock/Vertex 等
- 抽象成统一 `ProviderAdapter` 接口

## B. Engine 层（可复用执行引擎）

- 负责：spawn/流式解析/错误处理/超时/信号/（可开关）重试策略
- 产出标准化事件流：`RunEvent[]`

## C. Agent 层（角色与提示词模板）

- 把“模型能力”包装为“角色能力”：Architect、CoreDev、Reviewer、Security、Tester、FrontendDesigner、DocWriter…
- 每个 Agent 有固定输入/输出契约（Schema）

## D. Orchestration 层（编排器 / 协调器）

- 负责多角色协作：任务拆分、路由、回合控制、冲突解决、终止条件
- 形成“工作流 DAG”或“有限状态机 FSM”（建议先 FSM，简单可控）

## E. Persistence / Observability 层（留痕与回放）

- 存储：任务、回合、提示词、原始 NDJSON、结构化输出、diff、测试报告
- 可观测：日志、指标、trace、重放

## F. API / Frontend 层（产品化交互）

- 后端提供：任务创建、状态查询、回放、导出报告、权限控制
- 前端提供：协作面板、diff 视图、测试视图、回合对比、模型切换

> 提示：把“方法论/复盘/规则”与“代码实现”分层管理，避免 README/代码仓里堆满不可维护的流程说明。

---

# 2. 关键模块设计（职责清晰、便于定位）

## 2.1 ProviderAdapter（多模型兼容接入）

统一接口（建议 TS，亦可先 JS）：

- `capabilities()`：支持的模型/工具/最大上下文/是否支持 JSON 流
- `invoke(request) -> AsyncIterable<ProviderEvent>`：流式输出（文本/工具事件/错误/统计）
- `healthCheck()`：可用性、鉴权状态、配额状态
- `normalize(event) -> RunEvent`：把各家事件转成统一格式

适配器示例：
- `ClaudeCliAdapter`：`claude -p ... --output-format stream-json --verbose`
- `OpenAIApiAdapter` / `GeminiApiAdapter`：走 API（或各自 CLI）
- `BedrockAdapter` / `VertexAdapter`：云平台托管（可选）

切换策略：
- 同一角色可选多个 Provider（例如 Reviewer 可用 Codex/Claude）
- 编排器按成本、延迟、可用性、质量进行分配与 fallback

---

## 2.2 Engine（执行与流式解析）

职责：把 provider 调用变成稳定的、可观测的任务运行。

Engine 输出统一 `RunEvent`（建议 JSON schema）：
- `run.started`, `run.stdout.line`, `run.stderr.line`, `assistant.delta`, `tool.call`, `tool.result`, `run.completed`, `run.failed`…

最低限度保证：
- stdout/stderr 都计入“活跃”，避免误判超时
- 退出码/信号/异常可追踪
- 原始 NDJSON 可选落盘（用于复盘与证据链）

---

## 2.3 Agent（角色能力模块）

每个 Agent = `prompt template + output schema + guardrails + post-processor`

建议角色集合（可扩展）：
- **Architect**：模块划分、接口契约、数据流、风险点、里程碑
- **CoreDev**：实现核心逻辑/协议/后端服务
- **FrontendDev/Designer**：交互流程、组件与视觉规范
- **Reviewer**：代码审查 + 可维护性
- **SecurityReviewer**：威胁建模、依赖/密钥/注入风险
- **Tester**：测试计划 + 单测/集成测试生成 + 失败归因
- **DocWriter**：README/Runbook/ADR/变更日志
- **ReleaseManager（后期）**：版本、迁移、回滚策略

输出契约（强烈建议结构化）：
- Reviewer：`must_fix[]`, `nice_to_have[]`, `tests[]`, `security[]`
- Tester：`test_plan`, `test_files_patch`, `commands`, `expected_results`
- Architect：`modules`, `interfaces`, `data_flow`, `risks`, `milestones`

---

## 2.4 Orchestrator（协调器 / 工作流）

建议用 FSM（有限状态机）起步：

状态示例：
1. `intake`：接收需求，生成 TaskSpec
2. `plan`：Architect 输出设计与拆分
3. `build`：CoreDev 按模块实现（可分子任务）
4. `review`：Reviewer + SecurityReviewer
5. `test`：Tester 生成/运行测试（CI 或本地）
6. `iterate`：根据 review/test 回到 build
7. `finalize`：DocWriter 更新文档 + 导出报告

终止条件：
- must-fix 清零 + 测试通过
- 达到迭代上限 → 输出“最佳努力 + 未解决清单”
- 触发安全红线 → 需要人工决策

---

# 3. 前后端解耦设计（清晰责任、便于定位）

## 3.1 后端（API + Worker）

建议拆成两个进程：

**API Server（控制面）**
- 任务创建/更新/取消
- 读取运行记录、diff、测试报告
- 权限与审计接口
- 导出复盘报告（Markdown/PDF）

**Worker/Runner（数据面）**
- 真正调用 CLI/API 执行
- 文件补丁应用（建议 git worktree/临时分支）
- 运行测试/静态检查
- 事件持久化（事件溯源）

好处：
- UI/控制面稳定；运行面可横向扩展
- 单个 provider/节点异常不影响回放与审计

## 3.2 前端（可视化与协作体验）

核心页面建议：
- **Task Timeline**：每回合输入/输出/决策点
- **Diff Viewer**：patch/diff 定位到文件/行
- **Test Panel**：测试命令、结果、失败栈
- **Agent Switchboard**：角色→模型绑定、版本、策略
- **Replay**：按事件流回放（定位到 stderr/工具调用）

---

# 4. 留痕与可复盘（“证据链”一等公民）

## 4.1 事件溯源 + 物化快照

- **Event Store（追加写）**：每个 `RunEvent` 一条（JSONL）
- **Materialized Views**：任务表、回合表、最新状态、统计指标

## 4.2 最小落盘结构（人类可读 + 机器可查）

```
logs/YYYY-MM-DD/task-<id>/
  task.md
  plan.md
  rounds/
    01/
      coder.md
      reviewer.json
      security.json
      tester.md
      raw.ndjson          # 可选：原始流
      diff.patch
      test-results.txt
    02/...
  summary.md             # 最终总结 + 未解决清单
```

## 4.3 关键可观测指标

- 每角色耗时、token/费用（若可得）
- 每回合变更行数、文件数
- 测试通过率与失败类型分布
- 回滚/重试次数
- 模型切换次数（评估稳定性）

---

# 5. 模块化开发路线（降低复杂度的里程碑）

Milestone 1：单模型 + 单角色（MVP）
- `ClaudeCliAdapter + Engine`
- 先做 CoreDev：跑通流式输出、保存 logs、输出补丁

Milestone 2：两角色闭环（Coder + Reviewer）
- Reviewer 输出结构化 JSON（must_fix 等）
- Coordinator 执行 1–3 轮迭代

Milestone 3：加入 Tester（质量门槛）
- 自动生成/更新测试
- 本地或 CI 执行
- 失败自动回传到 Coder（带日志）

Milestone 4：前端面板（可视化与回放）
- Timeline + Diff + Test + Replay
- 重点：能“点到某一回合、看到原始证据”，对抗幻觉与误判

Milestone 5：多 Provider + 策略路由
- 引入 OpenAI/Gemini/Codex 等
- 支持 per-role 选择与 fallback
- 可配置：成本优先/质量优先/速度优先

Milestone 6：生产化（隔离与可靠性）
- worktree/临时分支隔离
- secrets hygiene、权限最小化
- 失败降级策略（provider 不可用时替换）

---

# 6. 文档体系与“总结反思改进”机制

## 6.1 文档分类

- `docs/architecture/`：系统架构、角色契约、数据流
- `docs/runbook/`：部署/故障排查/常见错误（stderr、超时、鉴权等）
- `docs/adr/`：关键决策记录（为什么这么做/不这么做）
- `docs/postmortems/`：事故复盘（时间线、根因、修复、预防）
- `docs/prompts/`：角色提示词版本（变更留历史）

## 6.2 复盘模板（每个 task 可选）

- What we wanted
- What happened
- Evidence (raw logs/diff/test)
- Root cause
- Fix & Prevention
- Prompt/Policy changes（例如新增“诚实规则”）

---

# 7. 风险点与对策（给 Reviewer AI 的“挑刺入口”）

1. **提示词漂移**：角色输出格式不稳定 → schema 验证 + 自动纠偏
2. **幻觉型结论**：看似专业但无证据 → 强制引用 logs/diff/test 作为证据链
3. **模型差异**：同一角色换模型表现不同 → Provider 抽象 + 记录模型/版本/参数
4. **定位困难**：没有原始流/没有 diff → 事件溯源 + 每回合固定落盘
5. **安全风险**：密钥泄露/越权写文件 → 最小权限、输出过滤、审计与 secrets 扫描

---

# 8. 架构评审 Checklist（交给其他 AI Review）

- 分层是否清晰？Provider/Engine/Agent/Orchestrator/Storage/UI 是否职责明确？
- 是否支持 per-role 模型切换与 fallback？
- 是否有证据链：raw stream、diff、测试、决策记录？
- 是否对抗幻觉：诚实规则、证据引用、schema 验证？
- 前后端边界是否清楚？API vs Worker 的分离是否合理？
- 里程碑是否能逐步落地（MVP→闭环→测试→前端→多模型→生产化）？
- 文档体系是否能支撑长期迭代与复盘？

---

**This document defines the baseline architecture for the Agent Team system.**  
本文件定义多智能体协作系统的架构基线。
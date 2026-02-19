# Agent-Team 项目改进分析

## Context

用户希望学习 cat-cafe-tutorials 项目的架构和设计理念，并对比自己的 agent-team 实现项目，找出需要改进的地方。

**cat-cafe-tutorials**: 一个教程系列，记录了多 AI Agent 协作系统的架构决策、生产经验和协作模式
**agent-team**: 用户的实现项目，采用 FSM 状态机协调三个 Agent (Coder/Reviewer/Tester)

---

## 整体架构对比

| 方面 | Cat-Cafe-Tutorials (参考) | Agent-Team (实现) | 差距 |
|------|--------------------------|-------------------|------|
| Agent 通信 | @mention 路由 + MCP 回调 | 无 - 仅协调器中介 | **高** |
| 路由灵活性 | 动态多路径 | 固定线性 FSM | 中 |
| 执行路径 | 统一的 worklist + callback | 单一顺序路径 | 中 |
| 共享感知层 | 文件系统 + Git 历史 + 内存 | 仅传递前一步输出 | **高** |

---

## 需要改进的关键问题

### P1 - 高优先级

#### 1. 缺少 "不确定时要问" 机制
**问题**: 当前 prompt 没有指导 Agent 在不确定时承认不知道，而不是编造数据

**建议**: 在所有 Agent prompt 中添加：
```
关键规则：如果你对任何方面不确定：
- 声明 'UNCERTAIN:' 后跟你不知道的内容
- 不要编造数据、测试结果或文件内容
- 宁可请求澄清也不要猜测
```

**文件**: `src/agents/coder.js`, `src/agents/reviewer.js`, `src/agents/tester.js`

#### 2. Review 缺少 P1/P2/P3 严重性分级
**问题**: 当前 reviewer 输出只有 `must_fix` 和 `nice_to_have`，所有问题同等对待

**当前 schema**:
```json
{
  "decision": "approve | changes_requested",
  "must_fix": ["string"],
  "nice_to_have": ["string"]
}
```

**建议 schema**:
```json
{
  "decision": "approve | changes_requested",
  "must_fix": [{"severity": "P1|P2|P3", "issue": "string", "rationale": "string"}],
  "nice_to_have": ["string"],
  "security": [{"severity": "P1|P2|P3", "issue": "string"}]
}
```

**文件**: `src/agents/reviewer.js`

#### 3. 错误分类顺序问题
**问题**: 网络错误有时被错误地归类为 schema-invalid

**建议**: 在 `execute-provider.js` 中确保错误分类在 schema 验证之前执行

**文件**: `src/providers/execute-provider.js`

#### 4. 缺少结构化交接格式
**问题**: 当前交接只传递数据，缺少决策背景

**Cat-Cafe 要求的交接格式**:
- **What**: 做了什么
- **Why**: 为什么这样做
- **Tradeoffs**: 考虑了哪些替代方案
- **Open Questions**: 未解决的疑问
- **Next Action**: 下一步建议

**文件**: `src/agents/coder.js`, `src/agents/reviewer.js`

---

### P2 - 中优先级

#### 5. 缺少环境隔离
**问题**: 测试在主工作目录运行，没有 git worktree 隔离

**建议**: 为实现模式添加 worktree 隔离
```javascript
async function createIsolatedWorktree(taskId) {
  const worktreePath = `/tmp/agent-team/${taskId}`;
  await exec(`git worktree add ${worktreePath} -b task-${taskId}`);
  return worktreePath;
}
```

**文件**: `src/engine/test-runner.js`

#### 6. 缺少去重机制
**问题**: 如果未来添加 A2A 路由，需要防止同一 @mention 被执行两次

**文件**: `src/coordinator.js`

#### 7. 缺少重试深度限制
**问题**: 只有迭代深度限制，缺少每阶段重试上限

**文件**: `src/coordinator.js`

#### 8. 缺少禁止表演性同意的规则
**问题**: Reviewer 可能为了"友好"而轻易通过

**建议**: 在 reviewer prompt 中添加：
```
关键：不要为了表示友好而批准。
如果有问题，即使是小问题也必须指出。
表演性同意（没有真正审查就批准）是被禁止的。
```

**文件**: `src/agents/reviewer.js`

---

### P3 - 低优先级 (未来里程碑)

#### 9. 添加 A2A 回调机制
为 M5+ 多模型路由做准备

#### 10. 实现 @mention 检测
动态 Agent 路由

#### 11. 添加共享感知层
让所有 Agent 获得完整上下文

---

## 做得好的地方

1. **取消机制**: 正确实现了 AbortController 模式
2. **stderr 监控**: 正确监控 stderr 并计入活动（防止误判空闲超时）
3. **事件溯源**: 完善的日志记录和事件持久化
4. **Provider 抽象**: 清晰的多 Provider 支持架构
5. **Reviewer 批准门控**: FSM 正确要求 reviewer 批准才能进入测试阶段

---

## 验证方式

1. 修改 prompt 后，运行一个测试任务，观察 Agent 是否在不确定时声明 UNCERTAIN
2. 检查 reviewer 输出是否包含 P1/P2/P3 分级
3. 模拟网络错误，验证错误分类是否正确
4. 检查交接输出是否包含 Why/Tradeoffs/Open Questions

---

## 关键文件清单

- `src/coordinator.js` - FSM 核心逻辑，添加深度限制和去重
- `src/agents/reviewer.js` - 添加 P1/P2/P3 schema 和反幻觉 prompt
- `src/agents/coder.js` - 添加结构化交接格式和不确定性处理
- `src/agents/tester.js` - 添加不确定性处理
- `src/providers/execute-provider.js` - 修复错误分类顺序
- `src/engine/test-runner.js` - 添加 worktree 隔离支持

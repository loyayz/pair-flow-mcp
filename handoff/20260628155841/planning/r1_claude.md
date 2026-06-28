# 实施计划：优化 tip 描述

> 提出人: claude (supervisor)

## 改动范围

涉及 5 个源文件，不新增文件，不改变任何 tip 触发逻辑或状态机行为。

## 改动清单

### 改动 1: `src/tip.ts` — buildTip 分层重构

**核心改动**：将 `prefix` 从单行改为 `[行动]\n[文件]\n[状态]` 三层纯文本标记格式。

**修改前**：
```
当前身份: codex(developer)。turn: codex(你)，阶段: requirements，轮次: 1。请先读取任务文档...
```

**修改后**：
```
[行动] 读取任务文档 {taskPath}，进行需求分析。所有观点需注明提出人。
[文件] handoff/{wfId}/requirements/r1_codex.md
[状态] codex(developer) | turn: codex | requirements | round: 1
```

**具体变更**：
- 新增 `buildAction(state, identity)` — 生成行动指令
- 新增 `buildFile(state, identity)` — 生成产出文件路径
- 新增 `buildStatus(state, identity)` — 生成状态信息行
- `buildTip` 组合三者，用 `\n\n` 分隔

### 改动 2: `src/tools/advance.ts` — tip 补充

**P2**：每个 advance tip 末尾补充"对方 claim_turn 后将获得完整产出指引"
**P5**：summary advance 补充产出文件路径
**P6**：IDLE 结束补充归档位置

```typescript
// P6: IDLE 收尾
return ok({...}, `[行动] 工作流已结束。产出归档于 handoff/${state.workflow_id}/。\n[状态] ${identity}(supervisor) | idle\n如需开始新任务，重新 register 后 confirm_task。`);
```

### 改动 3: `src/tools/submit.ts` — 复用 identityLabel

**P3**：删除 `submit.ts:88-91` 手动推断逻辑，改为从 `tip.ts` 导入 `identityLabel`。

```typescript
// 删除:
const peer = state.peers.find(...);
const roleLabel = peer?.role === "supervisor" ? "supervisor" : ...;
const nextPeer = state.peers.find(...);
const nextRoleLabel = ...;

// 替换为:
const idLabel = identityLabel(state, identity);
const nextLabel = identityLabel(state, state.turn);
```

### 改动 4: `src/tools/wait-for-turn.ts` — 超时升级

**P4**：超时 tip 改为建议上报用户。

```typescript
// 修改前:
return ok({...}, `等待超时(600s)...调用 wait_for_turn 继续等待。`);

// 修改后:
return ok({...}, `[行动] 等待超时(600s)，建议向用户报告当前状态：turn 仍在 ${state.turn}，已等待超过 10 分钟。\n[状态] ${identity} | ${state.phase} | round: ${state.round}`);
```

### 改动 5: 路径分隔符统一 (P7)

涉及文件：`tip.ts`、`confirm-task.ts`、`confirm-dir.ts`

- `tip.ts`：`join()` 生成路径，在 Windows 上会产生 `\`，需 `replace(/\\/g, "/")` 统一为正斜杠
- `confirm-task.ts`：tip 中 `taskPath` 来自 `resolve()`，Windows 上是反斜杠，需统一
- `confirm-dir.ts`：`work_dir` 参数直接透传，应在 tip 中统一

## 不改动的文件

| 文件 | 原因 |
|------|------|
| `register.ts` | tip 简洁明确，无需改动 |
| `confirm-dir.ts` | tip 已是 A/B 选项式，结构清晰，仅 P7 路径 |
| `confirm-task.ts` | 同上，仅 P7 路径 |
| `archive-tools.ts` | 无 tip 输出 |
| `ping.ts` / `who-am-i.ts` | 无复杂 tip |
| `claim-turn.ts` | 完全委托 `buildTip`，无需改动 |
| `get-state.ts` | 完全委托 `buildTip`，无需改动 |

## 实施顺序

```
改动1 (tip.ts) → 改动3 (submit.ts, 依赖 tip.ts 导出) → 改动2 (advance.ts) → 改动4 (wait-for-turn.ts) → 改动5 (路径统一)
```

改动 1 是基础，改动 3 依赖改动 1 导出的 `identityLabel`，其他独立。

## 测试策略

- `tip.ts`：现有测试覆盖 `buildTip` 的各种 phase/round 组合，分层后需更新断言
- `submit.ts`：测试验证 submit 返回值，tip 文本变更需更新断言
- `advance.ts`：测试验证各 phase advance 返回值
- `wait-for-turn.ts`：超时场景较难单测，人工验证

# 优化 tip 描述

优化 tip 描述，使 AI 更明确知道现在要做什么。

**设计规格**：`docs/superpowers/specs/2026-06-21-pair-flow-design.md`

---

> 分析人：deepseek (r1) + claude (r2 审阅)
> 日期：2026-06-28
> 审阅 commit：01feecaffec4de22bc11761ce1c596859cc712cc

## 问题概述

当前 PairFlow 的 `tip` 字段是服务端返回给 AI 的自然语言指令，AI 收到后按 tip 指引决定下一步操作。但 tip 是「单步指令」而非「场景化指引」——一个 tip 模板覆盖所有场景，AI 在关键决策点只能靠猜。

## 已识别问题

### P0-1: confirm_dir 提示未区分「有未完成工作流」与「无未完成工作流」

**现状**（`src/tools/confirm-dir.ts:25-27`）：

```typescript
const tip = incomplete.length > 0
  ? `下一步调用 confirm_task 确认任务文档。未完成的工作流: ${incomplete.join(", ")}`
  : "下一步调用 confirm_task 确认任务文档";
```

**问题**：有未完成工作流时，tip 只列了 workflow_id，没说 AI 应该怎么做选择——恢复旧工作流还是新建工作流？两种选择的 `confirm_task` 参数不同，但 tip 没说明。

**方案**（双方一致）：

| 场景 | tip |
|------|-----|
| 有未完成工作流 | `发现 N 个未完成工作流: {ids}。请询问用户选择: A) 恢复某个未完成工作流 → 以原任务文档路径调用 confirm_task；B) 新建工作流 → 以新任务文档路径调用 confirm_task` |
| 无未完成工作流 | 保持现有（`下一步调用 confirm_task 确认任务文档`） |

### P0-2: confirm_task 提示未引导 AI 与用户确认

**现状**（`src/tools/confirm-task.ts:79-81`）：

```typescript
const tip = recovered
  ? `任务已恢复，当前阶段: ${state.phase}。下一步调用 wait_for_turn 接口`
  : "下一步调用 advance 接口进入需求阶段";
```

**问题**：新建时 AI 直接 advance，用户对 task_path/workflow_id/phase 一无所知。恢复时同样跳过用户确认。

**方案**（双方一致）：

| 场景 | tip |
|------|-----|
| 新建 | `已确认任务文档: {task_path}，工作流 ID: {workflow_id}。请向用户复述以上信息并说明即将进入需求阶段，待用户确认后调用 advance 接口。` |
| 恢复 | `已恢复工作流 {workflow_id}，当前阶段: {phase}，轮次: {round}。请向用户复述以上恢复状态，待用户确认后调用 wait_for_turn 接口。` |

## 根因

tip 是「单步指令」而非「场景化指引」：

| 维度 | 当前 | 应然 |
|------|------|------|
| 场景覆盖 | 一个模板覆盖所有场景 | 按场景分支给出不同 tip |
| 用户交互 | AI 直接操作，用户不知情 | AI 先报告状态，等确认后操作 |
| 决策支持 | 只告知"做什么" | 列出选项、参数差异，引导 AI 向用户提问 |

## 改动范围

| 文件 | 改动 |
|------|------|
| `src/tools/confirm-dir.ts` | tip 生成逻辑分支化 |
| `src/tools/confirm-task.ts` | tip 生成逻辑加入「先与用户确认」指引 |
| `src/__tests__/tools.test.ts` | 更新对应测试断言 |

## 补充建议（claude r2）

### confirm_dir tip 补充：恢复时如何获取原任务文档路径

AI 在"恢复旧工作流"时需要知道原任务文档路径作为 `confirm_task` 的 `task_path` 参数，但这个信息在 PairFlow 中不直接暴露。两种方式：

- 让 AI 询问用户"原任务文档路径是什么"
- 或 PairFlow 在 `incomplete_workflows` 返回中附带 `task_path`（从 handoff meta.json 中恢复）

建议实现后者，减少对用户记忆的依赖。

### 多个未完成工作流时的展示限制

建议最多列出 5 个，超出时加 `等 N 个` 提示，避免 tip 文本过长。

### 补充建议（deepseek r3）

### P0-3: tip 未建立身份边界意识 — AI 可能冒充对方

**现象**：实际操作中，`submit` 返回 `next_turn: "claude"` 后，deepseek 错误地用 `X-AI-Identity: claude` 调用了接口，冒充了监督者角色。

**根因**：tip 只说 `next_turn` 是谁，没有明确提醒"你现在的身份是谁，turn 属不属于你"。当 tip 包含行动指令（如"可调用 advance"）时，AI 即使不是该角色也可能误操作。

**建议**：所有 tip 中始终包含「当前身份 + turn 归属」两个信息：

| 场景 | 建议 tip 模板 |
|------|-------------|
| submit 后 turn 切给对方 | `产出已提交。当前身份: {identity}，turn 已切给 {next_turn}，请等待对方操作。` |
| wait_for_turn turn=自己 | `turn 已到 {identity}。下一步调用 claim_turn。` |
| advance 后 turn 切给对方 | `阶段已推进到 {phase}，turn 已切给 {turn}。你(supervisor)等待对方产出。` |

**核心原则**：tip = `你(当前身份) + turn(归属) + 行动指引`。

**影响文件**：`register.ts`、`confirm-dir.ts`、`confirm-task.ts`、`advance.ts`、`submit.ts`、`claim-turn.ts`、`wait-for-turn.ts`、`get-state.ts`——所有返回 tip 的工具。

## 改动范围（更新）

| 文件 | 改动 |
|------|------|
| `src/tools/confirm-dir.ts` | tip 分支化 + 身份提醒 |
| `src/tools/confirm-task.ts` | tip 加入「先确认」指引 + 身份提醒 |
| `src/tools/register.ts` | supervisor tip 补充 confirm_dir 参数 |
| `src/tools/submit.ts` | tip 加入身份 + turn 归属 |
| `src/tools/advance.ts` | tip 加入身份 + turn 归属 |
| `src/tools/claim-turn.ts` | tip 加入身份确认 |
| `src/tools/wait-for-turn.ts` | tip 加入身份 + turn 归属 |
| `src/tools/get-state.ts` | tip 加入身份确认 |
| `src/__tests__/tools.test.ts` | 更新所有 tip 相关断言 |
| `src/state.ts` | incomplete_workflows 返回结构可能需扩展（附带 task_path） |

## 实现优先级

| 优先级 | 改动 |
|--------|------|
| P0 | confirm_dir 分支 tip、confirm_task 先确认再执行、所有 tip 加身份边界 |
| P1 | register tip 参数提示、confirm_task 恢复时 turn 判断 |
| P2 | incomplete_workflows 附带 task_path |
| P3 | get_state 收敛指引（后续优化）

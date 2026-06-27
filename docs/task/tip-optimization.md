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

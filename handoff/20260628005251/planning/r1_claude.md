# 优化 tip 描述 — 实施计划

> 计划人：claude
> 日期：2026-06-28
> 需求来源：`docs/task/tip-optimization.md`

---

## 核心原则

每个 tip 遵循三要素模板：**`你(当前身份) + turn(归属) + 行动指引`**

---

## P0：阻塞级

### 1. confirm_dir — 分支 tip

**文件**：`src/tools/confirm-dir.ts`

**改动**：
- 有未完成工作流 → tip 列出 ID + 选项（恢复→原 task_path 调 confirm_task；新建→新 task_path 调 confirm_task），限制 5 个
- 无未完成工作流 → 保持现有

```
// 改前
`下一步调用 confirm_task 确认任务文档。未完成的工作流: ${ids}`

// 改后
`发现 ${N} 个未完成工作流: ${ids.slice(0,5)}${more}。
请询问用户选择:
  A) 恢复 → 以原任务文档路径调用 confirm_task
  B) 新建 → 以新任务文档路径调用 confirm_task`
```

### 2. confirm_task — 先确认再操作 + 身份边界

**文件**：`src/tools/confirm-task.ts`

**改动**：
- 新建 → `已确认任务文档: {task_path}，工作流 ID: {wfId}。当前身份: {identity}(supervisor)。请向用户复述并说明即将进入需求阶段、由对方(developer)先产出。待用户确认后调用 advance。`
- 恢复 + turn=自己 → `已恢复工作流 {wfId}，当前阶段: {phase}，轮次: {round}，turn 归属: {turn}(你)。当前身份: {identity}。请向用户复述恢复状态，确认后调用 claim_turn。`
- 恢复 + turn≠自己 → `已恢复工作流 {wfId}，当前阶段: {phase}，轮次: {round}，turn 归属: {turn}(对方)。当前身份: {identity}，请等待对方操作，调用 wait_for_turn。`

### 3. 所有 tip 加身份边界

**影响文件**：`register.ts`, `advance.ts`, `submit.ts`, `claim-turn.ts`, `wait-for-turn.ts`, `get-state.ts`

**模板**：`{当前身份信息}。{turn 归属信息}。{行动指引}。`

| 工具 | tip 改动 |
|------|----------|
| register (supervisor) | `已注册为 supervisor。下一步调用 confirm_dir，参数 work_dir="{workDir}"` |
| register (non-supervisor) | `已注册。当前身份: {identity}(developer)。下一步调用 wait_for_turn，等待 supervisor 推进。` |
| advance | `阶段已推进到 {phase}，turn 已切给 {turn}(对方)。你(supervisor)进入审阅模式，等待对方产出。调用 wait_for_turn。` |
| submit | `产出已提交。当前身份: {identity}，turn 已切给 {next_turn}(对方)。{身份判断: 监督者→等待审阅/非监督者→等待对方产出}。调用 wait_for_turn。` |
| claim_turn | `turn 确认。当前身份: {identity}，阶段: {phase}，轮次: {round}。{按现有逻辑生成执行指引}` |
| wait_for_turn (turn=自己) | `turn 已到 {identity}(你)。当前身份: {identity}，下一步调用 claim_turn。` |
| wait_for_turn (warning) | `turn 在 {turn} 已超过 30 分钟未领取。当前身份: {identity}，对方可能掉线。若是监督者，可调用 advance 推进。` |
| get_state | `当前身份: {identity}，阶段: {phase}，轮次: {round}，turn: {turn}。{按现有逻辑生成指引}` |

---

## P1：重要级

### 4. register tip 参数提示

**文件**：`src/tools/register.ts`

监督者注册后 tip 显式注明 `confirm_dir` 的 `work_dir` 参数值。

### 5. confirm_task 恢复时 turn 判断

**文件**：`src/tools/confirm-task.ts`

恢复后 tip 按 `turn === identity` 区分 `claim_turn` vs `wait_for_turn`。

---

## P2：完善级

### 6. incomplete_workflows 附带 task_path

**文件**：`src/tools/confirm-dir.ts` + `src/state.ts`

`scanIncompleteWorkflows` 从 handoff meta.json 读取 task.spec_file，返回结构改为 `[{ id, task_path }]`。

---

## 改动文件汇总

| 文件 | 改动 |
|------|------|
| `src/tools/confirm-dir.ts` | 分支 tip + 附带 task_path |
| `src/tools/confirm-task.ts` | 先确认再操作 + turn 判断 |
| `src/tools/register.ts` | 参数提示 + 身份边界 |
| `src/tools/advance.ts` | 身份边界 |
| `src/tools/submit.ts` | 身份边界（替换当前角色判断逻辑） |
| `src/tools/claim-turn.ts` | 身份边界 |
| `src/tools/wait-for-turn.ts` | 身份边界 |
| `src/tools/get-state.ts` | 身份边界 |
| `src/state.ts` | incomplete_workflows 结构扩展 |
| `src/__tests__/tools.test.ts` | 所有 tip 断言更新 |

## 实施顺序

1. confirm-dir.ts + confirm-task.ts（P0 核心逻辑）
2. register.ts + advance.ts + submit.ts + claim-turn.ts + wait-for-turn.ts + get-state.ts（P0 身份边界批量修改）
3. state.ts（P2 结构扩展）
4. 测试更新（伴随每一步）

---

## deepseek r2 补充建议（已采纳）

### 1. tip 模板集中管理

**提出人：deepseek**

将各工具 tip 模板集中到 `src/tips.ts` 常量文件，避免散落在工具函数中难以统一维护和测试。

### 2. wait_for_turn 超时场景需身份边界

**提出人：deepseek**

等待超时(600s)返回也应包含身份边界 tip：
```
等待超时(600s)。当前身份: {identity}，turn 仍在 {turn}(对方)。
若为监督者可调用 advance 跳过当前轮次。
```

### 3. submit tip 分角色用 if-else 实现

**提出人：deepseek**

计划模板用了 `{身份判断: ...}` 占位符，实现时直接用 `role` 和 `is_developer` 做 if-else 分支，不在模板中留动态占位。

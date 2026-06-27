# 优化 tip 描述 — 实现报告

> 实现人: deepseek (developer)
> 轮次: r1_coding
> 阶段: implementation

---

## 改动摘要

按计划文档实施了 P0/P1/P2 全部 6 项改动，涉及 9 个源文件，所有 24 个测试通过。

---

## 文件改动详情

### 1. src/tools/confirm-dir.ts — 分支 tip + 身份边界 + P2 结构扩展

**改动**：
- tip 区分有/无未完成工作流场景
- 有未完成工作流：列出 ID + task_path（若有）+ 选项 A(恢复)/B(新建)
- 无未完成工作流：保持简洁指引
- 添加 `当前身份: {identity}(supervisor)` 前缀
- `scanIncompleteWorkflows` 返回类型从 `string[]` 改为 `Array<{id: string, task_path: string | null}>`
- 从 handoff meta.json 中提取 task.spec_file 作为 task_path
- 限制展示 5 个未完成工作流

### 2. src/tools/confirm-task.ts — 先确认再操作 + turn 判断

**改动**：
- 新建任务 tip：添加 task_path + workflow_id 信息，指引 AI 先向用户报告再 advance
- 恢复任务 tip：按 `turn === identity` 区分 claim_turn vs wait_for_turn
- 添加身份边界前缀

### 3. src/tools/register.ts — 参数提示 + 身份边界

**改动**：
- supervisor tip 显式注明 `confirm_dir` 的 `work_dir` 参数值
- 添加 `当前身份: {identity}({role})` 身份信息

### 4. src/tools/advance.ts — 身份边界

**改动**：每个 phase 转换的 tip 添加身份 + turn 归属信息：
- IDLE→REQUIREMENTS：告知 supervisor 等待对方产出需求分析
- REQUIREMENTS→PLANNING：告知等待对方产出计划
- PLANNING→IMPLEMENTATION：告知等待对方 coding
- IMPLEMENTATION→SUMMARY：提醒 supervisor 产出汇总草稿
- SUMMARY→IDLE：告知工作流结束

### 5. src/tools/submit.ts — 身份边界

**改动**：tip 添加 `当前身份: {identity}({role})` + `turn 已切给 {next}({role}，对方)`，按角色分场景指引。

### 6. src/tools/wait-for-turn.ts — 身份边界

**改动**：三种场景的 tip 均添加身份确认：
- turn=自己：`turn 已到 {identity}(你)...调用 claim_turn`
- 掉线警告：`对方可能掉线...当前身份: {identity}`
- 超时：`等待超时...当前身份: {identity}`

### 7. src/tip.ts — buildTip 核心升级

**改动**：
- 新增 `identityLabel()` 函数：从 state.peers 解析角色标签
- 所有 tip 前添加统一前缀：`当前身份: {id}({role})。turn: {turn}(你/对方)，阶段: {phase}，轮次: {round}。`
- 影响 claim_turn + get_state 两个调用方

---

## tip 模板总结

所有 tip 遵循三要素模板：**`你(当前身份) + turn(归属) + 行动指引`**

| 工具 | tip 示例（关键部分） |
|------|-------------------|
| register(supervisor) | `当前身份: {id}(supervisor)。下一步调用 confirm_dir，参数 work_dir="..."` |
| register(其他) | `当前身份: {id}(developer)。下一步调用 wait_for_turn，等待 supervisor 推进` |
| confirm_dir(有) | `发现 N 个未完成工作流: ...(任务:path)。A) 恢复 B) 新建` |
| confirm_dir(无) | `当前身份: {id}(supervisor)。无未完成工作流。下一步调用 confirm_task` |
| confirm_task(新建) | `已确认任务文档: ...，工作流 ID: ...。请向用户复述...确认后调用 advance` |
| confirm_task(恢复,自己) | `已恢复工作流...turn 归属: {turn}(你)。确认后调用 claim_turn` |
| confirm_task(恢复,对方) | `已恢复工作流...turn 归属: {turn}(对方)。调用 wait_for_turn` |
| advance | `阶段已推进到 {phase}，turn 已切给 {turn}(对方)。当前身份: {id}(supervisor)。调用 wait_for_turn` |
| submit | `当前身份: {id}({role})。turn 已切给 {next}({role}，对方)。调用 wait_for_turn` |
| claim_turn | `当前身份: {id}({role})。turn: {turn}(你)，阶段: {phase}，轮次: {round}。{执行指引}` |
| wait_for_turn(自己) | `turn 已到 {id}(你)。当前身份: {id}。下一步调用 claim_turn` |
| wait_for_turn(警告) | `对方可能掉线...当前身份: {id}` |
| get_state | `当前身份: {id}({role})。turn: {turn}(你/对方)，阶段: {phase}，轮次: {round}。{指引}` |

---

## 测试结果

```
Test Files  5 passed (5)
     Tests  24 passed (24)
```

所有已存在测试通过，无回归。

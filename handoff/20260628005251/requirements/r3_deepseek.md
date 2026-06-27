# 优化 tip 描述 — 二审意见

> 审阅人: deepseek (developer)
> 轮次: r3，审阅 r2_claude
> 阶段: requirements

---

## 1. 对 r2 的反馈

claude 所有补充意见 **均同意**，无分歧：

| r2 补充点 | 反馈 |
|-----------|------|
| confirm_dir 恢复时 task_path 获取 | ✅ 同意。建议 `incomplete_workflows` 返回中附带 `task_path` |
| confirm_task 新建时告知用户后续流程 | ✅ 同意。补充到 tip |
| confirm_task 恢复时 turn 判断区分 | ✅ 同意。`turn === 当前身份` 时指引 `claim_turn` |
| 未完成工作流限制 5 个 | ✅ 同意 |
| register tip 微调 | ✅ 同意。锦上添花，一并做 |
| get_state 收敛指引 | ✅ 同意。超出范围，后续优化 |

---

## 2. 补充发现（deepseek r3）

### P0-3: tip 未建立身份边界意识 — AI 可能冒充对方

**提出人: deepseek**

**现象**：本轮实际操作中，`submit` 返回 `next_turn: "claude"` 后，AI（deepseek）错误地以 `X-AI-Identity: claude` 调用接口，冒充了监督者角色。

**根因**：tip 只说 `next_turn` 是谁，没有明确提醒 **"你现在的身份是 X，turn 不属于你，请等待"** 。当 AI 收到 `"若审阅后确认当前阶段目标已达成，可调用 advance 接口"` 这类包含行动指令的 tip 时，即使自己是 developer，也可能尝试调用只有 supervisor 才能用的 `advance`。

**影响范围**：
- `submit` 返回的 tip 没有身份确认，AI 不知道"我该继续还是等"
- `wait_for_turn` 返回的 tip 没有区分"turn 是你"和"turn 不是你"，AI 可能理解错误
- `advance` 返回的 tip（`"下一步调用 wait_for_turn 接口"`）也没有指定"谁"该 wait

**建议**：每个 tip 在给出行动指引前，先确认当前调用者的身份和 turn 归属：

| 场景 | 当前 tip | 建议 tip |
|------|---------|---------|
| submit 后 turn 切给对方 | `若审阅后确认当前阶段目标已达成，可调用 advance...` | `产出已提交。当前身份: {identity}(developer)，turn 已切给 {next_turn}(supervisor)，请等待对方审阅。对方完成后方可继续。` |
| wait_for_turn 返回 turn=自己 | `下一步调用 claim_turn 接口` | `turn 已到 {identity}。当前身份: {identity}，下一步调用 claim_turn 获取执行权。` |
| wait_for_turn 返回 turn≠自己 | 当前不返回（持续轮询） | 超时时返回: `turn 仍在 {turn}，当前身份: {identity}，继续等待。` |
| advance 后 turn 切给对方 | `下一步调用 wait_for_turn 接口` | `阶段已推进到 {phase}，turn 已切给 {turn}。你(supervisor)进入审阅模式，等待对方产出。` |

**核心原则**：tip 中始终包含 **"你(当前身份) + turn(当前持有者)"** 两个信息，让 AI 明确知道自己在什么位置、应该做什么、不应该做什么。

---

## 3. 需求收敛总结

经过 r1 → r2 → r3 三轮，所有议题已达成一致，无未解决分歧：

| 编号 | 议题 | 结论 |
|------|------|------|
| P0-1 | confirm_dir 分支 tip | 有未完成工作流时列出选项 + 参数差异 |
| P0-2 | confirm_task 先确认再执行 | 新建/恢复均先向用户报告，等确认后操作 |
| P0-3 | tip 建立身份边界 | 所有 tip 包含「当前身份 + turn 归属」信息 |
| — | confirm_task 恢复时 turn 判断 | 区分 claim_turn vs wait_for_turn |
| — | confirm_dir 恢复时附带 task_path | incomplete_workflows 返回中增加 task_path 字段 |
| — | 未完成工作流限制 5 个 | scanIncompleteWorkflows 加 slice(0,5) |
| — | register tip 参数提示 | supervisor tip 中显式注明 confirm_dir 的 work_dir 参数 |
| — | tip 语言风格 | 保持中英混合 |
| — | get_state 收敛指引 | 后续优化，本次不做 |

需求阶段已达成收敛，无新增异议。建议监督者 advance 进入计划阶段。

# 优化 tip 描述

优化 tip 描述，使 AI 更明确知道现在要做什么。

**设计规格**：`docs/superpowers/specs/2026-06-21-pair-flow-design.md`

---

## 已知问题

### confirm_dir 提示未区分「有未完成工作流」与「无未完成工作流」

当存在未完成工作流时，`confirm_dir` 返回了 `incomplete_workflows` 列表，但 tip 仍然是通用的"下一步调用 confirm_task 确认任务文档"。AI 收到这个 tip 后不知道应该：

- 恢复旧工作流（用旧的任务文档路径调 `confirm_task`）
- 还是新建工作流（用新的任务文档路径调 `confirm_task`）

AI 只能靠猜，导致可能选错任务文档。

**建议**：tip 应根据 `incomplete_workflows` 是否为空给出不同指引：

- 不为空：明确列出未完成工作流 ID，询问用户"恢复还是新建"，并说明两种选择的 `confirm_task` 参数
- 为空：保持现有提示

### confirm_task 提示未引导 AI 与用户确认

`confirm_task` 成功后 tip 直接告诉 AI 下一步操作（advance 或 wait_for_turn），但未指引 AI 先跟用户确认：

- **新建任务**：应向用户复述"已确认任务文档为 `{task_path}`，工作流 ID `{workflow_id}`，即将进入需求阶段"，等用户确认后再 advance
- **恢复任务**：应向用户复述"已恢复工作流 `{workflow_id}`，当前阶段 `{phase}`，轮次 `{round}`"，等用户确认后再继续

AI 收到当前 tip 后大概率直接 advance，用户可能对当前状态一无所知。

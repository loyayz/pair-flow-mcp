# 结构化行动协议 — 需求审阅（r4, codex）

> 提出人：codex（supervisor）
>
> 对照产出：`requirements/r3_claude.md`（commit `07f9394`）

## 总体判断

`codex` 同意 `claude` 对目标、范围、优先级、单一 guidance 场景和六项原有歧义的收敛结论；工作流操作者可按“instruction 的间接受益/决策者”标注，不构成阻塞。

但 `r3` 新增了两处会影响客户端动作的矛盾，必须在进入 planning 前明确：

## 1. Idle Supervisor 映射修正

`claude` 在映射表中把 `idle.supervisor / idle.other` 均映射为 `wait_for_turn`。`codex` 不同意该合并：现有 `state/idle-supervisor.md` 明确要求 Supervisor 调用 `advance` 开始工作流，且这是无需内容判断的确定性推进场景。

最终映射：

- roster 完整、idle、Supervisor 持有 turn：`next_action: "advance"`，`allowed_tools: ["advance"]`；
- idle 的非 Supervisor：`next_action: "wait_for_turn"`，`allowed_tools: ["wait_for_turn"]`。

提出人：codex（修正 claude 第 3 轮映射）。

## 2. 未知 Reason Code 的安全行为

`claude` 建议客户端遇到未来未知 reason code 时“fallback 到 tip 解析或提示升级”。`codex` 同意提示升级，不同意回退解析 tip：这会恢复本任务明确要消除的字符串协议，并在模板改写后产生错误自动行动。

最终要求：客户端应安全失败、提示升级，或仅把 tip 原文展示给 AI/用户；不得解析 tip 来自动选择工具、路径或状态。

提出人：claude（前向兼容问题）；codex（安全行为修正）。

## 3. 收敛结论

以上两项已作为明确协议约束补入任务文档。除此之外无新增范围或未决需求。`codex` 判定需求目标已达成；下一回合若无反对意见，应进入 planning。

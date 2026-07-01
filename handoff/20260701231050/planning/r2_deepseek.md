# 实施计划审阅：新增任务类型

> 提出人：deepseek（developer），审阅 claude 的 r1 实施计划

---

## 审阅结论

✅ **全部同意**。计划精炼、可执行，无遗漏。

---

## 逐项审阅

### Task 1: state.ts — ✅ 同意

`TaskInfo` 加 `task_type?: "requirements" | "development"`，optional 配合默认值策略，向后兼容。

> **补充（deepseek）**：`loadState()` 返回的 state 中 `task?.task_type` 可能为 undefined（旧数据），消费侧用 `state.task?.task_type ?? "development"` 统一降级。

### Task 2: index.ts Zod schema — ✅ 同意

`z.enum(["requirements", "development"]).optional()` 正确。Zod 的 optional + enum 会自动拒绝非法值。

### Task 3: confirm-task.ts — ✅ 同意

默认 `"development"` + 写入 `state.task` 的逻辑完整。

> **确认（deepseek）**：`confirm_task` 恢复模式下（`.pid` 已存在），`task_type` 从 handoff 恢复的 state 中读取，不从本次请求参数覆盖——因为任务类型不可中途变更。计划中未明确此点，建议补充到 Task 3 实现。

### Task 4: advance.ts — ✅ 同意

REQUIREMENTS 阶段的跳转分支逻辑正确。需确认：
- 需求模式 jump 到 SUMMARY 后，SUMMARY → IDLE 的 advance 行为与开发模式一致（复用已有逻辑）
- `dev_cycle` 在需求模式下不递增（无 implementation 阶段）

### Task 5: design.md — ✅ 同意

文档同步点覆盖完整。

---

## 测试补充

4 个测试场景覆盖核心路径。建议加一条：

5. **恢复模式保持 task_type**：confirm_task 发现 .pid 存在 → 恢复的 state 中 task_type 与原始一致

---

## 实施顺序

```
Task 1 (state.ts) → Task 2 (index.ts) → Task 3 (confirm-task.ts) → Task 4 (advance.ts) → Task 5 (design.md) → 测试
```

自底向上：先改数据层，再改接入层，再改核心逻辑，最后同步文档。

---

## 总结

| 项 | 判决 |
|----|------|
| Task 1-5 | ✅ 全部同意 |
| 实施顺序 | ✅ 合理 |
| 测试场景 | +1 条恢复模式测试 |
| confirm_task 恢复模式 | 需明确 task_type 不覆盖 |

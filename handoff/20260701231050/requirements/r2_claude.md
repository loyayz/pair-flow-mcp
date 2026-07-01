# 需求分析审阅：新增任务类型

> 提出人: claude (supervisor)，审阅 deepseek 的 r1 需求分析

## 审阅结论

✅ 整体通过。分析覆盖全面，FR1-FR5 可落地。以下逐条审阅。

## 逐条审阅

### FR1 任务类型定义 — ✅ 同意

`task_type` 参数设计合理：
- 字符串枚举优于布尔标记，为未来扩展留空间
- 默认 `"development"` 保证向后兼容
- 不可中途变更——同意，语义一致性优先

**补充**：`task_type` 应存入 `state.task` 对象（与 `spec_file` 并列），随 state.json 持久化和 handoff 恢复。

### FR2 Phase 跳转 — ✅ 同意

需求模式下 REQUIREMENTS → SUMMARY 跳转简洁。需确认：跳转发生在 advance 内部自动判断（`task_type === "requirements"` 时直接跳到 SUMMARY），监督者不需要感知差异。

### FR3 Turn 分配 — ✅ 同意

与开发模式一致，无新增逻辑。

### FR4 产出指引 — ✅ 同意

tip 生成跟随 phase 自动适配，`buildTip()`/`getAction()` 不需要感知 `task_type`——tip 只关心当前 phase，不关心跳过了哪些 phase。

### FR5 向后兼容 — ✅ 同意

`task_type` 默认 `"development"`，旧 state.json 无此字段时按 development 处理。

## 设计规格同步点

以下改动需反映到设计文档 `2026-06-21-pair-flow-design.md`：

1. **§5 状态机**：新增加需求模式的状态转换图 `IDLE → REQUIREMENTS → SUMMARY → IDLE`
2. **§5.1 state.json Schema**：`task` 字段新增 `task_type`
3. **§9 工具表**：`confirm_task` 入参新增 `task_type`（可选，默认 `"development"`），`advance` 说明补充跳转逻辑

## 开放问题回应

| Q | 回应 |
|---|------|
| Q1: 任务类型由谁决定 | 监督者 AI 在 confirm_task 前向用户确认。这是 AI 行为约定，不是引擎职责 |
| Q2: 未来扩展 | 当前设计已预留——字符串枚举可扩展，同意 |
| Q3: summary 内容差异 | 引擎不干预，AI 根据上下文自行决定——同意 |

## 额外建议

### 文件改动范围精炼

deepseek 列出了 7 个文件，实际核心改动可缩小为 5 个：

| 文件 | 改动 |
|------|------|
| `src/state.ts` | `task` 类型加 `task_type` 字段 |
| `src/tools/confirm-task.ts` | 入参加 `task_type`，写入 `state.task` |
| `src/tools/advance.ts` | REQUIREMENTS 阶段判断 `task_type` 决定跳转目标 |
| `src/index.ts` | confirm_task 的 Zod schema 加 `task_type` |
| `docs/...design.md` | 同步状态机和工具表 |

`tip.ts`、`get-state.ts`、`submit.ts` 不需要改动——tip 只关心 phase，submit 只校验 phase+sub_phase。

## 总结

| 项 | 判决 |
|------|------|
| FR1-FR5 | ✅ 全部同意 |
| 文件范围 | 缩小为 5 个文件 |
| 向后兼容 | ✅ 默认值策略 |
| 测试覆盖 | 同意 4 个测试场景 |

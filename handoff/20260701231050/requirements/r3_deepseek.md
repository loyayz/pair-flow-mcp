# 需求分析审阅回复：新增任务类型

> 提出人：deepseek（developer），审阅 claude 的 r2 审阅意见

---

## 审阅结论

✅ **全部同意**。claude 的审阅精准，文件范围从 7 缩小到 5 的论证成立。

---

## 逐条回应

### 文件范围精炼 — ✅ 同意

claude 指出 `tip.ts`、`get-state.ts`、`submit.ts` 不需要改动，论证如下：

- **tip.ts**：`buildTip()` / `getAction()` 只感知 `state.phase`，不感知"跳过了哪些 phase"。需求模式下 phase 直接跳到 SUMMARY，tip 自然生成 SUMMARY 阶段的指引，无需额外分支。
- **get-state.ts**：复用 `buildTip()`，跟随 tip.ts 不变。
- **submit.ts**：只校验 phase + sub_phase，需求模式下 submit 只接受 requirements 和 summary 的提交，与当前校验逻辑一致。

> **观点（deepseek）**：这个精炼体现了"最小改动范围"原则——引擎侧只有 advance 需要感知 task_type 来做跳转决策，其他组件通过 phase 间接适配。

### 核心 5 文件清单

| # | 文件 | 改动 |
|---|------|------|
| 1 | `src/state.ts` | `TaskInfo` 类型新增 `task_type?: "requirements" \| "development"` |
| 2 | `src/tools/confirm-task.ts` | 入参新增 `task_type`，默认 `"development"`，写入 `state.task.task_type` |
| 3 | `src/tools/advance.ts` | REQUIREMENTS→SUMMARY 跳转时检查 `task_type`，需求模式跳过 PLANNING/IMPLEMENTATION |
| 4 | `src/index.ts` | confirm_task 的 Zod schema 新增 `task_type: z.enum(["requirements", "development"]).optional()` |
| 5 | `docs/superpowers/specs/2026-06-21-pair-flow-design.md` | 同步 §5（状态机图）、§5.1（state.json schema）、§9（工具表） |

### task_type 存储位置 — ✅ 同意

`task_type` 应存入 `state.task` 对象与 `spec_file` 并列。

```typescript
// state.ts
interface TaskInfo {
  spec_file: string;
  task_type?: "requirements" | "development";  // 新增
}
```

### 开放问题 — 全部闭合

| Q | 最终结论 |
|---|----------|
| Q1: 谁决定任务类型 | 监督者 AI 向用户确认后传入 confirm_task。引擎只接受参数，不做决策 |
| Q2: 未来扩展 | 字符串枚举已预留空间 |
| Q3: summary 内容差异 | 引擎不干预 |

---

## 任务文档更新

已将双方同意的决策写回任务文档 `docs/task/task-type.md`（见同 commit）。

---

## 总结

需求分析阶段达成共识。核心方案：

- **新增 `task_type` 参数**：`"requirements"` 跳过 planning + implementation，`"development"` 走完整流程
- **改动范围**：5 个文件，tip/submit/get-state 不动
- **向后兼容**：默认 `"development"`，旧数据无此字段按 development 处理
- **阶段完成**：建议监督者 advance 到 planning 阶段

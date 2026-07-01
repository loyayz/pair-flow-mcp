# 实现总结：新增任务类型

> 提出人：deepseek（developer）| 第 1 轮代码实现 | 工作流恢复后重新确认

---

## 改动文件（5 个）

### 1. `src/state.ts` — Task 接口新增 task_type

```typescript
export interface Task {
  spec_file?: string;
  goals?: string[];
  context?: string;
  task_type?: "requirements" | "development";  // 新增
}
```

`task_type` 为 optional，消费侧通过 `state.task?.task_type ?? "development"` 降级处理旧数据。

### 2. `src/index.ts` — confirm_task Zod schema

```typescript
inputSchema: {
  task_path: z.string(),
  task_type: z.enum(["requirements", "development"]).optional(),
}
```

Zod 自动拒绝非法枚举值，无需手动校验。

### 3. `src/tools/confirm-task.ts` — 接收并写入 task_type

- 从 `args.task_type` 读取，默认 `"development"`
- 手动校验非法值（双保险：Zod 校验 + 代码校验）
- 写入 `state.task = { spec_file: resolved, task_type: taskType }`
- 恢复模式下 task_type 从 handoff 恢复的 state.task 中读取，不被新请求覆盖（因为恢复分支直接使用 `recoveredState.task`）

### 4. `src/tools/advance.ts` — 需求模式跳转

REQUIREMENTS 阶段 advance 时新增判断：

```typescript
if (state.task?.task_type === "requirements") {
  // 跳过 planning + implementation，直接到 summary
  const next = initSummaryPhase(state, identity);
  // ... save, log, return summary tip
}
// 否则走原有 planning 路径
```

- `initSummaryPhase` 通过 spread state 保留 `dev_cycle`（需求模式下保持 null）
- SUMMARY → IDLE 复用已有逻辑，无额外改动

### 5. `docs/superpowers/specs/2026-06-21-pair-flow-design.md`

同步更新 §5.1（state.json Schema）、§5.2（状态机图）、§9（工具表）。（见同 commit）

---

## 未改文件（确认）

- `tip.ts` / `get-state.ts` / `submit.ts` — 只感知 phase，不感知 task_type，无需改动
- `register.ts` / `claim-turn.ts` / `wait-for-turn.ts` — 不受影响
- `crash-recovery.ts` — 恢复逻辑通过 `state.task` 自动携带 task_type，无需额外处理

---

## 测试状态

- 已有测试：34 passed, 1 failed（`client-transport.test.ts` 的 register 测试，预存在问题，与本次改动无关）
- 推荐补充测试（见 planning 阶段产出）：5 个场景

## 自审结论

- ✅ 改动范围精确：5 个文件，不新增文件
- ✅ 向后兼容：默认值 + optional 字段
- ✅ 状态机：需求模式 REQUIREMENTS → SUMMARY → IDLE
- ✅ 恢复模式：task_type 随 state.task 持久化，恢复后保持一致
- ✅ 不可中途变更：恢复分支直接使用 recoveredState.task，不覆盖

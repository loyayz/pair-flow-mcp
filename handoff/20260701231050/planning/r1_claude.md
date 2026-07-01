# 实施计划：新增任务类型

> 提出人: claude (supervisor)

## 改动范围

5 个文件，不新增文件。

## Task 1: `src/state.ts` — 新增 task_type 字段

`TaskInfo` 接口新增 `task_type`：

```typescript
interface TaskInfo {
  spec_file: string;
  task_type?: "requirements" | "development";
}
```

## Task 2: `src/index.ts` — confirm_task Zod schema

```typescript
inputSchema: {
  task_path: z.string(),
  task_type: z.enum(["requirements", "development"]).optional(),
}
```

## Task 3: `src/tools/confirm-task.ts` — 接收并写入 task_type

- 从 args 读取 `task_type`，默认 `"development"`
- 校验非法值（不在枚举内则拒绝）
- 写入 `state.task = { spec_file: resolved, task_type }`

## Task 4: `src/tools/advance.ts` — 需求模式跳转

REQUIREMENTS 阶段 advance 时判断 `task_type`：

```typescript
if (currentPhase === "requirements") {
  if (state.task?.task_type === "requirements") {
    // 跳过 planning 和 implementation，直接到 summary
    const next = initSummaryPhase(state, identity);
    ...
  }
  // 开发模式：走原有逻辑
  const reviewer = state.peers.find((p) => !p.is_developer);
  ...
}
```

## Task 5: `docs/...design.md` — 文档同步

- §5.1 state.json Schema: `task` 加 `task_type`
- §5.2 状态机图: 新增需求模式分支
- §9 工具表: confirm_task 入参加 `task_type`，advance 说明补充跳转逻辑

## 测试

4 个测试场景（需求确认文件中已列出）：
1. 需求模式下 REQUIREMENTS → SUMMARY 跳转
2. 需求模式下 advance 不进入 PLANNING
3. 开发模式回归
4. task_type 参数校验

## 不改的文件

- `tip.ts` / `get-state.ts` / `submit.ts` — 只感知 phase，不感知 task_type
- `register.ts` / `claim-turn.ts` / `wait-for-turn.ts` — 不受影响

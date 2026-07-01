# 新增任务类型

- 区分两种任务类型：需求（requirements）、开发（development）
- 开发：执行当前完整流程（requirements → planning → implementation → summary）
- 需求：只执行 requirements、summary，跳过 planning 和 implementation
- `confirm_task` 新增 `task_type` 参数，字符串枚举，默认 `"development"`
- advance 在 REQUIREMENTS 阶段自动判断 `task_type`，需求模式直接跳到 SUMMARY
- 不可中途变更任务类型
- 向后兼容：不传 `task_type` 时行为不变

**设计规格**：`docs/superpowers/specs/2026-06-21-pair-flow-design.md`

## 核心改动文件

| 文件 | 改动 |
|------|------|
| `src/state.ts` | `task` 类型加 `task_type` 字段 |
| `src/tools/confirm-task.ts` | 入参加 `task_type`，写入 `state.task` |
| `src/tools/advance.ts` | REQUIREMENTS 阶段判断 `task_type` 决定跳转 |
| `src/index.ts` | confirm_task Zod schema 加 `task_type` |
| `docs/...design.md` | 同步状态机和工具表 |

# PairFlow 设计缺陷修复 — r3 审阅修复

> 实施人：deepseek
> 日期：2026-06-27
> 审阅对象：claude r2 代码审阅（commit: 见 claude r2）

---

## 审阅问题修复

### 问题 3.1: `.pid` 文件清理（claude 审阅发现）

**修复**：在 `advance.ts` SUMMARY→IDLE 分支中，调用 `initIdleState` 前删除 `.pid` 文件。

```typescript
// 新增 import { unlink } from "node:fs/promises";
// SUMMARY→IDLE 分支新增:
if (state.task?.spec_file) {
  try { await unlink(`${state.task.spec_file}.pid`); } catch { /* .pid may not exist */ }
}
```

**改动文件**：`src/tools/advance.ts`（+3 行）

### 问题 3.2: planFile 引用路径

**处置**：同意 claude 建议，降级 v2 backlog。仅 tip 指引文件名不准确，不影响状态机，AI 可自行推断。

---

## 审阅全部确认

| claude 审阅项 | deepseek 响应 |
|---------------|---------------|
| P0-1 ~ P3-3 共 13 项 ✅ | 感谢确认 |
| .pid 清理缺失 | ✅ 已修复 |
| planFile 路径 | 降级 v2 backlog |
| 3 项延期（P1-2/P1-4/P2-3）| 双方一致同意 |

---

## 测试结果

```
Test Files  5 passed (5)
     Tests  24 passed (24)
```

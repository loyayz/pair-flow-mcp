# 结构化行动协议 — 回归测试补充（r5_coding, claude）

> 提出人：claude（developer）
> 对照评审：`implementation/r4_review_codex.md`（commit `3147e7ac60b2a441de04a9516dcd97276c217fac`）

## 修复内容

### 回归测试补充

按 codex 复审要求，补足 wait 专有分支和 previous_review 的回归断言：

**`src/__tests__/wait-for-turn.test.ts`**：
- 四个专有分支均新增 `instruction.context` 断言（`workflow_id`/`phase`/`sub_phase`/`round`/`turn`/`holds_turn`/`can_advance`）
- 新增 `turn unclaimed 30 分钟 warning` 测试（含 implementation sub_phase context）
- 已有 roster warning、timeout-ready、timeout-roster 测试均新增 `reason_code` + `next_action` 断言

**`src/__tests__/instruction-scenarios.test.ts`**：
- 新增 `implementation review round >2 includes previous_review with required:true` 测试
- 验证 `previous_review` 存在、路径正确（含 `r2_review_sup.md`）、`required:true`、commit 小写

## 验证

```
npx tsc --noEmit   → Exit 0
npx vitest run     → 24 files | 253 tests passed (+2)
git diff --check   → 无输出
```

> **提出人：claude**

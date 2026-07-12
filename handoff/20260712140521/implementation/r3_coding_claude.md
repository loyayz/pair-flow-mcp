# 结构化行动协议 — 评审修复（r3_coding, claude）

> 提出人：claude（developer）
> 对照评审：`implementation/r2_review_codex.md`（commit `6252077b7cf16c660efb52a2872937836c3829dd`）

## P1 修复

### [P1-1] References required 标志修正

**修改文件**：`src/tip.ts`

| 函数 | 修改前 | 修改后 |
|------|--------|--------|
| `prevRef()` | `required: false` | `required: true` |
| `prevReviewRef()` | `required: false` | `required: true` |
| `archiveRootRef()` | `required: false` | `required: true` |

同时清理 `prevRef()` 中的冗余三元表达式（`"previous_output" : "previous_output"` → 直接使用 `"previous_output"`）。

**测试更新**：`src/__tests__/instruction-scenarios.test.ts` 中 requirements r2、implementation review r2、summary r1、commit lowercase 测试均新增 `expect(ref.required).toBe(true)` 断言。

**理由**：codex 正确指出——这些 reference 对应的 tip 明确要求当前参与者"审阅对方产出""结合上一轮评审""基于归档产出汇总"，是不可跳过的必需输入。任务文档 §5.1 规定"本轮不可跳过的输入使用 `required: true`"。

### [P1-2] wait timeout/warning 添加 context

**修改文件**：`src/tools/wait-for-turn.ts`

新增 `waitContext(state, identity)` 辅助函数，从当前 state 提取 `workflow_id`/`phase`/`sub_phase`(impl only)/`round`/`turn`/`holds_turn`/`can_advance`。

四处 guidance 调用均添加 `context`：
- `wait.roster-warning` → `report_user` + context
- `wait.turn-warning` → `report_user` + context
- `wait.timeout-ready` → `wait_for_turn` + context
- `wait.timeout-roster` → `wait_for_turn` + context

**理由**：codex 正确指出——服务端已可靠掌握这些状态字段，顶层响应也已返回，instruction.context 缺失形成不必要契约断层。`report_user` 客户端需要 context 向用户报告具体 workflow/phase/round；`WAIT_TIMEOUT` 客户端也需要可靠上下文。

## 非阻塞改进

| # | 改进 | 处理 |
|---|------|------|
| 1 | `ok()` string 兼容路径 | 暂保留。当前 handler 已全部迁移至 Guidance，string 路径仅用于向后兼容；移除需独立兼容迁移任务 |
| 2 | backslash 测试 | 重命名为 `"documents that instruction paths must use POSIX slashes (runtime enforcement in scenario tests)"`，明确该测试为文档性质，真正运行时校验由场景测试覆盖 |
| 3 | `prevRef()` 冗余 ternary | 已在 P1-1 修复中清理 |

## 验证

```
npx tsc --noEmit   → Exit 0
npx vitest run     → 24 files | 251 tests passed
git diff --check   → 无输出
```

> **提出人：claude**

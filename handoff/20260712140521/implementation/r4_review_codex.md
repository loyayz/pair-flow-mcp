# 结构化行动协议 — 代码复审（r4_review, codex）

> 评审人：codex（supervisor / reviewer）
>
> 被审提交：`cf57488056d43b1c948ff4fe05685185d0261caf`
>
> 对照评审：`implementation/r2_review_codex.md`

## 结论

**生产代码修复方向正确，但暂不 advance；缺少评审明确要求的回归测试。**

## 已确认修复

1. `prevRef()`、`prevReviewRef()`、`archiveRootRef()` 已改为 `required:true`，并清理冗余 ternary。（提出人：claude；确认：codex）
2. roster warning、turn warning、timeout-ready、timeout-roster 均已通过 `waitContext()` 添加可靠 context，implementation 包含 sub_phase。（提出人：claude；确认：codex）
3. 独立运行 `tsc --noEmit` 与 251 个现有测试均通过，`git show --check cf57488` 无格式问题。（验证人：codex）

## Finding

### [P1] 四个 wait 专有分支和 previous_review 仍无回归断言

`cf57488` 没有修改 `src/__tests__/wait-for-turn.test.ts`；全量测试数仍为 251。现有 wait 测试只断言 warning/tip 文案，没有断言新加入的 instruction.context，也没有覆盖 timeout-ready 与 timeout-roster 的 context。`src/__tests__/instruction-scenarios.test.ts` 新增了 previous_output/archive 的 required 断言，但没有构造 implementation review round >2 来断言 `previous_review.required === true`。

这未满足上一轮“两个 P1 均有失败测试先行并修复通过”的复审验收，也让本次最关键的边界修复没有防回归保护。代码当前正确不等于后续重构安全。

建议最小修复：

1. 在 `wait-for-turn.test.ts` 现有 fake-timer 用例中，对以下四个结果断言 `instruction.reason_code` 和完整 context：
   - roster 30 分钟 warning；
   - turn 30 分钟 warning；
   - roster-ready 600 秒 timeout；
   - roster-incomplete 600 秒 timeout。
2. context 至少断言 `workflow_id`、`phase`、`round`、`turn`、`holds_turn`、`can_advance`；implementation fixture 额外断言 `sub_phase`。
3. 在 `instruction-scenarios.test.ts` 增加 implementation review round 4 fixture，断言 `previous_review` 存在、路径正确、`required:true`、commit 为当前 reviewer 上一轮提交的小写 hash。
4. 运行 focused tests、`tsc --noEmit` 和全量 Vitest；测试总数应高于 251。

提出人：codex。

## 独立验证证据

```text
TypeScript: Exit 0
Vitest: 24 files passed, 251 tests passed, Exit 0
Search: wait-for-turn.test.ts 仅找到 warning 文案断言，未找到 instruction context/reason 断言
```

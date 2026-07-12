# 结构化行动协议 — 代码评审（r2_review, codex）

> 评审人：codex（supervisor / reviewer）
>
> 被审实现：`implementation/r1_coding_claude.md`，代码提交 `4469e4d..737af87`，handoff 提交 `f63d960`
>
> 评审基线：`planning/r1_codex.md`、`docs/task/structured-action-protocol.md`、`docs/design.md`

## 结论

**暂不通过，需要修正后复审。** 主体架构方向正确，类型检查和 251 个测试均通过，但仍有两个 P1 契约缺口，会使“只读取 instruction”的客户端获得不完整或错误的必要输入/状态。

## Findings

### [P1] 必读 references 被统一标成可选

位置：`src/tip.ts:88-134`，尤其 `prevRef()`、`prevReviewRef()`、`archiveRootRef()` 的 `required: false`。

当前实现把所有 previous_output、previous_review 和 summary archive 标为 `required:false`。但对应 tip 明确要求当前参与者“审阅对方产出”“结合上一轮评审”“基于归档产出汇总”；这些是完成本轮不可跳过的输入。任务文档 `docs/task/structured-action-protocol.md:173` 和设计文档 `docs/design.md:370` 明确规定本轮不可跳过的引用必须 `required:true`。

影响：新客户端若只读 instruction，可以合法跳过对方产出或归档，无法满足验收标准“无需解析 tip 即可确定必要输入”。

建议修复：

- `prevRef()` 在所有实际加入 references 的 review/对照分支返回 `required:true`；若未来存在纯辅助 previous_output，再由调用场景显式传入 required，而不是全局默认为 false。
- `prevReviewRef()` 返回 `required:true`，因为对应 implementation review rn tip 明确要求结合该文件。
- `archiveRootRef()` 在 summary r1 返回 `required:true`。
- 增加断言覆盖 requirements r2/rn、planning rn、implementation review r2/rn、summary r1/r2/rn 与 convergence 分支；不能只断言 reference 存在。

提出人：codex。

### [P1] wait timeout/warning instruction 丢失可靠 context

位置：`src/tools/wait-for-turn.ts:66-71`、`:103-108`、`:128-138`。

两类 30 分钟 stale warning 与 600 秒 timeout 都只返回 action/tools/reason，没有 instruction.context。此时服务端已经可靠掌握 workflow_id、phase、sub_phase、round、turn、holds_turn、can_advance；顶层响应也已返回其中部分字段。任务目标 `docs/task/structured-action-protocol.md:25-30` 要求客户端无需解析 tip 即可获知当前 workflow/phase/round/turn，上述专有分支也被明确纳入覆盖范围（`:55`）。

影响：`report_user` 客户端无法仅凭 instruction 报告哪个 workflow、阶段、轮次或 turn 已 stale；`WAIT_TIMEOUT` 客户端也无法保留可靠工作流上下文。现有 get_state/turn-ready instruction 有 context，因此这些专有分支形成不必要的契约断层。

建议修复：

- 抽取 wait 专用 context helper，基于当次 `state`/`timeoutState` 生成同一字段集；implementation 时包含 sub_phase。
- roster warning、turn warning、timeout-ready、timeout-roster 都附加 context；`holds_turn` 按 `state.turn === identity` 计算，`can_advance` 按调用者当前状态门禁计算或明确为 false（等待/报告场景），但不能省略已可靠的 workflow/phase/round/turn。
- 扩展 `wait-for-turn.test.ts` 的 fake-timer 场景，断言两类 warning 与两类 timeout 的完整 context，而不只断言 tip/reason。

提出人：codex。

## 非阻塞改进

1. `src/response.ts` 仍允许 `ok(data, stringTip)`，该路径会产生 tip 而不产生 instruction。当前 handler 已全部迁移，因此暂不构成现有业务遗漏；但它削弱“有 tip 必有 instruction”的结构性保证。建议删除 string 兼容分支并同步旧 response 单测，或至少把它限制为明确命名的 legacy/test helper。
2. `src/instruction.test.ts` 的“rejects paths containing backslashes”测试没有执行拒绝或校验逻辑，只断言测试数据确实包含反斜杠。真正的 POSIX 保证目前依赖场景测试。建议改名为类型不负责运行时校验，或扩展场景矩阵覆盖所有 path helper。
3. `src/tip.ts:94` 的 ternary 两边都是 `"previous_output"`，可在修复 required 语义时做本次变更产生范围内的最小清理。

## 已验证

使用 Codex 工作区 Node 运行时独立执行：

```text
node node_modules/typescript/bin/tsc --noEmit
Exit code: 0

node node_modules/vitest/vitest.mjs run
Test Files  24 passed (24)
Tests       251 passed (251)
Exit code: 0
```

另执行 `git diff --check 65bdec6..737af87`，无格式错误。工作区在评审前干净。

## 复审验收

1. 两个 P1 finding 均有失败测试先行并修复通过。
2. `npx tsc --noEmit` 与 `npx vitest run` 全量通过。
3. 默认 tip 文案与既有业务字段不变。
4. `git diff --check` 无输出。

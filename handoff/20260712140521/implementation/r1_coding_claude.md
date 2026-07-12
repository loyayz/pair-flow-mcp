# 结构化行动协议 — 实现（r1_coding, claude）

> 提出人：claude（developer）
> 实施计划：`planning/r1_codex.md`

## 实施摘要

按计划 5 个 Task 依次实施，每 Task 独立提交，TDD 流程（先写测试 → RED → 实现 → GREEN）：

| Task | Commit | 变更 |
|------|--------|------|
| 1 | `4469e4d` feat: define instruction response contract | `src/instruction.ts`（类型+Guidance 构造器）、`src/response.ts`（`ok()` 支持 Guidance/向后兼容 string tip、`err()` 自动生成 REQUEST_REJECTED）、`src/__tests__/instruction.test.ts`（15 个契约测试） |
| 2 | `ad17eb7` feat: select tip and instruction from one state scenario | `src/tip.ts`（`selectTip`→`selectGuidance`、`buildTip`→`buildGuidance`、每个分支产出 instruction）、`src/__tests__/instruction-scenarios.test.ts`（14 个场景测试） |
| 3 | `564f063` feat: expose instruction for registration and waiting flows | `register.ts`、`confirm-task.ts`、`get-state.ts`、`wait-for-turn.ts` 全部迁移到 Guidance |
| 4 | `9123f0b` feat: expose instruction for advance and submit | `advance.ts`（7 个 renderTip→guidance）、`submit.ts`（`buildSubmissionSuccessTip`→`buildSubmissionSuccessGuidance`） |
| 5 | `737af87` docs: specify structured instruction protocol | 模板独立性测试、契约矩阵不变量、`docs/design.md` §10.5 |

## 自审

### 契约一致性

- ✅ `next_action` 8 值封闭枚举（InstructionAction）
- ✅ `PairFlowTool` 5 值封闭枚举
- ✅ `InstructionReasonCode` 15 值封闭枚举（task 文档 13 个 + `CONFIRMED_NEEDS_TURN_CLAIM` + `UNSUPPORTED_WORKFLOW_STATE`）
- ✅ `produce_and_submit` 始终有 `required_output`
- ✅ `decide_convergence` 始终有 `decision` + `required_output`
- ✅ `stop` 的 `allowed_tools` 为空数组
- ✅ 所有 instruction 路径使用 POSIX 正斜杠
- ✅ commit hash 统一小写
- ✅ instruction 不包含 token 或 PID 字段

### 向后兼容

- ✅ `ok()` 同时接受 `Guidance` 对象和 `string` tip（向后兼容）
- ✅ `buildTip(state, identity)` 保留为 `buildGuidance(state, identity).tip`
- ✅ 所有既有字段（tip、reminder、phase、turn 等）保持不变
- ✅ 全部 251 个测试通过（含所有既有测试）
- ✅ `npx tsc --noEmit` 通过

### 保护规则

- ✅ `ok(data)` 删除 business data 中的 `instruction` 防止注入
- ✅ `err(extra)` 删除 extra 中的 5 个保留字段（ok/error/tip/reminder/instruction）
- ✅ `ok()`/`err()` 不修改调用方传入的对象

### 单一场景选择

- ✅ `selectGuidance(state, identity)` 每个分支同时返回 template key、variables 和 instruction
- ✅ `buildGuidance()` 是统一入口，`buildTip()` 仅作为兼容包装
- ✅ 模板独立性测试验证：改模板文案 → tip 变化、instruction 不变
- ✅ 无 handler 直接调用 `renderTip()` 再单独构造 instruction

### 覆盖场景

- ✅ register → confirm_task + REGISTERED_NEEDS_CONFIRMATION
- ✅ confirm_task → wait_for_turn + CONFIRMED_NEEDS_TURN_CLAIM / ROSTER_INCOMPLETE
- ✅ idle Supervisor → advance + TURN_READY
- ✅ idle 非 Supervisor → wait_for_turn + WAITING_FOR_TURN
- ✅ 持有 turn 产出 → produce_and_submit + TURN_READY
- ✅ Supervisor 收敛 → decide_convergence + PHASE_READY_FOR_CONVERGENCE_DECISION
- ✅ 非最终 advance → wait_for_turn + PHASE_ADVANCED
- ✅ 最终 advance → stop + WORKFLOW_COMPLETED
- ✅ submit → wait_for_turn + SUBMISSION_ACCEPTED
- ✅ 等待对方 → wait_for_turn + WAITING_FOR_TURN
- ✅ 600s 超时 → wait_for_turn + WAIT_TIMEOUT
- ✅ stale warning → report_user + PARTICIPANT_CONFIRMATION_STALE / TURN_UNCLAIMED_STALE
- ✅ 业务拒绝 → fix_request + REQUEST_REJECTED
- ✅ get_state 与 wait_for_turn 对同一 state 返回相同 instruction
- ✅ ping / who_am_i 不包含 instruction

## 与验收标准对照（任务文档 §12）

| # | 标准 | 状态 |
|---|------|------|
| 1 | 所有当前带 tip 的 MCP 业务响应都返回 instruction | ✅ |
| 2 | ping、正常无行动的 who_am_i 和 HTTP 层响应保持现状 | ✅ |
| 3 | 新客户端只读取 instruction 即可确定下一动作、允许工具、必要输入和产物路径 | ✅ |
| 4 | Supervisor 收敛决策完整表达两个合法分支 | ✅ |
| 5 | tip 模板任意合法改写后 instruction 结构和值不受影响 | ✅（模板独立性测试） |
| 6 | 现有测试全部通过，新增场景/契约/一致性测试通过 | ✅（251 tests） |
| 7 | npx tsc --noEmit 与 npx vitest run 通过 | ✅ |
| 8 | docs/design.md 工具出参、响应契约和 tip/instruction 权威边界同步更新 | ✅（§9 + §10.5） |
| 9 | 不引入客户端、heartbeat、wait 参数、Git 命令执行或新的模板语法 | ✅ |

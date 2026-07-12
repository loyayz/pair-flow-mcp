# Structured Action Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 计划提出人：codex（supervisor）

**Goal:** 为所有当前带 `tip` 的 PairFlow MCP 业务响应增加稳定、机器可读且与 tip 同源的 `instruction`，同时保持全部既有响应和状态机行为兼容。

**Architecture:** 新建 `src/instruction.ts` 承载封闭契约与小型构造器；将 `tip.ts` 的状态分支提升为返回 `{ tip, instruction }` 的唯一 `Guidance` 场景选择。各 handler 的特殊场景也必须先构造同一个 `Guidance` 对象，再交给 `ok()`，禁止分别拼 tip 和 instruction。`response.ts` 负责保留字段保护；它只在收到 guidance 时输出 instruction，`err()` 统一生成 `REQUEST_REJECTED`。

**Tech Stack:** Node.js ≥20.19、TypeScript 7 strict/NodeNext、`@modelcontextprotocol/sdk`、Vitest 4、现有 tip template 与内存状态 helpers。

## Global Constraints

- `docs/design.md` 是唯一权威来源；实现必须同步更新其工具出参与 §10 响应契约。
- 纯增量：不删除/重命名既有字段，不改变工具入参、phase、模板键或模板默认文字。
- 有 tip 才有 instruction；`ping`、正常 `who_am_i`、HTTP/MCP 协议层错误不增加 instruction。
- instruction 与 tip 必须由同一个场景选择结果生成；禁止解析渲染后的 tip。
- 所有 instruction 路径使用 POSIX `/`；不得新增 token、PID 或非必要内部路径。
- `confirm_task` 成功后的 `next_action` 固定为 `wait_for_turn`；idle Supervisor 才是确定性 `advance`。
- 未知未来 reason code 时客户端安全失败/提示升级，不得回退解析 tip。
- 先写失败测试，再写最小实现；每个任务形成独立可审阅提交。

## File Structure

- Create `src/instruction.ts`：instruction 枚举、接口、`Guidance`/`guidance()` 构造器、路径与契约不变量。
- Modify `src/response.ts`：`ok(data, guidance?)` 输出同源 tip/instruction，保护 instruction；`err()` 统一拒绝 guidance。
- Modify `src/tip.ts`：将 `selectTip` 提升为 `selectGuidance`，导出 `buildGuidance`；保留 `buildTip` 兼容包装。
- Modify `src/tools/{register,confirm-task,get-state,wait-for-turn,advance,submit}.ts`：把直接 `renderTip()` 响应迁移为 guidance 场景。
- Create `src/__tests__/instruction.test.ts`：类型/运行时不变量、路径和响应封装契约。
- Create `src/__tests__/instruction-scenarios.test.ts`：状态型 action/context/output/reference/decision 场景表。
- Modify `src/__tests__/{response,state-machine,tools,wait-for-turn,tip-template}.test.ts`：handler 矩阵、超时/warning/completed、一致性与模板改写。
- Modify `docs/design.md`：工具出参、instruction 契约、reason code、tip/instruction 权威边界。

---

### Task 1: Instruction contract and protected response envelope

**Files:**
- Create: `src/instruction.ts`
- Create: `src/__tests__/instruction.test.ts`
- Modify: `src/response.ts`
- Modify: `src/__tests__/response.test.ts`

**Interfaces:**
- Produces: `PairFlowInstruction`, `InstructionReasonCode`, `Guidance`, `guidance(key, variables, instruction)` and `ok(data, guidance?)`.
- Consumes: existing `TemplateKey` and `renderTip()`.

- [ ] **Step 1: Add failing response-contract tests**

Add tests that construct a valid guidance and assert: tip and instruction appear together; `ok()` data cannot override `ok/error/tip/reminder/instruction`; `err()` extra cannot override those fields; `ok()` without guidance omits both tip and instruction; input objects remain unchanged.

```ts
const turnReady = guidance("requirements.r1", {
  task_path: "C:/repo/task.md", file_path: "C:/repo/handoff/w/requirements/r1_ai.md",
  identity_label: "ai（reviewer）", round: "1", phase_label: "需求分析",
}, {
  next_action: "produce_and_submit",
  allowed_tools: ["submit"],
  reason_code: "TURN_READY",
  required_output: {
    file_path: "C:/repo/handoff/w/requirements/r1_ai.md",
    commit_required: true,
    submit_tool: "submit",
  },
});
expect(payload(ok({ instruction: { forged: true } }, turnReady)).instruction)
  .toEqual(turnReady.instruction);
expect(payload(err("bad", { instruction: { forged: true } })).instruction)
  .toMatchObject({ next_action: "fix_request", reason_code: "REQUEST_REJECTED" });
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run src/__tests__/instruction.test.ts src/__tests__/response.test.ts`
Expected: FAIL because `instruction.ts`, `guidance()` and the new `ok()` signature do not exist.

- [ ] **Step 3: Implement the closed contract and guidance constructor**

Define the exact unions from the task spec, plus the confirm-specific reason needed to avoid false `TURN_READY`:

```ts
export type InstructionAction = "confirm_task" | "wait_for_turn" | "produce_and_submit"
  | "decide_convergence" | "advance" | "report_user" | "fix_request" | "stop";
export type PairFlowTool = "confirm_task" | "wait_for_turn" | "submit" | "advance" | "get_state";
export type InstructionReasonCode = "REGISTERED_NEEDS_CONFIRMATION" | "WORKFLOW_UNBOUND"
  | "ROSTER_INCOMPLETE" | "CONFIRMED_NEEDS_TURN_CLAIM" | "WAITING_FOR_TURN"
  | "TURN_READY" | "PHASE_READY_FOR_CONVERGENCE_DECISION" | "WAIT_TIMEOUT"
  | "PARTICIPANT_CONFIRMATION_STALE" | "TURN_UNCLAIMED_STALE"
  | "SUBMISSION_ACCEPTED" | "PHASE_ADVANCED" | "WORKFLOW_COMPLETED"
  | "UNSUPPORTED_WORKFLOW_STATE" | "REQUEST_REJECTED";
export interface Guidance {
  tip: string;
  instruction: PairFlowInstruction;
}
export function guidance(key: TemplateKey, variables: Record<string, string | number>, instruction: PairFlowInstruction): Guidance {
  return { tip: renderTip(key, variables), instruction };
}
```

Implement all interfaces exactly as §5.1, including `InstructionReference`, `RequiredOutput`, `InstructionContext`, and `decision`. Keep these plain serializable types; do not add Zod or a dependency. `CONFIRMED_NEEDS_TURN_CLAIM` exists because successful confirm must still enter the first wait even when turn is already assigned; `UNSUPPORTED_WORKFLOW_STATE` exists because the successful `state.unknown` tip cannot honestly use `REQUEST_REJECTED`.

Every direct handler calling `guidance()` must source paths and context from the same existing helpers/state used for the template variables (`outFile()`, `workflowArchivePath()`, `expectedSubmissionPath()` or the just-created next state). Manual path concatenation is forbidden.

- [ ] **Step 4: Change response assembly atomically**

Change `ok()` to accept `Guidance`, delete `instruction` from a copy of business data, and spread `{ tip, instruction }` only when guidance exists. Change `err()` to delete all five protected fields from `extra`, then create a rejection guidance with `allowed_tools: []` and `REQUEST_REJECTED`. Do not mutate caller objects.

- [ ] **Step 5: Run GREEN and commit**

Run: `npx vitest run src/__tests__/instruction.test.ts src/__tests__/response.test.ts`
Expected: PASS.
Commit: `git commit -m "feat: define instruction response contract"`

---

### Task 2: Single state-guidance selector

**Files:**
- Modify: `src/tip.ts`
- Create: `src/__tests__/instruction-scenarios.test.ts`
- Modify: `src/__tests__/state-machine.test.ts`

**Interfaces:**
- Consumes: `Guidance`, `guidance()`, `PairFlowState`, `outFile()`, `workflowArchivePath()`.
- Produces: `buildGuidance(state, identity): Guidance`; retains `buildTip(state, identity): string` as `buildGuidance(...).tip`.

- [ ] **Step 1: Write a table-driven RED suite for state-held turns**

Create fixtures for idle Supervisor/non-Supervisor; waiting for other turn; requirements/planning/summary round 1; implementation coding/review; Supervisor convergence. Assert exact `next_action`, ordered `allowed_tools`, reason, context and conditional sections.

```ts
expect(buildGuidance(idleSupervisor, "sup").instruction).toMatchObject({
  next_action: "advance", allowed_tools: ["advance"], reason_code: "TURN_READY",
  context: { phase: "idle", turn: "sup", holds_turn: true, can_advance: true },
});
expect(buildGuidance(convergedRequirements, "sup").instruction).toMatchObject({
  next_action: "decide_convergence", allowed_tools: ["advance", "submit"],
  reason_code: "PHASE_READY_FOR_CONVERGENCE_DECISION",
  decision: { criterion: "phase_goal_met", when_true: "advance", when_false: "produce_and_submit" },
});
```

Add an incomplete-roster idle Supervisor fixture and assert wait / `ROSTER_INCOMPLETE` / `can_advance: false`; idle Supervisor may advance only after both real participants are present.

Also assert `produce_and_submit` always has required_output, non-output actions do not; stop has no tools; all file paths reject `\\`; references contain canonical lowercase commit hashes.

The existing `state.unknown` tip branch maps to `report_user` / no tools / `UNSUPPORTED_WORKFLOW_STATE`; it must not masquerade as a rejected request.

- [ ] **Step 2: Run RED**

Run: `npx vitest run src/__tests__/instruction-scenarios.test.ts src/__tests__/state-machine.test.ts`
Expected: FAIL because `buildGuidance` is absent.

- [ ] **Step 3: Refactor selection without duplicating branches**

Rename private `TipSelection`/`selectTip` to `GuidanceSelection`/`selectGuidance`. Each existing branch must return template key, variables and instruction in the same object. `buildGuidance()` handles the current non-holder wait branch and otherwise renders the selected object once.

Context rules: include only reliable values; `workflow_id` only when non-null; `sub_phase` only for implementation; `holds_turn = state.turn === identity`; `can_advance` is true only for complete-roster idle Supervisor or converged Supervisor. For output actions use `outFile()` directly. References are built from task, planning document, previous output/review and archive paths already used by that same template branch. Omit `commit` when the corresponding submission hash is null; never emit an empty string.

- [ ] **Step 4: Preserve existing tip behavior**

Keep:

```ts
export function buildTip(state: PairFlowState, identity: string): string {
  return buildGuidance(state, identity).tip;
}
```

Run existing state-machine/tip tests to prove every default tip remains byte-for-byte compatible.

- [ ] **Step 5: Run GREEN and commit**

Run: `npx vitest run src/__tests__/instruction-scenarios.test.ts src/__tests__/state-machine.test.ts src/__tests__/tip-template.test.ts`
Expected: PASS.
Commit: `git commit -m "feat: select tip and instruction from one state scenario"`

---

### Task 3: Registration, confirmation, state and wait guidance

**Files:**
- Modify: `src/tools/register.ts`
- Modify: `src/tools/confirm-task.ts`
- Modify: `src/tools/get-state.ts`
- Modify: `src/tools/wait-for-turn.ts`
- Modify: `src/__tests__/tools.test.ts`
- Modify: `src/__tests__/wait-for-turn.test.ts`

**Interfaces:**
- Consumes: `guidance()`, `buildGuidance()`, new `ok()`.
- Produces: instruction on every tip-bearing response for these four tools.

- [ ] **Step 1: Add handler-level failing assertions**

Extend existing integration fixtures to assert:

- register success → `confirm_task` / `["confirm_task"]` / `REGISTERED_NEEDS_CONFIRMATION`, with no context or token inside instruction;
- confirm created/recovered with incomplete roster → wait / `ROSTER_INCOMPLETE`;
- confirm joined/existing with complete roster → wait / `CONFIRMED_NEEDS_TURN_CLAIM`, even if caller already owns turn;
- get_state unbound/inactive/recovery/roster and state-ready branches;
- wait turn-ready matches get_state for the same state;
- ordinary 600s timeouts → wait / `WAIT_TIMEOUT`;
- 30-minute roster and unclaimed-turn warnings → report / matching stale code;
- completed wait → stop / `WORKFLOW_COMPLETED`.

Confirm that register's missing/invalid identity paths already pass through the Task 1 `err()` wrapper and therefore receive fix_request / `REQUEST_REJECTED`. Both get-state unbound (valid token with no workflow binding) and inactive (binding no longer points at an active participant) use confirm_task / `WORKFLOW_UNBOUND` because the recovery action is identical.

- [ ] **Step 2: Run RED**

Run: `npx vitest run src/__tests__/tools.test.ts src/__tests__/wait-for-turn.test.ts`
Expected: FAIL on missing instruction fields.

- [ ] **Step 3: Migrate each direct template response to one guidance object**

Replace calls shaped as `ok(data, renderTip(key, vars))` with `ok(data, guidance(key, vars, instruction))`. For current state-ready paths use `ok(data, buildGuidance(state, identity))`; never call `buildTip()` and construct instruction separately.

Use `CONFIRMED_NEEDS_TURN_CLAIM` only for successful confirm with complete roster. Recovery/roster pending use `ROSTER_INCOMPLETE`. `get-state.inactive` remains `WORKFLOW_UNBOUND`. Warning guidance has no required_output and `allowed_tools: []`, because the immediate action is to report to the user.

- [ ] **Step 4: Add get_state/wait semantic equality test**

For the same fixture and identity, compare the full `instruction` returned by immediate `wait_for_turn` with `get_state`; allow differences only in dedicated timeout/warning/completed scenarios.

- [ ] **Step 5: Run GREEN and commit**

Run: `npx vitest run src/__tests__/tools.test.ts src/__tests__/wait-for-turn.test.ts src/__tests__/confirm-task-lifecycle.test.ts`
Expected: PASS.
Commit: `git commit -m "feat: expose instruction for registration and waiting flows"`

---

### Task 4: Advance and submit guidance

**Files:**
- Modify: `src/tools/advance.ts`
- Modify: `src/tools/submit.ts`
- Modify: `src/__tests__/advance.test.ts`
- Modify: `src/__tests__/submit-round-order.test.ts`
- Modify: `src/__tests__/tools.test.ts`

**Interfaces:**
- Consumes: `guidance()`, state/path helpers and `buildGuidance()` semantics.
- Produces: `PHASE_ADVANCED`, `WORKFLOW_COMPLETED`, `SUBMISSION_ACCEPTED` guidance with exact next-turn context.

- [ ] **Step 1: Add failing transition and submit matrices**

Cover every advance template key: requirements other, planning self/other, implementation self/other, summary self, completed. Assert phase/sub_phase/turn/holds_turn and references/output paths. Cover all submit success templates: ordinary wait, both submitted but other holds turn, advance-ready Supervisor, exact replay.

Expected mappings:

```ts
// every non-final advance first obtains the authoritative turn guidance
{ next_action: "wait_for_turn", allowed_tools: ["wait_for_turn"], reason_code: "PHASE_ADVANCED" }
// submit success (all variants)
{ next_action: "wait_for_turn", allowed_tools: ["wait_for_turn"], reason_code: "SUBMISSION_ACCEPTED" }
// final advance
{ next_action: "stop", allowed_tools: [], reason_code: "WORKFLOW_COMPLETED" }
```

For submit advance-ready, the response belongs to the submitter whose turn has already moved; it remains wait. The Supervisor later receives `decide_convergence` through wait/get_state. This avoids telling the old caller to advance out of turn.

- [ ] **Step 2: Run RED**

Run: `npx vitest run src/__tests__/advance.test.ts src/__tests__/submit-round-order.test.ts src/__tests__/tools.test.ts`
Expected: FAIL on missing instructions.

- [ ] **Step 3: Replace advance direct rendering with guidance**

Create a local helper accepting template key, variables, next state and caller identity, so tip and instruction share the same selected branch. Every non-final advance returns `wait_for_turn`, matching the existing tip's requirement to obtain the complete new-turn guidance. Do not place the just-computed future output path in `references`: it does not yet exist and is not an input the caller must read. The subsequent wait/get_state response supplies the real `required_output` and readable references. Never parse the tip. Completed guidance has archive reference only if required by the contract and exposes no PID.

- [ ] **Step 4: Replace submit success-tip helper with success-guidance helper**

Rename `buildSubmissionSuccessTip` to `buildSubmissionSuccessGuidance` and return `Guidance`. Select `submit.advance-ready`, `submit.both-submitted` or `submit.wait` once, then attach `SUBMISSION_ACCEPTED` and next-state context. Exact replay must reuse the same helper and deep-equal every instruction field from the first successful submit without advancing again.

- [ ] **Step 5: Run GREEN and commit**

Run: `npx vitest run src/__tests__/advance.test.ts src/__tests__/submit-round-order.test.ts src/__tests__/submit-atomicity.test.ts src/__tests__/tools.test.ts`
Expected: PASS.
Commit: `git commit -m "feat: expose instruction for advance and submit"`

---

### Task 5: Cross-handler contract matrix, template independence and design documentation

**Files:**
- Modify: `src/__tests__/instruction.test.ts`
- Modify: `src/__tests__/instruction-scenarios.test.ts`
- Modify: `src/__tests__/tip-template.test.ts`
- Modify: `docs/design.md`

**Interfaces:**
- Consumes: all instruction-producing handlers.
- Produces: complete acceptance evidence and authoritative documentation.

- [ ] **Step 1: Add the final contract matrix**

Build a table of every current tip-bearing business branch and assert a legal instruction. Add generic invariants: actions/tools/reasons are closed values; `produce_and_submit` has required_output; `decide_convergence` has decision plus output; stop has no tools; every path uses `/`; commit references are lowercase; no instruction contains `token` or PID fields; ping and both normal who_am_i forms omit instruction.

- [ ] **Step 2: Prove template customization cannot alter instruction**

In the existing temporary template-root test, render the same state before and after rewriting the action, output and current sections, including one full valid replacement template. Assert `tip` changes while required_output, context and the entire instruction deep-equal their prior values. Do this for one output scenario and one wait scenario.

- [ ] **Step 3: Update the authoritative design**

In `docs/design.md`:

- extend §9 tool outputs for register/confirm/advance/get_state/wait/submit with optional instruction;
- extend §10 with the exact TypeScript-shaped contract, all 15 reason codes (including `CONFIRMED_NEEDS_TURN_CLAIM` and `UNSUPPORTED_WORKFLOW_STATE`), field conditionality and protected-field rule;
- state instruction is the machine authority and tip is natural-language thinking guidance;
- document idle Supervisor advance, confirm-first-wait, Supervisor convergence dual branch, timeout vs stale warning, completed stop and unknown-code safe behavior;
- keep HTTP/MCP protocol errors, ping and normal who_am_i exclusions explicit.

- [ ] **Step 4: Run self-review checks required by writing-plans**

Run:

```powershell
rg -n "T[B]D|T[O]DO|implement la[t]er|fill in deta[i]ls|similar t[o]" handoff/20260712140521/planning/r1_codex.md
rg -n "instruction|CONFIRMED_NEEDS_TURN_CLAIM|decide_convergence" docs/design.md src
```

Expected: first command has no plan placeholders; second shows matching type names across code, tests and docs. Manually map every task-spec §4/§11/§12 item to a test above and add any missing case before committing.

Create a nine-row acceptance trace for task-document §12, naming the exact test/command that proves each criterion; use `N/A` only with a written reason. This trace belongs in the test description or final implementation handoff, not in runtime code.

- [ ] **Step 5: Run full verification**

Run:

```powershell
npx tsc --noEmit
npx vitest run
git diff --check
```

Expected: TypeScript exits 0; all Vitest suites pass; diff check prints nothing.

- [ ] **Step 6: Commit the acceptance layer**

Commit: `git commit -m "docs: specify structured instruction protocol"`

## Execution Handoff

本计划由 PairFlow 流程继续执行，不向用户另行选择执行模式。实现回合应按服务端 turn 分配：Developer 使用 `superpowers:test-driven-development` 按任务顺序实施，Reviewer 对每一轮提交核对本计划、任务文档和测试证据；实现全部通过后由 Supervisor 决定是否 advance。

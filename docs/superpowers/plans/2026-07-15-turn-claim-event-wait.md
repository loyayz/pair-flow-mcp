# Turn Claim and Event-Driven Wait Implementation Plan

> **For Codex:** Execute this plan in order with TDD. Keep `docs/design.md` authoritative; do not preserve behavior that conflicts with §§5.3–5.4, §9, or §12.

**Goal:** Restore explicit `claim_turn`, make `wait_for_turn` event-driven with repeating warning cycles, and return all MCP POST results as JSON rather than SSE.

**Architecture:** Persist only workflow truth (`turn_*` timestamps plus one `wait_warning_cycle`) in `PairFlowState`. Keep process-local coordination in a dedicated workflow event module that exposes monotonically increasing versions and abortable one-shot waiters. Every waiting decision is made under the workflow mutex from live state; events only wake the loop to re-read state. `claim_turn` becomes the sole assigned-to-claimed transition.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `async-mutex`, Zod, Vitest fake timers, Node HTTP client tests.

---

## Task 1: Extend the persisted state and protocol contract

**Files:**

- Modify: `src/state.ts`
- Modify: `src/instruction-protocol.ts`
- Modify: `src/instruction.ts`
- Modify: `src/tool-output.ts`
- Modify: `src/__tests__/instruction.test.ts`
- Modify: `src/__tests__/instruction-protocol.test.ts`
- Modify: `src/__tests__/instruction-scenarios.test.ts`
- Modify: `src/__tests__/tool-output-schema.test.ts`

- [x] Add failing tests for protocol `1.1`, action/tool `claim_turn`, reason `TURN_ASSIGNED`, the warning continuation decision, `json_response_v1`, and a top-level `claim_turn` output schema.
- [x] Add `WaitWarningCycle` and `wait_warning_cycle` to `PairFlowState`; initialize and phase-reset it to `null`.
- [x] Extend the catalog schemas from one authority. The decision must be a union of convergence and warning branches:

```ts
z.discriminatedUnion("criterion", [
  z.object({ criterion: z.literal("phase_goal_met"), when_true: z.literal("advance"), when_false: z.literal("produce_and_submit") }),
  z.object({ criterion: z.literal("user_wants_to_continue_waiting"), when_true: z.literal("wait_for_turn"), when_false: z.literal("stop") }),
])
```

- [x] Update catalog relationship validation so a decision is required exactly for convergence and stale-warning instructions.
- [x] Derive initialization/health catalogs and schemas from the updated catalog; add `json_response_v1` and bump `INSTRUCTION_PROTOCOL_VERSION` to `1.1`.
- [x] Run focused protocol/schema tests:

```powershell
npx vitest run src/__tests__/instruction.test.ts src/__tests__/instruction-protocol.test.ts src/__tests__/instruction-scenarios.test.ts src/__tests__/tool-output-schema.test.ts
```

## Task 2: Add workflow event coordination

**Files:**

- Create: `src/workflow-events.ts`
- Create: `src/__tests__/workflow-events.test.ts`
- Modify: `src/state.ts`

- [x] Write failing tests for version increments, registration/recheck without missed wakeups, abort cleanup, publish-before-delete termination, and coordinator deletion after the final waiter releases.
- [x] Implement a per-workflow coordinator with:

```ts
getWorkflowVersion(workflowId): number
waitForWorkflowChange(workflowId, observedVersion, signal): Promise<void>
publishWorkflowChange(workflowId, options?): void
```

- [x] Ensure waiter registration rechecks the version synchronously, and every resolve/reject path removes listeners and waiter entries.
- [x] Change workflow deletion to publish termination before removing state/mutex, while retaining coordinator data until all waiters release.
- [x] Run:

```powershell
npx vitest run src/__tests__/workflow-events.test.ts src/__tests__/state-machine.test.ts
```

## Task 3: Make turn assignment and reminders explicit state transitions

**Files:**

- Modify: `src/tools/confirm-task.ts`
- Modify: `src/tools/advance.ts`
- Modify: `src/tools/submit.ts`
- Modify: `src/crash-recovery.ts`
- Modify: `src/__tests__/confirm-task-lifecycle.test.ts`
- Modify: `src/__tests__/advance.test.ts`
- Modify: `src/__tests__/submit-round-order.test.ts`
- Modify: `src/__tests__/crash-recovery.test.ts`

- [x] Add failing assertions that every new turn has `turn_claimed_at === null` even when assigned to the caller.
- [x] Add failing assertions for roster and turn warning-cycle creation/replacement, including recovery receiving a fresh 30-minute turn window when the roster becomes real.
- [x] Introduce small helpers for `now + 30 minutes`, roster-cycle initialization, and turn-cycle initialization; increment generation from the previous cycle when replacing it.
- [x] Publish workflow changes only after successful confirm, submit, advance, and termination commits.
- [x] Preserve exact replay/idempotency paths without resetting timestamps or warning generations.
- [x] Run:

```powershell
npx vitest run src/__tests__/confirm-task-lifecycle.test.ts src/__tests__/confirm-task-mutex.test.ts src/__tests__/advance.test.ts src/__tests__/submit-round-order.test.ts src/__tests__/submit-atomicity.test.ts src/__tests__/crash-recovery.test.ts
```

## Task 4: Restore the no-argument `claim_turn` tool

**Files:**

- Create: `src/tools/claim-turn.ts`
- Create: `src/__tests__/claim-turn.test.ts`
- Modify: `src/index.ts`
- Modify: `src/tip.ts`
- Modify: `src/__tests__/tools.test.ts`
- Modify: `src/__tests__/instruction-scenarios.test.ts`

- [x] Write failing tests for first claim, idempotent retry preserving the first timestamp, wrong holder, stale turn, cancellation before the mutex linearization point, and cancellation after persistence without rollback.
- [x] Change `buildGuidance`/`get_state` behavior so an assigned holder receives only:

```ts
{ next_action: "claim_turn", allowed_tools: ["claim_turn"], reason_code: "TURN_ASSIGNED" }
```

- [x] Implement `claimTurn(extra)` with all authorization and turn checks repeated inside the workflow mutex. Check cancellation before persistence; after setting `turn_claimed_at`, publish a change and do not roll it back.
- [x] On an already-claimed current turn, return the same full `buildGuidance` without rewriting `turn_claimed_at`.
- [x] Register the no-input tool and output schema in `src/index.ts`.
- [x] Run:

```powershell
npx vitest run src/__tests__/claim-turn.test.ts src/__tests__/tools.test.ts src/__tests__/instruction-scenarios.test.ts src/__tests__/instruction.test.ts
```

## Task 5: Replace polling with event-driven `wait_for_turn`

**Files:**

- Rewrite: `src/tools/wait-for-turn.ts`
- Rewrite/extend: `src/__tests__/wait-for-turn.test.ts`

- [x] Replace polling-specific tests with fake-timer tests for immediate `TURN_ASSIGNED`, already-claimed guidance, event wakeup, exact `now >= deadline`, 600-second timeout, and no polling timer.
- [x] Add warning-cycle tests: one report per generation, no duplicate before acknowledgment, same-identity next call implicitly acknowledges, another identity does not, acknowledgment restarts at `now + 30m`, and cancellation before/after acknowledgment linearization.
- [x] Keep latest-wins scoped to `(workflowId, identity)` and test that superseded waits reject while other identities/workflows continue.
- [x] Implement each loop iteration under the workflow mutex:

```ts
type WaitDecision =
  | { kind: "return"; result: CallToolResult }
  | { kind: "wait"; version: number; deadlineAt?: number };
```

- [x] Before evaluating normal wait conditions, acknowledge a reported cycle only when `reported_to === identity`; publish after the mutex commit.
- [x] For waiting, race only the workflow event, warning deadline, request timeout, and combined cancellation signal. A deadline timer exists only for the active request and is cleared in `finally`.
- [x] `wait_for_turn` must never write `turn_claimed_at`; assigned holders get claim guidance, claimed holders get full guidance.
- [x] Run:

```powershell
npx vitest run src/__tests__/wait-for-turn.test.ts src/__tests__/claim-turn.test.ts
```

## Task 6: Switch Streamable HTTP to JSON response mode

**Files:**

- Modify: `src/index.ts`
- Modify: `src/__tests__/client-transport.test.ts`
- Modify: `src/__tests__/http-server-policy.test.ts`
- Modify: `src/__tests__/tools.test.ts`

- [x] Add failing raw HTTP assertions that every MCP POST receives `content-type: application/json`, never `text/event-stream`, including a delayed `wait_for_turn` response.
- [x] Construct `StreamableHTTPServerTransport` with `enableJsonResponse: true` while keeping stateless sessions.
- [x] Verify the standard SDK client remains compatible with delayed JSON responses.
- [x] Run:

```powershell
npx vitest run src/__tests__/client-transport.test.ts src/__tests__/http-server-policy.test.ts src/__tests__/tools.test.ts src/__tests__/transport-lifecycle.test.ts
```

## Task 7: Update cold-start evaluation and protocol discovery

**Files:**

- Modify: `src/__tests__/cold-start-eval.test.ts`
- Modify: `scripts/run-cold-start-eval.ts`
- Modify: any protocol snapshot assertions discovered by focused tests

- [x] Add failing preflight tests requiring `json_response_v1`, empty required input for `wait_for_turn` and `claim_turn`, and a listed `claim_turn` tool.
- [x] Require raw JSON-RPC parsing and reject SSE content types.
- [x] Extend real scenarios to `wait_for_turn -> claim_turn -> produce_and_submit/advance`; keep normal tip hidden.
- [x] Extend stale synthetic scenarios with the structured user-continuation decision and verify no automatic retry after `report_user`.
- [x] Run:

```powershell
npx vitest run src/__tests__/cold-start-eval.test.ts
npx tsc --noEmit
```

## Task 8: Full regression, review, and delivery

**Files:**

- Modify: `docs/feature/turn-claim-event-wait.md`
- Modify: only files required by review findings

- [x] Run all tests and build:

```powershell
npm test
npm run build
git diff --check
```

- [x] Request an independent code review against `docs/design.md`, especially mutex linearization, missed wakeups, cleanup, cancellation, warning generations, schema derivation, and JSON transport.
- [x] Reproduce and fix every valid review finding with focused regression tests.
- [x] Re-run the complete verification commands and record evidence in the lifecycle document.
- [x] Commit the implementation with a scoped message after the worktree is clean except for intended files.

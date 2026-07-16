# Delivery Manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist phase acceptance facts and expose a crash-safe, machine-readable final delivery manifest without reading artifact contents or executing external commands.

**Architecture:** Extract validated archive-submission discovery from crash recovery, then build a versioned manifest service with pure phase-selection logic and atomic sidecar I/O. Cache the active draft manifest in `PairFlowState` so synchronous instruction generation can use accepted references. A completed manifest write is the terminal linearization point; workflow cleanup follows and may report a warning without rolling completion back.

**Tech Stack:** Node.js, TypeScript, Zod, `@modelcontextprotocol/sdk`, `async-mutex`, atomic JSON sidecars, Vitest.

## Global Constraints

- `docs/design.md` is the sole implementation authority and must be updated before runtime code.
- PairFlow must not execute Git, tests, builds, static analysis, or any other external command at runtime.
- Commit hashes are caller-declared lowercase values and are never verified by PairFlow.
- `delivery-manifest.json` is a runtime sidecar under the workflow archive root and is not required to be committed.
- All manifest paths use POSIX separators and must stay inside the symlink/junction-free archive boundary.
- Skipped phases are omitted; they are not represented by `null` placeholders.
- `advanced_by` records only the Supervisor who invoked `advance`; it does not mean both participants approved.
- Completed is monotonic and cannot be rolled back because `.pid` cleanup failed.
- Preserve all existing explicit `wait_for_turn -> claim_turn` behavior.
- Preserve unrelated dirty-worktree changes, especially Task 04 and Task 06 cancellation edits.
- TDD is not mandatory. Implementation and automated coverage may be written together or in either order; a task is complete only when its focused tests pass.

---

### Task 1: Synchronize the authoritative design contract

**Files:**

- Modify: `docs/design.md`
- Modify: `docs/task/05-authoritative-artifacts-delivery-manifest.md` only if implementation planning reveals a wording mismatch
- Modify: `docs/superpowers/plans/2026-07-16-delivery-manifest.md` only to check off executed steps

**Interfaces:**

- Consumes: the approved Task 05 contract.
- Produces: normative manifest, advance, completion, recovery, references, sidecar, and output-schema rules used by every later task.

- [x] **Step 1: Add the persistent archive shape and state cache to the design**

Document the workflow-root sidecar and live cache exactly as follows:

```text
handoff/{workflow_id}/delivery-manifest.json
PairFlowState.delivery_manifest: DeliveryManifest | null
```

State that phase initialization preserves `delivery_manifest`, while a new workflow initializes it to `null`.

- [x] **Step 2: Add the manifest v1 schema and phase-selection rules**

Specify the exact top-level fields, phase records, `acceptance_commit` semantics, requirements/development omission rules, and summary selection rule from Task 05. Explicitly distinguish canonical documents from submissions.

- [x] **Step 3: Replace the current SUMMARY cleanup linearization contract**

Specify this order:

```text
1. Validate and atomically write status=completed manifest.
2. Treat that rename as logical workflow completion.
3. Publish the completion snapshot and unbind/delete live workflow state.
4. Attempt .pid cleanup.
5. Return ok=true; include cleanup_pending/error when cleanup failed.
```

Also specify that completed-manifest recovery never recreates active SUMMARY.

- [x] **Step 4: Update tool tables, instruction references, recovery, protocol discovery, and phase initialization sections**

Add `delivery_manifest_v1` to health capabilities. Require `advance` and terminal `wait_for_turn` success payloads to include the completion fields. Define draft-manifest recovery when the next phase has no submission yet.

- [x] **Step 5: Verify the design contains no old contradictory completion rule**

Run:

```powershell
rg -n "delivery-manifest|cleanup_pending|failed to delete pid|SUMMARY.*IDLE|last_submission_by_participant" docs/design.md
git diff --check
```

Expected: manifest and cleanup semantics are present; no rule says PID deletion failure keeps a completed workflow active; `git diff --check` exits 0.

- [ ] **Step 6: Commit the design contract**

```powershell
git add docs/design.md docs/task/05-authoritative-artifacts-delivery-manifest.md docs/superpowers/plans/2026-07-16-delivery-manifest.md
git commit -m "docs: define delivery manifest contract"
```

### Task 2: Extract reusable validated archive submissions

**Files:**

- Create: `src/archive-submissions.ts`
- Create: `src/__tests__/archive-submissions.test.ts`
- Modify: `src/crash-recovery.ts`
- Modify: `src/__tests__/crash-recovery.test.ts`

**Interfaces:**

- Consumes: existing filename, metadata, path, and regular-file validation from `src/crash-recovery.ts`.
- Produces:

```ts
export type RecoverablePhase = Exclude<Phase, "idle">;
export interface ValidatedSubmission {
  phase: RecoverablePhase;
  round: number;
  sub_phase: SubPhase;
  identity: string;
  meta: SubmissionMeta;
  meta_path: string;
  file_path: string;
}
export async function collectValidatedSubmissions(
  workDir: string,
  workflowId: string,
): Promise<ValidatedSubmission[]>;
export function latestSubmission(
  submissions: readonly ValidatedSubmission[],
  predicate?: (submission: ValidatedSubmission) => boolean,
): ValidatedSubmission | null;
```

- [ ] **Step 1: Add archive-catalog coverage**

Cover valid records, malformed metadata, missing/empty/link artifacts, wrong phase/sub-phase filenames, duplicate rounds, and numeric round ordering. Assert returned `file_path` is the `.md` path with POSIX separators.

```ts
const submissions = await collectValidatedSubmissions(TEST_ROOT, workflowId);
expect(submissions.map(({ phase, round, identity, file_path }) => ({ phase, round, identity, file_path }))).toEqual([
  {
    phase: "requirements",
    round: 2,
    identity: "bob",
    file_path: `${posixRoot}/handoff/${workflowId}/requirements/r2_bob.md`,
  },
]);
```

- [ ] **Step 2: Run focused verification after the extraction is implemented**

```powershell
npx vitest run src/__tests__/archive-submissions.test.ts
```

Expected: PASS after Steps 3–4 are complete. A pre-implementation failure run is optional.

- [ ] **Step 3: Move archive parsing and validation behind the exported catalog**

Use these public types and deterministic helper:

```ts
export interface SubmissionMeta {
  submitted_at: string;
  commit_hash: string;
  sub_phase: SubPhase;
  task: {
    spec_file: string;
    task_type: "requirements" | "development";
  };
}

export function latestSubmission(
  submissions: readonly ValidatedSubmission[],
  predicate: (submission: ValidatedSubmission) => boolean = () => true,
): ValidatedSubmission | null {
  return submissions
    .filter(predicate)
    .reduce<ValidatedSubmission | null>(
      (latest, current) => latest === null || current.round > latest.round ? current : latest,
      null,
    );
}
```

Keep the existing `lstat`, metadata validation, identity validation, phase directory allowlist, duplicate-round/parity consistency, and archive-root symlink rejection behavior. Do not weaken recovery validation to make manifest creation easier.

- [ ] **Step 4: Make crash recovery consume the shared catalog**

Delete the duplicate private submission interfaces and collection helpers from `crash-recovery.ts`; import `ValidatedSubmission`, `collectValidatedSubmissions`, and `latestSubmission`. Preserve `reconstructFromHandoff()` behavior at this task boundary.

- [ ] **Step 5: Run focused recovery tests**

```powershell
npx vitest run src/__tests__/archive-submissions.test.ts src/__tests__/crash-recovery.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the extraction**

```powershell
git add src/archive-submissions.ts src/crash-recovery.ts src/__tests__/archive-submissions.test.ts src/__tests__/crash-recovery.test.ts
git commit -m "refactor: share validated archive submissions"
```

### Task 3: Add the manifest schema, pure builder, and atomic store

**Files:**

- Create: `src/delivery-manifest-schema.ts`
- Create: `src/delivery-manifest.ts`
- Create: `src/__tests__/delivery-manifest.test.ts`
- Modify: `src/state.ts`
- Modify: `src/__tests__/state-machine.test.ts`

**Interfaces:**

- Consumes: `ValidatedSubmission[]`, `PairFlowState`, `atomicWriteText()`, archive/path-safety helpers.
- Produces:

```ts
export type DeliveryManifest = z.infer<typeof deliveryManifestSchema>;
export type SubmissionReference = z.infer<typeof submissionReferenceSchema>;
export interface PersistedManifest {
  manifest: DeliveryManifest;
  manifest_path: string;
}
export type WorkflowCompletionSnapshot = z.infer<typeof workflowCompletionSnapshotSchema>;
export function toCompletionSnapshot(persisted: PersistedManifest): WorkflowCompletionSnapshot;
export async function readDeliveryManifest(
  workDir: string,
  workflowId: string,
): Promise<PersistedManifest | null>;
export async function persistPhaseAcceptance(
  state: PairFlowState,
  advancedBy: string,
  acceptedAt: string,
): Promise<PersistedManifest>;
export async function persistCompletedManifest(
  state: PairFlowState,
  advancedBy: string,
  completedAt: string,
): Promise<PersistedManifest>;
```

- [ ] **Step 1: Add schema and selection coverage**

Cover strict parsing, skipped-phase omission, lowercase commit hashes, requirements/development completeness, phase-idempotency conflicts, canonical task/plan paths, implementation coding/review separation, summary r1+r2 selection, summary r4/r6 selection, and inconsistent archive failures.

```ts
const result = await persistCompletedManifest(summaryState, "alice", "2026-07-16T01:00:00.000Z");
expect(result.manifest).toMatchObject({
  manifest_version: 1,
  status: "completed",
  completed_by: "alice",
  phases: {
    summary: {
      advanced_by: "alice",
      final_summary: { round: 1, submitted_by: "alice" },
      review_submission: { round: 2, submitted_by: "bob" },
    },
  },
});
```

- [ ] **Step 2: Run focused verification after the manifest core is implemented**

```powershell
npx vitest run src/__tests__/delivery-manifest.test.ts src/__tests__/state-machine.test.ts
```

Expected: PASS after Steps 3–5 are complete. A pre-implementation failure run is optional.

- [ ] **Step 3: Define strict Zod schemas and exported types**

Implement these shapes without catch-all fields:

```ts
export const submissionReferenceSchema = z.object({
  file_path: z.string().min(1),
  submitted_by: z.string().min(1),
  round: z.number().int().positive(),
  sub_phase: z.enum(["coding", "review"]).optional(),
  commit_hash: z.string().regex(/^[0-9a-f]{7,40}$/),
  submitted_at: z.iso.datetime(),
}).strict();

export const taskCanonicalReferenceSchema = z.object({
  kind: z.literal("task"),
  file_path: z.string().min(1),
}).strict();

export const planCanonicalReferenceSchema = z.object({
  kind: z.literal("plan"),
  file_path: z.string().min(1),
}).strict();

export const canonicalReferenceSchema = z.discriminatedUnion("kind", [
  taskCanonicalReferenceSchema,
  planCanonicalReferenceSchema,
]);

const acceptanceBaseShape = {
  accepted_at: z.iso.datetime(),
  advanced_by: z.string().min(1),
  acceptance_commit: z.string().regex(/^[0-9a-f]{7,40}$/),
};

export const requirementsAcceptanceSchema = z.object({
  ...acceptanceBaseShape,
  phase: z.literal("requirements"),
  canonical_document: taskCanonicalReferenceSchema,
  latest_submission: submissionReferenceSchema,
}).strict();

export const planningAcceptanceSchema = z.object({
  ...acceptanceBaseShape,
  phase: z.literal("planning"),
  canonical_document: planCanonicalReferenceSchema,
  latest_submission: submissionReferenceSchema,
}).strict();

export const implementationAcceptanceSchema = z.object({
  ...acceptanceBaseShape,
  phase: z.literal("implementation"),
  latest_coding: submissionReferenceSchema.safeExtend({ sub_phase: z.literal("coding") }),
  latest_review: submissionReferenceSchema.safeExtend({ sub_phase: z.literal("review") }).optional(),
}).strict();

export const summaryAcceptanceSchema = z.object({
  ...acceptanceBaseShape,
  phase: z.literal("summary"),
  final_summary: submissionReferenceSchema,
  review_submission: submissionReferenceSchema.optional(),
}).strict();

export const workflowCompletionSnapshotSchema = z.object({
  manifest_path: z.string().min(1),
  archive_root: z.string().min(1),
  final_summary: submissionReferenceSchema,
}).strict();

export const deliveryManifestSchema = z.object({
  manifest_version: z.literal(1),
  status: z.enum(["in_progress", "completed"]),
  workflow_id: z.string().min(1),
  task_type: z.enum(["requirements", "development"]),
  archive_root: z.string().min(1),
  supervisor: z.string().min(1),
  phases: z.object({
    requirements: requirementsAcceptanceSchema.optional(),
    planning: planningAcceptanceSchema.optional(),
    implementation: implementationAcceptanceSchema.optional(),
    summary: summaryAcceptanceSchema.optional(),
  }).strict(),
  completed_at: z.iso.datetime().optional(),
  completed_by: z.string().min(1).optional(),
  final_summary: submissionReferenceSchema.optional(),
  commit_verification: z.literal("caller_declared_unverified"),
}).strict().superRefine(enforceManifestRelationships);
```

Define `enforceManifestRelationships` in the same module. It must require completion fields exactly when `status === "completed"`, reject planning/implementation for requirements tasks, require requirements+summary for completed requirements tasks, require all four phase records for completed development tasks, require `final_summary` to equal `phases.summary.final_summary`, and reject `sub_phase` on non-implementation references.

- [ ] **Step 4: Cache the active manifest in workflow state**

```ts
import type { DeliveryManifest } from "./delivery-manifest-schema.js";

export interface PairFlowState {
  // existing fields stay unchanged
  delivery_manifest: DeliveryManifest | null;
}

export function defaultState(): PairFlowState {
  return {
    // existing defaults stay unchanged
    delivery_manifest: null,
  };
}
```

Phase reset helpers must preserve this field through object spread.

- [ ] **Step 5: Implement pure phase-entry construction and atomic store operations**

Build references only from the validated archive catalog. Before writing, validate the workflow archive parent with `findSymbolicLinkInPath`, reject an existing non-regular/symlink manifest, serialize `deliveryManifestSchema.parse(manifest)` with a trailing newline, and call `atomicWriteText()`.

Use exactly this summary-document predicate:

```ts
const summaryDocument = latestSubmission(
  summarySubmissions,
  (submission) => submission.round === 1 || submission.round >= 3,
);
const summaryReview = latestSubmission(
  summarySubmissions,
  (submission) => submission.round === 2,
);
```

- [ ] **Step 6: Run focused tests**

```powershell
npx vitest run src/__tests__/delivery-manifest.test.ts src/__tests__/archive-submissions.test.ts src/__tests__/state-machine.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit the manifest core**

```powershell
git add src/delivery-manifest-schema.ts src/delivery-manifest.ts src/state.ts src/__tests__/delivery-manifest.test.ts src/__tests__/state-machine.test.ts
git commit -m "feat: persist phase delivery manifest"
```

### Task 4: Persist non-terminal advances and use accepted references

**Files:**

- Modify: `src/tools/advance.ts`
- Modify: `src/tip.ts`
- Modify: `src/__tests__/advance.test.ts`
- Modify: `src/__tests__/instruction-scenarios.test.ts`
- Modify: `templates/tips/summary/r1.md`
- Modify: `src/tip-template.ts`
- Modify: `src/__tests__/tip-template.test.ts`

**Interfaces:**

- Consumes: `persistPhaseAcceptance()` and `PairFlowState.delivery_manifest`.
- Produces: every non-terminal accepted phase is durably recorded before phase mutation; planning/summary instructions consume accepted manifest references.

- [ ] **Step 1: Add advance atomicity and idempotency coverage**

Test requirements→planning, requirements-mode→summary, planning→implementation, and implementation→summary. For each transition assert manifest write occurs before `setState`, failure leaves the original state/version unchanged, and the next state caches the returned manifest. Test a replayed/conflicting phase entry is rejected rather than overwritten.

```ts
expect(getState(TEST_WORKFLOW_ID)).toMatchObject({
  phase: "implementation",
  delivery_manifest: {
    status: "in_progress",
    phases: {
      planning: { advanced_by: "alice", acceptance_commit: "abcdef2" },
    },
  },
});
```

- [ ] **Step 2: Add accepted-reference coverage**

Assert implementation receives the planning canonical r1 path with `commit === planning.acceptance_commit`. Assert summary r1 receives required task, plan, latest coding, latest review, and archive references, omitting plan/coding/review for requirements tasks.

- [ ] **Step 3: Run focused verification after integration**

```powershell
npx vitest run src/__tests__/advance.test.ts src/__tests__/instruction-scenarios.test.ts src/__tests__/tip-template.test.ts
```

Expected: PASS after Steps 4–6 are complete. A pre-implementation failure run is optional.

- [ ] **Step 4: Persist before publishing each non-terminal transition**

Use this ordering inside the existing workflow mutex:

```ts
const acceptedAt = new Date().toISOString();
const { manifest } = await persistPhaseAcceptance(state, identity, acceptedAt);
const next = markTurnAssigned(
  initPlanningPhase({ ...state, delivery_manifest: manifest }, reviewer.identity),
  state.wait_warning_cycle,
);
setState(workflowId, next);
publishWorkflowChange(workflowId);
```

Use `initSummaryPhase` for accepted requirements-only/implementation phases and `initImplementationPhase` for accepted planning. Do not write a manifest for IDLE→REQUIREMENTS because no phase has been accepted yet.

- [ ] **Step 5: Replace guessed references with cached accepted records**

`planRef()` must read `state.delivery_manifest?.phases.planning`; absence in an implementation state is an internal protocol error, not a fallback to r1 with no commit. Summary r1 references must be constructed from accepted phase records and keep archive root required.

- [ ] **Step 6: Update summary template variables without making tip authoritative**

Add human-readable paths for accepted task/plan/coding/review inputs to the summary template registry, while keeping `instruction.references` as the machine authority. Requirements mode must render without fake empty planning/implementation paths.

- [ ] **Step 7: Run focused tests and typecheck**

```powershell
npx vitest run src/__tests__/advance.test.ts src/__tests__/instruction-scenarios.test.ts src/__tests__/tip-template.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit non-terminal integration**

```powershell
git add src/tools/advance.ts src/tip.ts src/tip-template.ts templates/tips/summary/r1.md src/__tests__/advance.test.ts src/__tests__/instruction-scenarios.test.ts src/__tests__/tip-template.test.ts
git commit -m "feat: use accepted phase references"
```

### Task 5: Make completed manifest the terminal linearization point

**Files:**

- Modify: `src/tools/advance.ts`
- Modify: `src/workflow-events.ts`
- Modify: `src/state.ts`
- Modify: `src/tools/wait-for-turn.ts`
- Modify: `src/tool-output.ts`
- Modify: `src/__tests__/advance.test.ts`
- Modify: `src/__tests__/workflow-events.test.ts`
- Modify: `src/__tests__/wait-for-turn.test.ts`
- Modify: `src/__tests__/tool-output-schema.test.ts`
- Modify: `templates/tips/advance/completed.md`
- Modify: `templates/tips/wait/completed.md`
- Modify: `src/tip-template.ts`

**Interfaces:**

- Consumes: `persistCompletedManifest()`.
- Produces:

```ts
export interface CompletionPayload extends WorkflowCompletionSnapshot {
  cleanup_pending?: boolean;
  cleanup_error?: string;
}

export function deleteState(
  workflowId: string,
  completion?: WorkflowCompletionSnapshot,
): void;

async function removePidAfterCompletion(taskPath: string | undefined): Promise<string | null>;
```

- [ ] **Step 1: Replace old PID-failure expectations with terminal completion coverage**

Add tests for successful completion, completed-manifest write failure, PID `ENOENT`, PID `EACCES`, response loss, and a waiting participant receiving the same completion snapshot. Assert `EACCES` returns `ok=true`, `cleanup_pending=true`, and deleted/unbound live state.

```ts
expect(payload).toMatchObject({
  ok: true,
  new_phase: "idle",
  turn: "idle",
  manifest_path: expect.stringMatching(/delivery-manifest\.json$/),
  archive_root: expect.any(String),
  final_summary: { round: 1, submitted_by: "alice" },
  cleanup_pending: true,
  cleanup_error: expect.stringContaining("EACCES"),
});
```

- [ ] **Step 2: Run focused verification after terminal integration**

```powershell
npx vitest run src/__tests__/advance.test.ts src/__tests__/workflow-events.test.ts src/__tests__/wait-for-turn.test.ts src/__tests__/tool-output-schema.test.ts
```

Expected: PASS after Steps 3–7 are complete. A pre-implementation failure run is optional.

- [ ] **Step 3: Carry completion data through termination events**

Change event waiting to return a snapshot rather than `void`:

```ts
export interface WorkflowChangeSnapshot {
  terminated: boolean;
  completion?: WorkflowCompletionSnapshot;
}

export function waitForWorkflowChange(
  workflowId: string,
  observedVersion: number,
  signal: AbortSignal,
): Promise<WorkflowChangeSnapshot>;

export function publishWorkflowChange(
  workflowId: string,
  options?: { terminated?: boolean; completion?: WorkflowCompletionSnapshot },
): void;
```

Resolve each waiter with a captured snapshot before releasing/deleting its coordinator so the last waiter cannot lose terminal data.

- [ ] **Step 4: Complete before cleanup in `advance`**

Implement this exact structure:

```ts
const completedAt = new Date().toISOString();
const persisted = await persistCompletedManifest(state, identity, completedAt);
const completion = toCompletionSnapshot(persisted);

deleteState(workflowId, completion);
unbindWorkflow(workflowId);

const cleanup = await removePidAfterCompletion(state.task?.spec_file);
return ok({
  ok: true,
  new_phase: "idle",
  turn: "idle",
  ...completion,
  ...(cleanup ? { cleanup_pending: true, cleanup_error: cleanup } : {}),
}, guidance("advance.completed", {
  identity,
  archive_root: completion.archive_root,
  manifest_path: completion.manifest_path,
  final_summary: completion.final_summary.file_path,
}, {
  next_action: "stop",
  allowed_tools: [],
  reason_code: "WORKFLOW_COMPLETED",
}));
```

Manifest persistence failure must return `ok=false` before state deletion. PID cleanup must never change the already completed result back to a rejection.

- [ ] **Step 5: Return captured completion data from `wait_for_turn`**

Store the `WorkflowChangeSnapshot` returned by the event race. When state disappears after a last-seen SUMMARY, return the captured `manifest_path`, `archive_root`, and `final_summary`; do not rescan the archive from the wait handler.

- [ ] **Step 6: Make output schemas exact**

Export the final-summary schema from `delivery-manifest-schema.ts`. Refactor `actionableToolOutputSchema` so `advance` and `wait_for_turn` can enforce conditional success shapes: completion fields are required exactly for `new_phase/phase === "idle"`; `cleanup_error` is present exactly when `cleanup_pending === true`.

- [ ] **Step 7: Update completed tips and registry contracts**

Both completed templates may display manifest and final summary paths, but structured fields remain authoritative. Add exact required variables to `tip-template.ts` and template tests.

- [ ] **Step 8: Run focused tests and typecheck**

```powershell
npx vitest run src/__tests__/advance.test.ts src/__tests__/workflow-events.test.ts src/__tests__/wait-for-turn.test.ts src/__tests__/tool-output-schema.test.ts src/__tests__/tip-template.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 9: Commit terminal completion**

```powershell
git add src/tools/advance.ts src/workflow-events.ts src/state.ts src/tools/wait-for-turn.ts src/tool-output.ts src/delivery-manifest-schema.ts src/tip-template.ts templates/tips/advance/completed.md templates/tips/wait/completed.md src/__tests__/advance.test.ts src/__tests__/workflow-events.test.ts src/__tests__/wait-for-turn.test.ts src/__tests__/tool-output-schema.test.ts src/__tests__/tip-template.test.ts
git commit -m "feat: expose durable workflow completion"
```

### Task 6: Reconcile draft/completed manifests during recovery

**Files:**

- Modify: `src/crash-recovery.ts`
- Modify: `src/tools/confirm-task.ts`
- Modify: `src/__tests__/crash-recovery.test.ts`
- Modify: `src/__tests__/confirm-task-lifecycle.test.ts`

**Interfaces:**

- Consumes: `readDeliveryManifest()`, accepted phase records, completed status.
- Produces: recovery resumes the first unaccepted phase; completed manifests clean stale PID pointers and are never reactivated.

- [ ] **Step 1: Add draft-manifest recovery coverage**

Cover requirements accepted with no planning submission, planning accepted with no implementation submission, implementation accepted with no summary submission, and later-phase submissions after an accepted record. Assert recovered `delivery_manifest`, phase, round 1, empty current-phase submissions, assigned/unclaimed turn after both real roles confirm.

- [ ] **Step 2: Add completed-manifest PID coverage**

Test stale PID cleanup followed by creation of a new workflow, stale PID `ENOENT`, cleanup `EACCES` rejection containing the completed manifest path, and completed manifest never becoming active SUMMARY.

- [ ] **Step 3: Run focused verification after recovery integration**

```powershell
npx vitest run src/__tests__/crash-recovery.test.ts src/__tests__/confirm-task-lifecycle.test.ts
```

Expected: PASS after Steps 4–6 are complete. A pre-implementation failure run is optional.

- [ ] **Step 4: Select recovery phase from submissions plus accepted records**

Use a fixed transition function:

```ts
export function phaseAfterAccepted(
  phase: RecoverablePhase,
  taskType: "requirements" | "development",
): RecoverablePhase | "completed" {
  if (phase === "requirements") return taskType === "requirements" ? "summary" : "planning";
  if (phase === "planning") return "implementation";
  if (phase === "implementation") return "summary";
  return "completed";
}
```

If the next phase has no validated submission, construct round 1 with empty `last_submission_by_participant` and let roster reconciliation assign the role-based initial turn. If later submissions exist, their highest round remains authoritative for round/turn reconstruction.

- [ ] **Step 5: Reconcile round-1 turns after recovered roles are confirmed**

Extend `reconcileRecoveredTurn()` so an empty recovered phase assigns:

```ts
if (state.phase === "planning") state.turn = reviewer.identity;
if (state.phase === "implementation") state.turn = developer.identity;
if (state.phase === "summary") state.turn = supervisor.identity;
```

Use `assignTurn()` after both placeholders become real so claim time and warning generation remain correct.

- [ ] **Step 6: Handle completed manifests before active reconstruction**

After reading `.pid` and before `reconstructFromHandoff()`, read the manifest. For `status === "completed"`, unlink the stale PID and continue the same `confirm_task` call as a new workflow. On non-ENOENT unlink failure, return a rejection whose message contains both the safe manifest path and filesystem error code.

- [ ] **Step 7: Run focused and neighboring lifecycle tests**

```powershell
npx vitest run src/__tests__/crash-recovery.test.ts src/__tests__/confirm-task-lifecycle.test.ts src/__tests__/confirm-task-mutex.test.ts src/__tests__/advance.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit recovery support**

```powershell
git add src/crash-recovery.ts src/tools/confirm-task.ts src/__tests__/crash-recovery.test.ts src/__tests__/confirm-task-lifecycle.test.ts
git commit -m "feat: recover delivery manifest state"
```

### Task 7: Publish capability, ignore sidecar, and run full verification

**Files:**

- Modify: `src/instruction-protocol.ts`
- Modify: `src/__tests__/instruction-protocol.test.ts`
- Modify: `src/__tests__/cold-start-eval.test.ts`
- Modify: `scripts/run-cold-start-eval.ts`
- Modify: `.gitignore`
- Modify: `README.md` only if it documents workflow completion output
- Modify: `docs/task/05-authoritative-artifacts-delivery-manifest.md` status and implementation evidence after verification

**Interfaces:**

- Consumes: all manifest runtime behavior.
- Produces: discoverable `delivery_manifest_v1`, clean runtime sidecar policy, cold-start coverage, and completion evidence.

- [ ] **Step 1: Add capability and cold-start assertions**

```ts
expect(INSTRUCTION_PROTOCOL.capabilities).toContain("delivery_manifest_v1");
expect(completedAdvance).toMatchObject({
  manifest_path: expect.stringMatching(/delivery-manifest\.json$/),
  final_summary: expect.objectContaining({ file_path: expect.any(String) }),
});
```

Require real completion responses to expose the manifest without revealing token values or requiring tip parsing.

- [ ] **Step 2: Add the capability and runtime sidecar ignore**

Add `delivery_manifest_v1` to the health protocol catalog and:

```gitignore
handoff/**/delivery-manifest.json
```

Do not bump the instruction action schema solely for this additive capability; capability discovery and tool output schemas carry compatibility.

- [ ] **Step 3: Run protocol and cold-start tests**

```powershell
npx vitest run src/__tests__/instruction-protocol.test.ts src/__tests__/cold-start-eval.test.ts src/__tests__/tool-output-schema.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run complete verification**

```powershell
npx vitest run
npx tsc --noEmit
npm run build
git diff --check
```

Expected: all tests pass, TypeScript exits 0, build exits 0, and diff check exits 0.

- [ ] **Step 5: Perform the final repository-level review**

Because the optional `code-review` skill is unavailable in this environment, review `git diff 1a207be...HEAD` directly against `docs/design.md` and Task 05. Check atomic ordering, manifest/output schema parity, stale PID handling, waiter completion capture, recovery with no next-phase submission, path safety, idempotency, and the no-external-command boundary. Record any findings in `docs/review/2026-07-16-delivery-manifest-review.md`, then fix confirmed findings with focused tests and rerun Step 4.

- [ ] **Step 6: Mark Task 05 complete with exact verification evidence**

Update its status only after Step 4 and the final review are clean. Record test-file/test counts from the actual command output; do not predict them.

- [ ] **Step 7: Commit the final protocol and evidence updates**

```powershell
git add src/instruction-protocol.ts src/__tests__/instruction-protocol.test.ts src/__tests__/cold-start-eval.test.ts scripts/run-cold-start-eval.ts .gitignore README.md docs/task/05-authoritative-artifacts-delivery-manifest.md docs/review/2026-07-16-delivery-manifest-review.md
git commit -m "feat: finalize delivery manifest protocol"
```

Do not add a path that was not changed; inspect `git status --short` and stage only intended files.

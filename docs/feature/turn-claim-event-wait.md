# Turn Claim and Event-Driven Wait

- Branch: `feat/2026-07-15-turn-claim-event-wait`
- Authority: `docs/design.md`
- Source tasks: `docs/task/02-turn-assignment-claim-reminder.md`, `docs/task/03-event-driven-wait.md`
- Detailed plan: `docs/superpowers/plans/2026-07-15-turn-claim-event-wait.md`
- Status: completed on feature branch

## Confirmed scope

- Restore independent no-argument `claim_turn` as the only assigned-to-claimed transition.
- Make `wait_for_turn` an event-driven synchronization tool with repeating, user-acknowledged 30-minute warning cycles.
- Change stateless Streamable HTTP MCP POST responses from SSE framing to JSON response mode.
- Bump the additive instruction protocol to `1.1` and update schemas, health discovery, tests, and cold-start evaluation.

## Stage record

- [x] Design discussion and conformance update completed.
- [x] Detailed implementation plan written.
- [x] TDD implementation completed.
- [x] Focused and full regression verification passed.
- [x] Independent per-task code reviews completed and findings resolved.
- [x] Broad whole-branch review completed and all valid findings resolved.
- [x] Implementation committed.

## Verification evidence

- Fresh verification on 2026-07-16 used the bundled Node runtime: Vitest passed 30/30 files and 378/378 tests; `tsc --noEmit` and emitting `tsc` both exited 0; `git diff --check` exited 0.
- Implementation base: `f22377d`. The feature plan checkpoint is `7d4df1c`; the implementation range ends at `3189e00` (`34f46a2^..3189e00`).
- Final broad whole-branch review reported 0 Critical findings, 0 Important findings, and `Ready to merge: Yes` after the valid findings were fixed with focused regression coverage.
- This records implementation and review completion on `feat/2026-07-15-turn-claim-event-wait` only. Nothing here records a merge, squash, push, or PR.

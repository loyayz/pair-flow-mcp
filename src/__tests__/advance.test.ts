import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { bindWorkflow, registerToken } from "../token-map.js";
import { defaultState, deleteState, getState, setState } from "../state.js";

const { unlinkMock, lstatMock, collectSubmissionsMock, atomicWriteMock } = vi.hoisted(() => ({
  unlinkMock: vi.fn(),
  lstatMock: vi.fn(),
  collectSubmissionsMock: vi.fn(),
  atomicWriteMock: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: unlinkMock, lstat: lstatMock };
});

vi.mock("../archive-submissions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../archive-submissions.js")>();
  return { ...actual, collectValidatedSubmissions: collectSubmissionsMock };
});

vi.mock("../atomic-write.js", () => ({ atomicWriteText: atomicWriteMock }));

import { advance } from "../tools/advance.js";
import { claimTurn } from "../tools/claim-turn.js";
import { whoAmI } from "../tools/who-am-i.js";
import { instructionOf } from "./instruction-assertions.js";
import { buildGuidance } from "../tip.js";
import { getWorkflowVersion, waitForWorkflowChange } from "../workflow-events.js";

const TEST_WORKFLOW_ID = "20260710000002";

function setupSummaryWorkflow(): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const token = registerToken("alice");
  bindWorkflow(token, TEST_WORKFLOW_ID);
  setState(TEST_WORKFLOW_ID, {
    ...defaultState(),
    turn_claimed_at: "2026-07-15T00:00:00.000Z",
    workflow_id: TEST_WORKFLOW_ID,
    phase: "summary",
    round: 3,
    turn: "alice",
    task: { spec_file: "C:/project/task.md", task_type: "development" },
    participants: [
      { identity: "alice", is_supervisor: true, is_developer: false, registered_at: "now", work_dir: "C:/project" },
      { identity: "bob", is_supervisor: false, is_developer: true, registered_at: "now", work_dir: "C:/project" },
    ],
    last_submission_by_participant: {
      alice: { round: 1, sub_phase: null, commit_hash: "abcdef1", submitted_at: "now", file_path: "alice.md" },
      bob: { round: 2, sub_phase: null, commit_hash: "abcdef2", submitted_at: "now", file_path: "bob.md" },
    },
    delivery_manifest: {
      manifest_version: 1,
      status: "in_progress",
      workflow_id: TEST_WORKFLOW_ID,
      task_type: "development",
      archive_root: "C:/project/handoff/20260710000002",
      supervisor: "alice",
      phases: {
        requirements: { phase: "requirements", advanced_by: "alice", accepted_at: "2026-07-15T00:00:00.000Z", acceptance_commit: "abcdef1", final_submission: { round: 1, submitted_by: "alice", commit_hash: "abcdef1", file_path: "C:/project/handoff/w/requirements/r1_alice.md" } },
        planning: { phase: "planning", advanced_by: "alice", accepted_at: "2026-07-15T00:00:00.000Z", acceptance_commit: "abcdef1", canonical_plan: { round: 1, submitted_by: "alice", commit_hash: "abcdef1", file_path: "C:/project/handoff/w/planning/r1_alice.md" } },
        implementation: { phase: "implementation", advanced_by: "alice", accepted_at: "2026-07-15T00:00:00.000Z", acceptance_commit: "abcdef2", coding_submission: { round: 1, submitted_by: "bob", commit_hash: "abcdef1", file_path: "C:/project/handoff/w/implementation/r1_coding_bob.md", sub_phase: "coding" }, review_submission: { round: 2, submitted_by: "alice", commit_hash: "abcdef2", file_path: "C:/project/handoff/w/implementation/r2_review_alice.md", sub_phase: "review" } },
      },
      commit_verification: "caller_declared_unverified",
    },
  });
  return {
    signal: new AbortController().signal,
    requestInfo: { headers: { "x-ai-identity": token } },
  } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

beforeEach(() => {
  vi.useRealTimers();
  unlinkMock.mockReset();
  lstatMock.mockReset();
  lstatMock.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  atomicWriteMock.mockReset();
  collectSubmissionsMock.mockResolvedValue([
    { phase: "requirements", round: 1, sub_phase: null, identity: "alice", meta: { submitted_at: "2026-07-15T00:00:00.000Z", commit_hash: "abcdef1", task: { spec_file: "C:/project/task.md", task_type: "development" } }, meta_path: "C:/project/handoff/w/requirements/r1_alice.meta.json", file_path: "C:/project/handoff/w/requirements/r1_alice.md" },
    { phase: "planning", round: 1, sub_phase: null, identity: "alice", meta: { submitted_at: "2026-07-15T00:00:00.000Z", commit_hash: "abcdef1", task: { spec_file: "C:/project/task.md", task_type: "development" } }, meta_path: "C:/project/handoff/w/planning/r1_alice.meta.json", file_path: "C:/project/handoff/w/planning/r1_alice.md" },
    { phase: "implementation", round: 1, sub_phase: "coding", identity: "bob", meta: { submitted_at: "2026-07-15T00:00:00.000Z", commit_hash: "abcdef1", task: { spec_file: "C:/project/task.md", task_type: "development" } }, meta_path: "C:/project/handoff/w/implementation/r1_coding_bob.meta.json", file_path: "C:/project/handoff/w/implementation/r1_coding_bob.md" },
    { phase: "implementation", round: 2, sub_phase: "review", identity: "alice", meta: { submitted_at: "2026-07-15T00:00:00.000Z", commit_hash: "abcdef2", task: { spec_file: "C:/project/task.md", task_type: "development" } }, meta_path: "C:/project/handoff/w/implementation/r2_review_alice.meta.json", file_path: "C:/project/handoff/w/implementation/r2_review_alice.md" },
    { phase: "summary", round: 1, sub_phase: null, identity: "alice", meta: { submitted_at: "2026-07-15T00:00:00.000Z", commit_hash: "abcdef1", task: { spec_file: "C:/project/task.md", task_type: "development" } }, meta_path: "C:/project/handoff/w/summary/r1_alice.meta.json", file_path: "C:/project/handoff/w/summary/r1_alice.md" },
    { phase: "summary", round: 2, sub_phase: null, identity: "bob", meta: { submitted_at: "2026-07-15T00:00:00.000Z", commit_hash: "abcdef2", task: { spec_file: "C:/project/task.md", task_type: "development" } }, meta_path: "C:/project/handoff/w/summary/r2_bob.meta.json", file_path: "C:/project/handoff/w/summary/r2_bob.md" },
  ]);
  deleteState(TEST_WORKFLOW_ID);
});

function setupAdvanceWorkflow(
  phase: "idle" | "requirements",
  taskType: "requirements" | "development" = "development",
) {
  const token = registerToken("alice");
  bindWorkflow(token, TEST_WORKFLOW_ID);
  setState(TEST_WORKFLOW_ID, {
    ...defaultState(),
    turn_claimed_at: "2026-07-15T00:00:00.000Z",
    workflow_id: TEST_WORKFLOW_ID,
    phase,
    round: phase === "idle" ? 1 : 3,
    turn: "alice",
    task: { spec_file: "C:/project/task.md", task_type: taskType },
    participants: [
      { identity: "alice", is_supervisor: true, is_developer: false, registered_at: "now", work_dir: "C:/project" },
      { identity: "bob", is_supervisor: false, is_developer: true, registered_at: "now", work_dir: "C:/project" },
    ],
    last_submission_by_participant: phase === "idle" ? {} : {
      alice: { round: 2, sub_phase: null, commit_hash: "abcdef1", submitted_at: "now", file_path: "alice.md" },
      bob: { round: 1, sub_phase: null, commit_hash: "abcdef2", submitted_at: "now", file_path: "bob.md" },
    },
  });
  return {
    signal: new AbortController().signal,
    requestInfo: { headers: { "x-ai-identity": token } },
  } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

describe("advance turn assignment timestamps", () => {
  it("requires the idle supervisor to claim the assigned turn before advancing", async () => {
    const extra = setupAdvanceWorkflow("idle");
    const state = getState(TEST_WORKFLOW_ID)!;
    state.turn_claimed_at = null;
    const before = structuredClone(state);
    const versionBefore = getWorkflowVersion(TEST_WORKFLOW_ID);

    const rejected = await advance({}, extra);
    const rejectedPayload = JSON.parse((rejected.content[0] as { text: string }).text);

    expect(rejectedPayload.ok).toBe(false);
    expect(rejectedPayload.tip).toContain("claim_turn");
    expect(getState(TEST_WORKFLOW_ID)).toEqual(before);
    expect(getWorkflowVersion(TEST_WORKFLOW_ID)).toBe(versionBefore);

    const claimed = await claimTurn(extra);
    expect(JSON.parse((claimed.content[0] as { text: string }).text).ok).toBe(true);

    const advanced = await advance({}, extra);
    expect(JSON.parse((advanced.content[0] as { text: string }).text)).toMatchObject({
      ok: true,
      new_phase: "requirements",
    });
  });

  it("requires the supervisor to claim a convergence-ready turn before advancing", async () => {
    const extra = setupAdvanceWorkflow("requirements");
    const state = getState(TEST_WORKFLOW_ID)!;
    state.turn_claimed_at = null;
    const before = structuredClone(state);
    const versionBefore = getWorkflowVersion(TEST_WORKFLOW_ID);

    const rejected = await advance({}, extra);
    const rejectedPayload = JSON.parse((rejected.content[0] as { text: string }).text);

    expect(rejectedPayload.ok).toBe(false);
    expect(rejectedPayload.tip).toContain("claim_turn");
    expect(getState(TEST_WORKFLOW_ID)).toEqual(before);
    expect(getWorkflowVersion(TEST_WORKFLOW_ID)).toBe(versionBefore);

    await claimTurn(extra);
    const advanced = await advance({}, extra);
    expect(JSON.parse((advanced.content[0] as { text: string }).text)).toMatchObject({
      ok: true,
      new_phase: "planning",
    });
  });

  it.each([
    { taskType: "requirements" as const, target: "进入汇总阶段", newPhase: "summary" },
    { taskType: "development" as const, target: "进入实施计划阶段", newPhase: "planning" },
  ])("keeps requirements convergence tip parity for $taskType", async ({ taskType, target, newPhase }) => {
    const extra = setupAdvanceWorkflow("requirements", taskType);
    const before = getState(TEST_WORKFLOW_ID)!;
    const convergence = buildGuidance(before, "alice");

    expect(convergence.tip).toContain(`可直接调用 advance（${target}）`);
    const result = await advance({}, extra);
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.new_phase).toBe(newPhase);
  });

  it("tells the supervisor that both participants must join through confirm_task", async () => {
    const extra = setupAdvanceWorkflow("idle");
    getState(TEST_WORKFLOW_ID)!.participants.pop();

    const result = await advance({}, extra);
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.ok).toBe(false);
    expect(payload.tip).toContain("both participants must join via confirm_task");
    expect(payload.tip).not.toContain("must register");
    expect(instructionOf(payload)).toMatchObject({
      next_action: "fix_request",
      allowed_tools: [],
      reason_code: "REQUEST_REJECTED",
    });
  });

  it("starts an unclaimed timer when the new turn belongs to the other participant", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T01:00:00.000Z"));

    const extra = setupAdvanceWorkflow("idle");
    getState(TEST_WORKFLOW_ID)!.wait_warning_cycle = {
      kind: "turn",
      generation: 6,
      next_report_at: "2026-07-11T00:30:00.000Z",
      reported_at: "2026-07-11T00:31:00.000Z",
      reported_to: "alice",
    };
    const versionBefore = getWorkflowVersion(TEST_WORKFLOW_ID);

    const result = await advance({}, extra);
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(getState(TEST_WORKFLOW_ID)!.turn).toBe("bob");
    expect(getState(TEST_WORKFLOW_ID)!.turn_switched_at).toBe("2026-07-11T01:00:00.000Z");
    expect(getState(TEST_WORKFLOW_ID)!.turn_claimed_at).toBeNull();
    expect(getState(TEST_WORKFLOW_ID)!.wait_warning_cycle).toEqual({
      kind: "turn",
      generation: 7,
      next_report_at: "2026-07-11T01:30:00.000Z",
      reported_at: null,
      reported_to: null,
    });
    expect(getWorkflowVersion(TEST_WORKFLOW_ID)).toBeGreaterThan(versionBefore);
    expect(instructionOf(payload)).toMatchObject({
      next_action: "wait_for_turn",
      allowed_tools: ["wait_for_turn"],
      reason_code: "PHASE_ADVANCED",
      context: {
        workflow_id: TEST_WORKFLOW_ID,
        phase: "requirements",
        round: 1,
        turn: "bob",
        holds_turn: false,
        can_advance: false,
      },
    });
  });

  it("leaves the new turn assigned when advance gives it to the caller", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T02:00:00.000Z"));

    const extra = setupAdvanceWorkflow("requirements");
    getState(TEST_WORKFLOW_ID)!.wait_warning_cycle = {
      kind: "turn",
      generation: 8,
      next_report_at: "2026-07-11T01:30:00.000Z",
      reported_at: null,
      reported_to: null,
    };

    await advance({}, extra);

    expect(getState(TEST_WORKFLOW_ID)!.phase).toBe("planning");
    expect(getState(TEST_WORKFLOW_ID)!.turn).toBe("alice");
    expect(getState(TEST_WORKFLOW_ID)!.turn_switched_at).toBe("2026-07-11T02:00:00.000Z");
    expect(getState(TEST_WORKFLOW_ID)!.turn_claimed_at).toBeNull();
    expect(getState(TEST_WORKFLOW_ID)!.wait_warning_cycle).toEqual({
      kind: "turn",
      generation: 9,
      next_report_at: "2026-07-11T02:30:00.000Z",
      reported_at: null,
      reported_to: null,
    });
  });
});

describe("advance summary completion", () => {
  it("requires a recovered assigned summary turn to be claimed before termination", async () => {
    const extra = setupSummaryWorkflow();
    const state = getState(TEST_WORKFLOW_ID)!;
    state.turn_claimed_at = null;
    const before = structuredClone(state);
    const versionBefore = getWorkflowVersion(TEST_WORKFLOW_ID);

    const rejected = await advance({}, extra);
    const rejectedPayload = JSON.parse((rejected.content[0] as { text: string }).text);

    expect(rejectedPayload.ok).toBe(false);
    expect(rejectedPayload.tip).toContain("claim_turn");
    expect(unlinkMock).not.toHaveBeenCalled();
    expect(getState(TEST_WORKFLOW_ID)).toEqual(before);
    expect(getWorkflowVersion(TEST_WORKFLOW_ID)).toBe(versionBefore);
  });

  it("completes the workflow and reports cleanup when pid deletion fails", async () => {
    const extra = setupSummaryWorkflow();
    unlinkMock.mockRejectedValueOnce(Object.assign(new Error("access denied"), { code: "EACCES" }));
    const versionBefore = getWorkflowVersion(TEST_WORKFLOW_ID);

    const result = await advance({}, extra);
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload).toMatchObject({ ok: true, new_phase: "idle", cleanup_pending: true });
    expect(payload.cleanup_error).toContain("failed to delete pid file");
    expect(getState(TEST_WORKFLOW_ID)).toBeUndefined();
    expect(getWorkflowVersion(TEST_WORKFLOW_ID)).toBeGreaterThan(versionBefore);
  });

  it("keeps the live workflow unchanged when the single completed manifest write fails", async () => {
    const extra = setupSummaryWorkflow();
    const before = structuredClone(getState(TEST_WORKFLOW_ID));
    atomicWriteMock.mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));

    const result = await advance({}, extra);
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.ok).toBe(false);
    expect(payload.tip).toContain("disk full");
    expect(atomicWriteMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock).not.toHaveBeenCalled();
    expect(getState(TEST_WORKFLOW_ID)).toEqual(before);
  });

  it("finishes the workflow when the pid file is already absent", async () => {
    const extra = setupSummaryWorkflow();
    unlinkMock.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "ENOENT" }));
    const abortController = new AbortController();
    const change = waitForWorkflowChange(
      TEST_WORKFLOW_ID,
      getWorkflowVersion(TEST_WORKFLOW_ID),
      abortController.signal,
    );

    const result = await advance({}, extra);
    await change;
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    const identityResult = await whoAmI(extra);
    const identityPayload = JSON.parse((identityResult.content[0] as { text: string }).text);

    expect(payload.ok).toBe(true);
    expect(payload.new_phase).toBe("idle");
    expect(payload.turn).toBe("idle");
    expect(payload.manifest_path).toContain("delivery-manifest.json");
    expect(payload.final_summary).toMatchObject({ round: 1, submitted_by: "alice" });
    expect(atomicWriteMock).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(atomicWriteMock.mock.calls[0][1] as string);
    expect(persisted).toMatchObject({
      status: "completed",
      phases: { summary: { phase: "summary" } },
      final_summary: { round: 1, submitted_by: "alice" },
    });
    expect(payload.tip).toContain("复用当前 token");
    expect(payload.tip).toContain("双方分别调用 confirm_task");
    expect(payload.tip).toContain("服务重启或 token 丢失时先重新 register");
    expect(payload.tip).not.toContain("双方重新 register");
    expect(instructionOf(payload)).toMatchObject({
      next_action: "stop",
      allowed_tools: [],
      reason_code: "WORKFLOW_COMPLETED",
    });
    expect(getState(TEST_WORKFLOW_ID)).toBeUndefined();
    expect(identityPayload.joined_workflow).toBe(false);
    expect(identityPayload.workflow_id).toBeNull();
  });
});

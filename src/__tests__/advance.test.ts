import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { bindWorkflow, registerToken } from "../token-map.js";
import { defaultState, deleteState, getState, setState } from "../state.js";

const unlinkMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, unlink: unlinkMock };
});

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
  });
  return {
    signal: new AbortController().signal,
    requestInfo: { headers: { "x-ai-identity": token } },
  } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

beforeEach(() => {
  vi.useRealTimers();
  unlinkMock.mockReset();
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

  it("keeps the workflow in summary when pid deletion fails", async () => {
    const extra = setupSummaryWorkflow();
    unlinkMock.mockRejectedValueOnce(Object.assign(new Error("access denied"), { code: "EACCES" }));
    const versionBefore = getWorkflowVersion(TEST_WORKFLOW_ID);

    const result = await advance({}, extra);
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.ok).toBe(false);
    expect(payload.tip).toContain("failed to delete pid file");
    expect(getState(TEST_WORKFLOW_ID)!.phase).toBe("summary");
    expect(getWorkflowVersion(TEST_WORKFLOW_ID)).toBe(versionBefore);
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

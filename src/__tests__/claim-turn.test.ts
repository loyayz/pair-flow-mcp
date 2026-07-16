import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { bindWorkflow, registerToken } from "../token-map.js";
import {
  defaultState,
  deleteState,
  getMutex,
  getState,
  setState,
  type PairFlowState,
} from "../state.js";
import { getWorkflowVersion } from "../workflow-events.js";
import { claimTurn } from "../tools/claim-turn.js";
import { getStateTool } from "../tools/get-state.js";
import { instructionOf } from "./instruction-assertions.js";

const WORKFLOW_ID = "20260715000004";

function workflow(overrides: Partial<PairFlowState> = {}): PairFlowState {
  return {
    ...defaultState(),
    workflow_id: WORKFLOW_ID,
    phase: "requirements",
    round: 1,
    turn: "alice",
    turn_switched_at: "2026-07-15T00:00:00.000Z",
    task: { spec_file: "C:/repo/task.md", task_type: "development" },
    participants: [
      { identity: "alice", is_supervisor: false, is_developer: true, registered_at: "now", work_dir: "C:/repo" },
      { identity: "bob", is_supervisor: true, is_developer: false, registered_at: "now", work_dir: "C:/repo" },
    ],
    last_submission_by_participant: {
      alice: { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null },
      bob: { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null },
    },
    wait_warning_cycle: {
      kind: "turn",
      generation: 2,
      next_report_at: "2026-07-15T00:30:00.000Z",
      reported_at: null,
      reported_to: null,
    },
    ...overrides,
  };
}

function extraForToken(
  token: string | undefined,
  signal: AbortSignal = new AbortController().signal,
): RequestHandlerExtra<ServerRequest, ServerNotification> {
  return {
    signal,
    requestInfo: { headers: token ? { "x-ai-identity": token } : {} },
  } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

function joinedExtra(identity = "alice", state: PairFlowState = workflow()) {
  const token = registerToken(identity);
  bindWorkflow(token, WORKFLOW_ID);
  setState(WORKFLOW_ID, state);
  return extraForToken(token);
}

function payload(result: Awaited<ReturnType<typeof claimTurn>>) {
  return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
}

beforeEach(() => {
  vi.useRealTimers();
  deleteState(WORKFLOW_ID);
});

describe("claim_turn guidance boundary", () => {
  it("get_state exposes only claim_turn until the assigned holder claims", async () => {
    const extra = joinedExtra();

    const assigned = payload(await getStateTool(extra));
    expect(instructionOf(assigned)).toMatchObject({
      next_action: "claim_turn",
      allowed_tools: ["claim_turn"],
      reason_code: "TURN_ASSIGNED",
    });
    expect(instructionOf(assigned).required_output).toBeUndefined();
    expect(instructionOf(assigned).references).toBeUndefined();
    expect(assigned.tip).not.toContain("submit");
    expect(assigned.tip).not.toContain("advance");

    getState(WORKFLOW_ID)!.turn_claimed_at = "2026-07-15T01:00:00.000Z";
    const claimed = payload(await getStateTool(extra));
    expect(instructionOf(claimed)).toMatchObject({
      next_action: "produce_and_submit",
      allowed_tools: ["submit"],
      reason_code: "TURN_READY",
    });
    expect(instructionOf(claimed).required_output).toBeDefined();
  });
});

describe("claim_turn state transition", () => {
  it("persists the first claim and returns full current-action guidance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T01:02:03.000Z"));
    const extra = joinedExtra();
    const versionBefore = getWorkflowVersion(WORKFLOW_ID);

    const result = payload(await claimTurn(extra));

    expect(result).toMatchObject({ ok: true, turn: "alice", phase: "requirements", round: 1 });
    expect(getState(WORKFLOW_ID)!.turn_claimed_at).toBe("2026-07-15T01:02:03.000Z");
    expect(getState(WORKFLOW_ID)!.wait_warning_cycle).toBeNull();
    expect(getWorkflowVersion(WORKFLOW_ID)).toBe(versionBefore + 1);
    expect(instructionOf(result)).toMatchObject({
      next_action: "produce_and_submit",
      allowed_tools: ["submit"],
      reason_code: "TURN_READY",
    });
    expect(instructionOf(result).required_output).toBeDefined();
  });

  it("is idempotent for the same claimed turn without changing timestamp or event version", async () => {
    const firstClaimedAt = "2026-07-15T01:02:03.000Z";
    const extra = joinedExtra("alice", workflow({ turn_claimed_at: firstClaimedAt, wait_warning_cycle: null }));
    const versionBefore = getWorkflowVersion(WORKFLOW_ID);

    const result = payload(await claimTurn(extra));

    expect(result.ok).toBe(true);
    expect(getState(WORKFLOW_ID)!.turn_claimed_at).toBe(firstClaimedAt);
    expect(getWorkflowVersion(WORKFLOW_ID)).toBe(versionBefore);
    expect(instructionOf(result).next_action).toBe("produce_and_submit");
  });

  it("rechecks the live turn after waiting for the workflow mutex", async () => {
    const extra = joinedExtra();
    const release = await getMutex(WORKFLOW_ID).acquire();
    const versionBefore = getWorkflowVersion(WORKFLOW_ID);

    const pending = claimTurn(extra);
    await Promise.resolve();
    getState(WORKFLOW_ID)!.turn = "bob";
    release();
    const result = payload(await pending);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not your turn");
    expect(getState(WORKFLOW_ID)!.turn_claimed_at).toBeNull();
    expect(getWorkflowVersion(WORKFLOW_ID)).toBe(versionBefore);
  });

  it("does not claim when cancellation is observed before the linearization point", async () => {
    const controller = new AbortController();
    const extra = joinedExtra();
    (extra as { signal: AbortSignal }).signal = controller.signal;
    const release = await getMutex(WORKFLOW_ID).acquire();
    const versionBefore = getWorkflowVersion(WORKFLOW_ID);

    const pending = claimTurn(extra);
    controller.abort(new Error("request cancelled"));
    release();

    await expect(pending).rejects.toThrow("request cancelled");
    expect(getState(WORKFLOW_ID)!.turn_claimed_at).toBeNull();
    expect(getWorkflowVersion(WORKFLOW_ID)).toBe(versionBefore);
  });

  it("never rolls back a persisted claim when cancellation is observed afterward", async () => {
    let checks = 0;
    const signal = {
      aborted: false,
      throwIfAborted() {
        checks += 1;
        if (checks === 3) throw new Error("response cancelled after persistence");
      },
    } as unknown as AbortSignal;
    const extra = joinedExtra();
    (extra as { signal: AbortSignal }).signal = signal;
    const versionBefore = getWorkflowVersion(WORKFLOW_ID);

    await expect(claimTurn(extra)).rejects.toThrow("response cancelled after persistence");

    expect(getState(WORKFLOW_ID)!.turn_claimed_at).not.toBeNull();
    expect(getWorkflowVersion(WORKFLOW_ID)).toBe(versionBefore + 1);
  });
});

describe("claim_turn rejection conventions", () => {
  it("rejects an unregistered caller", async () => {
    const result = payload(await claimTurn(extraForToken(undefined)));
    expect(result).toMatchObject({ ok: false, error: "valid registered token is required" });
  });

  it("rejects a registered but unbound caller", async () => {
    const result = payload(await claimTurn(extraForToken(registerToken("alice"))));
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain("not bound to a workflow");
  });

  it("rejects a bound identity that is not a participant", async () => {
    const result = payload(await claimTurn(joinedExtra("mallory")));
    expect(result).toMatchObject({ ok: false, error: "identity not registered" });
  });

  it("rejects the wrong turn holder without publishing", async () => {
    const extra = joinedExtra("bob");
    const versionBefore = getWorkflowVersion(WORKFLOW_ID);

    const result = payload(await claimTurn(extra));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not your turn");
    expect(getWorkflowVersion(WORKFLOW_ID)).toBe(versionBefore);
  });

  it("rejects a missing bound workflow", async () => {
    const token = registerToken("alice");
    bindWorkflow(token, WORKFLOW_ID);
    const result = payload(await claimTurn(extraForToken(token)));
    expect(result).toMatchObject({ ok: false, error: "workflow not found" });
  });

  it("rejects unsupported workflow state without mutation or publication", async () => {
    const unsupported = workflow({ phase: "mystery" as PairFlowState["phase"] });
    const extra = joinedExtra("alice", unsupported);
    const before = structuredClone(getState(WORKFLOW_ID));
    const versionBefore = getWorkflowVersion(WORKFLOW_ID);

    const result = payload(await claimTurn(extra));

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain("unsupported workflow state");
    expect(getState(WORKFLOW_ID)).toEqual(before);
    expect(getWorkflowVersion(WORKFLOW_ID)).toBe(versionBefore);
  });
});

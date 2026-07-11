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
import { whoAmI } from "../tools/who-am-i.js";

const TEST_WORKFLOW_ID = "20260710000002";

function setupSummaryWorkflow(): RequestHandlerExtra<ServerRequest, ServerNotification> {
  const token = registerToken("alice");
  bindWorkflow(token, TEST_WORKFLOW_ID);
  setState(TEST_WORKFLOW_ID, {
    ...defaultState(),
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

function setupAdvanceWorkflow(phase: "idle" | "requirements") {
  const token = registerToken("alice");
  bindWorkflow(token, TEST_WORKFLOW_ID);
  setState(TEST_WORKFLOW_ID, {
    ...defaultState(),
    workflow_id: TEST_WORKFLOW_ID,
    phase,
    round: phase === "idle" ? 1 : 3,
    turn: "alice",
    task: { spec_file: "C:/project/task.md", task_type: "development" },
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
  it("tells the supervisor that both participants must join through confirm_task", async () => {
    const extra = setupAdvanceWorkflow("idle");
    getState(TEST_WORKFLOW_ID)!.participants.pop();

    const result = await advance({}, extra);
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.ok).toBe(false);
    expect(payload.tip).toContain("both participants must join via confirm_task");
    expect(payload.tip).not.toContain("must register");
  });

  it("starts an unclaimed timer when the new turn belongs to the other participant", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T01:00:00.000Z"));

    await advance({}, setupAdvanceWorkflow("idle"));

    expect(getState(TEST_WORKFLOW_ID)!.turn).toBe("bob");
    expect(getState(TEST_WORKFLOW_ID)!.turn_switched_at).toBe("2026-07-11T01:00:00.000Z");
    expect(getState(TEST_WORKFLOW_ID)!.turn_claimed_at).toBeNull();
  });

  it("marks the new turn claimed when advance assigns it to the caller", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T02:00:00.000Z"));

    await advance({}, setupAdvanceWorkflow("requirements"));

    expect(getState(TEST_WORKFLOW_ID)!.phase).toBe("planning");
    expect(getState(TEST_WORKFLOW_ID)!.turn).toBe("alice");
    expect(getState(TEST_WORKFLOW_ID)!.turn_switched_at).toBe("2026-07-11T02:00:00.000Z");
    expect(getState(TEST_WORKFLOW_ID)!.turn_claimed_at).toBe("2026-07-11T02:00:00.000Z");
  });
});

describe("advance summary completion", () => {
  it("keeps the workflow in summary when pid deletion fails", async () => {
    const extra = setupSummaryWorkflow();
    unlinkMock.mockRejectedValueOnce(Object.assign(new Error("access denied"), { code: "EACCES" }));

    const result = await advance({}, extra);
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.ok).toBe(false);
    expect(payload.tip).toContain("failed to delete pid file");
    expect(getState(TEST_WORKFLOW_ID)!.phase).toBe("summary");
  });

  it("finishes the workflow when the pid file is already absent", async () => {
    const extra = setupSummaryWorkflow();
    unlinkMock.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "ENOENT" }));

    const result = await advance({}, extra);
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    const identityResult = await whoAmI(extra);
    const identityPayload = JSON.parse((identityResult.content[0] as { text: string }).text);

    expect(payload.ok).toBe(true);
    expect(payload.new_phase).toBe("idle");
    expect(payload.tip).toContain("复用当前 token");
    expect(payload.tip).toContain("双方分别调用 confirm_task");
    expect(payload.tip).toContain("服务重启或 token 丢失时先重新 register");
    expect(payload.tip).not.toContain("双方重新 register");
    expect(getState(TEST_WORKFLOW_ID)).toBeUndefined();
    expect(identityPayload.joined_workflow).toBe(false);
    expect(identityPayload.workflow_id).toBeNull();
  });
});

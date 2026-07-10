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
  unlinkMock.mockReset();
  deleteState(TEST_WORKFLOW_ID);
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
    expect(getState(TEST_WORKFLOW_ID)!.phase).toBe("idle");
    expect(identityPayload.joined_workflow).toBe(false);
    expect(identityPayload.workflow_id).toBeNull();
  });
});

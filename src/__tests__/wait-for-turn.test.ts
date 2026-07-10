import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { bindWorkflow, registerToken } from "../token-map.js";
import { defaultState, deleteState, getState, setState } from "../state.js";
import { waitForTurn } from "../tools/wait-for-turn.js";

const TEST_WORKFLOW_ID = "20260710000001";

afterEach(() => {
  vi.useRealTimers();
  deleteState(TEST_WORKFLOW_ID);
});

describe("wait_for_turn cancellation", () => {
  it("stops immediately without changing workflow state", async () => {
    vi.useFakeTimers();
    const token = registerToken("alice");
    bindWorkflow(token, TEST_WORKFLOW_ID);
    setState(TEST_WORKFLOW_ID, {
      ...defaultState(),
      workflow_id: TEST_WORKFLOW_ID,
      phase: "planning",
      turn: "bob",
      participants: [
        { identity: "alice", is_supervisor: true, is_developer: false, registered_at: "now" },
        { identity: "bob", is_supervisor: false, is_developer: true, registered_at: "now" },
      ],
    });

    const controller = new AbortController();
    const reason = new Error("request cancelled");
    const extra = {
      signal: controller.signal,
      requestInfo: { headers: { "x-ai-identity": token } },
    } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
    const outcomePromise = waitForTurn(extra).then(
      () => ({ type: "resolved" as const }),
      (error: unknown) => ({ type: "rejected" as const, error }),
    );

    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    void outcomePromise.then(() => { settled = true; });
    await Promise.resolve();
    const settledImmediately = settled;
    const outcome = settledImmediately ? await outcomePromise : null;

    if (!settledImmediately) {
      getState(TEST_WORKFLOW_ID)!.turn = "alice";
      await vi.advanceTimersByTimeAsync(10_000);
      await outcomePromise;
    }

    expect(settledImmediately).toBe(true);
    expect(outcome).toEqual({ type: "rejected", error: reason });
    expect(getState(TEST_WORKFLOW_ID)!.turn_claimed_at).toBeNull();
  });
});

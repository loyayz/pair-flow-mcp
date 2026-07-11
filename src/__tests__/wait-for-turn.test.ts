import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { bindWorkflow, registerToken } from "../token-map.js";
import { defaultState, deleteState, getMutex, getState, setState } from "../state.js";
import { waitForTurn } from "../tools/wait-for-turn.js";

const TEST_WORKFLOW_ID = "20260710000001";
const SECOND_WORKFLOW_ID = "20260710000002";

afterEach(() => {
  vi.useRealTimers();
  deleteState(TEST_WORKFLOW_ID);
  deleteState(SECOND_WORKFLOW_ID);
});

describe("wait_for_turn cancellation", () => {
  it("waits for the second participant before waiting for turn", async () => {
    vi.useFakeTimers();
    const token = registerToken("alice");
    bindWorkflow(token, TEST_WORKFLOW_ID);
    setState(TEST_WORKFLOW_ID, {
      ...defaultState(),
      workflow_id: TEST_WORKFLOW_ID,
      phase: "idle",
      turn: "idle",
      participants: [
        { identity: "alice", is_supervisor: true, is_developer: false, registered_at: "now", work_dir: process.cwd() },
      ],
    });
    const extra = {
      signal: new AbortController().signal,
      requestInfo: { headers: { "x-ai-identity": token } },
    } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;

    const resultPromise = waitForTurn(extra);
    const state = getState(TEST_WORKFLOW_ID)!;
    state.participants.push({ identity: "bob", is_supervisor: false, is_developer: true, registered_at: "now", work_dir: process.cwd() });
    state.turn = "alice";
    await vi.advanceTimersByTimeAsync(10_000);

    const payload = JSON.parse(((await resultPromise).content[0] as { text: string }).text);
    expect(payload.turn).toBe("alice");
    expect(payload.tip).toContain("调用 advance 开始工作流");
  });

  it("supersedes an older wait from the same workflow participant", async () => {
    vi.useFakeTimers();
    const firstToken = registerToken("alice");
    const secondToken = registerToken("alice");
    const thirdToken = registerToken("alice");
    bindWorkflow(firstToken, TEST_WORKFLOW_ID);
    bindWorkflow(secondToken, TEST_WORKFLOW_ID);
    bindWorkflow(thirdToken, TEST_WORKFLOW_ID);
    setState(TEST_WORKFLOW_ID, {
      ...defaultState(),
      workflow_id: TEST_WORKFLOW_ID,
      phase: "planning",
      turn: "bob",
      participants: [
        { identity: "alice", is_supervisor: true, is_developer: false, registered_at: "now", work_dir: process.cwd() },
        { identity: "bob", is_supervisor: false, is_developer: true, registered_at: "now", work_dir: process.cwd() },
      ],
    });
    const extra = (token: string) => ({
      signal: new AbortController().signal,
      requestInfo: { headers: { "x-ai-identity": token } },
    }) as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;

    const firstOutcome = waitForTurn(extra(firstToken)).then(
      () => ({ type: "resolved" as const }),
      (error: unknown) => ({ type: "rejected" as const, error }),
    );
    const secondOutcome = waitForTurn(extra(secondToken)).then(
      () => ({ type: "resolved" as const }),
      (error: unknown) => ({ type: "rejected" as const, error }),
    );
    await Promise.resolve();
    const first = await firstOutcome;
    const thirdResult = waitForTurn(extra(thirdToken));
    await Promise.resolve();
    const second = await secondOutcome;
    getState(TEST_WORKFLOW_ID)!.turn = "alice";
    await vi.advanceTimersByTimeAsync(10_000);

    const third = JSON.parse(((await thirdResult).content[0] as { text: string }).text);
    expect(first.type).toBe("rejected");
    expect((first as { error: Error }).error.message).toContain("newer wait_for_turn");
    expect(second.type).toBe("rejected");
    expect((second as { error: Error }).error.message).toContain("newer wait_for_turn");
    expect(third.turn).toBe("alice");
  });

  it("keeps waits for the same identity independent across workflows", async () => {
    vi.useFakeTimers();
    const firstToken = registerToken("alice");
    const secondToken = registerToken("alice");
    bindWorkflow(firstToken, TEST_WORKFLOW_ID);
    bindWorkflow(secondToken, SECOND_WORKFLOW_ID);
    const state = (workflowId: string) => ({
      ...defaultState(),
      workflow_id: workflowId,
      phase: "planning" as const,
      turn: "bob",
      participants: [
        { identity: "alice", is_supervisor: true, is_developer: false, registered_at: "now", work_dir: process.cwd() },
        { identity: "bob", is_supervisor: false, is_developer: true, registered_at: "now", work_dir: process.cwd() },
      ],
    });
    setState(TEST_WORKFLOW_ID, state(TEST_WORKFLOW_ID));
    setState(SECOND_WORKFLOW_ID, state(SECOND_WORKFLOW_ID));
    const extra = (token: string) => ({
      signal: new AbortController().signal,
      requestInfo: { headers: { "x-ai-identity": token } },
    }) as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;

    const firstResult = waitForTurn(extra(firstToken));
    const secondResult = waitForTurn(extra(secondToken));
    getState(TEST_WORKFLOW_ID)!.turn = "alice";
    getState(SECOND_WORKFLOW_ID)!.turn = "alice";
    await vi.advanceTimersByTimeAsync(10_000);

    const first = JSON.parse(((await firstResult).content[0] as { text: string }).text);
    const second = JSON.parse(((await secondResult).content[0] as { text: string }).text);
    expect(first.turn).toBe("alice");
    expect(second.turn).toBe("alice");
  });

  it("does not supersede an active wait with an already-cancelled request", async () => {
    vi.useFakeTimers();
    const activeToken = registerToken("alice");
    const cancelledToken = registerToken("alice");
    bindWorkflow(activeToken, TEST_WORKFLOW_ID);
    bindWorkflow(cancelledToken, TEST_WORKFLOW_ID);
    setState(TEST_WORKFLOW_ID, {
      ...defaultState(),
      workflow_id: TEST_WORKFLOW_ID,
      phase: "planning",
      turn: "bob",
      participants: [
        { identity: "alice", is_supervisor: true, is_developer: false, registered_at: "now", work_dir: process.cwd() },
        { identity: "bob", is_supervisor: false, is_developer: true, registered_at: "now", work_dir: process.cwd() },
      ],
    });
    const extra = (token: string, signal: AbortSignal) => ({
      signal,
      requestInfo: { headers: { "x-ai-identity": token } },
    }) as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;

    const activeResult = waitForTurn(extra(activeToken, new AbortController().signal));
    const cancelled = new AbortController();
    cancelled.abort(new Error("request cancelled"));
    await expect(waitForTurn(extra(cancelledToken, cancelled.signal))).rejects.toThrow("request cancelled");

    getState(TEST_WORKFLOW_ID)!.turn = "alice";
    await vi.advanceTimersByTimeAsync(10_000);
    const payload = JSON.parse(((await activeResult).content[0] as { text: string }).text);
    expect(payload.turn).toBe("alice");
  });

  it("keeps waiting when the turn changes before it can be claimed", async () => {
    const token = registerToken("alice");
    bindWorkflow(token, TEST_WORKFLOW_ID);
    const state = {
      ...defaultState(),
      workflow_id: TEST_WORKFLOW_ID,
      phase: "planning" as const,
      turn: "alice",
      participants: [
        { identity: "alice", is_supervisor: true, is_developer: false, registered_at: "now" },
        { identity: "bob", is_supervisor: false, is_developer: true, registered_at: "now" },
      ],
    };
    setState(TEST_WORKFLOW_ID, state);
    const release = await getMutex(TEST_WORKFLOW_ID).acquire();
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
    setState(TEST_WORKFLOW_ID, { ...state, turn: "bob" });
    release();
    controller.abort(reason);

    expect(await outcomePromise).toEqual({ type: "rejected", error: reason });
    expect(getState(TEST_WORKFLOW_ID)!.turn_claimed_at).toBeNull();
  });

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

  it("tells the AI to continue waiting after a single 600-second timeout", async () => {
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
    const extra = {
      signal: new AbortController().signal,
      requestInfo: { headers: { "x-ai-identity": token } },
    } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;

    const resultPromise = waitForTurn(extra);
    await vi.advanceTimersByTimeAsync(600_000);
    const result = await resultPromise;
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.tip).toContain("继续调用 wait_for_turn");
    expect(payload.tip).not.toContain("向用户报告");
  });

  it("continues waiting after timeout when the participant roster is incomplete", async () => {
    vi.useFakeTimers();
    const token = registerToken("alice");
    bindWorkflow(token, TEST_WORKFLOW_ID);
    setState(TEST_WORKFLOW_ID, {
      ...defaultState(),
      workflow_id: TEST_WORKFLOW_ID,
      participants: [
        { identity: "alice", is_supervisor: true, is_developer: false, registered_at: "now", work_dir: process.cwd() },
      ],
    });
    const extra = {
      signal: new AbortController().signal,
      requestInfo: { headers: { "x-ai-identity": token } },
    } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;

    const resultPromise = waitForTurn(extra);
    await vi.advanceTimersByTimeAsync(600_000);
    const payload = JSON.parse(((await resultPromise).content[0] as { text: string }).text);

    expect(payload.tip).toContain("继续调用 wait_for_turn");
    expect(payload.tip).toContain("参与者尚未全部完成 confirm_task");
  });

  it("warns after the participant roster remains incomplete for 30 minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T01:31:00.000Z"));
    const token = registerToken("alice");
    bindWorkflow(token, TEST_WORKFLOW_ID);
    setState(TEST_WORKFLOW_ID, {
      ...defaultState(),
      workflow_id: TEST_WORKFLOW_ID,
      participants: [
        { identity: "alice", is_supervisor: true, is_developer: false, registered_at: "2026-07-11T01:00:00.000Z", work_dir: process.cwd() },
      ],
    });
    const extra = {
      signal: new AbortController().signal,
      requestInfo: { headers: { "x-ai-identity": token } },
    } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;

    const result = await waitForTurn(extra);
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.warning).toContain("未完成 confirm_task");
    expect(payload.tip).toContain("建议向用户报告");
  });
});

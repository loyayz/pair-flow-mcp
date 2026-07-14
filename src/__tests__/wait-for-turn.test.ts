import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bindWorkflow, registerToken } from "../token-map.js";
import { defaultState, deleteState, getMutex, getState, setState } from "../state.js";
import { getStateTool } from "../tools/get-state.js";
import { waitForTurn } from "../tools/wait-for-turn.js";
import { instructionOf } from "./instruction-assertions.js";
import { TOOL_OUTPUT_SCHEMAS } from "../tool-output.js";

const TEST_WORKFLOW_ID = "20260710000001";
const SECOND_WORKFLOW_ID = "20260710000002";

async function callRegisteredToolThroughClient(
  name: "get_state" | "wait_for_turn",
  handler: (extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => Promise<unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) {
  const server = new McpServer({ name: "unsupported-state-test", version: "1" });
  server.registerTool(name, { outputSchema: TOOL_OUTPUT_SCHEMAS[name] }, async () => (
    handler(extra) as ReturnType<typeof getStateTool>
  ));
  const client = new Client({ name: "unsupported-state-client", version: "1" }, {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await client.callTool({ name, arguments: {} });
  } finally {
    await client.close();
    await server.close();
  }
}

afterEach(() => {
  vi.useRealTimers();
  deleteState(TEST_WORKFLOW_ID);
  deleteState(SECOND_WORKFLOW_ID);
});

describe("wait_for_turn cancellation", () => {
  it("preserves null sub_phase in supported non-implementation get_state payloads", async () => {
    const token = registerToken("alice");
    bindWorkflow(token, TEST_WORKFLOW_ID);
    setState(TEST_WORKFLOW_ID, {
      ...defaultState(),
      workflow_id: TEST_WORKFLOW_ID,
      phase: "requirements",
      sub_phase: null,
      round: 1,
      turn: "alice",
      task: { spec_file: "C:/project/task.md", task_type: "development" },
      participants: [
        { identity: "alice", is_supervisor: true, is_developer: false, registered_at: "now", work_dir: "C:/project" },
        { identity: "bob", is_supervisor: false, is_developer: true, registered_at: "now", work_dir: "C:/project" },
      ],
    });
    const extra = {
      signal: new AbortController().signal,
      requestInfo: { headers: { "x-ai-identity": token } },
    } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;

    const result = await callRegisteredToolThroughClient("get_state", getStateTool, extra);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      phase: "requirements",
      sub_phase: null,
    });
    expect((result.structuredContent as Record<string, unknown>).instruction).not.toHaveProperty("context.sub_phase");
  });

  it.each([
    {
      name: "unsupported phase through get_state",
      tool: "get_state" as const,
      mutate: (state: ReturnType<typeof defaultState>) => {
        (state as unknown as Record<string, unknown>).phase = "future-phase";
      },
      handler: getStateTool,
    },
    {
      name: "unsupported implementation sub-phase through wait_for_turn",
      tool: "wait_for_turn" as const,
      mutate: (state: ReturnType<typeof defaultState>) => {
        state.phase = "implementation";
        (state as unknown as Record<string, unknown>).sub_phase = "future-sub-phase";
      },
      handler: waitForTurn,
    },
  ])("returns a structured safe failure for $name", async ({ tool, mutate, handler }) => {
    const token = registerToken("alice");
    bindWorkflow(token, TEST_WORKFLOW_ID);
    const state = {
      ...defaultState(),
      workflow_id: TEST_WORKFLOW_ID,
      phase: "requirements" as const,
      round: 1,
      turn: "alice",
      task: { spec_file: "C:/project/task.md", task_type: "development" as const },
      participants: [
        { identity: "alice", is_supervisor: true, is_developer: false, registered_at: "now", work_dir: "C:/project" },
        { identity: "bob", is_supervisor: false, is_developer: true, registered_at: "now", work_dir: "C:/project" },
      ],
    };
    mutate(state);
    setState(TEST_WORKFLOW_ID, state);
    const extra = {
      signal: new AbortController().signal,
      requestInfo: { headers: { "x-ai-identity": token } },
    } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;

    const result = await callRegisteredToolThroughClient(tool, handler, extra);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      instruction: {
        next_action: "report_user",
        allowed_tools: [],
        reason_code: "UNSUPPORTED_WORKFLOW_STATE",
      },
    });
    const payload = result.structuredContent as Record<string, unknown>;
    expect(payload).not.toHaveProperty("phase");
    expect(payload).not.toHaveProperty("sub_phase");
  });

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

  it("returns the same turn-ready instruction as get_state for a shared state fixture", async () => {
    const token = registerToken("alice");
    bindWorkflow(token, TEST_WORKFLOW_ID);
    setState(TEST_WORKFLOW_ID, {
      ...defaultState(),
      workflow_id: TEST_WORKFLOW_ID,
      phase: "requirements",
      round: 1,
      turn: "alice",
      task: { spec_file: "C:/project/task.md", task_type: "development" },
      participants: [
        { identity: "alice", is_supervisor: false, is_developer: true, registered_at: "now", work_dir: "C:/project" },
        { identity: "bob", is_supervisor: true, is_developer: false, registered_at: "now", work_dir: "C:/project" },
      ],
    });
    const extra = {
      signal: new AbortController().signal,
      requestInfo: { headers: { "x-ai-identity": token } },
    } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;

    const stateResult = JSON.parse(((await getStateTool(extra)).content[0] as { text: string }).text);
    const waitResult = JSON.parse(((await waitForTurn(extra)).content[0] as { text: string }).text);
    const stateInstruction = instructionOf(stateResult);
    const waitInstruction = instructionOf(waitResult);

    expect(waitInstruction).toEqual(stateInstruction);
    expect(waitInstruction).toMatchObject({
      next_action: "produce_and_submit",
      allowed_tools: ["submit"],
      reason_code: "TURN_READY",
      context: { holds_turn: true, can_advance: false },
    });
    expect(waitInstruction.required_output).toBeDefined();
    expect(waitInstruction.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "task", required: true }),
    ]));
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

  it("keeps a persisted claim when cancellation happens after the claim linearization point", async () => {
    const token = registerToken("alice");
    bindWorkflow(token, TEST_WORKFLOW_ID);
    setState(TEST_WORKFLOW_ID, {
      ...defaultState(),
      workflow_id: TEST_WORKFLOW_ID,
      phase: "planning",
      turn: "alice",
      participants: [
        { identity: "alice", is_supervisor: true, is_developer: false, registered_at: "now" },
        { identity: "bob", is_supervisor: false, is_developer: true, registered_at: "now" },
      ],
    });
    const release = await getMutex(TEST_WORKFLOW_ID).acquire();
    const controller = new AbortController();
    const reason = new Error("request cancelled after claim");
    const extra = {
      signal: controller.signal,
      requestInfo: { headers: { "x-ai-identity": token } },
    } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;

    const outcomePromise = waitForTurn(extra).then(
      () => ({ type: "resolved" as const }),
      (error: unknown) => ({ type: "rejected" as const, error }),
    );
    release();
    queueMicrotask(() => controller.abort(reason));

    expect(await outcomePromise).toEqual({ type: "rejected", error: reason });
    expect(getState(TEST_WORKFLOW_ID)!.turn_claimed_at).not.toBeNull();
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

  it("reports normal completion when a summary workflow is deleted while waiting", async () => {
    vi.useFakeTimers();
    const token = registerToken("alice");
    bindWorkflow(token, TEST_WORKFLOW_ID);
    setState(TEST_WORKFLOW_ID, {
      ...defaultState(),
      workflow_id: TEST_WORKFLOW_ID,
      phase: "summary",
      turn: "bob",
      participants: [
        { identity: "alice", is_supervisor: false, is_developer: true, registered_at: "now" },
        { identity: "bob", is_supervisor: true, is_developer: false, registered_at: "now" },
      ],
    });
    const extra = {
      signal: new AbortController().signal,
      requestInfo: { headers: { "x-ai-identity": token } },
    } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;

    const resultPromise = waitForTurn(extra);
    deleteState(TEST_WORKFLOW_ID);
    await vi.advanceTimersByTimeAsync(10_000);
    const payload = JSON.parse(((await resultPromise).content[0] as { text: string }).text);

    expect(payload.ok).toBe(true);
    expect(payload.turn).toBe("idle");
    expect(payload.phase).toBe("idle");
    expect(payload.round).toBeUndefined();
    expect(payload.tip).toContain("已由监督者结束");
    expect(instructionOf(payload)).toMatchObject({
      next_action: "stop",
      allowed_tools: [],
      reason_code: "WORKFLOW_COMPLETED",
    });
  });

  it("reports an error when a non-summary workflow disappears while waiting", async () => {
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
    deleteState(TEST_WORKFLOW_ID);
    await vi.advanceTimersByTimeAsync(10_000);
    const payload = JSON.parse(((await resultPromise).content[0] as { text: string }).text);

    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("workflow not found");
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

    // instruction regression: timeout-ready must have context
    const instruction = instructionOf(payload);
    expect(instruction.reason_code).toBe("WAIT_TIMEOUT");
    expect(instruction.next_action).toBe("wait_for_turn");
    expect(instruction.allowed_tools).toEqual(["wait_for_turn"]);
    expect(instruction.context).toMatchObject({
      workflow_id: TEST_WORKFLOW_ID,
      phase: "planning",
      round: 1,
      turn: "bob",
      holds_turn: false,
      can_advance: false,
    });
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

    // instruction regression: timeout-roster must have context
    const instruction = instructionOf(payload);
    expect(instruction.reason_code).toBe("WAIT_TIMEOUT");
    expect(instruction.next_action).toBe("wait_for_turn");
    expect(instruction.allowed_tools).toEqual(["wait_for_turn"]);
    expect(instruction.context).toBeDefined();
    expect(instruction.context!.phase).toBe("idle");
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

    // instruction regression: roster warning must have context
    const instruction = instructionOf(payload);
    expect(instruction.reason_code).toBe("PARTICIPANT_CONFIRMATION_STALE");
    expect(instruction.next_action).toBe("report_user");
    expect(instruction.allowed_tools).toEqual([]);
    expect(instruction.context).toBeDefined();
    expect(instruction.context!.phase).toBe("idle");
  });

  it("warns when turn remains unclaimed for 30 minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T01:31:00.000Z"));
    const token = registerToken("alice");
    bindWorkflow(token, TEST_WORKFLOW_ID);
    setState(TEST_WORKFLOW_ID, {
      ...defaultState(),
      workflow_id: TEST_WORKFLOW_ID,
      phase: "implementation",
      sub_phase: "coding",
      round: 1,
      turn: "bob",
      turn_switched_at: "2026-07-11T01:00:00.000Z",
      turn_claimed_at: null,
      participants: [
        { identity: "alice", is_supervisor: true, is_developer: false, registered_at: "now" },
        { identity: "bob", is_supervisor: false, is_developer: true, registered_at: "now" },
      ],
    });
    const extra = {
      signal: new AbortController().signal,
      requestInfo: { headers: { "x-ai-identity": token } },
    } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;

    const result = await waitForTurn(extra);
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.warning).toContain("掉线");
    expect(payload.tip).toContain("建议向用户报告");

    // instruction regression: turn warning must have context
    const instruction = instructionOf(payload);
    expect(instruction.reason_code).toBe("TURN_UNCLAIMED_STALE");
    expect(instruction.next_action).toBe("report_user");
    expect(instruction.allowed_tools).toEqual([]);
    expect(instruction.context).toMatchObject({
      workflow_id: TEST_WORKFLOW_ID,
      phase: "implementation",
      sub_phase: "coding",
      round: 1,
      turn: "bob",
      holds_turn: false,
      can_advance: false,
    });
  });
});

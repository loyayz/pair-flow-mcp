import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bindWorkflow, registerToken } from "../token-map.js";
import { defaultState, deleteState, getMutex, getState, RECOVERY_REGISTERED_AT, setState } from "../state.js";
import { getStateTool } from "../tools/get-state.js";
import { waitForTurn } from "../tools/wait-for-turn.js";
import { instructionOf } from "./instruction-assertions.js";
import { TOOL_OUTPUT_SCHEMAS } from "../tool-output.js";
import { getWorkflowWaiterCount, publishWorkflowChange } from "../workflow-events.js";

const TEST_WORKFLOW_ID = "20260710000001";
const SECOND_WORKFLOW_ID = "20260710000002";

function registeredExtra(token: string, signal: AbortSignal = new AbortController().signal) {
  return {
    signal,
    requestInfo: { headers: { "x-ai-identity": token } },
  } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

function readPayload(result: Awaited<ReturnType<typeof waitForTurn>>) {
  return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

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
    publishWorkflowChange(TEST_WORKFLOW_ID);

    const payload = JSON.parse(((await resultPromise).content[0] as { text: string }).text);
    expect(payload.turn).toBe("alice");
    expect(instructionOf(payload)).toMatchObject({
      next_action: "claim_turn",
      allowed_tools: ["claim_turn"],
      reason_code: "TURN_ASSIGNED",
    });
    expect(getState(TEST_WORKFLOW_ID)!.turn_claimed_at).toBeNull();
  });

  it("returns the same turn-ready instruction as get_state for a shared state fixture", async () => {
    const token = registerToken("alice");
    bindWorkflow(token, TEST_WORKFLOW_ID);
    setState(TEST_WORKFLOW_ID, {
      ...defaultState(),
      turn_claimed_at: "2026-07-15T00:00:00.000Z",
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
    publishWorkflowChange(TEST_WORKFLOW_ID);

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
    publishWorkflowChange(TEST_WORKFLOW_ID);
    publishWorkflowChange(SECOND_WORKFLOW_ID);

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
    publishWorkflowChange(TEST_WORKFLOW_ID);
    const payload = JSON.parse(((await activeResult).content[0] as { text: string }).text);
    expect(payload.turn).toBe("alice");
  });

  it("returns assigned claim guidance without writing turn_claimed_at", async () => {
    const token = registerToken("alice");
    bindWorkflow(token, TEST_WORKFLOW_ID);
    const state = {
      ...defaultState(),
      workflow_id: TEST_WORKFLOW_ID,
      phase: "planning" as const,
      turn: "alice",
      task: { spec_file: "C:/project/task.md", task_type: "development" as const },
      participants: [
        { identity: "alice", is_supervisor: true, is_developer: false, registered_at: "now", work_dir: "C:/project" },
        { identity: "bob", is_supervisor: false, is_developer: true, registered_at: "now", work_dir: "C:/project" },
      ],
    };
    setState(TEST_WORKFLOW_ID, state);
    const extra = {
      signal: new AbortController().signal,
      requestInfo: { headers: { "x-ai-identity": token } },
    } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;

    const payload = JSON.parse((((await waitForTurn(extra)).content[0]) as { text: string }).text);

    expect(instructionOf(payload)).toMatchObject({
      next_action: "claim_turn",
      allowed_tools: ["claim_turn"],
      reason_code: "TURN_ASSIGNED",
    });
    expect(getState(TEST_WORKFLOW_ID)!.turn_claimed_at).toBeNull();
  });

  it("returns the full current action only when the holder already claimed", async () => {
    const token = registerToken("alice");
    bindWorkflow(token, TEST_WORKFLOW_ID);
    setState(TEST_WORKFLOW_ID, {
      ...defaultState(),
      workflow_id: TEST_WORKFLOW_ID,
      phase: "planning",
      turn: "alice",
      turn_claimed_at: "2026-07-15T00:00:00.000Z",
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

    const payload = JSON.parse((((await waitForTurn(extra)).content[0]) as { text: string }).text);

    expect(instructionOf(payload)).toMatchObject({
      next_action: "produce_and_submit",
      allowed_tools: ["submit"],
      reason_code: "TURN_READY",
    });
    expect(getState(TEST_WORKFLOW_ID)!.turn_claimed_at).toBe("2026-07-15T00:00:00.000Z");
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
      publishWorkflowChange(TEST_WORKFLOW_ID);
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
    await flushAsyncWork();
    deleteState(TEST_WORKFLOW_ID, {
      manifest_path: "C:/project/handoff/20260710000001/delivery-manifest.json",
      archive_root: "C:/project/handoff/20260710000001",
      final_summary: {
        round: 1,
        submitted_by: "bob",
        commit_hash: "abc1234",
        file_path: "C:/project/handoff/20260710000001/summary/r1_bob.md",
      },
    });
    const payload = JSON.parse(((await resultPromise).content[0] as { text: string }).text);

    expect(payload.ok).toBe(true);
    expect(payload.turn).toBe("idle");
    expect(payload.phase).toBe("idle");
    expect(payload.round).toBeUndefined();
    expect(payload).toMatchObject({
      manifest_path: "C:/project/handoff/20260710000001/delivery-manifest.json",
      archive_root: "C:/project/handoff/20260710000001",
      final_summary: { round: 1, submitted_by: "bob" },
    });
    expect(payload.tip).toContain("已由监督者结束");
    expect(instructionOf(payload)).toMatchObject({
      next_action: "stop",
      allowed_tools: [],
      reason_code: "WORKFLOW_COMPLETED",
    });
    expect(TOOL_OUTPUT_SCHEMAS.wait_for_turn.safeParse(payload).success).toBe(true);
  });

  it("delivers completed wait output through the MCP output schema", async () => {
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
    const extra = registeredExtra(token);
    const server = new McpServer({ name: "completed-wait-test", version: "1" });
    server.registerTool("wait_for_turn", { outputSchema: TOOL_OUTPUT_SCHEMAS.wait_for_turn }, async () => (
      waitForTurn(extra)
    ));
    const client = new Client({ name: "completed-wait-client", version: "1" }, {});
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const resultPromise = client.callTool({ name: "wait_for_turn", arguments: {} });
      for (let attempts = 0; attempts < 20 && getWorkflowWaiterCount(TEST_WORKFLOW_ID) === 0; attempts += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(getWorkflowWaiterCount(TEST_WORKFLOW_ID)).toBe(1);
      deleteState(TEST_WORKFLOW_ID, {
        manifest_path: "C:/project/handoff/20260710000001/delivery-manifest.json",
        archive_root: "C:/project/handoff/20260710000001",
        final_summary: {
          round: 1,
          submitted_by: "bob",
          commit_hash: "abc1234",
          file_path: "C:/project/handoff/20260710000001/summary/r1_bob.md",
        },
      });
      const result = await resultPromise;
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        phase: "idle",
        turn: "idle",
        manifest_path: "C:/project/handoff/20260710000001/delivery-manifest.json",
      });
    } finally {
      await client.close();
      await server.close();
    }
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
      wait_warning_cycle: {
        kind: "roster",
        generation: 1,
        next_report_at: "2026-07-11T01:30:00.000Z",
        reported_at: null,
        reported_to: null,
      },
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
      wait_warning_cycle: {
        kind: "turn",
        generation: 1,
        next_report_at: "2026-07-11T01:30:00.000Z",
        reported_at: null,
        reported_to: null,
      },
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

describe("wait_for_turn event deadlines and repeating warning acknowledgment", () => {
  function setupWaiting(
    identity = "alice",
    workflowId = TEST_WORKFLOW_ID,
    options: { roster?: boolean; reportedTo?: string | null; deadline?: string } = {},
  ) {
    const token = registerToken(identity);
    bindWorkflow(token, workflowId);
    const roster = options.roster ?? false;
    setState(workflowId, {
      ...defaultState(),
      workflow_id: workflowId,
      phase: roster ? "idle" : "planning",
      turn: roster ? "idle" : "bob",
      turn_switched_at: roster ? null : "2026-07-15T00:00:00.000Z",
      turn_claimed_at: null,
      wait_warning_cycle: {
        kind: roster ? "roster" : "turn",
        generation: 7,
        next_report_at: options.deadline ?? "2026-07-15T00:30:00.000Z",
        reported_at: options.reportedTo == null ? null : "2026-07-15T00:30:00.000Z",
        reported_to: options.reportedTo ?? null,
      },
      participants: roster
        ? [{ identity, is_supervisor: true, is_developer: false, registered_at: "2026-07-15T00:00:00.000Z", work_dir: process.cwd() }]
        : [
            { identity: "alice", is_supervisor: true, is_developer: false, registered_at: "2026-07-15T00:00:00.000Z", work_dir: process.cwd() },
            { identity: "bob", is_supervisor: false, is_developer: true, registered_at: "2026-07-15T00:00:00.000Z", work_dir: process.cwd() },
          ],
    });
    return { token, extra: registeredExtra(token) };
  }

  it("uses one request-owned deadline timer and reports at the exact boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:29:59.000Z"));
    const { extra } = setupWaiting("alice", TEST_WORKFLOW_ID, { roster: true });

    let settled = false;
    const resultPromise = waitForTurn(extra).then((result) => {
      settled = true;
      return result;
    });
    await flushAsyncWork();

    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(2); // one warning deadline + one absolute request timeout
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const payload = readPayload(await resultPromise);
    expect(instructionOf(payload)).toMatchObject({
      next_action: "report_user",
      allowed_tools: [],
      reason_code: "PARTICIPANT_CONFIRMATION_STALE",
      decision: {
        criterion: "user_wants_to_continue_waiting",
        when_true: "wait_for_turn",
        when_false: "stop",
      },
    });
    expect(getState(TEST_WORKFLOW_ID)!.wait_warning_cycle).toEqual({
      kind: "roster",
      generation: 7,
      next_report_at: "2026-07-15T00:30:00.000Z",
      reported_at: "2026-07-15T00:30:00.000Z",
      reported_to: "alice",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("measures a recovered roster warning from the current cycle when participant 1 reconfirms first", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:30:00.000Z"));
    const token = registerToken("alice");
    bindWorkflow(token, TEST_WORKFLOW_ID);
    setState(TEST_WORKFLOW_ID, {
      ...defaultState(),
      workflow_id: TEST_WORKFLOW_ID,
      participants: [
        { identity: "bob", is_supervisor: false, is_developer: true, registered_at: RECOVERY_REGISTERED_AT, work_dir: process.cwd() },
        { identity: "alice", is_supervisor: true, is_developer: false, registered_at: "2026-07-15T00:00:00.000Z", work_dir: process.cwd() },
      ],
      wait_warning_cycle: {
        kind: "roster",
        generation: 4,
        next_report_at: "2026-07-15T00:30:00.000Z",
        reported_at: null,
        reported_to: null,
      },
    });

    const payload = readPayload(await waitForTurn(registeredExtra(token)));

    expect(payload.warning).toBe("另一位参与者已超过 30 分钟未完成 confirm_task");
    expect(payload.tip).toContain("30 分钟");
    expect(payload.tip).not.toContain("29734590");
    expect(instructionOf(payload).reason_code).toBe("PARTICIPANT_CONFIRMATION_STALE");
  });

  it("reports an unclaimed-turn warning once and does not self-ack in that invocation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:30:00.000Z"));
    const { extra } = setupWaiting();

    const payload = readPayload(await waitForTurn(extra));

    expect(instructionOf(payload)).toMatchObject({
      next_action: "report_user",
      allowed_tools: [],
      reason_code: "TURN_UNCLAIMED_STALE",
    });
    expect(getState(TEST_WORKFLOW_ID)!.wait_warning_cycle).toMatchObject({
      generation: 7,
      next_report_at: "2026-07-15T00:30:00.000Z",
      reported_at: "2026-07-15T00:30:00.000Z",
      reported_to: "alice",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows only one concurrent waiter to report a warning generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:30:00.000Z"));
    const { extra: aliceExtra } = setupWaiting();
    getState(TEST_WORKFLOW_ID)!.turn = "carol";
    const bobToken = registerToken("bob");
    bindWorkflow(bobToken, TEST_WORKFLOW_ID);
    const bobController = new AbortController();

    const alice = waitForTurn(aliceExtra);
    const bob = waitForTurn(registeredExtra(bobToken, bobController.signal));
    await flushAsyncWork();

    const alicePayload = readPayload(await alice);
    expect(instructionOf(alicePayload).reason_code).toBe("TURN_UNCLAIMED_STALE");
    expect(getState(TEST_WORKFLOW_ID)!.wait_warning_cycle?.reported_to).toBe("alice");
    bobController.abort(new Error("stop remaining waiter"));
    await expect(bob).rejects.toThrow("stop remaining waiter");
    expect(getState(TEST_WORKFLOW_ID)!.wait_warning_cycle?.reported_to).toBe("alice");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not acknowledge another identity's report or schedule another warning deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:31:00.000Z"));
    setupWaiting("alice", TEST_WORKFLOW_ID, { reportedTo: "alice" });
    getState(TEST_WORKFLOW_ID)!.turn = "alice";
    const bobToken = registerToken("bob");
    bindWorkflow(bobToken, TEST_WORKFLOW_ID);
    const controller = new AbortController();

    const wait = waitForTurn(registeredExtra(bobToken, controller.signal));
    await flushAsyncWork();

    expect(getState(TEST_WORKFLOW_ID)!.wait_warning_cycle).toMatchObject({
      generation: 7,
      next_report_at: "2026-07-15T00:30:00.000Z",
      reported_at: "2026-07-15T00:30:00.000Z",
      reported_to: "alice",
    });
    expect(vi.getTimerCount()).toBe(1); // absolute request timeout only
    controller.abort(new Error("stop"));
    await expect(wait).rejects.toThrow("stop");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("acknowledges only on the reported identity's later invocation and preserves generation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:31:00.000Z"));
    const { token } = setupWaiting("alice", TEST_WORKFLOW_ID, { reportedTo: "alice" });
    const controller = new AbortController();

    const wait = waitForTurn(registeredExtra(token, controller.signal));
    await flushAsyncWork();

    expect(getState(TEST_WORKFLOW_ID)!.wait_warning_cycle).toEqual({
      kind: "turn",
      generation: 7,
      next_report_at: "2026-07-15T01:01:00.000Z",
      reported_at: null,
      reported_to: null,
    });
    expect(vi.getTimerCount()).toBe(2);
    controller.abort(new Error("stop after ack"));
    await expect(wait).rejects.toThrow("stop after ack");
    expect(getState(TEST_WORKFLOW_ID)!.wait_warning_cycle?.next_report_at).toBe("2026-07-15T01:01:00.000Z");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves a report unacknowledged when cancellation wins before the mutex write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:31:00.000Z"));
    const { token } = setupWaiting("alice", TEST_WORKFLOW_ID, { reportedTo: "alice" });
    const release = await getMutex(TEST_WORKFLOW_ID).acquire();
    const controller = new AbortController();
    const wait = waitForTurn(registeredExtra(token, controller.signal));

    controller.abort(new Error("cancel before ack"));
    release();

    await expect(wait).rejects.toThrow("cancel before ack");
    expect(getState(TEST_WORKFLOW_ID)!.wait_warning_cycle).toMatchObject({
      reported_at: "2026-07-15T00:30:00.000Z",
      reported_to: "alice",
      next_report_at: "2026-07-15T00:30:00.000Z",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never rolls back acknowledgment when cancellation happens after its mutex write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:31:00.000Z"));
    const { token } = setupWaiting("alice", TEST_WORKFLOW_ID, { reportedTo: "alice" });
    const controller = new AbortController();
    const wait = waitForTurn(registeredExtra(token, controller.signal));
    await flushAsyncWork();
    expect(getState(TEST_WORKFLOW_ID)!.wait_warning_cycle?.reported_at).toBeNull();

    controller.abort(new Error("cancel after ack"));

    await expect(wait).rejects.toThrow("cancel after ack");
    expect(getState(TEST_WORKFLOW_ID)!.wait_warning_cycle).toMatchObject({
      generation: 7,
      next_report_at: "2026-07-15T01:01:00.000Z",
      reported_at: null,
      reported_to: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses an absolute 600-second timeout and does not reset workflow or warning state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:31:00.000Z"));
    const { extra } = setupWaiting("alice", TEST_WORKFLOW_ID, { reportedTo: "bob" });
    const before = structuredClone(getState(TEST_WORKFLOW_ID)!);
    let settled = false;
    const wait = waitForTurn(extra).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(599_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(instructionOf(readPayload(await wait)).reason_code).toBe("WAIT_TIMEOUT");
    expect(getState(TEST_WORKFLOW_ID)).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out from invocation even while acknowledgment is queued on the mutex", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:31:00.000Z"));
    const { token } = setupWaiting("alice", TEST_WORKFLOW_ID, { reportedTo: "alice" });
    const before = structuredClone(getState(TEST_WORKFLOW_ID)!.wait_warning_cycle);
    const release = await getMutex(TEST_WORKFLOW_ID).acquire();
    let settled = false;
    const wait = waitForTurn(registeredExtra(token)).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(600_000);
    await flushAsyncWork();
    const settledAtDeadline = settled;
    release();

    expect(settledAtDeadline).toBe(true);
    expect(instructionOf(readPayload(await wait)).reason_code).toBe("WAIT_TIMEOUT");
    expect(getState(TEST_WORKFLOW_ID)!.wait_warning_cycle).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the invocation deadline while a post-event decision is queued on the mutex", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:31:00.000Z"));
    const { extra } = setupWaiting("alice", TEST_WORKFLOW_ID, { reportedTo: "bob" });
    let settled = false;
    const wait = waitForTurn(extra).then((result) => {
      settled = true;
      return result;
    });
    await flushAsyncWork();
    const release = await getMutex(TEST_WORKFLOW_ID).acquire();
    publishWorkflowChange(TEST_WORKFLOW_ID);
    await flushAsyncWork();

    await vi.advanceTimersByTimeAsync(600_000);
    await flushAsyncWork();
    const settledAtDeadline = settled;
    release();

    expect(settledAtDeadline).toBe(true);
    expect(instructionOf(readPayload(await wait)).reason_code).toBe("WAIT_TIMEOUT");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans event and timeout resources after an event-driven assigned result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
    const { extra } = setupWaiting("alice", TEST_WORKFLOW_ID, { deadline: "2026-07-15T00:30:00.000Z" });
    const wait = waitForTurn(extra);
    await flushAsyncWork();
    expect(vi.getTimerCount()).toBe(2);

    const state = getState(TEST_WORKFLOW_ID)!;
    state.turn = "alice";
    state.turn_claimed_at = null;
    publishWorkflowChange(TEST_WORKFLOW_ID);

    expect(instructionOf(readPayload(await wait)).reason_code).toBe("TURN_ASSIGNED");
    expect(state.turn_claimed_at).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

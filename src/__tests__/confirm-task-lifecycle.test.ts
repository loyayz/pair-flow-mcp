import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { confirmTask } from "../tools/confirm-task.js";
import {
  RECOVERY_REGISTERED_AT,
  defaultState,
  deleteState,
  getState,
  setState,
  type PairFlowState,
} from "../state.js";
import { registerToken, resolveSession } from "../token-map.js";

const WORKFLOW_ID = "20260711000002";
const WORK_DIR = join(tmpdir(), `pairflow-confirm-lifecycle-${randomUUID()}`);
const NESTED_WORK_DIR = join(WORK_DIR, "nested");
const TASK_PATH = join(NESTED_WORK_DIR, "task.md");
const SECOND_TASK_PATH = join(NESTED_WORK_DIR, "second-task.md");

function responsePayload(result: Awaited<ReturnType<typeof confirmTask>>): Record<string, unknown> {
  return JSON.parse((result.content[0] as { text: string }).text);
}

function requestExtra(token: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  return {
    signal: new AbortController().signal,
    requestInfo: { headers: { "x-ai-identity": token } },
  } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

function participantState(phase: PairFlowState["phase"] = "idle", registeredAt = "2026-07-11T00:00:00.000Z"): PairFlowState {
  return {
    ...defaultState(),
    workflow_id: WORKFLOW_ID,
    phase,
    task: { spec_file: TASK_PATH, task_type: "development" },
    participants: [{
      identity: "alice",
      is_supervisor: true,
      is_developer: false,
      registered_at: registeredAt,
      work_dir: WORK_DIR,
    }],
  };
}

async function confirm(token: string, overrides: Record<string, unknown> = {}) {
  return responsePayload(await confirmTask({
    task_path: TASK_PATH,
    is_supervisor: true,
    is_developer: false,
    work_dir: WORK_DIR,
    ...overrides,
  }, requestExtra(token)));
}

beforeEach(async () => {
  await mkdir(join(WORK_DIR, ".git"), { recursive: true });
  await mkdir(join(NESTED_WORK_DIR, ".git"), { recursive: true });
  await writeFile(TASK_PATH, "# task", "utf-8");
  await writeFile(SECOND_TASK_PATH, "# second task", "utf-8");
});

afterEach(async () => {
  deleteState(WORKFLOW_ID);
  await rm(WORK_DIR, { recursive: true, force: true });
});

describe("confirm_task participant lifecycle", () => {
  it("rejects responsibility changes after the workflow leaves idle", async () => {
    setState(WORKFLOW_ID, participantState("requirements"));
    const token = registerToken("alice");

    const result = await confirm(token, { is_supervisor: false, is_developer: true });

    expect(result.ok).toBe(false);
    expect(result.tip).toContain("participant responsibilities are locked after the workflow leaves idle");
    expect(getState(WORKFLOW_ID)?.participants[0]).toMatchObject({
      is_supervisor: true,
      is_developer: false,
      registered_at: "2026-07-11T00:00:00.000Z",
      work_dir: WORK_DIR,
    });
  });

  it("keeps active same-role confirmation idempotent while binding another token", async () => {
    setState(WORKFLOW_ID, participantState("requirements"));
    const token = registerToken("alice");

    const result = await confirm(token);

    expect(result.ok).toBe(true);
    expect(result.recovered).toBe(false);
    expect(resolveSession(token)?.workflowId).toBe(WORKFLOW_ID);
    expect(getState(WORKFLOW_ID)?.participants[0].registered_at).toBe("2026-07-11T00:00:00.000Z");
  });

  it("allows a participant to correct responsibilities while idle", async () => {
    setState(WORKFLOW_ID, participantState());
    const token = registerToken("alice");

    const result = await confirm(token, { is_supervisor: false, is_developer: true });

    expect(result.ok).toBe(true);
    expect(result.recovered).toBe(false);
    expect(getState(WORKFLOW_ID)?.participants[0]).toMatchObject({
      is_supervisor: false,
      is_developer: true,
      registered_at: "2026-07-11T00:00:00.000Z",
    });
  });

  it("rejects work_dir changes after participant confirmation", async () => {
    setState(WORKFLOW_ID, participantState());
    const token = registerToken("alice");

    const result = await confirm(token, { work_dir: NESTED_WORK_DIR });

    expect(result.ok).toBe(false);
    expect(result.tip).toContain("work_dir cannot change after participant confirmation");
    expect(getState(WORKFLOW_ID)?.participants[0].work_dir).toBe(WORK_DIR);
  });

  it("lets a recovered placeholder declare responsibilities and work_dir exactly once", async () => {
    setState(WORKFLOW_ID, participantState("requirements", RECOVERY_REGISTERED_AT));
    const token = registerToken("alice");

    const recovered = await confirm(token, {
      is_supervisor: false,
      is_developer: true,
      work_dir: NESTED_WORK_DIR,
    });
    const changedAgain = await confirm(token, {
      is_supervisor: true,
      is_developer: false,
      work_dir: NESTED_WORK_DIR,
    });

    expect(recovered.ok).toBe(true);
    expect(recovered.recovered).toBe(true);
    expect(getState(WORKFLOW_ID)?.participants[0]).toMatchObject({
      is_supervisor: false,
      is_developer: true,
      work_dir: NESTED_WORK_DIR,
    });
    expect(getState(WORKFLOW_ID)?.participants[0].registered_at).not.toBe(RECOVERY_REGISTERED_AT);
    expect(changedAgain.ok).toBe(false);
    expect(changedAgain.tip).toContain("participant responsibilities are locked after the workflow leaves idle");
  });

  it("requires explicit boolean responsibility values at the handler boundary", async () => {
    const token = registerToken("alice");

    const missingSupervisor = await confirm(token, { is_supervisor: undefined });
    const stringDeveloper = await confirm(token, { is_developer: "false" });

    expect(missingSupervisor.ok).toBe(false);
    expect(missingSupervisor.tip).toContain("is_supervisor must be a boolean");
    expect(stringDeveloper.ok).toBe(false);
    expect(stringDeveloper.tip).toContain("is_developer must be a boolean");
  });

  it("rejects non-string task and work directory values at the handler boundary", async () => {
    const token = registerToken("alice");

    const invalidTask = await confirm(token, { task_path: 42 });
    const invalidWorkDir = await confirm(token, { work_dir: 42 });
    const invalidTaskType = await confirm(token, { task_type: 42 });

    expect(invalidTask.ok).toBe(false);
    expect(invalidTask.tip).toContain("task_path must be a string");
    expect(invalidWorkDir.ok).toBe(false);
    expect(invalidWorkDir.tip).toContain("work_dir must be a string");
    expect(invalidTaskType.ok).toBe(false);
    expect(invalidTaskType.tip).toContain("task_type must be a string");
  });

  it("serializes concurrent confirmation attempts made with the same token", async () => {
    const token = registerToken("alice");
    const args = (taskPath: string) => ({
      task_path: taskPath,
      is_supervisor: true,
      is_developer: false,
      work_dir: WORK_DIR,
    });

    const results = await Promise.all([
      confirmTask(args(TASK_PATH), requestExtra(token)).then(responsePayload),
      confirmTask(args(SECOND_TASK_PATH), requestExtra(token)).then(responsePayload),
    ]);

    const accepted = results.filter((result) => result.ok === true);
    const rejected = results.filter((result) => result.ok === false);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].tip).toContain("token is already joined to active workflow");
    expect(resolveSession(token)?.workflowId).toBe(accepted[0].workflow_id);
    if (typeof accepted[0].workflow_id === "string") deleteState(accepted[0].workflow_id);
  });

  it("does not overwrite an active workflow when a pid reuses its workflow id", async () => {
    setState(WORKFLOW_ID, participantState("requirements"));
    await writeFile(`${SECOND_TASK_PATH}.pid`, WORKFLOW_ID, "utf-8");
    const phaseDir = join(WORK_DIR, "handoff", WORKFLOW_ID, "requirements");
    await mkdir(phaseDir, { recursive: true });
    await writeFile(join(phaseDir, "r1_archived.meta.json"), JSON.stringify({
      submitted_at: "2026-07-11T00:00:00.000Z",
      commit_hash: "abc1234",
      sub_phase: null,
      task: { spec_file: SECOND_TASK_PATH, task_type: "development" },
    }));
    const token = registerToken("charlie");

    const result = responsePayload(await confirmTask({
      task_path: SECOND_TASK_PATH,
      is_supervisor: false,
      is_developer: true,
      work_dir: WORK_DIR,
    }, requestExtra(token)));

    expect(result.ok).toBe(false);
    expect(result.tip).toContain(`workflow_id ${WORKFLOW_ID} is already active for another task`);
    expect(getState(WORKFLOW_ID)?.task?.spec_file).toBe(TASK_PATH);
    expect(resolveSession(token)?.workflowId).toBeNull();
  });
});

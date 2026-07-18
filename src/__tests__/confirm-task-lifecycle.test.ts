import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { getWorkflowVersion } from "../workflow-events.js";
import { instructionOf } from "./instruction-assertions.js";

const WORKFLOW_ID = "20260711000002";
const WORK_DIR = join(tmpdir(), `pairflow-confirm-lifecycle-${randomUUID()}`);
const NESTED_WORK_DIR = join(WORK_DIR, "nested");
const TASK_PATH = join(NESTED_WORK_DIR, "task.md");
const SECOND_TASK_PATH = join(NESTED_WORK_DIR, "second-task.md");

function posix(path: string): string {
  return path.replace(/\\/g, "/");
}

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
    task_type: "development",
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
  vi.useRealTimers();
  deleteState(WORKFLOW_ID);
  await rm(WORK_DIR, { recursive: true, force: true });
});

describe("confirm_task participant lifecycle", () => {
  it("cleans a completed stale pid before applying the new task_type", async () => {
    const archiveRoot = posix(join(WORK_DIR, "handoff", WORKFLOW_ID));
    const requirements = {
      round: 2,
      submitted_by: "alice",
      commit_hash: "abc1234",
      file_path: `${archiveRoot}/requirements/r2_alice.md`,
    };
    const finalSummary = {
      round: 1,
      submitted_by: "alice",
      commit_hash: "def5678",
      file_path: `${archiveRoot}/summary/r1_alice.md`,
    };
    const manifest = {
      manifest_version: 1,
      status: "completed",
      workflow_id: WORKFLOW_ID,
      task_type: "requirements",
      archive_root: archiveRoot,
      supervisor: "alice",
      phases: {
        requirements: {
          phase: "requirements",
          advanced_by: "alice",
          accepted_at: "2026-07-11T00:00:00.000Z",
          acceptance_commit: "abc1234",
          final_submission: requirements,
        },
        summary: {
          phase: "summary",
          advanced_by: "alice",
          accepted_at: "2026-07-11T00:10:00.000Z",
          acceptance_commit: "def5678",
          final_summary: finalSummary,
        },
      },
      completed_at: "2026-07-11T00:10:00.000Z",
      completed_by: "alice",
      final_summary: finalSummary,
      commit_verification: "caller_declared_unverified",
    };
    await mkdir(join(WORK_DIR, "handoff", WORKFLOW_ID), { recursive: true });
    await writeFile(join(WORK_DIR, "handoff", WORKFLOW_ID, "delivery-manifest.json"), JSON.stringify(manifest), "utf-8");
    await writeFile(`${TASK_PATH}.pid`, WORKFLOW_ID, "utf-8");
    const token = registerToken("alice");

    const result = await confirm(token);
    const newWorkflowId = result.workflow_id as string;
    try {
      expect(result).toMatchObject({ ok: true, recovered: false, phase: "idle" });
      expect(newWorkflowId).not.toBe(WORKFLOW_ID);
      expect(getState(WORKFLOW_ID)).toBeUndefined();
      expect(getState(newWorkflowId)?.task?.task_type).toBe("development");
    } finally {
      if (newWorkflowId) deleteState(newWorkflowId);
    }
  });

  it("starts the initial roster warning cycle from the first participant registration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T02:00:00.000Z"));
    const token = registerToken("alice");

    const result = await confirm(token);
    const workflowId = result.workflow_id as string;
    try {
      const state = getState(workflowId);
      expect(result.ok).toBe(true);
      expect(state?.participants[0].registered_at).toBe("2026-07-11T02:00:00.000Z");
      expect(state?.wait_warning_cycle).toEqual({
        kind: "roster",
        generation: 1,
        next_report_at: "2026-07-11T02:30:00.000Z",
        reported_at: null,
        reported_to: null,
      });
    } finally {
      if (workflowId) deleteState(workflowId);
    }
  });

  it("starts an unclaimed timer when the second participant assigns idle turn to the other supervisor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T03:00:00.000Z"));
    const state = participantState();
    state.wait_warning_cycle = {
      kind: "roster",
      generation: 4,
      next_report_at: "2026-07-11T02:30:00.000Z",
      reported_at: "2026-07-11T02:31:00.000Z",
      reported_to: "alice",
    };
    setState(WORKFLOW_ID, state);
    const token = registerToken("bob");
    const versionBefore = getWorkflowVersion(WORKFLOW_ID);

    const result = responsePayload(await confirmTask({
      task_path: TASK_PATH,
      task_type: "development",
      is_supervisor: false,
      is_developer: true,
      work_dir: WORK_DIR,
    }, requestExtra(token)));

    expect(result.ok).toBe(true);
    expect(instructionOf(result)).toMatchObject({
      next_action: "wait_for_turn",
      allowed_tools: ["wait_for_turn"],
      reason_code: "CONFIRMED_NEEDS_TURN_CLAIM",
      context: {
        workflow_id: WORKFLOW_ID,
        phase: "idle",
        round: 1,
        turn: "alice",
        holds_turn: false,
        can_advance: false,
      },
    });
    expect(getState(WORKFLOW_ID)).toMatchObject({
      turn: "alice",
      turn_switched_at: "2026-07-11T03:00:00.000Z",
      turn_claimed_at: null,
      wait_warning_cycle: {
        kind: "turn",
        generation: 5,
        next_report_at: "2026-07-11T03:30:00.000Z",
        reported_at: null,
        reported_to: null,
      },
    });
    expect(getWorkflowVersion(WORKFLOW_ID)).toBeGreaterThan(versionBefore);
  });

  it("rejects responsibility changes after the workflow leaves idle", async () => {
    setState(WORKFLOW_ID, participantState("requirements"));
    const token = registerToken("alice");
    const versionBefore = getWorkflowVersion(WORKFLOW_ID);

    const result = await confirm(token, { is_supervisor: false, is_developer: true });

    expect(result.ok).toBe(false);
    expect(result.tip).toContain("participant responsibilities are locked");
    expect(instructionOf(result)).toMatchObject({
      next_action: "fix_request",
      allowed_tools: [],
      reason_code: "REQUEST_REJECTED",
    });
    expect(getState(WORKFLOW_ID)?.participants[0]).toMatchObject({
      is_supervisor: true,
      is_developer: false,
      registered_at: "2026-07-11T00:00:00.000Z",
      work_dir: WORK_DIR,
    });
    expect(getWorkflowVersion(WORKFLOW_ID)).toBe(versionBefore);
  });

  it("keeps active same-role confirmation idempotent while binding another token", async () => {
    const state = participantState("requirements");
    state.turn = "alice";
    state.turn_switched_at = "2026-07-11T00:05:00.000Z";
    state.turn_claimed_at = null;
    state.wait_warning_cycle = {
      kind: "roster",
      generation: 3,
      next_report_at: "2026-07-11T00:30:00.000Z",
      reported_at: null,
      reported_to: null,
    };
    setState(WORKFLOW_ID, state);
    const token = registerToken("alice");

    const result = await confirm(token);

    expect(result.ok).toBe(true);
    expect(result.recovered).toBe(false);
    expect(resolveSession(token)?.workflowId).toBe(WORKFLOW_ID);
    expect(getState(WORKFLOW_ID)?.participants[0].registered_at).toBe("2026-07-11T00:00:00.000Z");
    expect(getState(WORKFLOW_ID)).toMatchObject({
      turn_switched_at: "2026-07-11T00:05:00.000Z",
      turn_claimed_at: null,
      wait_warning_cycle: {
        kind: "roster",
        generation: 3,
        next_report_at: "2026-07-11T00:30:00.000Z",
      },
    });
  });

  it("starts fresh roster and turn cycles while recovered participants reconfirm", async () => {
    vi.useFakeTimers();
    const state = participantState("requirements", RECOVERY_REGISTERED_AT);
    state.participants.push({
      identity: "bob",
      is_supervisor: false,
      is_developer: false,
      registered_at: RECOVERY_REGISTERED_AT,
    });
    state.turn = "bob";
    state.turn_switched_at = "2026-07-10T23:00:00.000Z";
    state.turn_claimed_at = null;
    state.last_submission_by_participant = {
      alice: { round: 1, sub_phase: null, commit_hash: "abc1234", submitted_at: "2026-07-10T23:00:00.000Z", file_path: "alice.md" },
      bob: { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null },
    };
    setState(WORKFLOW_ID, state);

    vi.setSystemTime(new Date("2026-07-11T04:00:00.000Z"));
    const aliceToken = registerToken("alice");
    const aliceResult = await confirm(aliceToken);

    expect(aliceResult.ok).toBe(true);
    expect(getState(WORKFLOW_ID)?.wait_warning_cycle).toEqual({
      kind: "roster",
      generation: 1,
      next_report_at: "2026-07-11T04:30:00.000Z",
      reported_at: null,
      reported_to: null,
    });

    vi.setSystemTime(new Date("2026-07-11T04:10:00.000Z"));
    const bobToken = registerToken("bob");
    const bobResult = responsePayload(await confirmTask({
      task_path: TASK_PATH,
      task_type: "development",
      is_supervisor: false,
      is_developer: true,
      work_dir: WORK_DIR,
    }, requestExtra(bobToken)));

    expect(bobResult.ok).toBe(true);
    expect(getState(WORKFLOW_ID)).toMatchObject({
      turn: "bob",
      turn_switched_at: "2026-07-10T23:00:00.000Z",
      turn_claimed_at: null,
      wait_warning_cycle: {
        kind: "turn",
        generation: 2,
        next_report_at: "2026-07-11T04:40:00.000Z",
        reported_at: null,
        reported_to: null,
      },
    });
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

  it("locks participant responsibilities once both participants have joined idle", async () => {
    const state = participantState();
    state.participants.push({
      identity: "bob",
      is_supervisor: false,
      is_developer: true,
      registered_at: "2026-07-11T00:01:00.000Z",
      work_dir: WORK_DIR,
    });
    setState(WORKFLOW_ID, state);
    const token = registerToken("alice");

    const result = await confirm(token, { is_supervisor: false, is_developer: false });

    expect(result.ok).toBe(false);
    expect(result.tip).toContain("responsibilities are locked once both participants have joined");
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
    expect(changedAgain.tip).toContain("participant responsibilities are locked");
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

  it("requires task_type at the handler boundary", async () => {
    const token = registerToken("alice");

    const missingTaskType = await confirm(token, { task_type: undefined });

    expect(missingTaskType.ok).toBe(false);
    expect(missingTaskType.tip).toContain("task_type is required");
  });

  it("serializes concurrent confirmation attempts made with the same token", async () => {
    const token = registerToken("alice");
    const args = (taskPath: string) => ({
      task_path: taskPath,
      task_type: "development",
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
      task_type: "development",
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

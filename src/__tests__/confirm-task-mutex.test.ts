import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { confirmTask } from "../tools/confirm-task.js";
import { defaultState, deleteState, getMutex, setState } from "../state.js";
import { registerToken } from "../token-map.js";

const WORKFLOW_ID = "20260711000001";
const RECOVERY_WORKFLOW_ID = "20260711000002";
const WORK_DIR = join(tmpdir(), `pairflow-confirm-mutex-${randomUUID()}`);
const TASK_PATH = join(WORK_DIR, "task.md");
let token = "";

beforeEach(async () => {
  await mkdir(join(WORK_DIR, ".git"), { recursive: true });
  await writeFile(TASK_PATH, "# task", "utf-8");
  token = registerToken("alice");
  setState(WORKFLOW_ID, {
    ...defaultState(),
    workflow_id: WORKFLOW_ID,
    task: { spec_file: TASK_PATH, task_type: "development" },
    participants: [{
      identity: "alice",
      is_supervisor: true,
      is_developer: false,
      registered_at: new Date().toISOString(),
      work_dir: WORK_DIR,
    }],
  });
});

afterEach(async () => {
  deleteState(WORKFLOW_ID);
  deleteState(RECOVERY_WORKFLOW_ID);
  await rm(WORK_DIR, { recursive: true, force: true });
});

describe("confirm_task workflow locking", () => {
  it("waits for the workflow mutex before updating an existing participant", async () => {
    const release = await getMutex(WORKFLOW_ID).acquire();
    let settled = false;
    const extra = {
      signal: new AbortController().signal,
      requestInfo: { headers: { "x-ai-identity": token } },
    } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;

    const pending = confirmTask({
      task_path: TASK_PATH,
      is_supervisor: true,
      is_developer: false,
      work_dir: WORK_DIR,
    }, extra).finally(() => { settled = true; });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);

    release();
    const result = await pending;
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);
  });

  it("allows only one task to recover the same workflow id concurrently", async () => {
    const firstTask = join(WORK_DIR, "first-task.md");
    const secondTask = join(WORK_DIR, "second-task.md");
    const phaseDir = join(WORK_DIR, "handoff", RECOVERY_WORKFLOW_ID, "requirements");
    await mkdir(phaseDir, { recursive: true });
    await writeFile(firstTask, "# first task", "utf-8");
    await writeFile(secondTask, "# second task", "utf-8");
    await writeFile(`${firstTask}.pid`, RECOVERY_WORKFLOW_ID, "utf-8");
    await writeFile(`${secondTask}.pid`, RECOVERY_WORKFLOW_ID, "utf-8");
    await writeFile(join(phaseDir, "r1_archived.md"), "# archived", "utf-8");
    await writeFile(join(phaseDir, "r1_archived.meta.json"), JSON.stringify({
      submitted_at: "2026-07-11T00:00:00.000Z",
      commit_hash: "abc1234",
      sub_phase: null,
      task: { spec_file: firstTask, task_type: "development" },
    }), "utf-8");

    const firstToken = registerToken("first");
    const secondToken = registerToken("second");
    const extra = (value: string) => ({
      signal: new AbortController().signal,
      requestInfo: { headers: { "x-ai-identity": value } },
    }) as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;

    const results = await Promise.all([
      confirmTask({
        task_path: firstTask,
        is_supervisor: true,
        is_developer: false,
        work_dir: WORK_DIR,
      }, extra(firstToken)),
      confirmTask({
        task_path: secondTask,
        is_supervisor: false,
        is_developer: true,
        work_dir: WORK_DIR,
      }, extra(secondToken)),
    ]);
    const payloads = results.map((result) =>
      JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>);

    expect(payloads.filter((payload) => payload.ok === true)).toHaveLength(1);
    const rejected = payloads.find((payload) => payload.ok === false);
    expect(rejected?.tip).toContain("already active for another task");
  });
});

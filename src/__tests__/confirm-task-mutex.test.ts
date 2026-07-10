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
});

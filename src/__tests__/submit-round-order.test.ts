import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { submit } from "../tools/submit.js";
import { bindWorkflow, registerToken } from "../token-map.js";
import { defaultState, deleteState, setState } from "../state.js";

const WORKFLOW_ID = "20260711000002";
const WORK_DIR = join(tmpdir(), `pairflow-submit-round-${randomUUID()}`);
const FILE_PATH = join(WORK_DIR, "handoff", WORKFLOW_ID, "requirements", "r3_alice.md");
let token = "";

beforeEach(async () => {
  await mkdir(dirname(FILE_PATH), { recursive: true });
  await writeFile(FILE_PATH, "# requirements", "utf-8");
  token = registerToken("alice");
  bindWorkflow(token, WORKFLOW_ID);
  setState(WORKFLOW_ID, {
    ...defaultState(),
    workflow_id: WORKFLOW_ID,
    phase: "requirements",
    round: 3,
    turn: "alice",
    task: { spec_file: join(WORK_DIR, "task.md"), task_type: "development" },
    participants: [
      { identity: "alice", is_supervisor: true, is_developer: false, registered_at: "now", work_dir: WORK_DIR },
      { identity: "bob", is_supervisor: false, is_developer: true, registered_at: "now", work_dir: WORK_DIR },
    ],
    last_submission_by_participant: {
      alice: { round: 1, sub_phase: null, commit_hash: "abc1234", submitted_at: "2026-07-11T00:20:00.000Z", file_path: "alice.md" },
      bob: { round: 2, sub_phase: null, commit_hash: "def5678", submitted_at: "2026-07-11T00:10:00.000Z", file_path: "bob.md" },
    },
  });
});

afterEach(async () => {
  deleteState(WORKFLOW_ID);
  await rm(WORK_DIR, { recursive: true, force: true });
});

describe("submit commit ordering", () => {
  it("compares git_commit_hash with the highest-round submission", async () => {
    const extra = {
      signal: new AbortController().signal,
      requestInfo: { headers: { "x-ai-identity": token } },
    } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;

    const result = await submit({
      file_path: FILE_PATH,
      git_commit_hash: "def5678",
    }, extra);
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.ok).toBe(false);
    expect(payload.tip).toContain("git_commit_hash unchanged since last submission");
  });
});

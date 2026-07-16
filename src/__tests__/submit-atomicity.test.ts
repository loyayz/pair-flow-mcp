import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { bindWorkflow, registerToken } from "../token-map.js";
import { defaultState, deleteState, getState, setState } from "../state.js";
import { getWorkflowVersion } from "../workflow-events.js";

const atomicWriteTextMock = vi.hoisted(() => vi.fn());

vi.mock("../atomic-write.js", () => ({ atomicWriteText: atomicWriteTextMock }));

import { submit } from "../tools/submit.js";

const WORKFLOW_ID = "20260711000003";
const WORK_DIR = join(tmpdir(), `pairflow-submit-atomic-${randomUUID()}`);
const FILE_PATH = join(WORK_DIR, "handoff", WORKFLOW_ID, "requirements", "r1_alice.md");
let token = "";

beforeEach(async () => {
  atomicWriteTextMock.mockReset();
  await mkdir(dirname(FILE_PATH), { recursive: true });
  await writeFile(FILE_PATH, "# requirements", "utf-8");
  token = registerToken("alice");
  bindWorkflow(token, WORKFLOW_ID);
  setState(WORKFLOW_ID, {
    ...defaultState(),
    turn_claimed_at: "2026-07-11T00:00:00.000Z",
    workflow_id: WORKFLOW_ID,
    phase: "requirements",
    turn: "alice",
    task: { spec_file: join(WORK_DIR, "task.md"), task_type: "development" },
    participants: [
      { identity: "alice", is_supervisor: true, is_developer: false, registered_at: "now", work_dir: WORK_DIR },
      { identity: "bob", is_supervisor: false, is_developer: true, registered_at: "now", work_dir: WORK_DIR },
    ],
    last_submission_by_participant: {
      alice: { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null },
      bob: { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null },
    },
  });
});

afterEach(async () => {
  deleteState(WORKFLOW_ID);
  await rm(WORK_DIR, { recursive: true, force: true });
});

describe("submit atomicity", () => {
  it("does not mutate workflow state when meta writing fails", async () => {
    atomicWriteTextMock.mockRejectedValueOnce(Object.assign(new Error("write failed"), { code: "EACCES" }));
    const stateBefore = structuredClone(getState(WORKFLOW_ID));
    const versionBefore = getWorkflowVersion(WORKFLOW_ID);
    const extra = {
      signal: new AbortController().signal,
      requestInfo: { headers: { "x-ai-identity": token } },
    } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;

    const result = await submit({
      file_path: FILE_PATH,
      git_commit_hash: "abcdef9",
    }, extra);
    const payload = JSON.parse((result.content[0] as { text: string }).text);

    expect(payload.ok).toBe(false);
    expect(payload.tip).toContain("failed to write meta.json");
    expect(payload.tip).toContain("EACCES");
    expect(getState(WORKFLOW_ID)).toEqual(stateBefore);
    expect(getWorkflowVersion(WORKFLOW_ID)).toBe(versionBefore);
  });
});

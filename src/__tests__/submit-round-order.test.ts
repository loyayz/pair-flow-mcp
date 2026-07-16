import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { submit } from "../tools/submit.js";
import { bindWorkflow, registerToken } from "../token-map.js";
import { defaultState, deleteState, getState, setState } from "../state.js";
import { getWorkflowVersion } from "../workflow-events.js";
import { claimTurn } from "../tools/claim-turn.js";

const WORKFLOW_ID = "20260711000002";
const WORK_DIR = join(tmpdir(), `pairflow-submit-round-${randomUUID()}`);
const FILE_PATH = join(WORK_DIR, "handoff", WORKFLOW_ID, "requirements", "r3_alice.md");
let token = "";

function requestExtra(): RequestHandlerExtra<ServerRequest, ServerNotification> {
  return {
    signal: new AbortController().signal,
    requestInfo: { headers: { "x-ai-identity": token } },
  } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

async function payload(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await submit(args, requestExtra());
  return JSON.parse((result.content[0] as { text: string }).text);
}

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
  vi.useRealTimers();
  deleteState(WORKFLOW_ID);
  await rm(WORK_DIR, { recursive: true, force: true });
});

describe("submit commit ordering", () => {
  it("requires the assigned holder to claim before a normal submission", async () => {
    const state = getState(WORKFLOW_ID)!;
    state.turn_claimed_at = null;
    const before = structuredClone(state);
    const versionBefore = getWorkflowVersion(WORKFLOW_ID);

    const rejected = await payload({ file_path: FILE_PATH, git_commit_hash: "abcdef9" });

    expect(rejected.ok).toBe(false);
    expect(rejected.tip).toContain("claim_turn");
    expect(getState(WORKFLOW_ID)).toEqual(before);
    expect(getWorkflowVersion(WORKFLOW_ID)).toBe(versionBefore);
    await expect(readFile(FILE_PATH.replace(/\.md$/, ".meta.json"), "utf-8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const claimed = await claimTurn(requestExtra());
    expect(JSON.parse((claimed.content[0] as { text: string }).text).ok).toBe(true);

    const submitted = await payload({ file_path: FILE_PATH, git_commit_hash: "abcdef9" });
    expect(submitted.ok).toBe(true);
  });

  it("returns an exact immediate retry idempotently without advancing or rewriting meta", async () => {
    const replayFile = join(WORK_DIR, "handoff", WORKFLOW_ID, "requirements", "r1_alice.md");
    const metaFile = replayFile.replace(/\.md$/, ".meta.json");
    await writeFile(replayFile, "# submitted requirements", "utf-8");
    await writeFile(metaFile, "sentinel", "utf-8");
    const state = getState(WORKFLOW_ID)!;
    state.round = 2;
    state.turn = "bob";
    state.turn_switched_at = "2026-07-11T00:20:00.000Z";
    state.turn_claimed_at = null;
    state.wait_warning_cycle = {
      kind: "turn",
      generation: 5,
      next_report_at: "2026-07-11T00:50:00.000Z",
      reported_at: null,
      reported_to: null,
    };
    state.last_submission_by_participant = {
      alice: { round: 1, sub_phase: null, commit_hash: "abc1234", submitted_at: "2026-07-11T00:20:00.000Z", file_path: replayFile },
      bob: { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null },
    };

    const versionBefore = getWorkflowVersion(WORKFLOW_ID);
    const result = await payload({ file_path: replayFile, git_commit_hash: "ABC1234" });

    expect(result.ok).toBe(true);
    expect(result.next_turn).toBe("bob");
    expect(getState(WORKFLOW_ID)).toMatchObject({
      round: 2,
      turn: "bob",
      turn_switched_at: "2026-07-11T00:20:00.000Z",
      turn_claimed_at: null,
      wait_warning_cycle: {
        kind: "turn",
        generation: 5,
        next_report_at: "2026-07-11T00:50:00.000Z",
      },
    });
    expect(getWorkflowVersion(WORKFLOW_ID)).toBe(versionBefore);
    expect(await readFile(metaFile, "utf-8")).toBe("sentinel");
  });

  it("compares git_commit_hash with the highest-round submission", async () => {
    getState(WORKFLOW_ID)!.turn_claimed_at = "2026-07-11T00:30:00.000Z";
    const sameCaseInsensitiveHash = await payload({
      file_path: FILE_PATH,
      git_commit_hash: "DEF5678",
    });
    const sameHashWithMoreCharacters = await payload({
      file_path: FILE_PATH,
      git_commit_hash: "DEF5678A",
    });

    expect(sameCaseInsensitiveHash.ok).toBe(false);
    expect(sameCaseInsensitiveHash.tip).toContain("git_commit_hash unchanged since last submission");
    expect(sameHashWithMoreCharacters.ok).toBe(false);
    expect(sameHashWithMoreCharacters.tip).toContain("git_commit_hash unchanged since last submission");
  });

  it("rejects non-string handler inputs", async () => {
    const invalidPath = await payload({ file_path: 42, git_commit_hash: "fedcba9" });
    const invalidHash = await payload({ file_path: FILE_PATH, git_commit_hash: 1234567 });

    expect(invalidPath.ok).toBe(false);
    expect(invalidPath.tip).toContain("file_path must be a string");
    expect(invalidHash.ok).toBe(false);
    expect(invalidHash.tip).toContain("git_commit_hash must be a string");
  });

  it("rejects zero-byte output without advancing workflow state", async () => {
    getState(WORKFLOW_ID)!.turn_claimed_at = "2026-07-11T00:30:00.000Z";
    await writeFile(FILE_PATH, "", "utf-8");

    const result = await payload({ file_path: FILE_PATH, git_commit_hash: "fedcba9" });

    expect(result.ok).toBe(false);
    expect(result.tip).toContain("file_path must not be empty");
    expect(getState(WORKFLOW_ID)?.round).toBe(3);
    expect(getState(WORKFLOW_ID)?.turn).toBe("alice");
  });

  it("normalizes commit hashes and uses one submission timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T01:00:00.000Z"));
    const stateBefore = getState(WORKFLOW_ID)!;
    stateBefore.turn_claimed_at = "2026-07-11T00:40:00.000Z";
    stateBefore.wait_warning_cycle = {
      kind: "turn",
      generation: 2,
      next_report_at: "2026-07-11T00:50:00.000Z",
      reported_at: "2026-07-11T00:51:00.000Z",
      reported_to: "alice",
    };
    const versionBefore = getWorkflowVersion(WORKFLOW_ID);

    const result = await payload({ file_path: FILE_PATH, git_commit_hash: "ABCDEF9" });
    const state = getState(WORKFLOW_ID)!;
    const meta = JSON.parse(await readFile(FILE_PATH.replace(/\.md$/, ".meta.json"), "utf-8"));

    expect(result.ok).toBe(true);
    expect(state.last_submission_by_participant.alice.commit_hash).toBe("abcdef9");
    expect(meta.commit_hash).toBe("abcdef9");
    expect(meta.submitted_at).toBe(state.last_submission_by_participant.alice.submitted_at);
    expect(state.turn_switched_at).toBe(meta.submitted_at);
    expect(state.turn_claimed_at).toBeNull();
    expect(state.wait_warning_cycle).toEqual({
      kind: "turn",
      generation: 3,
      next_report_at: "2026-07-11T01:30:00.000Z",
      reported_at: null,
      reported_to: null,
    });
    expect(getWorkflowVersion(WORKFLOW_ID)).toBeGreaterThan(versionBefore);
  });

  it("rejects an invalid implementation sub_phase", async () => {
    const implementationPath = join(WORK_DIR, "handoff", WORKFLOW_ID, "implementation", "r3_alice.md");
    await mkdir(dirname(implementationPath), { recursive: true });
    await writeFile(implementationPath, "# implementation", "utf-8");
    const state = getState(WORKFLOW_ID)!;
    state.turn_claimed_at = "2026-07-11T00:30:00.000Z";
    state.phase = "implementation";
    state.sub_phase = null;

    const result = await payload({ file_path: implementationPath, git_commit_hash: "fedcba9" });

    expect(result.ok).toBe(false);
    expect(result.tip).toContain("implementation sub_phase must be coding or review");
    expect(getState(WORKFLOW_ID)?.round).toBe(3);
  });

  it("rejects submission until both participants have joined", async () => {
    getState(WORKFLOW_ID)!.participants.pop();

    const result = await payload({ file_path: FILE_PATH, git_commit_hash: "fedcba9" });

    expect(result.ok).toBe(false);
    expect(result.tip).toContain("both participants must join via confirm_task before submit");
    expect(getState(WORKFLOW_ID)?.round).toBe(3);
  });

  it("rejects symbolic links at the expected handoff path", async ({ skip }) => {
    getState(WORKFLOW_ID)!.turn_claimed_at = "2026-07-11T00:30:00.000Z";
    const targetPath = process.platform === "win32"
      ? join(WORK_DIR, "outside-directory")
      : join(WORK_DIR, "outside.md");
    if (process.platform === "win32") {
      await mkdir(targetPath, { recursive: true });
    } else {
      await writeFile(targetPath, "# outside archive", "utf-8");
    }
    await rm(FILE_PATH, { force: true });
    try {
      await symlink(targetPath, FILE_PATH, process.platform === "win32" ? "junction" : "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        skip();
        return;
      }
      throw error;
    }
    const result = await payload({
      file_path: FILE_PATH,
      git_commit_hash: "fedcba9",
    });

    expect(result.ok).toBe(false);
    expect(result.tip).toContain("symbolic links are not allowed");
  });

  it("rejects symbolic links in parent archive directories", async ({ skip }) => {
    getState(WORKFLOW_ID)!.turn_claimed_at = "2026-07-11T00:30:00.000Z";
    const phaseDirectory = dirname(FILE_PATH);
    const outsidePhaseDirectory = join(WORK_DIR, "outside-phase");
    await rm(phaseDirectory, { recursive: true, force: true });
    await mkdir(outsidePhaseDirectory, { recursive: true });
    await writeFile(join(outsidePhaseDirectory, "r3_alice.md"), "# outside phase", "utf-8");
    try {
      await symlink(
        outsidePhaseDirectory,
        phaseDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        skip();
        return;
      }
      throw error;
    }
    const result = await payload({
      file_path: FILE_PATH,
      git_commit_hash: "fedcba9",
    });

    expect(result.ok).toBe(false);
    expect(result.tip).toContain("symbolic links are not allowed");
  });
});

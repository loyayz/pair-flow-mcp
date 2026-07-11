import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { reconstructFromHandoff, parseFilename } from "../crash-recovery.js";
import { defaultState } from "../state.js";

const TEST_ROOT = join(tmpdir(), `pairflow-test-${randomUUID()}`);
const origCwd = process.cwd();
const HANDOFF_DIR = "handoff";

function validMeta(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    submitted_at: "2026-06-22T00:00:00.000Z",
    commit_hash: "abc1234",
    sub_phase: null,
    task: { spec_file: join(TEST_ROOT, "task.md"), task_type: "development" },
    ...overrides,
  });
}

async function resetStateDir() {
  await mkdir(TEST_ROOT, { recursive: true });
  process.chdir(TEST_ROOT);
  try { await rm(join(TEST_ROOT, HANDOFF_DIR), { recursive: true }); } catch { /* */ }
}

afterEach(() => {
  process.chdir(origCwd);
});

describe("Handoff reconstruction", () => {
  beforeEach(resetStateDir);
  afterEach(resetStateDir);

  it("returns null when no handoff exists", async () => {
    const st = defaultState();
    const recovered = await reconstructFromHandoff(st, "00000000000000", TEST_ROOT, join(TEST_ROOT, "task.md"));
    expect(recovered).toBeNull();
  });

  it("recovers from handoff with given workflow_id", async () => {
    const wfId = "20260622000001";
    const wfDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "requirements");
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, "r1_alice.meta.json"), validMeta());
    await writeFile(join(wfDir, "r2_bob.meta.json"), validMeta({
      submitted_at: "2026-06-22T00:02:00.000Z",
      commit_hash: "def5678",
    }));

    const st = defaultState();
    const recovered = await reconstructFromHandoff(st, wfId, TEST_ROOT, join(TEST_ROOT, "task.md"));
    expect(recovered).not.toBeNull();
    expect(recovered!.workflow_id).toBe(wfId);
  });

  it("recovers summary when summary submissions exist", async () => {
    const wfId = "20260622000004";
    const requirementsDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "requirements");
    const summaryDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "summary");
    await mkdir(requirementsDir, { recursive: true });
    await mkdir(summaryDir, { recursive: true });
    await writeFile(join(requirementsDir, "r1_alice.meta.json"), validMeta());
    await writeFile(join(summaryDir, "r1_alice.meta.json"), validMeta({ submitted_at: "2026-06-22T00:01:00.000Z" }));
    await writeFile(join(summaryDir, "r2_bob.meta.json"), validMeta({
      submitted_at: "2026-06-22T00:02:00.000Z",
      commit_hash: "def5678",
    }));

    const recovered = await reconstructFromHandoff(defaultState(), wfId, TEST_ROOT, join(TEST_ROOT, "task.md"));
    expect(recovered).not.toBeNull();
    expect(recovered!.phase).toBe("summary");
  });

  it("recovers the state immediately after the latest implementation submission", async () => {
    const wfId = "20260622000006";
    const implementationDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "implementation");
    await mkdir(implementationDir, { recursive: true });
    await writeFile(join(implementationDir, "r9_coding_alice.meta.json"), validMeta({
      submitted_at: "2026-06-22T00:10:00.000Z",
      commit_hash: "abcdef1",
      sub_phase: "coding",
    }));
    await writeFile(join(implementationDir, "r2_review_bob.meta.json"), validMeta({
      submitted_at: "2026-06-22T00:02:00.000Z",
      commit_hash: "abcdef2",
      sub_phase: "review",
    }));

    const recovered = await reconstructFromHandoff(defaultState(), wfId, TEST_ROOT, join(TEST_ROOT, "task.md"));

    expect(recovered).not.toBeNull();
    expect(recovered!.phase).toBe("implementation");
    expect(recovered!.round).toBe(10);
    expect(recovered!.turn).toBe("bob");
    expect(recovered!.sub_phase).toBe("review");
    expect(recovered!.turn_switched_at).toBe("2026-06-22T00:10:00.000Z");
    expect(recovered!.turn_claimed_at).toBeNull();
  });

  it("rejects implementation recovery when sub_phase conflicts with round parity", async () => {
    const wfId = "20260622000013";
    const implementationDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "implementation");
    await mkdir(implementationDir, { recursive: true });
    await writeFile(join(implementationDir, "r1_review_alice.meta.json"), validMeta({
      submitted_at: "2026-06-22T00:01:00.000Z",
      sub_phase: "review",
    }));

    const recovered = await reconstructFromHandoff(
      defaultState(),
      wfId,
      TEST_ROOT,
      join(TEST_ROOT, "task.md"),
    );

    expect(recovered).toBeNull();
  });

  it("rejects implementation recovery when the filename omits sub_phase", async () => {
    const wfId = "20260622000014";
    const implementationDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "implementation");
    await mkdir(implementationDir, { recursive: true });
    await writeFile(join(implementationDir, "r1_alice.meta.json"), validMeta({
      submitted_at: "2026-06-22T00:01:00.000Z",
      sub_phase: "coding",
    }));

    const recovered = await reconstructFromHandoff(
      defaultState(),
      wfId,
      TEST_ROOT,
      join(TEST_ROOT, "task.md"),
    );

    expect(recovered).toBeNull();
  });

  it("ignores invalid implementation history when valid summary submissions exist", async () => {
    const wfId = "20260622000015";
    const implementationDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "implementation");
    const summaryDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "summary");
    await mkdir(implementationDir, { recursive: true });
    await mkdir(summaryDir, { recursive: true });
    await writeFile(join(implementationDir, "r2_coding_alice.meta.json"), validMeta({
      submitted_at: "2026-06-22T00:02:00.000Z",
      sub_phase: "coding",
    }));
    await writeFile(join(summaryDir, "r1_alice.meta.json"), validMeta({
      submitted_at: "2026-06-22T00:03:00.000Z",
    }));

    const recovered = await reconstructFromHandoff(
      defaultState(),
      wfId,
      TEST_ROOT,
      join(TEST_ROOT, "task.md"),
    );

    expect(recovered).not.toBeNull();
    expect(recovered!.phase).toBe("summary");
  });

  it("ignores corrupt metadata when determining the latest phase", async () => {
    const wfId = "20260622000016";
    const requirementsDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "requirements");
    const summaryDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "summary");
    await mkdir(requirementsDir, { recursive: true });
    await mkdir(summaryDir, { recursive: true });
    await writeFile(join(requirementsDir, "r1_alice.meta.json"), validMeta());
    await writeFile(join(summaryDir, "r1_alice.meta.json"), "{not-json", "utf-8");

    const recovered = await reconstructFromHandoff(
      defaultState(),
      wfId,
      TEST_ROOT,
      join(TEST_ROOT, "task.md"),
    );

    expect(recovered).not.toBeNull();
    expect(recovered!.phase).toBe("requirements");
  });

  it("uses round order rather than timestamps for each participant's latest submission", async () => {
    const wfId = "20260622000010";
    const requirementsDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "requirements");
    await mkdir(requirementsDir, { recursive: true });
    await writeFile(join(requirementsDir, "r2_alice.meta.json"), validMeta({
      submitted_at: "2026-06-22T00:20:00.000Z",
      commit_hash: "abcdef2",
    }));
    await writeFile(join(requirementsDir, "r10_alice.meta.json"), validMeta({
      submitted_at: "2026-06-22T00:10:00.000Z",
      commit_hash: "abcdef10",
    }));

    const recovered = await reconstructFromHandoff(
      defaultState(),
      wfId,
      TEST_ROOT,
      join(TEST_ROOT, "task.md"),
    );

    expect(recovered).not.toBeNull();
    expect(recovered!.last_submission_by_participant.alice.round).toBe(10);
    expect(recovered!.last_submission_by_participant.alice.commit_hash).toBe("abcdef10");
  });

  it("keeps the current task path while recovering task_type from metadata", async () => {
    const wfId = "20260622000007";
    const requirementsDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "requirements");
    const currentTaskPath = join(TEST_ROOT, "moved-task.md");
    await mkdir(requirementsDir, { recursive: true });
    await writeFile(join(requirementsDir, "r1_alice.meta.json"), validMeta({
      submitted_at: "2026-06-22T00:01:00.000Z",
      task: { spec_file: join(TEST_ROOT, "old-task.md"), task_type: "requirements" },
    }));

    const recovered = await reconstructFromHandoff(defaultState(), wfId, TEST_ROOT, currentTaskPath);

    expect(recovered).not.toBeNull();
    expect(recovered!.task).toEqual({
      spec_file: currentTaskPath,
      task_type: "requirements",
    });
  });

  it("rejects recovery when metadata contains conflicting task types", async () => {
    const wfId = "20260622000008";
    const requirementsDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "requirements");
    await mkdir(requirementsDir, { recursive: true });
    await writeFile(join(requirementsDir, "r1_alice.meta.json"), validMeta({
      task: { spec_file: join(TEST_ROOT, "task.md"), task_type: "requirements" },
    }));
    await writeFile(join(requirementsDir, "r2_bob.meta.json"), validMeta({
      submitted_at: "2026-06-22T00:02:00.000Z",
      commit_hash: "def5678",
      task: { spec_file: join(TEST_ROOT, "task.md"), task_type: "development" },
    }));

    const initialState = defaultState();
    const recovered = await reconstructFromHandoff(
      initialState,
      wfId,
      TEST_ROOT,
      join(TEST_ROOT, "task.md"),
    );

    expect(recovered).toBeNull();
    expect(initialState).toEqual(defaultState());
  });

  it("ignores task phases that are incompatible with a requirements-only workflow", async () => {
    const wfId = "20260622000017";
    const requirementsDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "requirements");
    const implementationDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "implementation");
    await mkdir(requirementsDir, { recursive: true });
    await mkdir(implementationDir, { recursive: true });
    const requirementsTask = { spec_file: join(TEST_ROOT, "task.md"), task_type: "requirements" };
    await writeFile(join(requirementsDir, "r1_alice.meta.json"), validMeta({ task: requirementsTask }));
    await writeFile(join(implementationDir, "r1_coding_alice.meta.json"), validMeta({
      submitted_at: "2026-06-22T00:02:00.000Z",
      sub_phase: "coding",
      task: requirementsTask,
    }));

    const recovered = await reconstructFromHandoff(defaultState(), wfId, TEST_ROOT, join(TEST_ROOT, "task.md"));

    expect(recovered).not.toBeNull();
    expect(recovered!.phase).toBe("requirements");
    expect(recovered!.task?.task_type).toBe("requirements");
  });

  it("rejects recovery when the archive contains more than two identities", async () => {
    const wfId = "20260622000009";
    const requirementsDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "requirements");
    await mkdir(requirementsDir, { recursive: true });
    for (const [round, identity] of ["alice", "bob", "charlie"].entries()) {
      await writeFile(
        join(requirementsDir, `r${round + 1}_${identity}.meta.json`),
        validMeta({
          submitted_at: `2026-06-22T00:0${round + 1}:00.000Z`,
          commit_hash: `abc123${round + 4}`,
        }),
      );
    }

    const recovered = await reconstructFromHandoff(
      defaultState(),
      wfId,
      TEST_ROOT,
      join(TEST_ROOT, "task.md"),
    );

    expect(recovered).toBeNull();
  });

  it("rejects recovery when a phase contains duplicate rounds", async () => {
    const wfId = "20260622000011";
    const requirementsDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "requirements");
    await mkdir(requirementsDir, { recursive: true });
    await writeFile(join(requirementsDir, "r2_alice.meta.json"), validMeta({
      submitted_at: "2026-06-22T00:01:00.000Z",
    }));
    await writeFile(join(requirementsDir, "r2_bob.meta.json"), validMeta({
      submitted_at: "2026-06-22T00:02:00.000Z",
      commit_hash: "def5678",
    }));

    const recovered = await reconstructFromHandoff(
      defaultState(),
      wfId,
      TEST_ROOT,
      join(TEST_ROOT, "task.md"),
    );

    expect(recovered).toBeNull();
  });

  it("rejects duplicate rounds in an earlier phase", async () => {
    const wfId = "20260622000018";
    const requirementsDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "requirements");
    const summaryDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "summary");
    await mkdir(requirementsDir, { recursive: true });
    await mkdir(summaryDir, { recursive: true });
    await writeFile(join(requirementsDir, "r1_alice.meta.json"), validMeta());
    await writeFile(join(requirementsDir, "r1_bob.meta.json"), validMeta({ commit_hash: "def5678" }));
    await writeFile(join(summaryDir, "r1_alice.meta.json"), validMeta({ commit_hash: "fedcba9" }));

    const recovered = await reconstructFromHandoff(defaultState(), wfId, TEST_ROOT, join(TEST_ROOT, "task.md"));

    expect(recovered).toBeNull();
  });

  it("rejects participant identities that conflict with round alternation", async () => {
    const wfId = "20260622000019";
    const requirementsDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "requirements");
    await mkdir(requirementsDir, { recursive: true });
    await writeFile(join(requirementsDir, "r1_alice.meta.json"), validMeta());
    await writeFile(join(requirementsDir, "r2_alice.meta.json"), validMeta({ commit_hash: "def5678" }));

    const recovered = await reconstructFromHandoff(defaultState(), wfId, TEST_ROOT, join(TEST_ROOT, "task.md"));

    expect(recovered).toBeNull();
  });

  it("allows missing historical rounds and resumes after the highest round", async () => {
    const wfId = "20260622000012";
    const requirementsDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "requirements");
    await mkdir(requirementsDir, { recursive: true });
    await writeFile(join(requirementsDir, "r1_alice.meta.json"), validMeta({
      submitted_at: "2026-06-22T00:01:00.000Z",
    }));
    await writeFile(join(requirementsDir, "r4_bob.meta.json"), validMeta({
      submitted_at: "2026-06-22T00:04:00.000Z",
      commit_hash: "def5678",
    }));

    const recovered = await reconstructFromHandoff(
      defaultState(),
      wfId,
      TEST_ROOT,
      join(TEST_ROOT, "task.md"),
    );

    expect(recovered).not.toBeNull();
    expect(recovered!.round).toBe(5);
    expect(recovered!.turn).toBe("alice");
  });

  it("ignores metadata below phase directories", async () => {
    const wfId = "20260622000020";
    const requirementsDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "requirements");
    const backupDir = join(requirementsDir, "backup");
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(requirementsDir, "r1_alice.meta.json"), validMeta());
    await writeFile(join(backupDir, "r2_charlie.meta.json"), validMeta({ commit_hash: "def5678" }));

    const recovered = await reconstructFromHandoff(defaultState(), wfId, TEST_ROOT, join(TEST_ROOT, "task.md"));

    expect(recovered).not.toBeNull();
    expect(recovered!.participants.map((participant) => participant.identity)).toEqual(["alice"]);
    expect(recovered!.round).toBe(2);
  });

  it("surfaces archive structure errors instead of treating them as an empty archive", async () => {
    const wfId = "20260622000021";
    const workflowDir = join(TEST_ROOT, HANDOFF_DIR, wfId);
    await mkdir(workflowDir, { recursive: true });
    await writeFile(join(workflowDir, "requirements"), "not a directory", "utf-8");

    await expect(reconstructFromHandoff(defaultState(), wfId, TEST_ROOT, join(TEST_ROOT, "task.md")))
      .rejects.toThrow(/failed to read recovery archive.*requirements.*ENOTDIR/i);
  });

  it("rejects symbolic phase directories instead of reading through them", async () => {
    const wfId = "20260622000022";
    const workflowDir = join(TEST_ROOT, HANDOFF_DIR, wfId);
    const outsidePhaseDir = join(TEST_ROOT, "outside-recovery-phase");
    const phaseDir = join(workflowDir, "requirements");
    await mkdir(workflowDir, { recursive: true });
    await mkdir(outsidePhaseDir, { recursive: true });
    await writeFile(join(outsidePhaseDir, "r1_alice.meta.json"), validMeta());
    await symlink(outsidePhaseDir, phaseDir, process.platform === "win32" ? "junction" : "dir");

    await expect(reconstructFromHandoff(defaultState(), wfId, TEST_ROOT, join(TEST_ROOT, "task.md")))
      .rejects.toThrow(/symbolic links are not allowed in recovery archive/i);
  });

  it("ignores archived filenames with invalid identity segments", async () => {
    const wfId = "20260622000005";
    const wfDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "requirements");
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, "r1_bad.identity.meta.json"), validMeta());

    const recovered = await reconstructFromHandoff(defaultState(), wfId, TEST_ROOT, join(TEST_ROOT, "task.md"));
    expect(recovered).toBeNull();
  });
});

describe("parseFilename", () => {
  it("parses requirements filename: r1_alice.meta.json", () => {
    const r = parseFilename("r1_alice.meta.json");
    expect(r).toEqual({ round: 1, sub_phase: null, identity: "alice" });
  });

  it("parses requirements filename: r2_bob.md", () => {
    const r = parseFilename("r2_bob.md");
    expect(r).toEqual({ round: 2, sub_phase: null, identity: "bob" });
  });

  it("parses implementation coding: r1_coding_alice.meta.json", () => {
    const r = parseFilename("r1_coding_alice.meta.json");
    expect(r).toEqual({ round: 1, sub_phase: "coding", identity: "alice" });
  });

  it("parses implementation review: r3_review_bob.md", () => {
    const r = parseFilename("r3_review_bob.md");
    expect(r).toEqual({ round: 3, sub_phase: "review", identity: "bob" });
  });

  it("parses underscore suffixes as part of the identity", () => {
    const r = parseFilename("r1_alice_final.md");
    expect(r).toEqual({ round: 1, sub_phase: null, identity: "alice_final" });
  });

  it("returns null for unrecognized format", () => {
    expect(parseFilename("random.txt")).toBeNull();
    expect(parseFilename("r0_alice.md")).toBeNull();
    expect(parseFilename("r1_.md")).toBeNull();
    expect(parseFilename("r1_bad.identity.md")).toBeNull();
    expect(parseFilename("r1_bad@identity.md")).toBeNull();
    expect(parseFilename(`r1_${"a".repeat(65)}.md`)).toBeNull();
    expect(parseFilename("r1_unknown.md")).toBeNull();
    expect(parseFilename("r1_IDLE.md")).toBeNull();
    expect(parseFilename("")).toBeNull();
    expect(parseFilename(`r${"9".repeat(400)}_alice.md`)).toBeNull();
  });
});

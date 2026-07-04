import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { reconstructFromHandoff, parseFilename, isWorkflowComplete } from "../crash-recovery.js";
import { defaultState } from "../state.js";

const TEST_ROOT = join(tmpdir(), `pairflow-test-${randomUUID()}`);
const origCwd = process.cwd();
const HANDOFF_DIR = process.env.HANDOFF_DIR || "handoff";

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
    const recovered = await reconstructFromHandoff(st, "00000000000000");
    expect(recovered).toBeNull();
  });

  it("recovers from handoff with given workflow_id", async () => {
    const wfId = "20260622000001";
    const wfDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "requirements");
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, "r1_alice.meta.json"), JSON.stringify({ round: 1 }));
    await writeFile(join(wfDir, "r1_bob.meta.json"), JSON.stringify({ round: 1 }));

    const st = defaultState();
    const recovered = await reconstructFromHandoff(st, wfId);
    expect(recovered).not.toBeNull();
    expect(recovered!.workflow_id).toBe(wfId);
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

  it("parses filename with _final suffix: r1_alice_final.md", () => {
    const r = parseFilename("r1_alice_final.md");
    expect(r).toEqual({ round: 1, sub_phase: null, identity: "alice" });
  });

  it("returns null for unrecognized format", () => {
    expect(parseFilename("random.txt")).toBeNull();
    expect(parseFilename("r1_.md")).toBeNull();
    expect(parseFilename("")).toBeNull();
  });
});

describe("isWorkflowComplete", () => {
  beforeEach(resetStateDir);
  afterEach(resetStateDir);

  it("returns false when summary dir does not exist", async () => {
    const complete = await isWorkflowComplete("99999999999999");
    expect(complete).toBe(false);
  });

  it("returns true when summary dir has files", async () => {
    const wfId = "20260622000002";
    const summaryDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "summary");
    await mkdir(summaryDir, { recursive: true });
    await writeFile(join(summaryDir, "r1_alice.md"), "# Summary");

    const complete = await isWorkflowComplete(wfId);
    expect(complete).toBe(true);
  });

  it("returns false when summary dir exists but is empty", async () => {
    const wfId = "20260622000003";
    const summaryDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "summary");
    await mkdir(summaryDir, { recursive: true });

    const complete = await isWorkflowComplete(wfId);
    expect(complete).toBe(false);
  });
});

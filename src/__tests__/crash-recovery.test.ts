import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { reconstructFromHandoff } from "../crash-recovery.js";
import { saveState, defaultState } from "../state.js";

const TEST_ROOT = join(tmpdir(), `pairflow-test-${randomUUID()}`);
const origCwd = process.cwd();
const STATE_DIR = process.env.STATE_DIR || ".pairflow";
const HANDOFF_DIR = process.env.HANDOFF_DIR || "handoff";

async function resetStateDir() {
  await mkdir(TEST_ROOT, { recursive: true });
  process.chdir(TEST_ROOT);
  try { await rm(join(TEST_ROOT, STATE_DIR), { recursive: true }); } catch { /* */ }
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
    const recovered = await reconstructFromHandoff(st);
    expect(recovered).toBeNull();
  });

  it("recovers from handoff with given workflow_id", async () => {
    const wfId = "20260622000001";
    const wfDir = join(TEST_ROOT, HANDOFF_DIR, wfId, "requirements");
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, "r1_alice.meta.json"), JSON.stringify({ round: 1 }));
    await writeFile(join(wfDir, "r1_bob.meta.json"), JSON.stringify({ round: 1 }));

    const st = defaultState();
    const recovered = await reconstructFromHandoff(st, undefined, wfId);
    expect(recovered).not.toBeNull();
    expect(recovered!.workflow_id).toBe(wfId);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { recoverState } from "../crash-recovery.js";
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

describe("Crash recovery", () => {
  beforeEach(resetStateDir);
  afterEach(resetStateDir);

  it("returns default state when no state exists", async () => {
    const state = await recoverState();
    expect(state.phase).toBe("idle");
  });

  it("recovers IDLE with cleared peers", async () => {
    const st = defaultState();
    st.peers = [{ identity: "a", role: "supervisor", is_developer: false, registered_at: "" }];
    await saveState(st);
    const recovered = await recoverState();
    expect(recovered.phase).toBe("idle");
    expect(recovered.peers).toEqual([]);
  });

  it("finds latest workflow_id from handoff", async () => {
    const wfDir = join(TEST_ROOT, HANDOFF_DIR, "20260622000001", "requirements");
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, "r1_alice.meta.json"), JSON.stringify({ round: 1, new_issues: [] }));

    const st = defaultState();
    st.phase = "requirements";
    await saveState(st);
    const recovered = await recoverState();
    expect(recovered.workflow_id).toBe("20260622000001");
  });
});

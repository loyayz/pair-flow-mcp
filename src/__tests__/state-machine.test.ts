import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { defaultState, loadState, saveState, initRequirementsPhase, initPlanningPhase, initImplementationPhase, isSupervisor, getOtherIdentity } from "../state.js";
import type { PairFlowState } from "../state.js";

async function resetState() {
  try { await rm(".pairflow", { recursive: true }); } catch { /* ok */ }
  await mkdir(".pairflow", { recursive: true });
  await saveState(defaultState());
}

describe("State management", () => {
  beforeEach(resetState);
  afterEach(async () => { try { await rm(".pairflow", { recursive: true }); } catch { /* ok */ } });

  it("loads default state on first run", async () => {
    const state = await loadState();
    expect(state.schema_version).toBe(1);
    expect(state.phase).toBe("idle");
    expect(state.turn).toBe("idle");
  });

  it("saves and loads state", async () => {
    const state = defaultState();
    state.peers = [
      { identity: "alice", role: "supervisor", is_developer: false, registered_at: new Date().toISOString() },
      { identity: "bob", role: "peer", is_developer: true, registered_at: new Date().toISOString() },
    ];
    await saveState(state);
    const loaded = await loadState();
    expect(loaded.peers.length).toBe(2);
    expect(loaded.peers[0].identity).toBe("alice");
  });

  it("initRequirementsPhase sets correct initial turn", () => {
    const state = defaultState();
    state.peers = [
      { identity: "supervisor", role: "supervisor", is_developer: false, registered_at: "" },
      { identity: "peer", role: "peer", is_developer: false, registered_at: "" },
    ];
    const next = initRequirementsPhase(state, "peer");
    expect(next.phase).toBe("requirements");
    expect(next.turn).toBe("peer");
    expect(next.workflow_id).toBeTruthy();
    expect(next.workflow_id).toMatch(/^\d{14}$/);
  });
});

describe("Role helpers", () => {
  it("identifies supervisor", () => {
    const state = defaultState();
    state.peers = [
      { identity: "admin", role: "supervisor", is_developer: false, registered_at: "" },
      { identity: "user", role: "peer", is_developer: true, registered_at: "" },
    ];
    expect(isSupervisor(state, "admin")).toBe(true);
    expect(isSupervisor(state, "user")).toBe(false);
  });

  it("gets other identity", () => {
    const state = defaultState();
    state.peers = [
      { identity: "a", role: "supervisor", is_developer: false, registered_at: "" },
      { identity: "b", role: "peer", is_developer: true, registered_at: "" },
    ];
    expect(getOtherIdentity(state, "a")).toBe("b");
    expect(getOtherIdentity(state, "b")).toBe("a");
  });
});

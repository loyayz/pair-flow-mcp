import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { defaultState, setState, getState, deleteState, initRequirementsPhase, initPlanningPhase, initImplementationPhase, isSupervisor, getOtherIdentity } from "../state.js";
import type { PairFlowState } from "../state.js";

const TEST_WF = "20260701000001";

function resetState() {
  deleteState(TEST_WF);
}

describe("State management", () => {
  beforeEach(resetState);
  afterEach(resetState);

  it("returns undefined for unknown workflow", () => {
    expect(getState(TEST_WF)).toBeUndefined();
  });

  it("sets and gets state", () => {
    const state = defaultState();
    state.workflow_id = TEST_WF;
    state.peers = [
      { identity: "alice", role: "supervisor", is_developer: false, registered_at: new Date().toISOString() },
      { identity: "bob", role: "peer", is_developer: true, registered_at: new Date().toISOString() },
    ];
    setState(TEST_WF, state);
    const loaded = getState(TEST_WF);
    expect(loaded).toBeDefined();
    expect(loaded!.peers.length).toBe(2);
    expect(loaded!.peers[0].identity).toBe("alice");
  });

  it("deletes state", () => {
    setState(TEST_WF, defaultState());
    expect(getState(TEST_WF)).toBeDefined();
    deleteState(TEST_WF);
    expect(getState(TEST_WF)).toBeUndefined();
  });

  it("initRequirementsPhase sets correct initial turn", () => {
    const state = defaultState();
    state.workflow_id = "20260627000000";
    state.peers = [
      { identity: "supervisor", role: "supervisor", is_developer: false, registered_at: "" },
      { identity: "peer", role: "peer", is_developer: false, registered_at: "" },
    ];
    const next = initRequirementsPhase(state, "peer", { description: "test task" });
    expect(next.phase).toBe("requirements");
    expect(next.turn).toBe("peer");
    expect(next.workflow_id).toBe("20260627000000");
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

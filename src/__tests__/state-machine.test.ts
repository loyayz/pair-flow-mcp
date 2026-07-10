import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { defaultState, setState, getState, deleteState, initRequirementsPhase, initPlanningPhase, initImplementationPhase, isSupervisor, getOtherIdentity } from "../state.js";
import type { PairFlowState } from "../state.js";
import { buildTip } from "../tip.js";

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
    state.participants = [
      { identity: "alice", is_supervisor: true, is_developer: false, registered_at: new Date().toISOString() },
      { identity: "bob", is_supervisor: false, is_developer: true, registered_at: new Date().toISOString() },
    ];
    setState(TEST_WF, state);
    const loaded = getState(TEST_WF);
    expect(loaded).toBeDefined();
    expect(loaded!.participants.length).toBe(2);
    expect(loaded!.participants[0].identity).toBe("alice");
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
    state.participants = [
      { identity: "supervisor", is_supervisor: true, is_developer: false, registered_at: "" },
      { identity: "participant", is_supervisor: false, is_developer: false, registered_at: "" },
    ];
    const next = initRequirementsPhase(state, "participant", { spec_file: "test-task.md" });
    expect(next.phase).toBe("requirements");
    expect(next.turn).toBe("participant");
    expect(next.workflow_id).toBe("20260627000000");
  });
});

describe("Role helpers", () => {
  it("identifies supervisor", () => {
    const state = defaultState();
    state.participants = [
      { identity: "admin", is_supervisor: true, is_developer: false, registered_at: "" },
      { identity: "user", is_supervisor: false, is_developer: true, registered_at: "" },
    ];
    expect(isSupervisor(state, "admin")).toBe(true);
    expect(isSupervisor(state, "user")).toBe(false);
  });

  it("gets other identity", () => {
    const state = defaultState();
    state.participants = [
      { identity: "a", is_supervisor: true, is_developer: false, registered_at: "" },
      { identity: "b", is_supervisor: false, is_developer: true, registered_at: "" },
    ];
    expect(getOtherIdentity(state, "a")).toBe("b");
    expect(getOtherIdentity(state, "b")).toBe("a");
  });
});

describe("Tip guidance", () => {
  it("does not tell supervisor to advance before both participants submitted", () => {
    const state: PairFlowState = {
      ...defaultState(),
      workflow_id: TEST_WF,
      phase: "planning",
      round: 2,
      turn: "supervisor",
      task: { spec_file: "C:/project/task.md", task_type: "development" },
      participants: [
        { identity: "supervisor", is_supervisor: true, is_developer: true, registered_at: "" },
        { identity: "reviewer", is_supervisor: false, is_developer: false, registered_at: "" },
      ],
      last_submission_by_participant: {
        supervisor: { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null },
        reviewer: { round: 1, sub_phase: null, commit_hash: "abc1234", submitted_at: "2026-07-10T00:00:00.000Z", file_path: "handoff/wf/planning/r1_reviewer.md" },
      },
    };

    const tip = buildTip(state, "supervisor");

    expect(tip).not.toContain("可直接调用 advance");
    expect(tip).toContain("调用 submit");
  });
});

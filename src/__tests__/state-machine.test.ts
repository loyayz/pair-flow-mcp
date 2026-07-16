import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { defaultState, setState, getState, deleteState, initRequirementsPhase, initPlanningPhase, initImplementationPhase, isSupervisor, getOtherIdentity } from "../state.js";
import type { PairFlowState } from "../state.js";
import { buildTip, identityLabel } from "../tip.js";

const TEST_WF = "20260701000001";

function resetState() {
  deleteState(TEST_WF);
}

function claimedState(): PairFlowState {
  return {
    ...defaultState(),
    turn_claimed_at: "2026-07-15T00:00:00.000Z",
  };
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
  it("shows combined supervisor and developer responsibilities", () => {
    const state = defaultState();
    state.participants = [
      { identity: "admin", is_supervisor: true, is_developer: true, registered_at: "" },
    ];

    expect(identityLabel(state, "admin")).toBe("admin（supervisor/developer）");
  });

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
  it("places workflow artifacts under work_dir/handoff", () => {
    const workDir = resolve("target-project");
    const state: PairFlowState = {
      ...claimedState(),
      workflow_id: TEST_WF,
      phase: "requirements",
      round: 1,
      turn: "alice",
      task: { spec_file: resolve(workDir, "task.md"), task_type: "development" },
      participants: [
        { identity: "alice", is_supervisor: false, is_developer: true, registered_at: "", work_dir: workDir },
        { identity: "bob", is_supervisor: true, is_developer: false, registered_at: "", work_dir: workDir },
      ],
    };

    const tip = buildTip(state, "alice");
    const expected = resolve(workDir, "handoff", TEST_WF, "requirements", "r1_alice.md").replace(/\\/g, "/");

    expect(tip).toContain(expected);
  });

  it("includes the task document in first-round requirements guidance", () => {
    const state: PairFlowState = {
      ...claimedState(),
      workflow_id: TEST_WF,
      phase: "requirements",
      round: 1,
      turn: "developer",
      task: { spec_file: "C:/project/task.md", task_type: "development" },
      participants: [
        { identity: "supervisor", is_supervisor: true, is_developer: false, registered_at: "", work_dir: resolve("project") },
        { identity: "developer", is_supervisor: false, is_developer: true, registered_at: "", work_dir: resolve("project") },
      ],
    };

    expect(buildTip(state, "developer")).toContain("C:/project/task.md");
  });

  it("points implementation review to the reviewer's planning document", () => {
    const state: PairFlowState = {
      ...claimedState(),
      workflow_id: TEST_WF,
      phase: "implementation",
      sub_phase: "review",
      round: 2,
      turn: "reviewer",
      task: { spec_file: "C:/project/task.md", task_type: "development" },
      participants: [
        { identity: "developer", is_supervisor: false, is_developer: true, registered_at: "", work_dir: resolve("project") },
        { identity: "reviewer", is_supervisor: true, is_developer: false, registered_at: "", work_dir: resolve("project") },
      ],
      last_submission_by_participant: {
        developer: { round: 1, sub_phase: "coding", commit_hash: "abc1234", submitted_at: "2026-07-10T00:00:00.000Z", file_path: "handoff/wf/implementation/r1_coding_developer.md" },
        reviewer: { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null },
      },
    };

    const tip = buildTip(state, "reviewer");

    expect(tip).toContain("planning/r1_reviewer.md");
    expect(tip).not.toContain("planning/r1_developer.md");
  });

  it("keeps pointing later planning rounds to the reviewer's round-one plan", () => {
    const state: PairFlowState = {
      ...claimedState(),
      workflow_id: TEST_WF,
      phase: "planning",
      round: 4,
      turn: "developer",
      task: { spec_file: "C:/project/task.md", task_type: "development" },
      participants: [
        { identity: "developer", is_supervisor: true, is_developer: true, registered_at: "", work_dir: resolve("project") },
        { identity: "reviewer", is_supervisor: false, is_developer: false, registered_at: "", work_dir: resolve("project") },
      ],
      last_submission_by_participant: {
        developer: { round: 2, sub_phase: null, commit_hash: "def5678", submitted_at: "2026-07-10T00:01:00.000Z", file_path: "C:/project/handoff/wf/planning/r2_developer.md" },
        reviewer: { round: 3, sub_phase: null, commit_hash: "abc1234", submitted_at: "2026-07-10T00:02:00.000Z", file_path: "C:/project/handoff/wf/planning/r3_reviewer.md" },
      },
    };

    const tip = buildTip(state, "developer");

    expect(tip).toContain("planning/r1_reviewer.md");
    expect(tip).not.toContain("planning/r1_developer.md");
  });

  it("includes the previous review artifact in later coding guidance", () => {
    const state: PairFlowState = {
      ...claimedState(),
      workflow_id: TEST_WF,
      phase: "implementation",
      sub_phase: "coding",
      round: 3,
      turn: "developer",
      task: { spec_file: "C:/project/task.md", task_type: "development" },
      participants: [
        { identity: "developer", is_supervisor: false, is_developer: true, registered_at: "", work_dir: resolve("project") },
        { identity: "reviewer", is_supervisor: true, is_developer: false, registered_at: "", work_dir: resolve("project") },
      ],
      last_submission_by_participant: {
        developer: { round: 1, sub_phase: "coding", commit_hash: "abc1234", submitted_at: "2026-07-10T00:00:00.000Z", file_path: "C:/project/handoff/wf/implementation/r1_coding_developer.md" },
        reviewer: { round: 2, sub_phase: "review", commit_hash: "def5678", submitted_at: "2026-07-10T00:01:00.000Z", file_path: "C:/project/handoff/wf/implementation/r2_review_reviewer.md" },
      },
    };

    expect(buildTip(state, "developer")).toContain("implementation/r2_review_reviewer.md");
  });

  it("points first-round summary guidance to the task and workflow archive", () => {
    const state: PairFlowState = {
      ...claimedState(),
      workflow_id: TEST_WF,
      phase: "summary",
      round: 1,
      turn: "supervisor",
      task: { spec_file: "C:/project/task.md", task_type: "development" },
      participants: [
        { identity: "supervisor", is_supervisor: true, is_developer: false, registered_at: "", work_dir: resolve("project") },
        { identity: "developer", is_supervisor: false, is_developer: true, registered_at: "", work_dir: resolve("project") },
      ],
    };

    const tip = buildTip(state, "supervisor");

    expect(tip).toContain("C:/project/task.md");
    expect(tip).toContain(`/handoff/${TEST_WF}/`);
  });

  it("does not give submission instructions to a participant without the turn", () => {
    const state: PairFlowState = {
      ...claimedState(),
      workflow_id: TEST_WF,
      phase: "implementation",
      sub_phase: "review",
      round: 2,
      turn: "reviewer",
      participants: [
        { identity: "developer", is_supervisor: false, is_developer: true, registered_at: "", work_dir: resolve("project") },
        { identity: "reviewer", is_supervisor: true, is_developer: false, registered_at: "", work_dir: resolve("project") },
      ],
      last_submission_by_participant: {},
    };

    const tip = buildTip(state, "developer");

    expect(tip).toContain("等待 reviewer");
    expect(tip).toContain("wait_for_turn");
    expect(tip).not.toContain("[产出]");
    expect(tip).not.toContain("调用 submit");
  });

  it("does not tell supervisor to advance before both participants submitted", () => {
    const state: PairFlowState = {
      ...claimedState(),
      workflow_id: TEST_WF,
      phase: "planning",
      round: 2,
      turn: "supervisor",
      task: { spec_file: "C:/project/task.md", task_type: "development" },
      participants: [
        { identity: "supervisor", is_supervisor: true, is_developer: true, registered_at: "", work_dir: resolve("project") },
        { identity: "reviewer", is_supervisor: false, is_developer: false, registered_at: "", work_dir: resolve("project") },
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

  it("keeps submission instructions out of the action section", () => {
    const workDir = resolve("project");
    const state: PairFlowState = {
      ...claimedState(),
      workflow_id: TEST_WF,
      phase: "planning",
      round: 3,
      turn: "supervisor",
      task: { spec_file: "C:/project/task.md", task_type: "development" },
      participants: [
        { identity: "supervisor", is_supervisor: true, is_developer: true, registered_at: "", work_dir: workDir },
        { identity: "reviewer", is_supervisor: false, is_developer: false, registered_at: "", work_dir: workDir },
      ],
      last_submission_by_participant: {
        supervisor: { round: 2, sub_phase: null, commit_hash: "def5678", submitted_at: "2026-07-10T00:01:00.000Z", file_path: "C:/project/handoff/wf/planning/r2_supervisor.md" },
        reviewer: { round: 1, sub_phase: null, commit_hash: "abc1234", submitted_at: "2026-07-10T00:00:00.000Z", file_path: "C:/project/handoff/wf/planning/r1_reviewer.md" },
      },
    };

    const tip = buildTip(state, "supervisor");
    const [action, remainder] = tip.split("[产出]");

    expect(action).toContain("planning/r1_reviewer.md");
    expect(action).toContain("可直接调用 advance");
    expect(action).not.toContain("submit");
    expect(remainder).toContain("调用 submit");
    expect(remainder).toContain("planning/r3_supervisor.md");
  });
});

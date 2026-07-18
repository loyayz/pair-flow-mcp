import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { defaultState, initPlanningPhase } from "../state.js";
import type { PairFlowState } from "../state.js";
import type {
  InstructionAction,
  InstructionReasonCode,
  PairFlowInstruction,
  PairFlowTool,
  ReferenceKind,
} from "../instruction.js";
import {
  instructionActionSchema,
  instructionReasonCodeSchema,
  pairFlowToolSchema,
} from "../instruction-protocol.js";
import { expectProtocolInstruction } from "./instruction-assertions.js";
import { buildGuidance, buildTip } from "../tip.js";
import {
  resetTipTemplatesForTests,
  initializeTipTemplates,
  DEFAULT_TIP_TEMPLATE_ROOT,
} from "../tip-template.js";

function fixture(overrides: Partial<PairFlowState> = {}): PairFlowState {
  const base = defaultState();
  base.workflow_id = "20260701000001";
  base.turn_claimed_at = "2026-07-15T00:00:00.000Z";
  base.task = { spec_file: "C:/repo/task.md", task_type: "development" };
  base.participants = [
    { identity: "sup", is_supervisor: true, is_developer: false, registered_at: new Date().toISOString(), work_dir: "C:/repo" },
    { identity: "dev", is_supervisor: false, is_developer: true, registered_at: new Date().toISOString(), work_dir: "C:/repo" },
  ];
  base.delivery_manifest = {
    manifest_version: 1,
    status: "in_progress",
    workflow_id: "20260701000001",
    task_type: "development",
    archive_root: "C:/repo/handoff/20260701000001",
    supervisor: "sup",
    phases: {
      requirements: { phase: "requirements", advanced_by: "sup", accepted_at: "2026-07-15T00:00:00.000Z", acceptance_commit: "abcdef1", final_submission: { round: 1, submitted_by: "sup", commit_hash: "abcdef1", file_path: "C:/repo/handoff/20260701000001/requirements/r1_sup.md" } },
      planning: { phase: "planning", advanced_by: "sup", accepted_at: "2026-07-15T00:00:00.000Z", acceptance_commit: "fedcba9", canonical_plan: { round: 1, submitted_by: "sup", commit_hash: "abcdef1", file_path: "C:/repo/handoff/20260701000001/planning/r1_sup.md" } },
      implementation: { phase: "implementation", advanced_by: "sup", accepted_at: "2026-07-15T00:00:00.000Z", acceptance_commit: "abcdef2", coding_submission: { round: 1, submitted_by: "dev", commit_hash: "abcdef1", file_path: "C:/repo/handoff/20260701000001/implementation/r1_coding_dev.md", sub_phase: "coding" }, review_submission: { round: 2, submitted_by: "sup", commit_hash: "abcdef2", file_path: "C:/repo/handoff/20260701000001/implementation/r2_review_sup.md", sub_phase: "review" } },
    },
    commit_verification: "caller_declared_unverified",
  };
  return Object.assign(base, overrides) as PairFlowState;
}

function expectActionFieldInvariants(instruction: PairFlowInstruction) {
  if (instruction.next_action === "produce_and_submit") {
    expect(instruction.required_output).toBeDefined();
    expect(instruction.allowed_tools).toContain("submit");
  }
  if (instruction.next_action === "decide_convergence") {
    expect(instruction.required_output).toBeDefined();
    expect(instruction.decision).toEqual({
      criterion: "phase_goal_met",
      when_true: "advance",
      when_false: "produce_and_submit",
    });
  }
  if (["report_user", "stop"].includes(instruction.next_action)) {
    expect(instruction.allowed_tools).toEqual([]);
  }
  for (const reference of instruction.references ?? []) {
    expect(reference.file_path).not.toContain("\\");
    if (reference.commit) expect(reference.commit).toBe(reference.commit.toLowerCase());
  }
}

function buildAuditedGuidance(state: PairFlowState, identity: string) {
  const result = buildGuidance(state, identity);
  expectProtocolInstruction(result.instruction);
  expectActionFieldInvariants(result.instruction);
  return result;
}

const REASON_MATRIX = {
  REGISTERED_NEEDS_CONFIRMATION: [{ action: "confirm_task", tools: ["confirm_task"] }],
  WORKFLOW_UNBOUND: [{ action: "confirm_task", tools: ["confirm_task"] }],
  ROSTER_INCOMPLETE: [{ action: "wait_for_turn", tools: ["wait_for_turn"] }],
  CONFIRMED_NEEDS_TURN_CLAIM: [{ action: "wait_for_turn", tools: ["wait_for_turn"] }],
  WAITING_FOR_TURN: [{ action: "wait_for_turn", tools: ["wait_for_turn"] }],
  TURN_ASSIGNED: [{ action: "claim_turn", tools: ["claim_turn"] }],
  TURN_READY: [
    { action: "produce_and_submit", tools: ["submit"] },
    { action: "advance", tools: ["advance"] },
  ],
  PHASE_READY_FOR_CONVERGENCE_DECISION: [{ action: "decide_convergence", tools: ["advance", "submit"] }],
  WAIT_TIMEOUT: [{ action: "wait_for_turn", tools: ["wait_for_turn"] }],
  PARTICIPANT_CONFIRMATION_STALE: [{ action: "report_user", tools: [] }],
  TURN_UNCLAIMED_STALE: [{ action: "report_user", tools: [] }],
  SUBMISSION_ACCEPTED: [{ action: "wait_for_turn", tools: ["wait_for_turn"] }],
  PHASE_ADVANCED: [{ action: "wait_for_turn", tools: ["wait_for_turn"] }],
  WORKFLOW_COMPLETED: [{ action: "stop", tools: [] }],
  UNSUPPORTED_WORKFLOW_STATE: [{ action: "report_user", tools: [] }],
  REQUEST_REJECTED: [{ action: "fix_request", tools: [] }],
} satisfies Record<InstructionReasonCode, Array<{ action: InstructionAction; tools: PairFlowTool[] }>>;

describe("persisted wait warning cycle", () => {
  it("initializes and phase-resets the warning cycle to null", () => {
    const initial = defaultState();
    expect(initial.wait_warning_cycle).toBeNull();

    const state = fixture({
      wait_warning_cycle: {
        kind: "turn",
        generation: 3,
        next_report_at: "2026-07-15T10:30:00.000Z",
        reported_at: "2026-07-15T10:31:00.000Z",
        reported_to: "sup",
      },
    });
    expect(initPlanningPhase(state, "sup").wait_warning_cycle).toBeNull();
  });
});

describe("instruction scenarios", () => {
  it("covers every closed reason code with its allowed action and direct-tool outcomes", () => {
    expect(Object.keys(REASON_MATRIX).toSorted()).toEqual(instructionReasonCodeSchema.options.toSorted());

    for (const [reason, outcomes] of Object.entries(REASON_MATRIX)) {
      expect(instructionReasonCodeSchema.safeParse(reason).success).toBe(true);
      for (const outcome of outcomes) {
        expect(instructionActionSchema.safeParse(outcome.action).success).toBe(true);
        for (const tool of outcome.tools) {
          expect(pairFlowToolSchema.safeParse(tool).success).toBe(true);
        }
      }
    }
  });

  it("limits an assigned holder to the no-argument claim_turn action", () => {
    const state = fixture({
      phase: "requirements",
      round: 1,
      turn: "dev",
      turn_claimed_at: null,
    });

    const g = buildAuditedGuidance(state, "dev");

    expect(g.instruction).toMatchObject({
      next_action: "claim_turn",
      allowed_tools: ["claim_turn"],
      reason_code: "TURN_ASSIGNED",
      context: {
        workflow_id: state.workflow_id,
        phase: "requirements",
        round: 1,
        turn: "dev",
        holds_turn: true,
        can_advance: false,
      },
    });
    expect(g.instruction.required_output).toBeUndefined();
    expect(g.instruction.references).toBeUndefined();
    expect(g.instruction.decision).toBeUndefined();
    expect(g.tip).toContain("claim_turn");
    expect(g.tip).not.toContain("submit");
    expect(g.tip).not.toContain("advance");
    expect(g.tip).not.toContain("C:/repo/task.md");
    expect(g.tip).not.toContain("/handoff/");
  });

  it("restores the holder's full current action only after the turn is claimed", () => {
    const state = fixture({
      phase: "requirements",
      round: 1,
      turn: "dev",
      turn_claimed_at: "2026-07-15T01:02:03.000Z",
    });

    const g = buildAuditedGuidance(state, "dev");

    expect(g.instruction.next_action).toBe("produce_and_submit");
    expect(g.instruction.allowed_tools).toEqual(["submit"]);
    expect(g.instruction.reason_code).toBe("TURN_READY");
    expect(g.instruction.required_output).toBeDefined();
    expect(g.instruction.references).toBeDefined();
    expect(g.tip).toContain("submit");
  });

  it("idle supervisor with complete roster gets advance", () => {
    const state = fixture({ phase: "idle", turn: "sup", turn_claimed_at: "2026-07-15T01:02:03.000Z" });
    const g = buildAuditedGuidance(state, "sup");

    expect(g.instruction.next_action).toBe("advance");
    expect(g.instruction.allowed_tools).toEqual(["advance"]);
    expect(g.instruction.reason_code).toBe("TURN_READY");
    expect(g.instruction.context).toMatchObject({
      phase: "idle", turn: "sup", holds_turn: true, can_advance: true,
    });
    expect(g.instruction.required_output).toBeUndefined();
    expect(g.instruction.decision).toBeUndefined();
  });

  it("idle non-supervisor waits", () => {
    const state = fixture({ phase: "idle", turn: "sup" });
    const g = buildAuditedGuidance(state, "dev");

    expect(g.instruction.next_action).toBe("wait_for_turn");
    expect(g.instruction.allowed_tools).toEqual(["wait_for_turn"]);
    expect(g.instruction.reason_code).toBe("WAITING_FOR_TURN");
    expect(g.instruction.context).toMatchObject({
      phase: "idle", turn: "sup", holds_turn: false, can_advance: false,
    });
  });

  it("idle supervisor with incomplete roster waits", () => {
    const state = fixture({ phase: "idle", turn: "idle" });
    state.participants = [state.participants[0]]; // only sup
    const g = buildAuditedGuidance(state, "sup");

    expect(g.instruction.next_action).toBe("wait_for_turn");
    expect(g.instruction.reason_code).toBe("ROSTER_INCOMPLETE");
  });

  it("waiting for other turn", () => {
    const state = fixture({
      phase: "requirements", round: 2, turn: "dev",
      last_submission_by_participant: {
        sup: { round: 1, sub_phase: null, commit_hash: "abc1234", submitted_at: new Date().toISOString(), file_path: "C:/repo/handoff/w/requirements/r1_sup.md" },
        dev: { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null },
      },
    });
    const g = buildAuditedGuidance(state, "sup");

    expect(g.instruction.next_action).toBe("wait_for_turn");
    expect(g.instruction.allowed_tools).toEqual(["wait_for_turn"]);
    expect(g.instruction.reason_code).toBe("WAITING_FOR_TURN");
    expect(g.instruction.context?.holds_turn).toBe(false);
  });

  it("requirements round 1 produce_and_submit", () => {
    const state = fixture({ phase: "requirements", round: 1, turn: "dev" });
    const g = buildAuditedGuidance(state, "dev");

    expect(g.instruction.next_action).toBe("produce_and_submit");
    expect(g.instruction.allowed_tools).toEqual(["submit"]);
    expect(g.instruction.reason_code).toBe("TURN_READY");
    expect(g.instruction.context).toMatchObject({
      phase: "requirements", round: 1, turn: "dev", holds_turn: true, can_advance: false,
    });
    expect(g.instruction.required_output).toBeDefined();
    expect(g.instruction.required_output!.commit_required).toBe(true);
    expect(g.instruction.required_output!.submit_tool).toBe("submit");
    expect(g.instruction.required_output!.file_path).toContain("/requirements/r1_dev.md");
    expect(g.instruction.decision).toBeUndefined();
    // task reference
    expect(g.instruction.references).toBeDefined();
    expect(g.instruction.references!.some((r) => r.kind === "task")).toBe(true);
  });

  it("requirements round 2 produce_and_submit with prev reference", () => {
    const state = fixture({
      phase: "requirements", round: 2, turn: "dev",
      last_submission_by_participant: {
        sup: { round: 1, sub_phase: null, commit_hash: "abc1234", submitted_at: new Date().toISOString(), file_path: "C:/repo/handoff/20260701000001/requirements/r1_sup.md" },
        dev: { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null },
      },
    });
    const g = buildAuditedGuidance(state, "dev");

    expect(g.instruction.next_action).toBe("produce_and_submit");
    expect(g.instruction.references).toBeDefined();
    const prevRef = g.instruction.references!.find((r) => r.kind === "previous_output");
    expect(prevRef).toBeDefined();
    expect(prevRef!.required).toBe(true);
    expect(prevRef!.commit).toBe("abc1234");
  });

  it("supervisor convergence decision", () => {
    const state = fixture({
      phase: "requirements", round: 3, turn: "sup",
      last_submission_by_participant: {
        sup: { round: 1, sub_phase: null, commit_hash: "abc1111", submitted_at: new Date().toISOString(), file_path: "C:/repo/handoff/20260701000001/requirements/r1_sup.md" },
        dev: { round: 2, sub_phase: null, commit_hash: "abc2222", submitted_at: new Date().toISOString(), file_path: "C:/repo/handoff/20260701000001/requirements/r2_dev.md" },
      },
    });
    const g = buildAuditedGuidance(state, "sup");

    expect(g.instruction.next_action).toBe("decide_convergence");
    expect(g.instruction.allowed_tools).toEqual(["advance", "submit"]);
    expect(g.instruction.reason_code).toBe("PHASE_READY_FOR_CONVERGENCE_DECISION");
    expect(g.instruction.context?.can_advance).toBe(true);
    expect(g.instruction.decision).toEqual({
      criterion: "phase_goal_met",
      when_true: "advance",
      when_false: "produce_and_submit",
    });
    expect(g.instruction.required_output).toBeDefined();
  });

  it("implementation coding round 1 with plan reference", () => {
    const state = fixture({
      phase: "implementation", sub_phase: "coding", round: 1, turn: "dev",
    });
    const g = buildAuditedGuidance(state, "dev");

    expect(g.instruction.next_action).toBe("produce_and_submit");
    expect(g.instruction.context?.sub_phase).toBe("coding");
    expect(g.instruction.references).toBeDefined();
    expect(g.instruction.references!.find((r) => r.kind === "plan")).toEqual({
      kind: "plan",
      file_path: "C:/repo/handoff/20260701000001/planning/r1_sup.md",
      required: true,
      commit: "fedcba9",
    });
    expect(g.instruction.required_output!.file_path).toContain("r1_coding_dev.md");
  });

  it("implementation review round 2 with plan and prev references", () => {
    const state = fixture({
      phase: "implementation", sub_phase: "review", round: 2, turn: "sup",
      last_submission_by_participant: {
        sup: { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null },
        dev: { round: 1, sub_phase: "coding", commit_hash: "def5678", submitted_at: new Date().toISOString(), file_path: "C:/repo/handoff/20260701000001/implementation/r1_coding_dev.md" },
      },
    });
    const g = buildAuditedGuidance(state, "sup");

    expect(g.instruction.next_action).toBe("produce_and_submit");
    expect(g.instruction.context?.sub_phase).toBe("review");
    expect(g.instruction.required_output!.file_path).toContain("r2_review_sup.md");
    const prevRef = g.instruction.references!.find((r) => r.kind === "previous_output");
    expect(prevRef).toBeDefined();
    expect(prevRef!.required).toBe(true);
    expect(prevRef!.commit).toBe("def5678");
    expect(g.instruction.references!.find((r) => r.kind === "plan")?.commit).toBe("fedcba9");
  });

  it("keeps the accepted canonical plan reference on later coding and convergence turns", () => {
    const coding = buildAuditedGuidance(fixture({
      phase: "implementation", sub_phase: "coding", round: 3, turn: "dev",
      last_submission_by_participant: {
        sup: { round: 2, sub_phase: "review", commit_hash: "def5678", submitted_at: new Date().toISOString(), file_path: "C:/repo/handoff/20260701000001/implementation/r2_review_sup.md" },
        dev: { round: 1, sub_phase: "coding", commit_hash: "abc1234", submitted_at: new Date().toISOString(), file_path: "C:/repo/handoff/20260701000001/implementation/r1_coding_dev.md" },
      },
    }), "dev");
    const convergence = buildAuditedGuidance(fixture({
      phase: "implementation", sub_phase: "review", round: 4, turn: "sup",
      last_submission_by_participant: {
        sup: { round: 4, sub_phase: "review", commit_hash: "def5678", submitted_at: new Date().toISOString(), file_path: "C:/repo/handoff/20260701000001/implementation/r4_review_sup.md" },
        dev: { round: 3, sub_phase: "coding", commit_hash: "abc1234", submitted_at: new Date().toISOString(), file_path: "C:/repo/handoff/20260701000001/implementation/r3_coding_dev.md" },
      },
    }), "sup");

    for (const instruction of [coding.instruction, convergence.instruction]) {
      expect(instruction.references?.find((reference) => reference.kind === "plan")).toEqual({
        kind: "plan",
        file_path: "C:/repo/handoff/20260701000001/planning/r1_sup.md",
        required: true,
        commit: "fedcba9",
      });
    }
    expect(convergence.instruction.next_action).toBe("decide_convergence");
  });

  it("summary round 1 with archive reference", () => {
    const state = fixture({ phase: "summary", round: 1, turn: "sup" });
    const g = buildAuditedGuidance(state, "sup");

    expect(g.instruction.next_action).toBe("produce_and_submit");
    expect(g.instruction.context?.phase).toBe("summary");
    const archiveRef = g.instruction.references!.find((r) => r.kind === "archive");
    expect(archiveRef).toBeDefined();
    expect(archiveRef!.required).toBe(true);
  });

  it("planning round 1 with task reference", () => {
    const state = fixture({ phase: "planning", round: 1, turn: "sup" });
    // sup is also reviewer in this fixture (is_developer=false)
    const g = buildAuditedGuidance(state, "sup");

    expect(g.instruction.next_action).toBe("produce_and_submit");
    expect(g.instruction.context?.phase).toBe("planning");
    expect(g.instruction.references!.some((r) => r.kind === "task")).toBe(true);
  });

  it("state.unknown maps to report_user", () => {
    const state = fixture({ phase: "requirements", round: 1, turn: "dev" });
    // Force unknown by setting an impossible phase
    (state as unknown as Record<string, unknown>).phase = "nonexistent";
    const g = buildAuditedGuidance(state as unknown as PairFlowState, "dev");

    expect(g.instruction.next_action).toBe("report_user");
    expect(g.instruction.allowed_tools).toEqual([]);
    expect(g.instruction.reason_code).toBe("UNSUPPORTED_WORKFLOW_STATE");
  });

  it.each<{
    name: string;
    makeState: () => PairFlowState;
    identity: string;
    action: PairFlowInstruction["next_action"];
    tools: PairFlowInstruction["allowed_tools"];
  }>([
    {
      name: "idle supervisor advance",
      makeState: () => fixture({ phase: "idle", turn: "sup" }),
      identity: "sup",
      action: "advance",
      tools: ["advance"],
    },
    {
      name: "turn owner production",
      makeState: () => fixture({ phase: "requirements", round: 1, turn: "dev" }),
      identity: "dev",
      action: "produce_and_submit",
      tools: ["submit"],
    },
    {
      name: "supervisor convergence decision",
      makeState: () => fixture({
        phase: "requirements",
        round: 3,
        turn: "sup",
        last_submission_by_participant: {
          sup: { round: 1, sub_phase: null, commit_hash: "abc1111", submitted_at: "now", file_path: "C:/repo/handoff/w/requirements/r1_sup.md" },
          dev: { round: 2, sub_phase: null, commit_hash: "abc2222", submitted_at: "now", file_path: "C:/repo/handoff/w/requirements/r2_dev.md" },
        },
      }),
      identity: "sup",
      action: "decide_convergence",
      tools: ["advance", "submit"],
    },
    {
      name: "other participant turn",
      makeState: () => fixture({ phase: "requirements", round: 1, turn: "dev" }),
      identity: "sup",
      action: "wait_for_turn",
      tools: ["wait_for_turn"],
    },
    {
      name: "unsupported state",
      makeState: () => {
        const state = fixture({ phase: "requirements", round: 1, turn: "dev" });
        (state as unknown as Record<string, unknown>).phase = "nonexistent";
        return state;
      },
      identity: "dev",
      action: "report_user",
      tools: [],
    },
  ])("enforces action and conditional-field invariants for $name", ({ makeState, identity, action, tools }) => {
    const instruction = buildAuditedGuidance(makeState(), identity).instruction;

    expect(instruction.next_action).toBe(action);
    expect(instruction.allowed_tools).toEqual(tools);
  });

  it.each<{
    name: string;
    makeState: () => PairFlowState;
    identity: string;
    output: boolean;
    decision: boolean;
    implementationSubPhase: boolean;
    canAdvance: boolean;
    hasReferences: boolean;
    referenceKind?: ReferenceKind;
  }>([
    {
      name: "idle supervisor ready",
      makeState: () => fixture({ phase: "idle", turn: "sup" }),
      identity: "sup", output: false, decision: false, implementationSubPhase: false, canAdvance: true,
      hasReferences: false,
    },
    {
      name: "idle participant waiting",
      makeState: () => fixture({ phase: "idle", turn: "sup" }),
      identity: "dev", output: false, decision: false, implementationSubPhase: false, canAdvance: false,
      hasReferences: false,
    },
    {
      name: "requirements production",
      makeState: () => fixture({ phase: "requirements", round: 1, turn: "dev" }),
      identity: "dev", output: true, decision: false, implementationSubPhase: false, canAdvance: false,
      hasReferences: true,
    },
    {
      name: "requirements convergence",
      makeState: () => fixture({
        phase: "requirements", round: 3, turn: "sup",
        last_submission_by_participant: {
          sup: { round: 1, sub_phase: null, commit_hash: "abc1111", submitted_at: "now", file_path: "C:/repo/handoff/w/requirements/r1_sup.md" },
          dev: { round: 2, sub_phase: null, commit_hash: "abc2222", submitted_at: "now", file_path: "C:/repo/handoff/w/requirements/r2_dev.md" },
        },
      }),
      identity: "sup", output: true, decision: true, implementationSubPhase: false, canAdvance: true,
      hasReferences: true, referenceKind: "previous_output",
    },
    {
      name: "implementation production",
      makeState: () => fixture({ phase: "implementation", sub_phase: "coding", round: 1, turn: "dev" }),
      identity: "dev", output: true, decision: false, implementationSubPhase: true, canAdvance: false,
      hasReferences: true,
    },
    {
      name: "unsupported state",
      makeState: () => {
        const state = fixture({ phase: "requirements", round: 1, turn: "dev" });
        (state as unknown as Record<string, unknown>).phase = "nonexistent";
        return state;
      },
      identity: "dev", output: false, decision: false, implementationSubPhase: false, canAdvance: false,
      hasReferences: false,
    },
  ])("enforces conditional fields in real guidance: $name", ({
    makeState, identity, output, decision, implementationSubPhase, canAdvance, hasReferences, referenceKind,
  }) => {
    const instruction = buildGuidance(makeState(), identity).instruction;
    expect(Object.hasOwn(instruction, "required_output")).toBe(output);
    expect(Object.hasOwn(instruction, "decision")).toBe(decision);
    expect(Object.hasOwn(instruction.context ?? {}, "sub_phase")).toBe(implementationSubPhase);
    expect(instruction.context?.workflow_id).toBe("20260701000001");
    expect(instruction.context?.can_advance).toBe(canAdvance);
    expect(Object.hasOwn(instruction, "references")).toBe(hasReferences);
    if (hasReferences) expect(instruction.references).not.toHaveLength(0);
    if (referenceKind) {
      expect(instruction.references?.some((reference) => reference.kind === referenceKind)).toBe(true);
    }
  });

  it("shared protocol assertion rejects conditional-field and reference mutants of real guidance", () => {
    const waiting = buildGuidance(fixture({ phase: "requirements", round: 1, turn: "dev" }), "sup").instruction;
    const production = buildGuidance(fixture({ phase: "requirements", round: 1, turn: "dev" }), "dev").instruction;
    const implementation = buildGuidance(
      fixture({ phase: "implementation", sub_phase: "coding", round: 1, turn: "dev" }),
      "dev",
    ).instruction;
    const convergence = buildGuidance(fixture({
      phase: "requirements", round: 3, turn: "sup",
      last_submission_by_participant: {
        sup: { round: 1, sub_phase: null, commit_hash: "abc1111", submitted_at: "now", file_path: "C:/repo/handoff/w/requirements/r1_sup.md" },
        dev: { round: 2, sub_phase: null, commit_hash: "abc2222", submitted_at: "now", file_path: "C:/repo/handoff/w/requirements/r2_dev.md" },
      },
    }), "sup").instruction;
    const idleWaiting = buildGuidance(fixture({ phase: "idle", turn: "sup" }), "dev").instruction;
    const { required_output: _requiredOutput, ...productionWithoutOutput } = production;
    const { decision: _decision, ...convergenceWithoutDecision } = convergence;
    const { sub_phase: _subPhase, ...implementationContextWithoutSubPhase } = implementation.context!;
    const mutants: PairFlowInstruction[] = [
      { ...waiting, required_output: production.required_output },
      productionWithoutOutput,
      { ...waiting, decision: convergence.decision },
      convergenceWithoutDecision,
      { ...waiting, context: { ...waiting.context!, sub_phase: "coding" } },
      { ...implementation, context: implementationContextWithoutSubPhase },
      { ...idleWaiting, context: { ...idleWaiting.context!, can_advance: true } },
      { ...convergence, context: { ...convergence.context!, can_advance: false } },
      { ...waiting, references: [] },
    ];

    for (const mutant of mutants) {
      expect(() => expectProtocolInstruction(mutant)).toThrow();
    }
  });

  it("all instruction paths use POSIX slashes", () => {
    const state = fixture({ phase: "requirements", round: 1, turn: "dev" });
    const g = buildAuditedGuidance(state, "dev");

    const paths: string[] = [];
    if (g.instruction.required_output) paths.push(g.instruction.required_output.file_path);
    if (g.instruction.references) {
      for (const ref of g.instruction.references) paths.push(ref.file_path);
    }

    for (const p of paths) {
      expect(p).not.toContain("\\");
    }
  });

  it("buildTip returns the same tip as buildGuidance", () => {
    const state = fixture({ phase: "requirements", round: 1, turn: "dev" });
    const g = buildAuditedGuidance(state, "dev");
    const tip = buildTip(state, "dev");

    expect(tip).toBe(g.tip);
  });

  it("keeps real template action, turn, output, and reference paths consistent with instruction", () => {
    const advanceGuidance = buildAuditedGuidance(fixture({ phase: "idle", turn: "sup" }), "sup");
    expect(advanceGuidance.tip).toContain(advanceGuidance.instruction.allowed_tools[0]);

    const waitingGuidance = buildAuditedGuidance(
      fixture({ phase: "requirements", round: 2, turn: "dev" }),
      "sup",
    );
    expect(waitingGuidance.tip).toContain("wait_for_turn");
    expect(waitingGuidance.tip).toContain(waitingGuidance.instruction.context!.turn);

    const productionGuidance = buildAuditedGuidance(
      fixture({ phase: "requirements", round: 2, turn: "dev", last_submission_by_participant: {
        sup: { round: 1, sub_phase: null, commit_hash: "abc1234", submitted_at: "now", file_path: "C:/repo/handoff/20260701000001/requirements/r1_sup.md" },
        dev: { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null },
      } }),
      "dev",
    );
    expect(productionGuidance.tip).toContain("submit");
    expect(productionGuidance.tip).toContain(productionGuidance.instruction.required_output!.file_path);
    const previousOutput = productionGuidance.instruction.references!.find((reference) => reference.kind === "previous_output")!;
    expect(productionGuidance.tip).toContain(previousOutput.file_path);
    expect(productionGuidance.tip).toContain(previousOutput.commit);
  });

  // ── Template independence ────────────────────────────────────

  it("template customization does not alter instruction", () => {
    const root = resolve(tmpdir(), `pairflow-inst-test-${Date.now()}`);
    mkdirSync(root, { recursive: true });

    cpSync(DEFAULT_TIP_TEMPLATE_ROOT, root, { recursive: true });

    try {
      resetTipTemplatesForTests();
      initializeTipTemplates(root);

      const state = fixture({ phase: "requirements", round: 1, turn: "dev" });
      const g1 = buildAuditedGuidance(state, "dev");

      // Modify the action text of the template
      const tmplPath = resolve(root, "requirements/r1.md");
      const original = readFileSync(tmplPath, "utf8");
      const modified = original.replace("[行动]", "[行动]\n（自定义文案）");
      writeFileSync(tmplPath, modified, "utf8");

      resetTipTemplatesForTests();
      initializeTipTemplates(root);

      const g2 = buildAuditedGuidance(state, "dev");

      // Tip should change
      expect(g2.tip).not.toBe(g1.tip);
      // Instruction must be identical
      expect(g2.instruction).toEqual(g1.instruction);
      expectProtocolInstruction(g2.instruction);
    } finally {
      resetTipTemplatesForTests();
      initializeTipTemplates(DEFAULT_TIP_TEMPLATE_ROOT);
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── Contract matrix invariants ───────────────────────────────

  it("produce_and_submit always has required_output", () => {
    const state = fixture({ phase: "requirements", round: 1, turn: "dev" });
    const g = buildAuditedGuidance(state, "dev");
    expect(g.instruction.next_action).toBe("produce_and_submit");
    expect(g.instruction.required_output).toBeDefined();
    expect(g.instruction.required_output!.commit_required).toBe(true);
    expect(g.instruction.required_output!.submit_tool).toBe("submit");
  });

  it("decide_convergence has decision and required_output", () => {
    const state = fixture({
      phase: "requirements", round: 3, turn: "sup",
      last_submission_by_participant: {
        sup: { round: 1, sub_phase: null, commit_hash: "abc1111", submitted_at: new Date().toISOString(), file_path: "C:/repo/handoff/w/requirements/r1_sup.md" },
        dev: { round: 2, sub_phase: null, commit_hash: "abc2222", submitted_at: new Date().toISOString(), file_path: "C:/repo/handoff/w/requirements/r2_dev.md" },
      },
    });
    const g = buildAuditedGuidance(state, "sup");

    expect(g.instruction.next_action).toBe("decide_convergence");
    expect(g.instruction.decision).toBeDefined();
    expect(g.instruction.decision!.criterion).toBe("phase_goal_met");
    expect(g.instruction.required_output).toBeDefined();
  });

  it("commit references in instruction are lowercase", () => {
    const state = fixture({
      phase: "requirements", round: 2, turn: "dev",
      last_submission_by_participant: {
        sup: { round: 1, sub_phase: null, commit_hash: "ABCDEF1234567890", submitted_at: new Date().toISOString(), file_path: "C:/repo/handoff/w/requirements/r1_sup.md" },
        dev: { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null },
      },
    });
    const g = buildAuditedGuidance(state, "dev");

    const prevRef = g.instruction.references!.find((r) => r.kind === "previous_output");
    expect(prevRef).toBeDefined();
    expect(prevRef!.required).toBe(true);
    if (prevRef!.commit) {
      expect(prevRef!.commit).toBe(prevRef!.commit.toLowerCase());
    }
  });

  it("instruction does not contain token or PID fields", () => {
    const state = fixture({ phase: "requirements", round: 1, turn: "dev" });
    const g = buildAuditedGuidance(state, "dev");
    const json = JSON.stringify(g.instruction);

    expect(json).not.toContain("token");
    expect(json).not.toContain(".pid");
  });

  it("implementation review round >2 includes previous_review with required:true", () => {
    const state = fixture({
      phase: "implementation", sub_phase: "review", round: 4, turn: "sup",
      last_submission_by_participant: {
        sup: { round: 2, sub_phase: "review", commit_hash: "myreview1", submitted_at: new Date().toISOString(), file_path: "C:/repo/handoff/20260701000001/implementation/r2_review_sup.md" },
        dev: { round: 3, sub_phase: "coding", commit_hash: "devcode3", submitted_at: new Date().toISOString(), file_path: "C:/repo/handoff/20260701000001/implementation/r3_coding_dev.md" },
      },
    });
    const g = buildAuditedGuidance(state, "sup");

    // Both participants have submitted → convergence scenario for supervisor
    expect(g.instruction.next_action).toBe("decide_convergence");
    expect(g.instruction.references).toBeDefined();

    const prevOut = g.instruction.references!.find((r) => r.kind === "previous_output");
    expect(prevOut).toBeDefined();
    expect(prevOut!.required).toBe(true);

    const prevRev = g.instruction.references!.find((r) => r.kind === "previous_review");
    expect(prevRev).toBeDefined();
    expect(prevRev!.required).toBe(true);
    expect(prevRev!.file_path).toContain("r2_review_sup.md");
    expect(prevRev!.commit).toBe("myreview1");
  });
});

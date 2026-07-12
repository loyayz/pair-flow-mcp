import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { defaultState } from "../state.js";
import type { PairFlowState } from "../state.js";
import { buildGuidance, buildTip } from "../tip.js";
import {
  resetTipTemplatesForTests,
  initializeTipTemplates,
  DEFAULT_TIP_TEMPLATE_ROOT,
} from "../tip-template.js";

function fixture(overrides: Partial<PairFlowState> = {}): PairFlowState {
  const base = defaultState();
  base.workflow_id = "20260701000001";
  base.task = { spec_file: "C:/repo/task.md", task_type: "development" };
  base.participants = [
    { identity: "sup", is_supervisor: true, is_developer: false, registered_at: new Date().toISOString(), work_dir: "C:/repo" },
    { identity: "dev", is_supervisor: false, is_developer: true, registered_at: new Date().toISOString(), work_dir: "C:/repo" },
  ];
  return Object.assign(base, overrides) as PairFlowState;
}

describe("instruction scenarios", () => {
  it("idle supervisor with complete roster gets advance", () => {
    const state = fixture({ phase: "idle", turn: "sup" });
    const g = buildGuidance(state, "sup");

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
    const g = buildGuidance(state, "dev");

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
    const g = buildGuidance(state, "sup");

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
    const g = buildGuidance(state, "sup");

    expect(g.instruction.next_action).toBe("wait_for_turn");
    expect(g.instruction.allowed_tools).toEqual(["wait_for_turn"]);
    expect(g.instruction.reason_code).toBe("WAITING_FOR_TURN");
    expect(g.instruction.context?.holds_turn).toBe(false);
  });

  it("requirements round 1 produce_and_submit", () => {
    const state = fixture({ phase: "requirements", round: 1, turn: "dev" });
    const g = buildGuidance(state, "dev");

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
    const g = buildGuidance(state, "dev");

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
    const g = buildGuidance(state, "sup");

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
    const g = buildGuidance(state, "dev");

    expect(g.instruction.next_action).toBe("produce_and_submit");
    expect(g.instruction.context?.sub_phase).toBe("coding");
    expect(g.instruction.references).toBeDefined();
    expect(g.instruction.references!.some((r) => r.kind === "plan")).toBe(true);
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
    const g = buildGuidance(state, "sup");

    expect(g.instruction.next_action).toBe("produce_and_submit");
    expect(g.instruction.context?.sub_phase).toBe("review");
    expect(g.instruction.required_output!.file_path).toContain("r2_review_sup.md");
    const prevRef = g.instruction.references!.find((r) => r.kind === "previous_output");
    expect(prevRef).toBeDefined();
    expect(prevRef!.required).toBe(true);
    expect(prevRef!.commit).toBe("def5678");
  });

  it("summary round 1 with archive reference", () => {
    const state = fixture({ phase: "summary", round: 1, turn: "sup" });
    const g = buildGuidance(state, "sup");

    expect(g.instruction.next_action).toBe("produce_and_submit");
    expect(g.instruction.context?.phase).toBe("summary");
    const archiveRef = g.instruction.references!.find((r) => r.kind === "archive");
    expect(archiveRef).toBeDefined();
    expect(archiveRef!.required).toBe(true);
  });

  it("planning round 1 with task reference", () => {
    const state = fixture({ phase: "planning", round: 1, turn: "sup" });
    // sup is also reviewer in this fixture (is_developer=false)
    const g = buildGuidance(state, "sup");

    expect(g.instruction.next_action).toBe("produce_and_submit");
    expect(g.instruction.context?.phase).toBe("planning");
    expect(g.instruction.references!.some((r) => r.kind === "task")).toBe(true);
  });

  it("state.unknown maps to report_user", () => {
    const state = fixture({ phase: "requirements", round: 1, turn: "dev" });
    // Force unknown by setting an impossible phase
    (state as unknown as Record<string, unknown>).phase = "nonexistent";
    const g = buildGuidance(state as unknown as PairFlowState, "dev");

    expect(g.instruction.next_action).toBe("report_user");
    expect(g.instruction.allowed_tools).toEqual([]);
    expect(g.instruction.reason_code).toBe("UNSUPPORTED_WORKFLOW_STATE");
  });

  it("all instruction paths use POSIX slashes", () => {
    const state = fixture({ phase: "requirements", round: 1, turn: "dev" });
    const g = buildGuidance(state, "dev");

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
    const g = buildGuidance(state, "dev");
    const tip = buildTip(state, "dev");

    expect(tip).toBe(g.tip);
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
      const g1 = buildGuidance(state, "dev");

      // Modify the action text of the template
      const tmplPath = resolve(root, "requirements/r1.md");
      const original = readFileSync(tmplPath, "utf8");
      const modified = original.replace("[行动]", "[行动]\n（自定义文案）");
      writeFileSync(tmplPath, modified, "utf8");

      resetTipTemplatesForTests();
      initializeTipTemplates(root);

      const g2 = buildGuidance(state, "dev");

      // Tip should change
      expect(g2.tip).not.toBe(g1.tip);
      // Instruction must be identical
      expect(g2.instruction).toEqual(g1.instruction);
    } finally {
      resetTipTemplatesForTests();
      initializeTipTemplates(DEFAULT_TIP_TEMPLATE_ROOT);
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── Contract matrix invariants ───────────────────────────────

  it("produce_and_submit always has required_output", () => {
    const state = fixture({ phase: "requirements", round: 1, turn: "dev" });
    const g = buildGuidance(state, "dev");
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
    const g = buildGuidance(state, "sup");

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
    const g = buildGuidance(state, "dev");

    const prevRef = g.instruction.references!.find((r) => r.kind === "previous_output");
    expect(prevRef).toBeDefined();
    expect(prevRef!.required).toBe(true);
    if (prevRef!.commit) {
      expect(prevRef!.commit).toBe(prevRef!.commit.toLowerCase());
    }
  });

  it("instruction does not contain token or PID fields", () => {
    const state = fixture({ phase: "requirements", round: 1, turn: "dev" });
    const g = buildGuidance(state, "dev");
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
    const g = buildGuidance(state, "sup");

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

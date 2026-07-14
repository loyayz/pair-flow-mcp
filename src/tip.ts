import { haveAllParticipantsSubmittedCurrentPhase, hasCompleteParticipantRoster } from "./state.js";
import type { PairFlowState } from "./state.js";
import { workflowArchivePath } from "./archive-path.js";
import { renderTip, type TemplateKey } from "./tip-template.js";
import {
  withInstructionProtocol,
  type Guidance,
  type InstructionContext,
  type InstructionInput,
  type InstructionReasonCode,
  type InstructionReference,
} from "./instruction.js";
import { phaseSchema, subPhaseSchema } from "./instruction-protocol.js";

const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/;

function safe(s: string | null | undefined): string {
  return (s && SAFE_ID.test(s)) ? s : "unknown";
}

export function identityLabel(state: PairFlowState, identity: string): string {
  const participant = state.participants.find((p) => p.identity === identity);
  if (!participant) return `${safe(identity)}`;
  const responsibilityLabel = participant.is_supervisor && participant.is_developer
    ? "supervisor/developer"
    : participant.is_supervisor
      ? "supervisor"
      : participant.is_developer
        ? "developer"
        : "reviewer";
  return `${safe(identity)}（${responsibilityLabel}）`;
}

export function outFile(state: PairFlowState, identity: string): string {
  const wfId = safe(state.workflow_id);
  const phase = safe(state.phase);
  const ident = safe(identity);
  const filePrefix = state.phase === "implementation" && state.sub_phase
    ? `r${state.round}_${state.sub_phase}_${ident}`
    : `r${state.round}_${ident}`;
  return workflowArchivePath(state, wfId, phase, `${filePrefix}.md`).replace(/\\/g, "/");
}

function planningDocument(state: PairFlowState): string {
  const reviewer = state.participants.find((participant) => !participant.is_developer);
  return workflowArchivePath(
    state,
    safe(state.workflow_id),
    "planning",
    `r1_${safe(reviewer?.identity)}.md`,
  ).replace(/\\/g, "/");
}

// ── Instruction helpers ────────────────────────────────────────────

export function reliableWorkflowPhase(
  state: PairFlowState,
): Pick<InstructionContext, "phase" | "sub_phase"> {
  const parsedPhase = phaseSchema.safeParse(state.phase);
  if (!parsedPhase.success) return {};
  if (parsedPhase.data === "implementation") {
    const parsedSubPhase = subPhaseSchema.safeParse(state.sub_phase);
    if (!parsedSubPhase.success || parsedSubPhase.data === null) return {};
    return { phase: parsedPhase.data, sub_phase: parsedSubPhase.data };
  }
  if (state.sub_phase !== null) return {};
  return { phase: parsedPhase.data };
}

export function workflowInstructionContext(
  state: PairFlowState,
  identity: string,
): InstructionContext {
  const c: InstructionContext = {
    ...reliableWorkflowPhase(state),
    round: state.round,
    turn: state.turn,
    holds_turn: state.turn === identity,
    can_advance: false,
  };
  if (state.workflow_id) c.workflow_id = state.workflow_id;
  return c;
}

function supportsInstructionState(state: PairFlowState): boolean {
  return reliableWorkflowPhase(state).phase !== undefined;
}

function outputReq(state: PairFlowState, identity: string) {
  return {
    file_path: outFile(state, identity),
    commit_required: true as const,
    submit_tool: "submit" as const,
  };
}

function taskRef(state: PairFlowState): InstructionReference | null {
  if (!state.task?.spec_file) return null;
  return {
    kind: "task",
    file_path: state.task.spec_file.replace(/\\/g, "/"),
    required: true,
  };
}

function prevRef(state: PairFlowState, identity: string): InstructionReference | null {
  const other = state.participants.find((p) => p.identity !== identity);
  const sub = other ? state.last_submission_by_participant[other.identity] : null;
  if (!sub?.file_path) return null;
  const ref: InstructionReference = {
    kind: "previous_output",
    file_path: sub.file_path.replace(/\\/g, "/"),
    required: true,
  };
  if (sub.commit_hash) ref.commit = sub.commit_hash.toLowerCase();
  return ref;
}

function planRef(state: PairFlowState): InstructionReference {
  const path = planningDocument(state);
  const reviewer = state.participants.find((p) => !p.is_developer);
  const sub = reviewer ? state.last_submission_by_participant[reviewer.identity] : null;
  const ref: InstructionReference = {
    kind: "plan",
    file_path: path,
    required: true,
  };
  if (sub?.commit_hash) ref.commit = sub.commit_hash.toLowerCase();
  return ref;
}

function prevReviewRef(state: PairFlowState, identity: string): InstructionReference | null {
  if (state.round <= 2) return null;
  const path = workflowArchivePath(
    state,
    safe(state.workflow_id),
    safe(state.phase),
    `r${state.round - 2}_review_${safe(identity)}.md`,
  ).replace(/\\/g, "/");
  const sub = state.last_submission_by_participant[identity];
  const ref: InstructionReference = {
    kind: "previous_review",
    file_path: path,
    required: true,
  };
  if (sub?.commit_hash) ref.commit = sub.commit_hash.toLowerCase();
  return ref;
}

function archiveRootRef(state: PairFlowState): InstructionReference {
  const path = workflowArchivePath(state, safe(state.workflow_id)).replace(/\\/g, "/");
  return { kind: "archive", file_path: path, required: true };
}

// ── Guidance Selection ─────────────────────────────────────────────

type GuidanceSelection = {
  key: TemplateKey;
  variables: Record<string, string | number>;
  instruction: InstructionInput;
};

function instruction(
  action: InstructionInput["next_action"],
  reason: InstructionReasonCode,
  state: PairFlowState,
  identity: string,
  opts?: {
    allowedTools?: InstructionInput["allowed_tools"];
    output?: InstructionInput["required_output"];
    refs?: InstructionReference[];
    decision?: InstructionInput["decision"];
    canAdvance?: boolean;
  },
): InstructionInput {
  const c = workflowInstructionContext(state, identity);
  if (opts?.canAdvance !== undefined) c.can_advance = opts.canAdvance;
  const inst: InstructionInput = {
    next_action: action,
    allowed_tools: opts?.allowedTools ?? [],
    reason_code: reason,
    context: c,
  };
  if (opts?.output) inst.required_output = opts.output;
  if (opts?.refs && opts.refs.length > 0) inst.references = opts.refs.filter(Boolean) as InstructionReference[];
  if (opts?.decision) inst.decision = opts.decision;
  return inst;
}

function selectGuidance(state: PairFlowState, identity: string): GuidanceSelection {
  const taskPath = (state.task?.spec_file ?? "任务文档").replace(/\\/g, "/");
  const other = state.participants.find((p) => p.identity !== identity);
  const otherSubmit = other ? state.last_submission_by_participant[other.identity] : null;
  const prevFile = otherSubmit?.file_path?.replace(/\\/g, "/") ?? null;
  const prevCommit = otherSubmit?.commit_hash ?? null;
  const label = identityLabel(state, identity);
  const phaseText = phaseLabel(safe(state.phase), state.sub_phase);
  const round = String(state.round);
  const filePath = outFile(state, identity);

  const common = {
    identity_label: label,
    round,
    phase_label: phaseText,
    file_path: filePath,
    ...(taskPath ? { task_path: taskPath } : {}),
    ...(prevFile ? { prev_file: prevFile } : {}),
    ...(prevCommit ? { prev_commit: prevCommit } : {}),
  };

  const isSupervisor = state.participants.some((p) => p.identity === identity && p.is_supervisor);
  const canSupervisorAdvance = isSupervisor
    && state.turn === identity
    && haveAllParticipantsSubmittedCurrentPhase(state);
  const rosterComplete = hasCompleteParticipantRoster(state);

  let advanceTarget = "";
  if (canSupervisorAdvance) {
    if (state.phase === "requirements") {
      advanceTarget = state.task?.task_type === "requirements" ? "进入汇总阶段" : "进入实施计划阶段";
    }
    else if (state.phase === "planning") advanceTarget = "进入代码实现阶段";
    else if (state.phase === "implementation") advanceTarget = "进入汇总阶段";
    else if (state.phase === "summary") advanceTarget = "结束工作流";
  }

  // ── Idle ──────────────────────────────────────────────────────
  if (state.phase === "idle") {
    if (isSupervisor && rosterComplete) {
      return {
        key: "state.idle.supervisor",
        variables: { identity_label: label },
        instruction: instruction("advance", "TURN_READY", state, identity, {
          allowedTools: ["advance"],
          canAdvance: true,
        }),
      };
    }
    return {
      key: "state.idle.other",
      variables: { identity_label: label },
      instruction: instruction("wait_for_turn", rosterComplete ? "WAITING_FOR_TURN" : "ROSTER_INCOMPLETE", state, identity, {
        allowedTools: ["wait_for_turn"],
      }),
    };
  }

  // ── Round 1 ───────────────────────────────────────────────────
  if (state.round === 1) {
    if (state.phase === "requirements") {
      const refs: InstructionReference[] = [];
      const t = taskRef(state);
      if (t) refs.push(t);
      return {
        key: "requirements.r1",
        variables: { task_path: taskPath, file_path: filePath, identity_label: label, round, phase_label: phaseText },
        instruction: instruction("produce_and_submit", "TURN_READY", state, identity, {
          allowedTools: ["submit"],
          output: outputReq(state, identity),
          refs,
        }),
      };
    }
    if (state.phase === "planning") {
      const refs: InstructionReference[] = [];
      const t = taskRef(state);
      if (t) refs.push(t);
      return {
        key: "planning.r1",
        variables: { task_path: taskPath, file_path: filePath, identity_label: label, round, phase_label: phaseText },
        instruction: instruction("produce_and_submit", "TURN_READY", state, identity, {
          allowedTools: ["submit"],
          output: outputReq(state, identity),
          refs,
        }),
      };
    }
    if (state.phase === "implementation" && state.sub_phase === "coding") {
      const refs: InstructionReference[] = [planRef(state)];
      return {
        key: "implementation.coding.r1",
        variables: { plan_file: planningDocument(state), file_path: filePath, identity_label: label, round, phase_label: phaseText },
        instruction: instruction("produce_and_submit", "TURN_READY", state, identity, {
          allowedTools: ["submit"],
          output: outputReq(state, identity),
          refs,
        }),
      };
    }
    if (state.phase === "summary") {
      const refs: InstructionReference[] = [archiveRootRef(state)];
      const t = taskRef(state);
      if (t) refs.push(t);
      return {
        key: "summary.r1",
        variables: { task_path: taskPath, archive_root: workflowArchivePath(state, safe(state.workflow_id)).replace(/\\/g, "/"), file_path: filePath, identity_label: label, round, phase_label: phaseText },
        instruction: instruction("produce_and_submit", "TURN_READY", state, identity, {
          allowedTools: ["submit"],
          output: outputReq(state, identity),
          refs,
        }),
      };
    }
    return {
      key: "state.unknown",
      variables: { phase: safe(state.phase), sub_phase: safe(state.sub_phase), round },
      instruction: instruction("report_user", "UNSUPPORTED_WORKFLOW_STATE", state, identity),
    };
  }

  // ── Round ≥2 ──────────────────────────────────────────────────

  // Convergence decision
  if (canSupervisorAdvance) {
    const refs: InstructionReference[] = [];
    const p = prevRef(state, identity);
    if (p) refs.push(p);
    if (state.phase === "requirements") {
      const t = taskRef(state);
      if (t) refs.push(t);
      return {
        key: "requirements.rn.advance",
        variables: { ...common, advance_target: advanceTarget },
        instruction: instruction("decide_convergence", "PHASE_READY_FOR_CONVERGENCE_DECISION", state, identity, {
          allowedTools: ["advance", "submit"],
          output: outputReq(state, identity),
          refs,
          decision: { criterion: "phase_goal_met", when_true: "advance", when_false: "produce_and_submit" },
          canAdvance: true,
        }),
      };
    }
    if (state.phase === "planning") {
      refs.push(planRef(state));
      return {
        key: "planning.rn.advance",
        variables: { ...common, plan_file: planningDocument(state), advance_target: advanceTarget },
        instruction: instruction("decide_convergence", "PHASE_READY_FOR_CONVERGENCE_DECISION", state, identity, {
          allowedTools: ["advance", "submit"],
          output: outputReq(state, identity),
          refs,
          decision: { criterion: "phase_goal_met", when_true: "advance", when_false: "produce_and_submit" },
          canAdvance: true,
        }),
      };
    }
    if (state.phase === "implementation" && state.sub_phase === "review") {
      refs.push(planRef(state));
      const prv = prevReviewRef(state, identity);
      if (prv) refs.push(prv);
      return {
        key: "implementation.review.rn.advance",
        variables: { ...common, plan_file: planningDocument(state), previous_review: prevReviewRef(state, identity)?.file_path ?? "", advance_target: advanceTarget },
        instruction: instruction("decide_convergence", "PHASE_READY_FOR_CONVERGENCE_DECISION", state, identity, {
          allowedTools: ["advance", "submit"],
          output: outputReq(state, identity),
          refs,
          decision: { criterion: "phase_goal_met", when_true: "advance", when_false: "produce_and_submit" },
          canAdvance: true,
        }),
      };
    }
    if (state.phase === "summary") {
      return {
        key: "summary.rn.advance",
        variables: { ...common, advance_target: advanceTarget },
        instruction: instruction("decide_convergence", "PHASE_READY_FOR_CONVERGENCE_DECISION", state, identity, {
          allowedTools: ["advance", "submit"],
          output: outputReq(state, identity),
          refs,
          decision: { criterion: "phase_goal_met", when_true: "advance", when_false: "produce_and_submit" },
          canAdvance: true,
        }),
      };
    }
  }

  // Non-convergence round ≥2
  if (state.phase === "requirements") {
    if (state.round === 2) {
      const refs: InstructionReference[] = [];
      const t = taskRef(state);
      if (t) refs.push(t);
      const p = prevRef(state, identity);
      if (p) refs.push(p);
      return {
        key: "requirements.r2",
        variables: { ...common, task_path: taskPath },
        instruction: instruction("produce_and_submit", "TURN_READY", state, identity, {
          allowedTools: ["submit"],
          output: outputReq(state, identity),
          refs,
        }),
      };
    }
    const refs: InstructionReference[] = [];
    const p = prevRef(state, identity);
    if (p) refs.push(p);
    return {
      key: "requirements.rn",
      variables: common,
      instruction: instruction("produce_and_submit", "TURN_READY", state, identity, {
        allowedTools: ["submit"],
        output: outputReq(state, identity),
        refs,
      }),
    };
  }

  if (state.phase === "planning") {
    const refs: InstructionReference[] = [planRef(state)];
    const p = prevRef(state, identity);
    if (p) refs.push(p);
    return {
      key: "planning.rn",
      variables: { ...common, plan_file: planningDocument(state) },
      instruction: instruction("produce_and_submit", "TURN_READY", state, identity, {
        allowedTools: ["submit"],
        output: outputReq(state, identity),
        refs,
      }),
    };
  }

  if (state.phase === "implementation" && state.sub_phase === "review") {
    const refs: InstructionReference[] = [planRef(state)];
    const p = prevRef(state, identity);
    if (p) refs.push(p);
    if (state.round > 2) {
      const prv = prevReviewRef(state, identity);
      if (prv) refs.push(prv);
      return {
        key: "implementation.review.rn",
        variables: { ...common, plan_file: planningDocument(state), previous_review: prevReviewRef(state, identity)?.file_path ?? "" },
        instruction: instruction("produce_and_submit", "TURN_READY", state, identity, {
          allowedTools: ["submit"],
          output: outputReq(state, identity),
          refs,
        }),
      };
    }
    return {
      key: "implementation.review.r2",
      variables: { ...common, plan_file: planningDocument(state) },
      instruction: instruction("produce_and_submit", "TURN_READY", state, identity, {
        allowedTools: ["submit"],
        output: outputReq(state, identity),
        refs,
      }),
    };
  }

  if (state.phase === "implementation" && state.sub_phase === "coding") {
    const refs: InstructionReference[] = [];
    const p = prevRef(state, identity);
    if (p) refs.push(p);
    return {
      key: "implementation.coding.rn",
      variables: common,
      instruction: instruction("produce_and_submit", "TURN_READY", state, identity, {
        allowedTools: ["submit"],
        output: outputReq(state, identity),
        refs,
      }),
    };
  }

  if (state.phase === "summary") {
    if (state.round === 2) {
      const refs: InstructionReference[] = [];
      const p = prevRef(state, identity);
      if (p) refs.push(p);
      return {
        key: "summary.r2",
        variables: common,
        instruction: instruction("produce_and_submit", "TURN_READY", state, identity, {
          allowedTools: ["submit"],
          output: outputReq(state, identity),
          refs,
        }),
      };
    }
    const refs: InstructionReference[] = [];
    const p = prevRef(state, identity);
    if (p) refs.push(p);
    return {
      key: "summary.rn",
      variables: common,
      instruction: instruction("produce_and_submit", "TURN_READY", state, identity, {
        allowedTools: ["submit"],
        output: outputReq(state, identity),
        refs,
      }),
    };
  }

  return {
    key: "state.unknown",
    variables: { phase: safe(state.phase), sub_phase: safe(state.sub_phase), round },
    instruction: instruction("report_user", "UNSUPPORTED_WORKFLOW_STATE", state, identity),
  };
}

export function phaseLabel(phase: string, subPhase: string | null): string {
  if (phase === "implementation") return subPhase === "review" ? "代码评审" : "代码实现";
  if (phase === "requirements") return "需求分析";
  if (phase === "planning") return "实施计划";
  if (phase === "summary") return "汇总";
  return phase;
}

export function buildGuidance(state: PairFlowState, identity: string): Guidance {
  const holdsTurn = state.turn === identity;

  if (!supportsInstructionState(state)) {
    const round = String(state.round);
    return {
      tip: renderTip("state.unknown", {
        phase: safe(state.phase),
        sub_phase: safe(state.sub_phase),
        round,
      }),
      instruction: withInstructionProtocol(
        instruction("report_user", "UNSUPPORTED_WORKFLOW_STATE", state, identity),
      ),
    };
  }

  if (state.phase !== "idle" && !holdsTurn) {
    const label = identityLabel(state, identity);
    const rosterComplete = hasCompleteParticipantRoster(state);
    const reason: InstructionReasonCode = rosterComplete ? "WAITING_FOR_TURN" : "ROSTER_INCOMPLETE";
    const tip = renderTip("state.wait.other", {
      identity_label: label,
      turn: safe(state.turn),
      round: String(state.round),
      phase_label: phaseLabel(safe(state.phase), state.sub_phase),
    });
    return {
      tip,
      instruction: withInstructionProtocol(
        instruction("wait_for_turn", reason, state, identity, {
          allowedTools: ["wait_for_turn"],
        }),
      ),
    };
  }

  const selection = selectGuidance(state, identity);
  return {
    tip: renderTip(selection.key, selection.variables),
    instruction: withInstructionProtocol(selection.instruction),
  };
}

export function buildTip(state: PairFlowState, identity: string): string {
  return buildGuidance(state, identity).tip;
}

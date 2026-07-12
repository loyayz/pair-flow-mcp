import { haveAllParticipantsSubmittedCurrentPhase } from "./state.js";
import type { PairFlowState } from "./state.js";
import { workflowArchivePath } from "./archive-path.js";
import { renderTip, type TemplateKey } from "./tip-template.js";

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

type TipSelection = { key: TemplateKey; variables: Record<string, string | number> };

function selectTip(state: PairFlowState, identity: string): TipSelection {
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

  if (state.phase === "idle") {
    const isSup = state.participants.some((p) => p.identity === identity && p.is_supervisor);
    return isSup
      ? { key: "state.idle.supervisor", variables: { identity_label: label } }
      : { key: "state.idle.other", variables: { identity_label: label } };
  }

  if (state.round === 1) {
    if (state.phase === "requirements") {
      return { key: "requirements.r1", variables: { task_path: taskPath, file_path: filePath, identity_label: label, round, phase_label: phaseText } };
    }
    if (state.phase === "planning") {
      return { key: "planning.r1", variables: { task_path: taskPath, file_path: filePath, identity_label: label, round, phase_label: phaseText } };
    }
    if (state.phase === "implementation" && state.sub_phase === "coding") {
      return { key: "implementation.coding.r1", variables: { plan_file: planningDocument(state), file_path: filePath, identity_label: label, round, phase_label: phaseText } };
    }
    if (state.phase === "summary") {
      const archiveRoot = workflowArchivePath(state, safe(state.workflow_id)).replace(/\\/g, "/");
      return { key: "summary.r1", variables: { task_path: taskPath, archive_root: archiveRoot, file_path: filePath, identity_label: label, round, phase_label: phaseText } };
    }
    return { key: "state.unknown", variables: { phase: safe(state.phase), sub_phase: safe(state.sub_phase), round } };
  }

  const isSupervisor = state.participants.some((p) => p.identity === identity && p.is_supervisor);
  const canSupervisorAdvance = isSupervisor
    && state.turn === identity
    && haveAllParticipantsSubmittedCurrentPhase(state);

  let advanceTarget = "";
  if (canSupervisorAdvance) {
    let target = "";
    if (state.phase === "requirements") target = "进入实施计划阶段";
    else if (state.phase === "planning") target = "进入代码实现阶段";
    else if (state.phase === "implementation") target = "进入汇总阶段";
    else if (state.phase === "summary") target = "结束工作流";
    advanceTarget = `作为监督者，若确认目标已达成可直接调用 advance（${target}）。否则：`;
  }

  if (state.phase === "requirements") {
    if (state.round === 2) {
      return { key: "requirements.r2", variables: { ...common, task_path: taskPath } };
    }
    const key: TemplateKey = canSupervisorAdvance ? "requirements.rn.advance" : "requirements.rn";
    return { key, variables: { ...common, ...(canSupervisorAdvance ? { advance_target: advanceTarget } : {}) } };
  }

  if (state.phase === "planning") {
    const planFile = planningDocument(state);
    const key: TemplateKey = canSupervisorAdvance ? "planning.rn.advance" : "planning.rn";
    return { key, variables: { ...common, plan_file: planFile, ...(canSupervisorAdvance ? { advance_target: advanceTarget } : {}) } };
  }

  if (state.phase === "implementation" && state.sub_phase === "review") {
    const planFile = planningDocument(state);
    if (state.round > 2) {
      const myPrevReview = workflowArchivePath(state, safe(state.workflow_id), safe(state.phase), `r${state.round - 2}_review_${safe(identity)}.md`).replace(/\\/g, "/");
      const key: TemplateKey = canSupervisorAdvance ? "implementation.review.rn.advance" : "implementation.review.rn";
      return {
        key,
        variables: {
          ...common,
          plan_file: planFile,
          previous_review: myPrevReview,
          ...(canSupervisorAdvance ? { advance_target: advanceTarget } : {}),
        },
      };
    }
    return { key: "implementation.review.r2", variables: { ...common, plan_file: planFile } };
  }

  if (state.phase === "implementation" && state.sub_phase === "coding") {
    return { key: "implementation.coding.rn", variables: common };
  }

  if (state.phase === "summary") {
    if (state.round === 2) {
      return { key: "summary.r2", variables: common };
    }
    const key: TemplateKey = canSupervisorAdvance ? "summary.rn.advance" : "summary.rn";
    return { key, variables: { ...common, ...(canSupervisorAdvance ? { advance_target: advanceTarget } : {}) } };
  }

  return { key: "state.unknown", variables: { phase: safe(state.phase), sub_phase: safe(state.sub_phase), round } };
}

export function phaseLabel(phase: string, subPhase: string | null): string {
  if (phase === "implementation") return subPhase === "review" ? "代码评审" : "代码实现";
  if (phase === "requirements") return "需求分析";
  if (phase === "planning") return "实施计划";
  if (phase === "summary") return "汇总";
  return phase;
}

export function buildTip(state: PairFlowState, identity: string): string {
  const holdsTurn = state.turn === identity;

  if (state.phase !== "idle" && !holdsTurn) {
    const label = identityLabel(state, identity);
    return renderTip("state.wait.other", {
      identity_label: label,
      turn: safe(state.turn),
      round: String(state.round),
      phase_label: phaseLabel(safe(state.phase), state.sub_phase),
    });
  }

  const selection = selectTip(state, identity);
  return renderTip(selection.key, selection.variables);
}

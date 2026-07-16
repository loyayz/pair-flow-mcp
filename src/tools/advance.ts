import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseSession } from "../identity.js";
import { assignTurn, deleteState, getState, setState, getMutex, hasCompleteParticipantRoster, hasRecoveryPlaceholderParticipant, haveAllParticipantsSubmittedCurrentPhase, isSupervisor, getOtherIdentity, initRequirementsPhase, initPlanningPhase, initImplementationPhase, initSummaryPhase, type PairFlowState, type WaitWarningCycle } from "../state.js";

import { err, ok } from "../response.js";
import { workflowArchivePath, workflowWorkDir } from "../archive-path.js";
import { unbindWorkflow } from "../token-map.js";
import { guidance } from "../instruction.js";
import { publishWorkflowChange } from "../workflow-events.js";

export async function advance(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const { identity, workflowId, registered } = parseSession(extra.requestInfo?.headers);
  if (!registered) return err("valid registered token is required");
  if (!workflowId) return err("not bound to a workflow — call confirm_task first");

  return getMutex(workflowId).runExclusive(async () => {
    const state = getState(workflowId);
    if (!state) return err("workflow not found");
    if (hasRecoveryPlaceholderParticipant(state)) {
      return err("workflow recovery incomplete — every recovered participant must call confirm_task before advance");
    }
    if (!hasCompleteParticipantRoster(state)) {
      return err("both participants must join via confirm_task before advance");
    }
    if (!workflowWorkDir(state)) return err("workflow work_dir is missing");

    if (!isSupervisor(state, identity)) {
      return err("only supervisor can advance");
    }

    const currentPhase = state.phase;
    const bothSubmitted = haveAllParticipantsSubmittedCurrentPhase(state);

    if (state.turn !== identity) {
      if (currentPhase !== "idle" && bothSubmitted) {
        return err(`turn 尚未回到监督者 — 当前 turn: ${state.turn}。当前 turn 持有者需要继续处理或确认并 submit 后，监督者才能 advance`);
      }
      return err(`not your turn — current turn: ${state.turn}. Wait for the other participant to finish before advancing`);
    }
    if (state.turn_claimed_at === null) {
      return err("current turn is assigned but not claimed — call claim_turn first");
    }

    // 非 idle 阶段：双方至少各 submit 一次才能 advance（§6 收敛）
    if (currentPhase !== "idle") {
      if (!bothSubmitted) return err("both participants must submit at least once before advancing");
    }

    if (currentPhase === "idle") {
      if (!state.task || !state.task.spec_file) {
        return err("task not confirmed — call confirm_task first");
      }
      const nonSupervisor = getOtherIdentity(state, identity);
      if (!nonSupervisor) return err("no other participant registered");
      const next = markTurnAssigned(initRequirementsPhase(state, nonSupervisor, state.task), state.wait_warning_cycle);
      setState(workflowId, next);
      publishWorkflowChange(workflowId);

      const reqFile = workflowArchivePath(next, next.workflow_id!, "requirements", `r1_${nonSupervisor}.md`).replace(/\\/g, "/");
      return ok({ ok: true, new_phase: "requirements", turn: nonSupervisor }, guidance("advance.requirements.other", { identity, turn: nonSupervisor, file_path: reqFile }, {
        next_action: "wait_for_turn",
        allowed_tools: ["wait_for_turn"],
        reason_code: "PHASE_ADVANCED",
        context: {
          workflow_id: next.workflow_id!,
          phase: "requirements",
          round: 1,
          turn: nonSupervisor,
          holds_turn: nonSupervisor === identity,
          can_advance: false,
        },
      }));
    }

    if (currentPhase === "requirements") {
      if (state.task?.task_type === "requirements") {
        const next = markTurnAssigned(initSummaryPhase(state, identity), state.wait_warning_cycle);
        setState(workflowId, next);
        publishWorkflowChange(workflowId);

        const summaryFile = workflowArchivePath(next, next.workflow_id!, "summary", `r1_${identity}.md`).replace(/\\/g, "/");
        return ok({ ok: true, new_phase: "summary", turn: identity }, guidance("advance.summary.self", { identity, file_path: summaryFile }, {
          next_action: "wait_for_turn",
          allowed_tools: ["wait_for_turn"],
          reason_code: "PHASE_ADVANCED",
          context: {
            workflow_id: next.workflow_id!,
            phase: "summary",
            round: 1,
            turn: identity,
            holds_turn: true,
            can_advance: false,
          },
        }));
      }
      const reviewer = state.participants.find((p) => !p.is_developer);
      if (!reviewer) return err("no reviewer (is_developer=false) registered");
      const next = markTurnAssigned(initPlanningPhase(state, reviewer.identity), state.wait_warning_cycle);
      setState(workflowId, next);
      publishWorkflowChange(workflowId);

      const planIsSelf = reviewer.identity === identity;
      const planFile = workflowArchivePath(next, next.workflow_id!, "planning", `r1_${reviewer.identity}.md`).replace(/\\/g, "/");
      if (planIsSelf) {
        return ok({ ok: true, new_phase: "planning", turn: reviewer.identity }, guidance("advance.planning.self", { identity, file_path: planFile }, {
          next_action: "wait_for_turn",
          allowed_tools: ["wait_for_turn"],
          reason_code: "PHASE_ADVANCED",
          context: {
            workflow_id: next.workflow_id!,
            phase: "planning",
            round: 1,
            turn: reviewer.identity,
            holds_turn: true,
            can_advance: false,
          },
        }));
      }
      return ok({ ok: true, new_phase: "planning", turn: reviewer.identity }, guidance("advance.planning.other", { identity, turn: reviewer.identity, file_path: planFile }, {
        next_action: "wait_for_turn",
        allowed_tools: ["wait_for_turn"],
        reason_code: "PHASE_ADVANCED",
        context: {
          workflow_id: next.workflow_id!,
          phase: "planning",
          round: 1,
          turn: reviewer.identity,
          holds_turn: false,
          can_advance: false,
        },
      }));
    }

    if (currentPhase === "planning") {
      const developer = state.participants.find((p) => p.is_developer);
      if (!developer) return err("no developer (is_developer=true) registered");
      const next = markTurnAssigned(initImplementationPhase(state, developer.identity), state.wait_warning_cycle);
      setState(workflowId, next);
      publishWorkflowChange(workflowId);

      const implIsSelf = developer.identity === identity;
      const implFile = workflowArchivePath(next, next.workflow_id!, "implementation", `r1_coding_${developer.identity}.md`).replace(/\\/g, "/");
      if (implIsSelf) {
        return ok({ ok: true, new_phase: "implementation", sub_phase: "coding", turn: developer.identity }, guidance("advance.implementation.self", { identity, file_path: implFile }, {
          next_action: "wait_for_turn",
          allowed_tools: ["wait_for_turn"],
          reason_code: "PHASE_ADVANCED",
          context: {
            workflow_id: next.workflow_id!,
            phase: "implementation",
            sub_phase: "coding",
            round: 1,
            turn: developer.identity,
            holds_turn: true,
            can_advance: false,
          },
        }));
      }
      return ok({ ok: true, new_phase: "implementation", sub_phase: "coding", turn: developer.identity }, guidance("advance.implementation.other", { identity, turn: developer.identity, file_path: implFile }, {
        next_action: "wait_for_turn",
        allowed_tools: ["wait_for_turn"],
        reason_code: "PHASE_ADVANCED",
        context: {
          workflow_id: next.workflow_id!,
          phase: "implementation",
          sub_phase: "coding",
          round: 1,
          turn: developer.identity,
          holds_turn: false,
          can_advance: false,
        },
      }));
    }

    if (currentPhase === "implementation") {
      const next = markTurnAssigned(initSummaryPhase(state, identity), state.wait_warning_cycle);
      setState(workflowId, next);
      publishWorkflowChange(workflowId);

      const summaryFile = workflowArchivePath(next, next.workflow_id!, "summary", `r1_${identity}.md`).replace(/\\/g, "/");
      return ok({ ok: true, new_phase: "summary", turn: identity }, guidance("advance.summary.self", { identity, file_path: summaryFile }, {
        next_action: "wait_for_turn",
        allowed_tools: ["wait_for_turn"],
        reason_code: "PHASE_ADVANCED",
        context: {
          workflow_id: next.workflow_id!,
          phase: "summary",
          round: 1,
          turn: identity,
          holds_turn: true,
          can_advance: false,
        },
      }));
    }

    if (currentPhase === "summary") {
      if (state.task?.spec_file) {
        const pidPath = resolve(`${state.task.spec_file}.pid`);
        try {
          await unlink(pidPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            return err(`failed to delete pid file: ${pidPath.replace(/\\/g, "/")}`);
          }
        }
      }
      const finishedId = state.workflow_id;
      const finishedArchive = workflowArchivePath(state, finishedId!).replace(/\\/g, "/");
      deleteState(workflowId);
      unbindWorkflow(workflowId);

      return ok({ ok: true, new_phase: "idle", turn: "idle" }, guidance("advance.completed", { identity, archive_root: finishedArchive }, {
        next_action: "stop",
        allowed_tools: [],
        reason_code: "WORKFLOW_COMPLETED",
      }));
    }

    return err(`unknown phase: ${currentPhase}`);
  });
}

function markTurnAssigned(
  state: PairFlowState,
  previousCycle: WaitWarningCycle | null,
): PairFlowState {
  const assignedAt = new Date().toISOString();
  return assignTurn(state, state.turn, assignedAt, previousCycle);
}

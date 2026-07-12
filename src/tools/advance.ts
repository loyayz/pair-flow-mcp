import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseSession } from "../identity.js";
import { deleteState, getState, setState, getMutex, hasCompleteParticipantRoster, hasRecoveryPlaceholderParticipant, haveAllParticipantsSubmittedCurrentPhase, isSupervisor, getOtherIdentity, initRequirementsPhase, initPlanningPhase, initImplementationPhase, initSummaryPhase } from "../state.js";

import { err, ok } from "../response.js";
import { workflowArchivePath, workflowWorkDir } from "../archive-path.js";
import { unbindWorkflow } from "../token-map.js";
import { renderTip } from "../tip-template.js";

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

    if (state.turn !== "idle" && state.turn !== identity) {
      if (currentPhase !== "idle" && bothSubmitted) {
        return err(`turn 尚未回到监督者 — 当前 turn: ${state.turn}。当前 turn 持有者需要继续处理或确认并 submit 后，监督者才能 advance`);
      }
      return err(`not your turn — current turn: ${state.turn}. Wait for the other participant to finish before advancing`);
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
      const next = markTurnAssigned(initRequirementsPhase(state, nonSupervisor, state.task), identity);
      setState(workflowId, next);

      const reqFile = workflowArchivePath(next, next.workflow_id!, "requirements", `r1_${nonSupervisor}.md`).replace(/\\/g, "/");
      return ok({ ok: true, new_phase: "requirements", turn: nonSupervisor }, renderTip("advance.requirements.other", { identity, turn: nonSupervisor, file_path: reqFile }));
    }

    if (currentPhase === "requirements") {
      if (state.task?.task_type === "requirements") {
        const next = markTurnAssigned(initSummaryPhase(state, identity), identity);
        setState(workflowId, next);

        const summaryFile = workflowArchivePath(next, next.workflow_id!, "summary", `r1_${identity}.md`).replace(/\\/g, "/");
        return ok({ ok: true, new_phase: "summary", turn: identity }, renderTip("advance.summary.self", { identity, file_path: summaryFile }));
      }
      const reviewer = state.participants.find((p) => !p.is_developer);
      if (!reviewer) return err("no reviewer (is_developer=false) registered");
      const next = markTurnAssigned(initPlanningPhase(state, reviewer.identity), identity);
      setState(workflowId, next);

      const planIsSelf = reviewer.identity === identity;
      const planFile = workflowArchivePath(next, next.workflow_id!, "planning", `r1_${reviewer.identity}.md`).replace(/\\/g, "/");
      if (planIsSelf) {
        return ok({ ok: true, new_phase: "planning", turn: reviewer.identity }, renderTip("advance.planning.self", { identity, file_path: planFile }));
      }
      return ok({ ok: true, new_phase: "planning", turn: reviewer.identity }, renderTip("advance.planning.other", { identity, turn: reviewer.identity, file_path: planFile }));
    }

    if (currentPhase === "planning") {
      const developer = state.participants.find((p) => p.is_developer);
      if (!developer) return err("no developer (is_developer=true) registered");
      const next = markTurnAssigned(initImplementationPhase(state, developer.identity), identity);
      setState(workflowId, next);

      const implIsSelf = developer.identity === identity;
      const implFile = workflowArchivePath(next, next.workflow_id!, "implementation", `r1_coding_${developer.identity}.md`).replace(/\\/g, "/");
      if (implIsSelf) {
        return ok({ ok: true, new_phase: "implementation", sub_phase: "coding", turn: developer.identity }, renderTip("advance.implementation.self", { identity, file_path: implFile }));
      }
      return ok({ ok: true, new_phase: "implementation", sub_phase: "coding", turn: developer.identity }, renderTip("advance.implementation.other", { identity, turn: developer.identity, file_path: implFile }));
    }

    if (currentPhase === "implementation") {
      const next = markTurnAssigned(initSummaryPhase(state, identity), identity);
      setState(workflowId, next);

      const summaryFile = workflowArchivePath(next, next.workflow_id!, "summary", `r1_${identity}.md`).replace(/\\/g, "/");
      return ok({ ok: true, new_phase: "summary", turn: identity }, renderTip("advance.summary.self", { identity, file_path: summaryFile }));
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

      return ok({ ok: true, new_phase: "idle", turn: "idle" }, renderTip("advance.completed", { identity, archive_root: finishedArchive }));
    }

    return err(`unknown phase: ${currentPhase}`);
  });
}

function markTurnAssigned<T extends { turn: string; turn_switched_at: string | null; turn_claimed_at: string | null }>(
  state: T,
  callerIdentity: string,
): T {
  const assignedAt = new Date().toISOString();
  state.turn_switched_at = assignedAt;
  state.turn_claimed_at = state.turn === callerIdentity ? assignedAt : null;
  return state;
}

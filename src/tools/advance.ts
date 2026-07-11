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
      return ok({ ok: true, new_phase: "requirements", turn: nonSupervisor }, `[行动] 等待 ${nonSupervisor} 产出需求分析。对方调用 wait_for_turn 后将获得完整指引。不要频繁调用 get_state，wait_for_turn 会在 turn 到你时自动返回。\n\n[产出] ${nonSupervisor} 将产出到 ${reqFile}\n\n[当前] 你是 ${identity}（supervisor）。当前是第 1 轮需求分析，轮到 ${nonSupervisor} 了。`);
    }

    if (currentPhase === "requirements") {
      if (state.task?.task_type === "requirements") {
        const next = markTurnAssigned(initSummaryPhase(state, identity), identity);
        setState(workflowId, next);

        const summaryFile = workflowArchivePath(next, next.workflow_id!, "summary", `r1_${identity}.md`).replace(/\\/g, "/");
        return ok({ ok: true, new_phase: "summary", turn: identity }, `[行动] 产出汇总草稿，包含关键决策、遗留问题和后续建议。调用 wait_for_turn 获取完整指引。\n\n[产出] ${summaryFile}\n\n[当前] 你是 ${identity}（supervisor）。当前是第 1 轮汇总，轮到你了。`);
      }
      const reviewer = state.participants.find((p) => !p.is_developer);
      if (!reviewer) return err("no reviewer (is_developer=false) registered");
      const next = markTurnAssigned(initPlanningPhase(state, reviewer.identity), identity);
      setState(workflowId, next);

      const turnIsSelf = reviewer.identity === identity;
      const planFile = workflowArchivePath(next, next.workflow_id!, "planning", `r1_${reviewer.identity}.md`).replace(/\\/g, "/");
      const planAction = turnIsSelf
        ? `产出实施计划。调用 wait_for_turn 获取完整指引。`
        : `等待 ${reviewer.identity} 产出实施计划。对方调用 wait_for_turn 后将获得完整指引。不要频繁调用 get_state，wait_for_turn 会在 turn 到你时自动返回。`;
      const planWho = turnIsSelf ? "轮到你了。" : `轮到 ${reviewer.identity} 了。`;
      return ok({ ok: true, new_phase: "planning", turn: reviewer.identity }, `[行动] ${planAction}\n\n[产出] ${reviewer.identity} 将产出到 ${planFile}\n\n[当前] 你是 ${identity}（supervisor）。当前是第 1 轮实施计划，${planWho}`);
    }

    if (currentPhase === "planning") {
      const developer = state.participants.find((p) => p.is_developer);
      if (!developer) return err("no developer (is_developer=true) registered");
      const next = markTurnAssigned(initImplementationPhase(state, developer.identity), identity);
      setState(workflowId, next);

      const turnIsSelf = developer.identity === identity;
      const implFile = workflowArchivePath(next, next.workflow_id!, "implementation", `r1_coding_${developer.identity}.md`).replace(/\\/g, "/");
      const implAction = turnIsSelf
        ? `进行代码实现(coding)。调用 wait_for_turn 获取完整指引。`
        : `等待 ${developer.identity} 产出代码实现(coding)。对方调用 wait_for_turn 后将获得完整指引。不要频繁调用 get_state，wait_for_turn 会在 turn 到你时自动返回。`;
      const implWho = turnIsSelf ? "轮到你了。" : `轮到 ${developer.identity} 了。`;
      return ok({ ok: true, new_phase: "implementation", sub_phase: "coding", turn: developer.identity }, `[行动] ${implAction}\n\n[产出] ${developer.identity} 将产出到 ${implFile}\n\n[当前] 你是 ${identity}（supervisor）。当前是第 1 轮代码实现，${implWho}`);
    }

    if (currentPhase === "implementation") {
      const next = markTurnAssigned(initSummaryPhase(state, identity), identity);
      setState(workflowId, next);

      const summaryFile = workflowArchivePath(next, next.workflow_id!, "summary", `r1_${identity}.md`).replace(/\\/g, "/");
      return ok({ ok: true, new_phase: "summary", turn: identity }, `[行动] 产出汇总草稿，包含关键决策、遗留问题和后续建议。调用 wait_for_turn 获取完整指引。\n\n[产出] ${summaryFile}\n\n[当前] 你是 ${identity}（supervisor）。当前是第 1 轮汇总，轮到你了。`);
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

      return ok({ ok: true, new_phase: "idle" }, `[行动] 工作流已结束。全部产出归档于 ${finishedArchive}/。如需开始新任务，在服务未重启且 token 仍可用时可复用当前 token；双方分别调用 confirm_task，并使用相同 task_path。服务重启或 token 丢失时先重新 register。\n\n[当前] 你是 ${identity}（supervisor）。工作流已结束。`);
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

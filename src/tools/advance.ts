import { unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseIdentity } from "../identity.js";
import { loadState, saveState, isSupervisor, getOtherIdentity, initRequirementsPhase, initPlanningPhase, initImplementationPhase, initSummaryPhase, initIdleState } from "../state.js";
import { logEvent } from "../logger.js";
import { stateMutex } from "../mutex.js";
import { err, ok } from "../response.js";

export async function advance(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") return err("identity required");

  return stateMutex.runExclusive(async () => {
    const state = await loadState();

    if (!isSupervisor(state, identity)) {
      return err("only supervisor can advance");
    }

    // Only allow advance when turn is idle or belongs to the supervisor.
    // Prevents supervisor from skipping the other peer's round.
    if (state.turn !== "idle" && state.turn !== identity) {
      return err(`not your turn — current turn: ${state.turn}. Wait for the other peer to finish before advancing`);
    }

    const currentPhase = state.phase;

    if (currentPhase === "idle") {
      // IDLE → REQUIREMENTS
      if (state.peers.length < 2) {
        return err("both peers must register before advance");
      }
      if (!state.task || !state.task.spec_file) {
        return err("task not confirmed — call confirm_task first");
      }
      const nonSupervisor = getOtherIdentity(state, identity);
      if (!nonSupervisor) return err("no other peer registered");
      const next = initRequirementsPhase(state, nonSupervisor, state.task);
      await saveState(next);
      await logEvent("advance", { identity, from: "idle", to: "requirements", task: state.task.spec_file });
      const reqFile = join("handoff", next.workflow_id!, "requirements", `r1_${nonSupervisor}.md`).replace(/\\/g, "/");
      return ok({ ok: true, new_phase: "requirements", turn: nonSupervisor }, `[行动] 等待 ${nonSupervisor}(对方) 产出需求分析。对方 claim_turn 后将获得完整产出指引。调用 wait_for_turn 接口。\n\n[文件] ${reqFile}\n\n[状态] ${identity}(supervisor) | requirements | round: 1`);
    }

    // Non-IDLE phases: supervisor decides when to advance (no automated convergence check)

    if (currentPhase === "requirements") {
      const reviewer = state.peers.find((p) => !p.is_developer);
      if (!reviewer) return err("no reviewer (is_developer=false) registered");
      const next = initPlanningPhase(state, reviewer.identity);
      await saveState(next);
      await logEvent("advance", { identity, from: "requirements", to: "planning" });
      const turnIsSelf = reviewer.identity === identity;
      const planFile = join("handoff", next.workflow_id!, "planning", `r1_${reviewer.identity}.md`).replace(/\\/g, "/");
      return ok({ ok: true, new_phase: "planning", turn: reviewer.identity }, `[行动] 等待 ${reviewer.identity}(${turnIsSelf ? "你" : "对方"}) 产出实施计划。对方 claim_turn 后将获得完整产出指引。${turnIsSelf ? "调用 claim_turn 获取执行权。" : "调用 wait_for_turn 接口。"}\n\n[文件] ${planFile}\n\n[状态] ${identity}(supervisor) | planning | round: 1`);
    }

    if (currentPhase === "planning") {
      const developer = state.peers.find((p) => p.is_developer);
      if (!developer) return err("no developer (is_developer=true) registered");
      const next = initImplementationPhase(state, developer.identity);
      await saveState(next);
      await logEvent("advance", { identity, from: "planning", to: "implementation", dev_cycle: next.dev_cycle });
      const turnIsSelf = developer.identity === identity;
      const implFile = join("handoff", next.workflow_id!, "implementation", `r1_coding_${developer.identity}.md`).replace(/\\/g, "/");
      return ok({ ok: true, new_phase: "implementation", sub_phase: "coding", turn: developer.identity }, `[行动] 等待 ${developer.identity}(${turnIsSelf ? "你" : "对方"}) 产出代码实现(coding)。对方 claim_turn 后将获得完整产出指引。${turnIsSelf ? "调用 claim_turn 获取执行权。" : "调用 wait_for_turn 接口。"}\n\n[文件] ${implFile}\n\n[状态] ${identity}(supervisor) | implementation/coding | round: 1`);
    }

    if (currentPhase === "implementation") {
      const next = initSummaryPhase(state, identity);
      await saveState(next);
      await logEvent("advance", { identity, from: "implementation", to: "summary" });
      const summaryFile = join("handoff", next.workflow_id!, "summary", `r1_${identity}.md`).replace(/\\/g, "/");
      return ok({ ok: true, new_phase: "summary", turn: identity }, `[行动] 产出汇总草稿，包含关键决策、遗留问题和后续建议。调用 claim_turn 获取执行权。\n\n[文件] ${summaryFile}\n\n[状态] ${identity}(supervisor) | summary | round: 1`);
    }

    if (currentPhase === "summary") {
      // P2-7: Require at least one submission in SUMMARY before advancing to IDLE
      const summarySubmissions = Object.values(state.last_submit_per_turn).filter((s) => s.commit_hash);
      if (summarySubmissions.length === 0) {
        return err("no summary submissions yet — at least one peer must submit before advancing to IDLE");
      }
      // P2-7 supplement: Clean .pid file so next confirm_task starts fresh
      if (state.task?.spec_file) {
        const pidPath = resolve(`${state.task.spec_file}.pid`);
        const projectRoot = resolve(".");
        // Guard: .pid must live under the project root.
        // Use sep to prevent prefix bypass (e.g. /project-backup matching /project).
        if (pidPath.startsWith(projectRoot + sep) || pidPath === projectRoot) {
          try { await unlink(pidPath); } catch { /* .pid may not exist */ }
        }
      }
      const finishedId = state.workflow_id;
      const next = initIdleState(state);
      await saveState(next);
      await logEvent("advance", { identity, from: "summary", to: "idle" });
      return ok({ ok: true, new_phase: "idle" }, `[行动] 工作流已结束。全部产出归档于 handoff/${finishedId}/。\n\n如需开始新任务，双方重新 register 后，监督者调用 confirm_dir → confirm_task。\n\n[状态] ${identity}(supervisor) | idle`);
    }

    return err(`unknown phase: ${currentPhase}`);
  });
}

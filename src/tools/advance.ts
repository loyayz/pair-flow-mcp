import { unlink } from "node:fs/promises";
import { resolve, sep } from "node:path";
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
      return ok({ ok: true, new_phase: "requirements", turn: nonSupervisor }, `阶段已推进到 requirements，turn 已切给 ${nonSupervisor}(对方)。当前身份: ${identity}(supervisor)。请等待对方产出需求分析。调用 wait_for_turn 接口。`);
    }

    // Non-IDLE phases: supervisor decides when to advance (no automated convergence check)

    if (currentPhase === "requirements") {
      const reviewer = state.peers.find((p) => !p.is_developer);
      if (!reviewer) return err("no reviewer (is_developer=false) registered");
      const next = initPlanningPhase(state, reviewer.identity);
      await saveState(next);
      await logEvent("advance", { identity, from: "requirements", to: "planning" });
      return ok({ ok: true, new_phase: "planning", turn: reviewer.identity }, `阶段已推进到 planning，turn 已切给 ${reviewer.identity}(对方)。当前身份: ${identity}(supervisor)。请等待对方产出实施计划。调用 wait_for_turn 接口。`);
    }

    if (currentPhase === "planning") {
      const developer = state.peers.find((p) => p.is_developer);
      if (!developer) return err("no developer (is_developer=true) registered");
      const next = initImplementationPhase(state, developer.identity);
      await saveState(next);
      await logEvent("advance", { identity, from: "planning", to: "implementation", dev_cycle: next.dev_cycle });
      return ok({ ok: true, new_phase: "implementation", sub_phase: "coding", turn: developer.identity }, `阶段已推进到 implementation(coding)，turn 已切给 ${developer.identity}(对方)。当前身份: ${identity}(supervisor)。请等待对方产出代码。调用 wait_for_turn 接口。`);
    }

    if (currentPhase === "implementation") {
      const next = initSummaryPhase(state, identity);
      await saveState(next);
      await logEvent("advance", { identity, from: "implementation", to: "summary" });
      return ok({ ok: true, new_phase: "summary", turn: identity }, `阶段已推进到 summary，turn 归属: ${identity}(你)。当前身份: ${identity}(supervisor)。请产出汇总草稿。调用 claim_turn 获取执行权。`);
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
      const next = initIdleState(state);
      await saveState(next);
      await logEvent("advance", { identity, from: "summary", to: "idle" });
      return ok({ ok: true, new_phase: "idle" }, `工作流已结束，阶段: idle。当前身份: ${identity}(supervisor)。`);
    }

    return err(`unknown phase: ${currentPhase}`);
  });
}

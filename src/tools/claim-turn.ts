import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { parseIdentity } from "../identity.js";
import { loadState, saveState, isCurrentHolder, isSupervisor, getOtherIdentity, initRequirementsPhase, initPlanningPhase, initImplementationPhase, initSummaryPhase, initIdleState, type PairFlowState } from "../state.js";
import { logEvent } from "../logger.js";
import { stateMutex } from "../mutex.js";
import { err, ok } from "../response.js";
import { getTemplate, getRulesSummary } from "../template.js";
import { startLeaseTimer, stopLeaseTimer } from "../lease.js";
import { extractCycleCount } from "../planning.js";

export async function claimTurn(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") {
    return err("identity required");
  }

  const mode = args.mode as string;
  if (mode !== "turn" && mode !== "advance") {
    return err("mode must be 'turn' or 'advance'");
  }

  return stateMutex.runExclusive(async () => {
    const state = await loadState();

    if (mode === "advance") {
      return handleAdvance(state, identity, args);
    }
    return handleTurn(state, identity);
  });
}

async function handleTurn(state: PairFlowState, identity: string): Promise<CallToolResult> {
  if (state.converged && !state.blind_review_pending) {
    return err("phase already converged — claim_turn(turn) not allowed");
  }
  // Blind review: allow any registered peer to claim turn
  // P0-3: blind_review_pending 独立于 converged，盲审期间 converged=false，此处不做 converged 检查
  if (state.blind_review_pending) {
    const isPeer = state.peers.some((p) => p.identity === identity);
    if (!isPeer) {
      return err("identity not registered");
    }
    state.turn = identity;
    // Allow — bypass isCurrentHolder check below
  } else if (!isCurrentHolder(state, identity)) {
    return err(`not your turn — current turn: ${state.turn}`);
  }

  const token = randomUUID();
  const expires = new Date(Date.now() + getPhaseTimeoutMinutes(state) * 60 * 1000).toISOString();
  state.current_lease = { token, holder: identity, expires_at: expires, grace_used: false };
  state.current_timeout.expires = expires; // §9 sync
  state.current_timeout.started = new Date().toISOString();
  await saveState(state);
  await logEvent("claim_turn", { identity, mode: "turn", lease_token: token });
  startLeaseTimer(state);

  const isReviewer = state.sub_phase === "review";
  return ok({
    ok: true, lease_token: token, lease_expires_at: expires,
    template: getTemplate(state, isReviewer),
    rules_summary: getRulesSummary(state, "turn"),
  }, { tool: "get_state", when: "获取当前状态（issues/round/上次提交）后按 template 产出并 submit" });
}

async function handleAdvance(state: PairFlowState, identity: string, args: Record<string, unknown>): Promise<CallToolResult> {
  if (!isSupervisor(state, identity)) {
    return err("only supervisor can advance");
  }

  // Validate phase transitions
  const currentPhase = state.phase;

  if (currentPhase === "idle") {
    // IDLE → REQUIREMENTS
    if (state.peers.length < 2) {
      return err("both peers must register before advance");
    }
    const developers = state.peers.filter((p) => p.is_developer);
    if (developers.length !== 1) {
      return err("exactly one peer must be developer=true");
    }
    // Require timeouts on first advance
    const timeouts = args.timeouts as Record<string, number> | undefined;
    if (!timeouts || !timeouts.requirements || !timeouts.planning || !timeouts.implementation || !timeouts.summary) {
      return err("first advance requires timeouts: { requirements, planning, implementation, summary }");
    }
    // P0-21: require task on IDLE→REQUIREMENTS
    const task = args.task as { description?: string; spec_file?: string; goals?: string[]; context?: string } | undefined;
    if (!task || !task.description || task.description.trim().length < 10) {
      return err("advance from IDLE requires task: { description (≥10 chars), spec_file?, goals?, context? }");
    }
    const taskObj: import("../state.js").Task = {
      description: task.description.trim(),
      spec_file: task.spec_file,
      goals: task.goals,
      context: task.context,
    };
    state.current_timeout.phase_config = {
      requirements: timeouts.requirements,
      planning: timeouts.planning,
      implementation: timeouts.implementation,
      summary: timeouts.summary,
    };
    const nonSupervisor = getOtherIdentity(state, identity)!;
    const next = initRequirementsPhase(state, nonSupervisor, taskObj);
    await saveState(next);
    await logEvent("advance", { identity, from: "idle", to: "requirements", task: taskObj.description });
    return ok({ ok: true, new_phase: "requirements", turn: nonSupervisor, task: taskObj, template: getTemplate(next), rules_summary: getRulesSummary(next, "advance") }, { tool: "wait_for_turn", when: "turn 已切换给对方" });
  }

  // Non-IDLE phases: must be converged + blind review done
  const phase = currentPhase as string; // avoid TS narrowing
  if (phase !== "idle") {
    if (!state.converged) return err("phase not converged");
    if (state.blind_review_pending) return err("blind review pending — complete blind review before advance");
  }

  if (currentPhase === "requirements") {
    const reviewer = state.peers.find((p) => !p.is_developer);
    if (!reviewer) {
      return err("no reviewer (is_developer=false) registered");
    }
    const next = initPlanningPhase(state, reviewer.identity);
    await saveState(next);
    await logEvent("advance", { identity, from: "requirements", to: "planning" });
    return ok({ ok: true, new_phase: "planning", turn: reviewer.identity, template: getTemplate(next), rules_summary: getRulesSummary(next, "advance") }, { tool: "wait_for_turn", when: "turn 已切换给对方" });
  }

  if (currentPhase === "planning") {
    const developer = state.peers.find((p) => p.is_developer);
    if (!developer) {
      return err("no developer (is_developer=true) registered");
    }
    const next = initImplementationPhase(state, developer.identity);
    await saveState(next);
    await logEvent("advance", { identity, from: "planning", to: "implementation", dev_phase: next.dev_phase });
    return ok({ ok: true, new_phase: "implementation", dev_phase: next.dev_phase, sub_phase: "coding", turn: developer.identity, template: getTemplate(next), rules_summary: getRulesSummary(next, "advance") }, { tool: "wait_for_turn", when: "turn 已切换给对方" });
  }

  if (currentPhase === "implementation") {
    // P0-13: check deferred issues before advance
    const deferredIssues = state.issues.filter((i) => i.status === "deferred" && i.phase === currentPhase);
    if (deferredIssues.length > 0) {
      // deferred_reason may be null until defer tool is implemented — accept resolution as fallback
      const noReasonDeferred = deferredIssues.filter((i) =>
        (!i.deferred_reason || i.deferred_reason.trim().length === 0) &&
        (!i.resolution || i.resolution.trim().length === 0)
      );
      if (noReasonDeferred.length > 0) {
        return err(`cannot advance: ${noReasonDeferred.length} deferred issue(s) without reason`, { deferred_issues: noReasonDeferred.map((i) => ({ id: i.id, topic: i.topic })) });
      }
    }
    // Auto-escalate issues deferred across 2+ consecutive phases
    for (const di of deferredIssues) {
      di.deferred_count += 1; // increment each advance while deferred
      if (di.deferred_count >= 2) {
        di.status = "escalated";
        di.escalated_at = new Date().toISOString();
        di.type = "P0"; // upgrade
        di.deferred_count = 0; // reset after escalation
      }
    }

    // Multi-cycle: check planning draft for total cycles
    const totalCycles = state.workflow_id ? await extractCycleCount(state.workflow_id) : null;
    // P1-13/P2-4: warn when totalCycles is null — cycle check skipped, may be handoff unavailable
    if (totalCycles === null && state.workflow_id) {
      await logEvent("advance", { identity, warning: "totalCycles is null — advancing to SUMMARY without cycle check", workflow_id: state.workflow_id });
    }
    const currentCycle = state.dev_phase ?? 0;

    if (totalCycles !== null && currentCycle + 1 < totalCycles) {
      // More cycles remain — advance to next dev_phase within IMPLEMENTATION
      const dev = state.peers.find((p) => p.is_developer);
      const nextDev = dev?.identity ?? identity;
      const next = initImplementationPhase(state, nextDev);
      await saveState(next);
      await logEvent("advance", { identity, from: "implementation", to: "implementation", dev_phase: next.dev_phase });
      return ok({ ok: true, new_phase: "implementation", dev_phase: next.dev_phase, sub_phase: "coding", turn: nextDev, template: getTemplate(next), rules_summary: getRulesSummary(next, "advance") });
    }

    // Last cycle or no cycle count — advance to SUMMARY
    const nonSupervisor = getOtherIdentity(state, identity)!;
    const next = initSummaryPhase(state, nonSupervisor);
    await saveState(next);
    await logEvent("advance", { identity, from: "implementation", to: "summary" });
    return ok({ ok: true, new_phase: "summary", turn: nonSupervisor, template: getTemplate(next), rules_summary: getRulesSummary(next, "advance") }, { tool: "wait_for_turn", when: "turn 已切换给对方" });
  }

  if (currentPhase === "summary") {
    // P0-14: check open/deferred issues before SUMMARY→IDLE
    const unresolved = state.issues.filter((i) => i.status === "open" || i.status === "deferred");
    if (unresolved.length > 0) {
      return err(`cannot advance to IDLE: ${unresolved.length} unresolved issue(s)`, { unresolved_issues: unresolved.map((i) => ({ id: i.id, topic: i.topic, status: i.status })) });
    }

    const next = initIdleState(state);
    await saveState(next);
    await logEvent("advance", { identity, from: "summary", to: "idle" });
    return ok({ ok: true, new_phase: "idle" });
  }

  return err(`unknown phase: ${currentPhase}`);
}

function getPhaseTimeoutMinutes(state: PairFlowState): number {
  const cfg = state.current_timeout.phase_config;
  const D = 30;
  if (!cfg) return D;
  switch (state.phase) {
    case "requirements": return cfg.requirements ?? D;
    case "planning": return cfg.planning ?? D;
    case "implementation": return cfg.implementation ?? D;
    case "summary": return cfg.summary ?? D;
    default: return D;
  }
}

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { parseIdentity } from "../identity.js";
import { loadState, saveState, isCurrentHolder, isSupervisor, getOtherIdentity, initRequirementsPhase, initPlanningPhase, initImplementationPhase, initSummaryPhase, initIdleState, type PairFlowState } from "../state.js";
import { logEvent } from "../logger.js";
import { stateMutex } from "../mutex.js";

export async function claimTurn(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "identity required" }) }], isError: true };
  }

  const mode = args.mode as string;
  if (mode !== "turn" && mode !== "advance") {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "mode must be 'turn' or 'advance'" }) }], isError: true };
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
  if (state.converged) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "phase already converged — claim_turn(turn) not allowed" }) }], isError: true };
  }
  if (!isCurrentHolder(state, identity)) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `not your turn — current turn: ${state.turn}` }) }], isError: true };
  }

  const token = randomUUID();
  const expires = new Date(Date.now() + getPhaseTimeoutMinutes(state) * 60 * 1000).toISOString();
  state.current_lease = { token, holder: identity, expires_at: expires, grace_used: false };
  await saveState(state);
  await logEvent("claim_turn", { identity, mode: "turn", lease_token: token });

  return {
    content: [{ type: "text", text: JSON.stringify({ ok: true, lease_token: token, lease_expires_at: expires }) }],
  };
}

async function handleAdvance(state: PairFlowState, identity: string, args: Record<string, unknown>): Promise<CallToolResult> {
  if (!isSupervisor(state, identity)) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "only supervisor can advance" }) }], isError: true };
  }

  // Validate phase transitions
  const currentPhase = state.phase;

  if (currentPhase === "idle") {
    // IDLE → REQUIREMENTS
    if (state.peers.length < 2) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "both peers must register before advance" }) }], isError: true };
    }
    const developers = state.peers.filter((p) => p.is_developer);
    if (developers.length !== 1) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "exactly one peer must be developer=true" }) }], isError: true };
    }
    // Require timeouts on first advance
    const timeouts = args.timeouts as Record<string, number> | undefined;
    if (!timeouts || !timeouts.requirements || !timeouts.planning || !timeouts.implementation || !timeouts.summary) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "first advance requires timeouts: { requirements, planning, implementation, summary }" }) }], isError: true };
    }
    state.current_timeout.phase_config = {
      requirements: timeouts.requirements,
      planning: timeouts.planning,
      implementation: timeouts.implementation,
      summary: timeouts.summary,
    };
    const nonSupervisor = getOtherIdentity(state, identity)!;
    const next = initRequirementsPhase(state, nonSupervisor);
    await saveState(next);
    await logEvent("advance", { identity, from: "idle", to: "requirements" });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, new_phase: "requirements", turn: nonSupervisor }) }] };
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
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "no reviewer (is_developer=false) registered" }) }], isError: true };
    }
    const next = initPlanningPhase(state, reviewer.identity);
    await saveState(next);
    await logEvent("advance", { identity, from: "requirements", to: "planning" });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, new_phase: "planning", turn: reviewer.identity }) }] };
  }

  if (currentPhase === "planning") {
    const developer = state.peers.find((p) => p.is_developer);
    if (!developer) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "no developer (is_developer=true) registered" }) }], isError: true };
    }
    const next = initImplementationPhase(state, developer.identity);
    await saveState(next);
    await logEvent("advance", { identity, from: "planning", to: "implementation", dev_phase: next.dev_phase });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, new_phase: "implementation", dev_phase: next.dev_phase, sub_phase: "coding", turn: developer.identity }) }] };
  }

  if (currentPhase === "implementation") {
    // Check if there are more dev_phases (from planning draft — stored in state or hardcoded)
    // For now: advance to summary directly (multi-cycle support in Phase 2)
    const nonSupervisor = getOtherIdentity(state, identity)!;
    const next = initSummaryPhase(state, nonSupervisor);
    await saveState(next);
    await logEvent("advance", { identity, from: "implementation", to: "summary" });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, new_phase: "summary", turn: nonSupervisor }) }] };
  }

  if (currentPhase === "summary") {
    const next = initIdleState(state);
    await saveState(next);
    await logEvent("advance", { identity, from: "summary", to: "idle" });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, new_phase: "idle" }) }] };
  }

  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `unknown phase: ${currentPhase}` }) }], isError: true };
}

function err(message: string): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }], isError: true };
}

function getPhaseTimeoutMinutes(state: PairFlowState): number {
  const cfg = state.current_timeout.phase_config;
  switch (state.phase) {
    case "requirements": return cfg.requirements;
    case "planning": return cfg.planning;
    case "implementation": return cfg.implementation;
    case "summary": return cfg.summary;
    default: return 30;
  }
}

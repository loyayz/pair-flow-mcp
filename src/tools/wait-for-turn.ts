import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseIdentity } from "../identity.js";
import { loadState } from "../state.js";
import { err, ok } from "../response.js";

const POLL_INTERVAL_MS = 10_000;
const TIMEOUT_MS = 60_000;

export async function waitForTurn(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") return err("identity required");

  const started = Date.now();
  const initialState = await loadState();

  // Already caller's turn — return immediately
  if (initialState.turn === identity) {
    return ok({ ok: true, turn: initialState.turn, phase: initialState.phase, round: initialState.round, waited_ms: 0 },
      { tool: "claim_turn", when: "获取 turn 开始工作" });
  }

  // Not registered
  if (!initialState.peers.some((p) => p.identity === identity)) {
    return err("identity not registered");
  }

  const initialPhase = initialState.phase;

  while (Date.now() - started < TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    const state = await loadState();

    // Turn switched to caller
    if (state.turn === identity) {
      return ok({ ok: true, turn: state.turn, phase: state.phase, round: state.round, waited_ms: Date.now() - started },
        { tool: "claim_turn", when: "获取 turn 开始工作" });
    }

    // Both peers now registered (was waiting for second peer, or both in IDLE)
    if (initialState.peers.length < 2 && state.peers.length >= 2) {
      return ok({ ok: true, turn: state.turn, phase: state.phase, round: state.round, waited_ms: Date.now() - started, note: "both peers registered" },
        { tool: "wait_for_turn", when: "双方已注册，等待 supervisor advance" });
    }

    // Phase changed (converged, advanced from IDLE, etc.) — but not during blind_review_pending
    if (state.phase !== initialPhase || (state.converged && !state.blind_review_pending)) {
      const next = state.turn === identity
        ? { tool: "claim_turn", when: "阶段已变更且 turn=自己，获取 turn" } as const
        : { tool: "wait_for_turn", when: "阶段已变更但 turn 不是自己，继续等待" } as const;
      return ok({ ok: true, turn: state.turn, phase: state.phase, round: state.round, waited_ms: Date.now() - started, note: "phase changed or converged before turn" }, next);
    }
  }

  // Timeout — return current state
  const finalState = await loadState();
  return ok({ ok: true, turn: finalState.turn, phase: finalState.phase, round: finalState.round, waited_ms: TIMEOUT_MS, note: "timeout" },
    { tool: "wait_for_turn", when: "超时，继续轮询" });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

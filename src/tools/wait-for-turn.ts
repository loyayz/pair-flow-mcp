import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseIdentity } from "../identity.js";
import { loadState } from "../state.js";

const POLL_INTERVAL_MS = 2000;
const TIMEOUT_MS = 60_000;

export async function waitForTurn(
  _args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "identity required" }) }], isError: true };
  }

  const started = Date.now();
  const initialState = await loadState();

  // Already caller's turn — return immediately
  if (initialState.turn === identity) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        ok: true, turn: initialState.turn, phase: initialState.phase, round: initialState.round, waited_ms: 0,
      }) }],
    };
  }

  // Not registered
  if (!initialState.peers.some((p) => p.identity === identity)) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "identity not registered" }) }], isError: true };
  }

  const initialPhase = initialState.phase;
  const initialTurn = initialState.turn;

  while (Date.now() - started < TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    const state = await loadState();

    // Turn switched to caller
    if (state.turn === identity) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          ok: true, turn: state.turn, phase: state.phase, round: state.round, waited_ms: Date.now() - started,
        }) }],
      };
    }

    // Phase changed (converged, advanced, etc.)
    if (state.phase !== initialPhase || state.converged) {
      return {
        content: [{ type: "text", text: JSON.stringify({
          ok: true, turn: state.turn, phase: state.phase, round: state.round,
          waited_ms: Date.now() - started, note: "phase changed or converged before turn",
        }) }],
      };
    }
  }

  // Timeout — return current state
  const finalState = await loadState();
  return {
    content: [{ type: "text", text: JSON.stringify({
      ok: true, turn: finalState.turn, phase: finalState.phase, round: finalState.round, waited_ms: TIMEOUT_MS, note: "timeout",
    }) }],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseIdentity } from "../identity.js";
import { loadState } from "../state.js";
import { err, ok } from "../response.js";

const POLL_INTERVAL_MS = 10_000;
const TIMEOUT_MS = 600_000;

export async function waitForTurn(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") return err("identity required");

  const initialState = await loadState();
  if (!initialState.peers.some((p) => p.identity === identity)) {
    return err("identity not registered");
  }

  const started = Date.now();

  while (Date.now() - started < TIMEOUT_MS) {
    const state = await loadState();
    if (state.turn === identity) {
      return ok({ turn: state.turn, phase: state.phase, round: state.round }, "下一步调用 claim_turn 接口");
    }
    // Warn if turn was given but not claimed within 30 minutes
    if (state.turn_switched_at && !state.turn_claimed_at) {
      const elapsed = (Date.now() - new Date(state.turn_switched_at).getTime()) / 60_000;
      if (elapsed > 30) {
        return ok({ turn: state.turn, phase: state.phase, round: state.round, warning: `对方可能已掉线：turn 已于 ${Math.round(elapsed)} 分钟前切换给 ${state.turn}，但未被领取` }, "下一步调用 wait_for_turn 接口");
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  const state = await loadState();
  return ok({ turn: state.turn, phase: state.phase, round: state.round }, "下一步调用 wait_for_turn 接口");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

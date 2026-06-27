import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseIdentity } from "../identity.js";
import { loadState, saveState, isCurrentHolder } from "../state.js";
import { stateMutex } from "../mutex.js";
import { err, ok } from "../response.js";
import { buildTip } from "../tip.js";

export async function claimTurn(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") return err("identity required");

  return stateMutex.runExclusive(async () => {
    const state = await loadState();
    if (!state.peers.some((p) => p.identity === identity)) return err("identity not registered");
    if (!isCurrentHolder(state, identity)) {
      return err(`not your turn — current turn: ${state.turn}`);
    }
    state.turn_claimed_at = new Date().toISOString();
    await saveState(state);
    return ok({ ok: true }, buildTip(state, identity));
  });
}
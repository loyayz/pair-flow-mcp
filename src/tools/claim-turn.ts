import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseSession } from "../identity.js";
import { getState, setState, getMutex, isCurrentHolder } from "../state.js";
import { err, ok } from "../response.js";
import { buildTip } from "../tip.js";

export async function claimTurn(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const { identity, workflowId } = parseSession(extra.requestInfo?.headers);
  if (identity === "unknown") return err("identity required");
  if (!workflowId) return err("not bound to a workflow — call confirm_task first");

  return getMutex(workflowId).runExclusive(async () => {
    const state = getState(workflowId);
    if (!state) return err("workflow not found");
    if (!state.peers.some((p) => p.identity === identity)) return err("identity not registered");
    if (!isCurrentHolder(state, identity)) {
      return err(`not your turn — current turn: ${state.turn}`);
    }
    state.turn_claimed_at = new Date().toISOString();
    setState(workflowId, state);
    return ok({ ok: true }, buildTip(state, identity));
  });
}

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseSession } from "../identity.js";
import { getState, hasCompleteParticipantRoster, hasRecoveryPlaceholderParticipant } from "../state.js";
import { err, ok } from "../response.js";
import { buildTip } from "../tip.js";
import { renderTip } from "../tip-template.js";

export async function getStateTool(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const { identity, workflowId, registered } = parseSession(extra.requestInfo?.headers);
  if (!registered) return err("valid registered token is required");
  const state = workflowId ? getState(workflowId) : undefined;
  if (!state) return ok({}, renderTip("get-state.unbound", { identity }));
  if (!state.participants.some((p) => p.identity === identity)) {
    return ok({}, renderTip("get-state.inactive", { identity }));
  }
  const workflowData = {
    workflow_id: workflowId,
    phase: state.phase,
    sub_phase: state.sub_phase,
    round: state.round,
    turn: state.turn,
  };
  if (hasRecoveryPlaceholderParticipant(state)) {
    return ok(workflowData, renderTip("get-state.recovery-pending", { identity, workflow_id: workflowId }));
  }
  if (!hasCompleteParticipantRoster(state)) {
    return ok(workflowData, renderTip("get-state.roster-pending", { identity, workflow_id: workflowId }));
  }
  return ok(workflowData, buildTip(state, identity));
}

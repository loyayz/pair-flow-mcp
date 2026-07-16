import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { parseSession } from "../identity.js";
import {
  getMutex,
  getState,
  hasCompleteParticipantRoster,
  setState,
  type PairFlowState,
} from "../state.js";
import { err, ok } from "../response.js";
import { buildGuidance, reliableWorkflowPhase } from "../tip.js";
import { publishWorkflowChange } from "../workflow-events.js";

function validateClaimState(
  state: PairFlowState,
  identity: string,
): CallToolResult | null {
  if (!state.participants.some((participant) => participant.identity === identity)) {
    return err("identity not registered");
  }
  if (!hasCompleteParticipantRoster(state)) {
    return err("both participants must join via confirm_task before claim_turn");
  }
  if (!reliableWorkflowPhase(state).phase) {
    return err("unsupported workflow state");
  }
  if (state.turn !== identity) {
    return err(`not your turn — current turn: ${state.turn}`);
  }
  return null;
}

export async function claimTurn(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<CallToolResult> {
  extra.signal.throwIfAborted();
  const { identity, workflowId, registered } = parseSession(extra.requestInfo?.headers);
  if (!registered) return err("valid registered token is required");
  if (!workflowId) return err("not bound to a workflow — call confirm_task first");

  const observedState = getState(workflowId);
  if (!observedState) return err("workflow not found");
  const observedError = validateClaimState(observedState, identity);
  if (observedError) return observedError;

  const result = await getMutex(workflowId).runExclusive((): CallToolResult => {
    const state = getState(workflowId);
    if (!state) return err("workflow not found");
    const liveError = validateClaimState(state, identity);
    if (liveError) return liveError;

    if (state.turn_claimed_at === null) {
      extra.signal.throwIfAborted();
      state.turn_claimed_at = new Date().toISOString();
      state.wait_warning_cycle = null;
      setState(workflowId, state);
      publishWorkflowChange(workflowId);
    }

    return ok(
      { turn: state.turn, phase: state.phase, round: state.round },
      buildGuidance(state, identity),
    );
  });

  extra.signal.throwIfAborted();
  return result;
}

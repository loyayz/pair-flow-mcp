import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseSession } from "../identity.js";
import { getState, hasCompleteParticipantRoster, hasRecoveryPlaceholderParticipant } from "../state.js";
import { err, ok } from "../response.js";
import { buildGuidance, reliableWorkflowPhase, workflowInstructionContext } from "../tip.js";
import { guidance, type InstructionContext } from "../instruction.js";
import type { PairFlowState } from "../state.js";

function getStatePhaseProjection(
  state: PairFlowState,
): Pick<InstructionContext, "phase" | "sub_phase"> {
  const reliablePhase = reliableWorkflowPhase(state);
  if (!reliablePhase.phase) return {};
  return {
    phase: reliablePhase.phase,
    sub_phase: reliablePhase.phase === "implementation" ? reliablePhase.sub_phase : null,
  };
}

export async function getStateTool(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const { identity, workflowId, registered } = parseSession(extra.requestInfo?.headers);
  if (!registered) return err("valid registered token is required");
  const state = workflowId ? getState(workflowId) : undefined;
  if (!state) {
    return ok({}, guidance("get-state.unbound", { identity }, {
      next_action: "confirm_task",
      allowed_tools: ["confirm_task"],
      reason_code: "WORKFLOW_UNBOUND",
    }));
  }
  if (!state.participants.some((p) => p.identity === identity)) {
    return ok({}, guidance("get-state.inactive", { identity }, {
      next_action: "confirm_task",
      allowed_tools: ["confirm_task"],
      reason_code: "WORKFLOW_UNBOUND",
    }));
  }
  const workflowData = {
    workflow_id: workflowId,
    ...getStatePhaseProjection(state),
    round: state.round,
    turn: state.turn,
  };
  if (!reliableWorkflowPhase(state).phase) {
    return ok(workflowData, buildGuidance(state, identity));
  }
  if (hasRecoveryPlaceholderParticipant(state)) {
    return ok(workflowData, guidance("get-state.recovery-pending", { identity, workflow_id: workflowId! }, {
      next_action: "wait_for_turn",
      allowed_tools: ["wait_for_turn"],
      reason_code: "ROSTER_INCOMPLETE",
      context: workflowInstructionContext(state, identity),
    }));
  }
  if (!hasCompleteParticipantRoster(state)) {
    return ok(workflowData, guidance("get-state.roster-pending", { identity, workflow_id: workflowId! }, {
      next_action: "wait_for_turn",
      allowed_tools: ["wait_for_turn"],
      reason_code: "ROSTER_INCOMPLETE",
      context: workflowInstructionContext(state, identity),
    }));
  }
  return ok(workflowData, buildGuidance(state, identity));
}

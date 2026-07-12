import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseSession } from "../identity.js";
import { getState, hasCompleteParticipantRoster, hasRecoveryPlaceholderParticipant } from "../state.js";
import { err, ok } from "../response.js";
import { buildGuidance } from "../tip.js";
import { guidance } from "../instruction.js";

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
    phase: state.phase,
    sub_phase: state.sub_phase,
    round: state.round,
    turn: state.turn,
  };
  if (hasRecoveryPlaceholderParticipant(state)) {
    return ok(workflowData, guidance("get-state.recovery-pending", { identity, workflow_id: workflowId! }, {
      next_action: "wait_for_turn",
      allowed_tools: ["wait_for_turn"],
      reason_code: "ROSTER_INCOMPLETE",
      context: {
        workflow_id: workflowId!,
        phase: state.phase as "idle" | "requirements" | "planning" | "implementation" | "summary",
        round: state.round,
        turn: state.turn,
        holds_turn: false,
        can_advance: false,
      },
    }));
  }
  if (!hasCompleteParticipantRoster(state)) {
    return ok(workflowData, guidance("get-state.roster-pending", { identity, workflow_id: workflowId! }, {
      next_action: "wait_for_turn",
      allowed_tools: ["wait_for_turn"],
      reason_code: "ROSTER_INCOMPLETE",
      context: {
        workflow_id: workflowId!,
        phase: state.phase as "idle" | "requirements" | "planning" | "implementation" | "summary",
        round: state.round,
        turn: state.turn,
        holds_turn: false,
        can_advance: false,
      },
    }));
  }
  return ok(workflowData, buildGuidance(state, identity));
}

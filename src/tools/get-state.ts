import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadState } from "../state.js";

export async function getState(): Promise<CallToolResult> {
  const state = await loadState();
  const escalatedIds = state.issues.filter((i) => i.status === "escalated").map((i) => i.id);
  const fixLoopIds = state.issues.filter((i) => i.fix_review_cycles >= 2 && i.status === "open").map((i) => i.id);
  const staleIds = state.issues.filter((i) => i.fix_review_cycles >= 5 && i.status === "open").map((i) => i.id);
  const escalationRecommended = escalatedIds.length > 0 || fixLoopIds.length > 0 ? { issue_ids: [...escalatedIds, ...fixLoopIds], stale_warning: staleIds.length > 0 ? `issues ${staleIds.join(",")} have been open for 5+ review rounds` : undefined } : undefined;

  return {
    content: [{ type: "text", text: JSON.stringify({
      phase: state.phase, sub_phase: state.sub_phase, dev_phase: state.dev_phase,
      round: state.round, turn: state.turn, converged: state.converged,
      task: state.task,
      pending_supervisor_review: state.pending_supervisor_review,
      blind_review_pending: state.blind_review_pending,
      peers: state.peers, issues: state.issues,
      escalation_recommended: escalationRecommended,
    }) }],
  };
}

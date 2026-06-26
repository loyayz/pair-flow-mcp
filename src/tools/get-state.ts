import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadState } from "../state.js";
import { ok } from "../response.js";

// P1-10: blacklist — only exclude internal/sensitive fields, everything else auto-exposes
const INTERNAL_FIELDS = new Set([
  "schema_version",
  "workflow_id",
  "next_issue_id",
  "current_lease",
  "current_timeout",
  "history",
  "last_submit_per_turn",
]);

export async function getState(): Promise<CallToolResult> {
  const state = await loadState();
  const escalatedIds = state.issues.filter((i) => i.status === "escalated").map((i) => i.id);
  const fixLoopIds = state.issues.filter((i) => i.fix_review_cycles >= 2 && i.status === "open").map((i) => i.id);
  const staleIds = state.issues.filter((i) => i.fix_review_cycles >= 5 && i.status === "open").map((i) => i.id);
  const escalationRecommended = escalatedIds.length > 0 || fixLoopIds.length > 0 ? { issue_ids: [...escalatedIds, ...fixLoopIds], stale_warning: staleIds.length > 0 ? `issues ${staleIds.join(",")} have been open for 5+ review rounds` : undefined } : undefined;

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (!INTERNAL_FIELDS.has(key)) {
      output[key] = value;
    }
  }
  output.escalation_recommended = escalationRecommended;

  return ok(output);
}

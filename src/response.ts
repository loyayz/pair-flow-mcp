import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { renderTip } from "./tip-template.js";
import type { Guidance } from "./instruction.js";
import { guidance } from "./instruction.js";

const REMINDER = "质量优先，完整完成任务目标。";

export function err(message: string, extra?: Record<string, unknown>): CallToolResult {
  const safeExtra = extra ? { ...extra } : {};
  delete safeExtra.ok;
  delete safeExtra.error;
  delete safeExtra.tip;
  delete safeExtra.reminder;
  delete safeExtra.instruction;
  const rejectionGuidance = guidance("response.rejected", { message }, {
    next_action: "fix_request",
    allowed_tools: [],
    reason_code: "REQUEST_REJECTED",
  });
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ...safeExtra,
        ok: false,
        error: message,
        tip: rejectionGuidance.tip,
        reminder: REMINDER,
        instruction: rejectionGuidance.instruction,
      }),
    }],
    isError: true,
  };
}

export function ok(data: Record<string, unknown>, g?: Guidance | string): CallToolResult {
  // Backward-compatible: accept string tip directly
  const businessData = { ...data };
  delete businessData.ok;
  delete businessData.error;
  delete businessData.tip;
  delete businessData.reminder;
  delete businessData.instruction;

  let tip: string | undefined;
  let instruction = undefined;

  if (g && typeof g === "object" && "instruction" in g) {
    tip = g.tip;
    instruction = g.instruction;
  } else if (typeof g === "string") {
    tip = g;
  }

  const payload: Record<string, unknown> = {
    ...businessData,
    ok: true,
    reminder: REMINDER,
    ...(tip ? { tip } : {}),
    ...(instruction ? { instruction } : {}),
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

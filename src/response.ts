import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Guidance } from "./instruction.js";
import { guidance } from "./instruction.js";
import { businessRejectionSchema } from "./tool-output.js";

const REMINDER = "质量优先，完整完成任务目标。";

function sanitizeBusinessData(data: Record<string, unknown>): Record<string, unknown> {
  const businessData = { ...data };
  delete businessData.ok;
  delete businessData.error;
  delete businessData.tip;
  delete businessData.reminder;
  delete businessData.instruction;
  return businessData;
}

export function err(message: string, extra?: Record<string, unknown>): CallToolResult {
  const safeExtra = sanitizeBusinessData(extra ?? {});
  const rejectionGuidance = guidance("response.rejected", { message }, {
    next_action: "fix_request",
    allowed_tools: [],
    reason_code: "REQUEST_REJECTED",
  });
  const payload = businessRejectionSchema.parse({
    ...safeExtra,
    ok: false,
    error: message,
    tip: rejectionGuidance.tip,
    reminder: REMINDER,
    instruction: rejectionGuidance.instruction,
  });
  return {
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: true,
  };
}

export function ok(data: Record<string, unknown>, g?: Guidance): CallToolResult {
  const businessData = sanitizeBusinessData(data);
  const payload = {
    ...businessData,
    ok: true,
    reminder: REMINDER,
    ...(g ? { tip: g.tip, instruction: g.instruction } : {}),
  };
  return {
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

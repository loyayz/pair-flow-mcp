import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { renderTip } from "./tip-template.js";

const REMINDER = "质量优先，完整完成任务目标。";

export function err(message: string, extra?: Record<string, unknown>): CallToolResult {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ...extra,
        ok: false,
        error: message,
        tip: renderTip("response.rejected", { message }),
        reminder: REMINDER,
      }),
    }],
    isError: true,
  };
}

export function ok(data: Record<string, unknown>, tip?: string): CallToolResult {
  const businessData = { ...data };
  delete businessData.ok;
  delete businessData.error;
  delete businessData.tip;
  delete businessData.reminder;
  const payload = {
    ...businessData,
    ok: true,
    reminder: REMINDER,
    ...(tip ? { tip } : {}),
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

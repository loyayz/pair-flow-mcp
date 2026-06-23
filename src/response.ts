import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const REMINDER = "追求完美完成任务目标，而非快速推进。质量优先于速度——这是唯一核心。";

export function err(message: string, extra?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, reminder: REMINDER, ...extra }) }], isError: true };
}

export function ok(data: Record<string, unknown>): CallToolResult {
  data.reminder = REMINDER;
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

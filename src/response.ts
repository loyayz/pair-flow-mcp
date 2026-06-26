import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const REMINDER = "追求完美完成任务目标，而非快速推进。质量优先于速度——这是唯一核心。";

export interface NextAction {
  tool: string;
  when: string;
  // P1-3: extra 携带参数提示，消除 AI 手动推断参数的认知负担
  extra?: Record<string, unknown>;
}

export function err(message: string, extra?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, reminder: REMINDER, ...extra }) }], isError: true };
}

export function ok(data: Record<string, unknown>, next?: NextAction): CallToolResult {
  data.reminder = REMINDER;
  if (next) data.next = next;
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

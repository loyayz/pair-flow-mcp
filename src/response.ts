import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const REMINDER = "质量优先，完整完成任务目标。";

export function err(message: string, extra?: Record<string, unknown>): CallToolResult {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ...extra,
        ok: false,
        error: message,
        tip: `[行动] 请求被拒绝：${message}`,
        reminder: REMINDER,
      }),
    }],
    isError: true,
  };
}

export function ok(data: Record<string, unknown>, tip?: string): CallToolResult {
  const payload = {
    ...data,
    ok: true,
    reminder: REMINDER,
    ...(tip ? { tip } : {}),
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";

export async function ping(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  return {
    // uptime 单位：秒（浮点数，process.uptime() 返回秒）
    content: [{ type: "text", text: JSON.stringify({ ok: true, uptime: process.uptime() }) }],
  };
}

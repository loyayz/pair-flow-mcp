import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function err(message: string): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }], isError: true };
}

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadState } from "../state.js";

export async function getState(): Promise<CallToolResult> {
  const state = await loadState();
  return {
    content: [{ type: "text", text: JSON.stringify(state, null, 2) }],
  };
}

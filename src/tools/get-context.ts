import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadState } from "../state.js";

export async function getContext(): Promise<CallToolResult> {
  const state = await loadState();
  const currentKey = state.turn !== "idle" ? state.turn : undefined;
  const lastSubmit = currentKey ? state.last_submit_per_turn[currentKey] : null;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          phase: state.phase,
          sub_phase: state.sub_phase,
          dev_phase: state.dev_phase,
          round: state.round,
          turn: state.turn,
          task: state.task,
          issues: state.issues,
          last_submit: lastSubmit,
        }),
      },
    ],
  };
}

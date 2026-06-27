import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseIdentity } from "../identity.js";
import { loadState, saveState, defaultState, isSupervisor } from "../state.js";
import { logEvent } from "../logger.js";
import { stateMutex } from "../mutex.js";
import { err, ok } from "../response.js";

export async function resetState(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") return err("identity required");

  return stateMutex.runExclusive(async () => {
    const state = await loadState();

    if (!isSupervisor(state, identity)) {
      return err("only supervisor can reset — permission denied");
    }
    if (state.phase !== "idle") {
      return err(`reset only allowed in IDLE phase, current: ${state.phase}`);
    }

    const fresh = defaultState(state.current_timeout.phase_config);
    fresh.recovered = false;

    await saveState(fresh);
    await logEvent("reset", { identity, previous_workflow_id: state.workflow_id });

    return ok({ ok: true, message: "state reset — runtime cleared, handoff archives preserved" },
      "下一步调用 register 接口");
  });
}

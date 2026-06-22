import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseIdentity } from "../identity.js";
import { loadState, saveState } from "../state.js";
import { logEvent } from "../logger.js";
import { stateMutex } from "../mutex.js";

export async function register(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "identity required — set X-AI-Identity header" }) }], isError: true };
  }

  const supervisor = args.supervisor === true;
  const developer = args.developer === true;

  return stateMutex.runExclusive(async () => {
    const state = await loadState();
    const now = new Date().toISOString();

    // Validate phase
    if (state.phase !== "idle") {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `register only allowed in IDLE phase, current: ${state.phase}` }) }], isError: true };
    }

    // Check for existing registration
    const existing = state.peers.find((p) => p.identity === identity);
    const overwritten = existing !== undefined;
    if (overwritten) {
      const warning = `previous connection had in-flight operation, completed before override`;
      // Remove old, add new
      state.peers = state.peers.filter((p) => p.identity !== identity);
      state.peers.push({ identity, role: supervisor ? "supervisor" : "peer", is_developer: developer, registered_at: now });
      await saveState(state);
      await logEvent("register", { identity, supervisor, developer, overwritten: true });
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, identity, role: supervisor ? "supervisor" : "peer", is_developer: developer, warning }) }],
      };
    }

    // Validate role constraints
    if (supervisor) {
      const existingSupervisor = state.peers.find((p) => p.role === "supervisor");
      if (existingSupervisor) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `supervisor already registered: ${existingSupervisor.identity}` }) }], isError: true };
      }
    }

    state.peers.push({ identity, role: supervisor ? "supervisor" : "peer", is_developer: developer, registered_at: now });
    await saveState(state);
    await logEvent("register", { identity, supervisor, developer });

    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, identity, role: supervisor ? "supervisor" : "peer", is_developer: developer }) }],
    };
  });
}

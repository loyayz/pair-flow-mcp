import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseIdentity } from "../identity.js";
import { loadState } from "../state.js";
import { ok } from "../response.js";

export async function whoAmI(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  const state = await loadState();
  const peer = state.peers.find((p) => p.identity === identity);
  const registered = peer !== undefined;
  const next = registered
    ? { tool: "wait_for_turn", when: "等待双方就位并推进阶段" }
    : { tool: "register", when: "注册身份和角色" };
  return ok({
    identity,
    registered,
    role: peer?.role ?? null,
    is_developer: peer?.is_developer ?? null,
  }, next);
}

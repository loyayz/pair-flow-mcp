import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseSession } from "../identity.js";
import { getState } from "../state.js";
import { ok } from "../response.js";

export async function whoAmI(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const { identity, workflowId, registered } = parseSession(extra.requestInfo?.headers);
  if (identity === "unknown") {
    return ok({ identity: "unknown", registered: false, joined_workflow: false });
  }
  const state = workflowId ? getState(workflowId) : undefined;
  const peer = state?.peers.find((p) => p.identity === identity);
  return ok({
    identity,
    registered,
    joined_workflow: !!peer,
    is_supervisor: peer?.role === "supervisor",
    is_developer: peer?.is_developer ?? false,
    workflow_id: workflowId,
  });
}

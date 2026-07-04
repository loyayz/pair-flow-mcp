import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseSession } from "../identity.js";
import { getState } from "../state.js";
import { ok } from "../response.js";
import { buildTip } from "../tip.js";

export async function getStateTool(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const { identity, workflowId } = parseSession(extra.requestInfo?.headers);
  const state = workflowId ? getState(workflowId) : undefined;
  if (!state) return ok({ tip: `[行动] 你还未绑定到任何工作流。调用 confirm_task 确认任务文档并声明角色。` });
  return ok({ tip: buildTip(state, identity) });
}

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseSession } from "../identity.js";
import { getState, hasRecoveryPlaceholderParticipant } from "../state.js";
import { ok } from "../response.js";
import { buildTip } from "../tip.js";

export async function getStateTool(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const { identity, workflowId } = parseSession(extra.requestInfo?.headers);
  const state = workflowId ? getState(workflowId) : undefined;
  if (!state) return ok({ tip: `[行动] 你还未绑定到任何工作流。调用 confirm_task 确认任务文档并声明职责。` });
  if (!state.participants.some((p) => p.identity === identity)) {
    return ok({ tip: `[行动] 你当前没有加入活跃工作流。若要开始或恢复任务，调用 confirm_task 确认任务文档并声明职责。\n\n[当前] 你是 ${identity}。当前 token 未加入任何活跃 workflow。` });
  }
  if (hasRecoveryPlaceholderParticipant(state)) {
    return ok({ tip: `[行动] 工作流恢复未完成。所有从归档恢复出的参与者都必须先调用 confirm_task 重新确认职责和 work_dir；在此之前不要调用 advance、wait_for_turn 或 submit。\n\n[当前] 你是 ${identity}。工作流 ${workflowId} 仍有参与者未重新确认。` });
  }
  return ok({ tip: buildTip(state, identity) });
}

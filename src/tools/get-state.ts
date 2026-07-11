import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseSession } from "../identity.js";
import { getState, hasCompleteParticipantRoster, hasRecoveryPlaceholderParticipant } from "../state.js";
import { err, ok } from "../response.js";
import { buildTip } from "../tip.js";
import { formatTip } from "../tip-format.js";

export async function getStateTool(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const { identity, workflowId, registered } = parseSession(extra.requestInfo?.headers);
  if (!registered) return err("valid registered token is required");
  const state = workflowId ? getState(workflowId) : undefined;
  if (!state) return ok({}, formatTip({
    action: "调用 confirm_task 确认任务文档并声明职责。",
    current: `你是 ${identity}。当前 token 还未绑定到任何工作流。`,
  }));
  if (!state.participants.some((p) => p.identity === identity)) {
    return ok({}, formatTip({
      action: "若要开始或恢复任务，调用 confirm_task 确认任务文档并声明职责。",
      current: `你是 ${identity}。当前 token 未加入任何活跃 workflow。`,
    }));
  }
  if (hasRecoveryPlaceholderParticipant(state)) {
    return ok({}, formatTip({
      action: "等待所有从归档恢复出的参与者调用 confirm_task 重新确认职责和 work_dir；在此之前不要调用 advance、wait_for_turn 或 submit。",
      current: `你是 ${identity}。工作流恢复未完成：工作流 ${workflowId} 仍有参与者未重新确认。`,
    }));
  }
  if (!hasCompleteParticipantRoster(state)) {
    return ok({}, formatTip({
      action: "等待第二位参与者（另一位 AI）使用相同 task_path 调用 confirm_task 加入；在双方就位前不要调用 advance、wait_for_turn 或 submit。",
      current: `你是 ${identity}。工作流 ${workflowId} 当前只有一位已确认参与者。`,
    }));
  }
  return ok({}, buildTip(state, identity));
}

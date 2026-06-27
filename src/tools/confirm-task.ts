import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseIdentity } from "../identity.js";
import { loadState, saveState, isSupervisor } from "../state.js";
import { reconstructFromHandoff } from "../crash-recovery.js";
import { stateMutex } from "../mutex.js";
import { err, ok } from "../response.js";

function formatWorkflowId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export async function confirmTask(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") return err("identity required");

  const taskPath = args.task_path as string;
  if (!taskPath) return err("task_path is required");

  // Path traversal guard
  const resolved = resolve(taskPath);
  if (taskPath.includes("..")) return err("task_path must not contain path traversal");

  return stateMutex.runExclusive(async () => {
    const state = await loadState();
    if (!isSupervisor(state, identity)) return err("only supervisor can confirm task");
    if (state.phase !== "idle") return err("confirm_task only allowed in IDLE phase");

    state.task = { description: resolved, spec_file: resolved };

    const pidFile = `${resolved}.pid`;
    let recovered = false;

    try {
      const raw = (await readFile(pidFile, "utf-8")).trim();
      // Validate workflow ID format (14-digit timestamp)
      if (raw && /^\d{14}$/.test(raw)) {
        const recoveredState = await reconstructFromHandoff(state, undefined, raw);
        if (recoveredState) {
          // Restore workflow progress, keep current registered peers
          state.workflow_id = recoveredState.workflow_id;
          state.phase = recoveredState.phase;
          state.sub_phase = recoveredState.sub_phase;
          state.round = recoveredState.round;
          state.last_submit_per_turn = recoveredState.last_submit_per_turn;
          state.task = recoveredState.task;
          state.issues = recoveredState.issues;
          state.history = recoveredState.history;
          recovered = true;
        }
      }
    } catch {
      const wfId = formatWorkflowId();
      state.workflow_id = wfId;
      await writeFile(pidFile, wfId, "utf-8");
    }

    await saveState(state);

    const tip = recovered
      ? `任务已恢复，当前阶段: ${state.phase}。下一步调用 wait_for_turn 接口`
      : "下一步调用 advance 接口进入需求阶段";

    return ok({
      task_path: resolved,
      workflow_id: state.workflow_id,
      phase: state.phase,
      recovered,
    }, tip);
  });
}

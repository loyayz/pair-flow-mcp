import { access, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
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

    // Validate task file is under work_dir
    const supervisor = state.peers.find((p) => p.identity === identity);
    if (!supervisor?.work_dir) return err("supervisor must have a registered work_dir");
    const resolvedWorkDir = resolve(supervisor.work_dir);
    if (resolved !== resolvedWorkDir && !resolved.startsWith(resolvedWorkDir + sep)) {
      return err("task_path must be under work_dir");
    }

    // Validate task file actually exists
    try {
      await access(resolved);
    } catch {
      return err(`task file not found: ${resolved.replace(/\\/g, "/")}`);
    }

    state.task = { spec_file: resolved };

    const pidFile = `${resolved}.pid`;
    let recovered = false;

    try {
      const raw = (await readFile(pidFile, "utf-8")).trim();
      // Validate workflow ID format (14-digit timestamp)
      if (raw && /^\d{14}$/.test(raw)) {
        const recoveredState = await reconstructFromHandoff(state, raw);
        if (recoveredState) {
          // Restore workflow progress, keep current registered peers
          state.workflow_id = recoveredState.workflow_id;
          state.phase = recoveredState.phase;
          state.sub_phase = recoveredState.sub_phase;
          state.round = recoveredState.round;
          state.last_submit_per_turn = recoveredState.last_submit_per_turn;
          state.task = recoveredState.task;
          state.history = recoveredState.history;
          recovered = true;

          // P2-4: Validate recovered turn holder is registered. If not, fall back to first peer.
          const currentPeerIds = new Set(state.peers.map((p) => p.identity));
          if (!currentPeerIds.has(state.turn)) {
            state.turn = state.peers[0]?.identity ?? "idle";
          }
          // Clean last_submit_per_turn entries for unregistered identities
          for (const key of Object.keys(state.last_submit_per_turn)) {
            if (!currentPeerIds.has(key)) {
              delete state.last_submit_per_turn[key];
            }
          }
        }
      }
    } catch {
      const wfId = formatWorkflowId();
      state.workflow_id = wfId;
      await writeFile(pidFile, wfId, "utf-8");
    }

    await saveState(state);

    const identityInfo = `当前身份: ${identity}(supervisor)`;

    if (recovered) {
      const turnIsSelf = state.turn === identity;
      const turnInfo = turnIsSelf
        ? `turn 归属: ${state.turn}(你)`
        : `turn 归属: ${state.turn}(对方)`;
      const action = turnIsSelf
        ? "请向用户复述以上恢复状态，确认后调用 claim_turn 获取执行权"
        : "请等待对方操作，调用 wait_for_turn 接口";
      const taskPathNorm = resolved.replace(/\\/g, "/");
      const tip = `已恢复工作流 ${state.workflow_id}，当前阶段: ${state.phase}，轮次: ${state.round}。${identityInfo}。${turnInfo}。${action}。`;
      return ok({
        task_path: taskPathNorm,
        workflow_id: state.workflow_id,
        phase: state.phase,
        recovered,
      }, tip);
    }

    const taskPathNorm = resolved.replace(/\\/g, "/");
    const tip = `已确认任务文档: ${taskPathNorm}（绝对路径），工作流 ID: ${state.workflow_id}。${identityInfo}。请向用户复述以上信息并说明即将进入需求阶段、由对方(developer)先产出。待用户确认后调用 advance 接口。`;
    return ok({
      task_path: taskPathNorm,
      workflow_id: state.workflow_id,
      phase: state.phase,
      recovered,
    }, tip);
  });
}

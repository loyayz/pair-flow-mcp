import { access, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseSession } from "../identity.js";
import { getState, setState, getAllStates, defaultState, formatWorkflowId } from "../state.js";
import { reconstructFromHandoff, isWorkflowComplete } from "../crash-recovery.js";
import { err, ok } from "../response.js";
import { bindWorkflow } from "../token-map.js";

const HANDOFF_DIR = process.env.HANDOFF_DIR || "handoff";

async function findWorkflowByTaskPath(taskPath: string): Promise<string | null> {
  // Search in-memory states
  for (const [wfId, state] of [...getAllStates()]) {
    if (state.task?.spec_file === taskPath) return wfId;
  }
  return null;
}

async function readPidFile(taskPath: string): Promise<string | null> {
  try {
    const pidFile = `${taskPath}.pid`;
    const wfId = (await readFile(pidFile, "utf-8")).trim();
    if (!/^\d{14}$/.test(wfId)) return null;
    if (await isWorkflowComplete(wfId)) return null;
    return wfId;
  } catch { /* .pid doesn't exist or is unreadable */ }
  return null;
}

export async function confirmTask(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const { identity } = parseSession(extra.requestInfo?.headers);
  if (identity === "unknown") return err("identity required");

  const taskPath = args.task_path as string;
  if (!taskPath) return err("task_path is required");

  // Task type
  const taskType = (args.task_type as string) || "development";
  if (taskType !== "requirements" && taskType !== "development") {
    return err(`invalid task_type "${taskType}" — must be "requirements" or "development"`);
  }

  // Role declaration
  const supervisor = args.supervisor === true;
  const developer = args.developer === true;

  // work_dir
  const workDir = (args.work_dir as string) || "";
  if (!workDir) return err("work_dir is required");

  // Path traversal guard
  const resolvedTaskPath = resolve(taskPath);
  if (taskPath.includes("..")) return err("task_path must not contain path traversal");

  // Validate task file is under work_dir
  const resolvedWorkDir = resolve(workDir);
  if (resolvedTaskPath !== resolvedWorkDir && !resolvedTaskPath.startsWith(resolvedWorkDir + sep)) {
    return err("task_path must be under work_dir");
  }

  // Validate task file exists
  try { await access(resolvedTaskPath); } catch {
    return err(`task file not found: ${resolvedTaskPath.replace(/\\/g, "/")}`);
  }

  let wfId: string;
  let recovered = false;
  let isFirst = false;

  // 1. 查内存 — 是否有同 task_path 的活跃工作流
  let existing = await findWorkflowByTaskPath(resolvedTaskPath);

  // 2. 读 .pid — 恢复未完成工作流（内存中没找到时）
  if (!existing) {
    const pidWfId = await readPidFile(resolvedTaskPath);
    if (pidWfId) {
      const defState = defaultState();
      const recoveredState = await reconstructFromHandoff(defState, pidWfId);
      if (recoveredState) {
        setState(pidWfId, recoveredState);
        existing = pidWfId;
        recovered = true;
      }
    }
  }

  if (!existing) {
    // 全新工作流
    wfId = formatWorkflowId();
    const state = defaultState();
    state.workflow_id = wfId;
    state.task = { spec_file: resolvedTaskPath, task_type: taskType as "requirements" | "development" };
    // 将当前调用者加入 peers
    state.peers.push({
      identity,
      role: supervisor ? "supervisor" : "peer",
      is_developer: developer,
      registered_at: new Date().toISOString(),
      work_dir: workDir,
    });
    setState(wfId, state);
    isFirst = true;
  } else {
    wfId = existing;
    const state = getState(wfId);
    if (!state) return err("workflow state not found");

    // 当前调用者可能已经在工作流中（恢复场景）
    const alreadyIn = state.peers.some((p) => p.identity === identity);
    if (alreadyIn) {
      const raw = extra.requestInfo?.headers?.["x-ai-identity"] as string;
      if (raw) bindWorkflow(raw.trim(), wfId);

      const myPeer = state.peers.find(p => p.identity === identity)!;
      // 用确认时的入参覆盖重建推断的角色——调用者声明为准
      myPeer.role = supervisor ? "supervisor" : "peer";
      myPeer.is_developer = developer;
      setState(wfId, state);

      const turnIsSelf = state.turn === identity;
      const turnInfo = turnIsSelf ? `turn 在 ${state.turn}（你）` : `turn 在 ${state.turn}（对方）`;
      const tip = `[行动] 已重新加入工作流 ${wfId}。当前在 ${state.phase} 阶段第 ${state.round} 轮，${turnInfo}。调用 wait_for_turn（长轮询，10s 间隔，最多 600s）。不要频繁调用 get_state，wait_for_turn 会在 turn 到你时自动返回。\n\n[当前] 你是 ${identity}（${myPeer.role === "supervisor" ? "supervisor" : "developer"}）。工作流 ${wfId}。`;
      return ok({
        task_path: resolvedTaskPath.replace(/\\/g, "/"),
        workflow_id: wfId,
        phase: state.phase,
        recovered: true,
      }, tip);
    }

    // 检查是否已满
    if (state.peers.length >= 2) {
      return err("this task already has 2 peers — cannot join");
    }

    // 角色校验
    const firstPeer = state.peers[0];
    if (supervisor && firstPeer.role === "supervisor") {
      return err("supervisor already exists for this task");
    }
    if (developer && firstPeer.is_developer) {
      return err("developer already exists for this task");
    }

    // work_dir 一致性
    if (firstPeer.work_dir !== workDir) {
      return err(`work_dir mismatch: "${workDir}" vs "${firstPeer.work_dir}"`);
    }

    // 加入
    state.peers.push({
      identity,
      role: supervisor ? "supervisor" : "peer",
      is_developer: developer,
      registered_at: new Date().toISOString(),
      work_dir: workDir,
    });
    // idle 阶段双方就位后，turn 切给监督者——使其 wait_for_turn 立即返回
    if (state.phase === "idle") {
      const sup = state.peers.find((p) => p.role === "supervisor");
      if (sup) state.turn = sup.identity;
    }
    setState(wfId, state);
  }

  // 绑定 token → workflow
  const raw = extra.requestInfo?.headers?.["x-ai-identity"] as string;
  if (raw) bindWorkflow(raw.trim(), wfId);

  // 写 .pid
  const pidFile = `${resolvedTaskPath}.pid`;
  try { await writeFile(pidFile, wfId, "utf-8"); } catch { /* best effort */ }

  const curState = getState(wfId)!;
  const roleLabel = supervisor ? "supervisor" : "developer";
  const phaseText = curState.phase !== "idle" ? `，${curState.phase} 阶段第 ${curState.round} 轮` : "，idle 阶段";
  const statusLine = `[当前] 你是 ${identity}（${roleLabel}）。工作流 ${wfId}${phaseText}。`;

  let actionLine: string;
  if (isFirst) {
    actionLine = `${recovered ? "已恢复" : "已创建"}工作流 ${wfId}。等待对方 AI 以相同 task_path 调用 confirm_task 加入。调用 wait_for_turn（长轮询，10s 间隔，最多 600s）。不要频繁调用 get_state，wait_for_turn 会在 turn 到你时自动返回。`;
  } else {
    const p = curState.peers;
    const names = p.map((x) => `${x.identity}（${x.role === "supervisor" ? "supervisor" : "developer"}）`).join(" + ");
    actionLine = `已加入工作流 ${wfId}。双方已就位：${names}。调用 wait_for_turn（长轮询，10s 间隔，最多 600s）。不要频繁调用 get_state，wait_for_turn 会在 turn 到你时自动返回。`;
  }

  return ok({
    task_path: resolvedTaskPath.replace(/\\/g, "/"),
    workflow_id: wfId,
    phase: curState.phase,
    recovered,
  }, `[行动] ${actionLine}\n\n${statusLine}`);
}

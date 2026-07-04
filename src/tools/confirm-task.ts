import { access, readFile, writeFile, readdir } from "node:fs/promises";
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

async function findIncompleteByTaskPath(taskPath: string): Promise<string | null> {
  try {
    const entries = await readdir(HANDOFF_DIR, { withFileTypes: true });
    const wfDirs = entries.filter((e) => e.isDirectory() && /^\d{14}$/.test(e.name));
    // Sort descending, return the latest incomplete workflow
    wfDirs.sort((a, b) => b.name.localeCompare(a.name));
    for (const d of wfDirs) {
      if (await isWorkflowComplete(d.name)) continue;
      // Check if this workflow's task_path matches
      for (const phase of ["requirements", "planning", "implementation", "summary"]) {
        try {
          const phaseDir = `${HANDOFF_DIR}/${d.name}/${phase}`;
          const pEntries = await readdir(phaseDir, { withFileTypes: true });
          const metaFile = pEntries.find((e) => e.isFile() && e.name.endsWith(".meta.json"));
          if (metaFile) {
            const metaRaw = await readFile(`${phaseDir}/${metaFile.name}`, "utf-8");
            const meta = JSON.parse(metaRaw);
            if (meta.task?.spec_file === taskPath) return d.name;
            break; // Found this workflow's task, doesn't match — try next workflow
          }
        } catch { /* phase dir may not exist */ }
      }
    }
  } catch { /* handoff dir doesn't exist */ }
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

  // 2. 查磁盘 — handoff 扫描未完成工作流（仅在内存中没找到时）
  if (!existing) {
    const handoffWfId = await findIncompleteByTaskPath(resolvedTaskPath);
    if (handoffWfId) {
      const defState = defaultState();
      const recoveredState = await reconstructFromHandoff(defState, handoffWfId);
      if (recoveredState) {
        setState(handoffWfId, recoveredState);
        existing = handoffWfId;
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
      const turnIsSelf = state.turn === identity;
      const turnInfo = turnIsSelf ? `turn 在 ${state.turn}（你）` : `turn 在 ${state.turn}（对方）`;
      const tip = `[行动] 已重新加入工作流 ${wfId}。当前在 ${state.phase} 阶段第 ${state.round} 轮，${turnInfo}。调用 wait_for_turn，根据服务端提示继续下一步。\n\n[当前] 你是 ${identity}（${myPeer.role === "supervisor" ? "supervisor" : "developer"}）。工作流 ${wfId}。`;
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
    actionLine = `${recovered ? "已恢复" : "已创建"}工作流 ${wfId}。等待对方 AI 以相同 task_path 调用 confirm_task 加入。调用 wait_for_turn，根据服务端提示继续下一步。`;
  } else {
    const p = curState.peers;
    const names = p.map((x) => `${x.identity}（${x.role === "supervisor" ? "supervisor" : "developer"}）`).join(" + ");
    actionLine = `已加入工作流 ${wfId}。双方已就位：${names}。调用 wait_for_turn，根据服务端提示继续下一步。`;
  }

  return ok({
    task_path: resolvedTaskPath.replace(/\\/g, "/"),
    workflow_id: wfId,
    phase: curState.phase,
    recovered,
  }, `[行动] ${actionLine}\n\n${statusLine}`);
}

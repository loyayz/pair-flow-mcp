import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseSession } from "../identity.js";
import { getState, setState, getAllStates, defaultState, formatWorkflowId, isRecoveryPlaceholderParticipant, type Participant } from "../state.js";
import { reconstructFromHandoff } from "../crash-recovery.js";
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
    return wfId;
  } catch { /* .pid doesn't exist or is unreadable */ }
  return null;
}

function validateParticipantCombination(participants: Participant[]): string | null {
  const supervisorCount = participants.filter((p) => p.role === "supervisor").length;
  const developerCount = participants.filter((p) => p.is_developer).length;
  if (supervisorCount > 1) return "supervisor already exists for this task";
  if (developerCount > 1) return "developer already exists for this task";
  if (participants.length >= 2 && !participants.some(isRecoveryPlaceholderParticipant)) {
    if (supervisorCount !== 1) return "exactly one supervisor is required once both participants have joined";
    if (developerCount !== 1) return "exactly one developer is required once both participants have joined";
  }

  const confirmedWorkDirs = participants
    .filter((p) => !isRecoveryPlaceholderParticipant(p) && p.work_dir)
    .map((p) => p.work_dir!);
  const firstWorkDir = confirmedWorkDirs[0];
  const mismatchedWorkDir = firstWorkDir
    ? confirmedWorkDirs.find((workDir) => !samePath(workDir, firstWorkDir))
    : undefined;
  if (firstWorkDir && mismatchedWorkDir) {
    return `work_dir mismatch: "${posixPath(mismatchedWorkDir)}" vs "${posixPath(firstWorkDir)}"`;
  }

  return null;
}

function roleLabel(participant: Pick<Participant, "role" | "is_developer">): string {
  if (participant.role === "supervisor" && participant.is_developer) return "supervisor/developer";
  if (participant.role === "supervisor") return "supervisor";
  if (participant.is_developer) return "developer";
  return "reviewer";
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function posixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function hasRelativeSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((part) => part === "." || part === "..");
}

export async function confirmTask(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const { identity } = parseSession(extra.requestInfo?.headers);
  if (identity === "unknown") return err("identity required");

  const taskPath = args.task_path as string;
  if (!taskPath) return err("task_path is required");
  if (!isAbsolute(taskPath)) return err("task_path must be an absolute path");
  if (hasRelativeSegment(taskPath)) return err("task_path must not contain . or .. path segments");

  // Task type
  const suppliedTaskType = args.task_type as string | undefined;
  const taskType = suppliedTaskType || "development";
  if (taskType !== "requirements" && taskType !== "development") {
    return err(`invalid task_type "${taskType}" — must be "requirements" or "development"`);
  }

  // Role declaration
  const supervisor = args.supervisor === true;
  const developer = args.developer === true;

  // work_dir
  const workDir = (args.work_dir as string) || "";
  if (!workDir) return err("work_dir is required");
  if (!isAbsolute(workDir)) return err("work_dir must be an absolute path");
  if (hasRelativeSegment(workDir)) return err("work_dir must not contain . or .. path segments");

  const resolvedTaskPath = resolve(taskPath);

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
    // 将当前调用者加入 participants
    state.participants.push({
      identity,
      role: supervisor ? "supervisor" : "participant",
      is_developer: developer,
      registered_at: new Date().toISOString(),
      work_dir: resolvedWorkDir,
    });
    setState(wfId, state);
    isFirst = true;
  } else {
    wfId = existing;
    const state = getState(wfId);
    if (!state) return err("workflow state not found");
    const existingTaskType = state.task?.task_type ?? "development";
    if (suppliedTaskType && suppliedTaskType !== existingTaskType) {
      return err(`task_type mismatch: "${suppliedTaskType}" vs "${existingTaskType}"`);
    }

    // 当前调用者可能已经在工作流中（恢复场景）
    const alreadyIn = state.participants.some((p) => p.identity === identity);
    if (alreadyIn) {
      const raw = extra.requestInfo?.headers?.["x-ai-identity"] as string;
      if (raw) bindWorkflow(raw.trim(), wfId);

      const myParticipant = state.participants.find(p => p.identity === identity)!;
      const confirmedAt = new Date().toISOString();
      const nextParticipants = state.participants.map((p) => p.identity === identity
        ? { ...p, role: supervisor ? "supervisor" as const : "participant" as const, is_developer: developer, registered_at: confirmedAt, work_dir: resolvedWorkDir }
        : p);
      const roleError = validateParticipantCombination(nextParticipants);
      if (roleError) return err(roleError);

      // 用确认时的入参覆盖重建推断的角色——调用者声明为准
      myParticipant.role = supervisor ? "supervisor" : "participant";
      myParticipant.is_developer = developer;
      myParticipant.registered_at = confirmedAt;
      myParticipant.work_dir = resolvedWorkDir;
      setState(wfId, state);

      const turnIsSelf = state.turn === identity;
      const turnInfo = turnIsSelf ? `turn 在 ${state.turn}（你）` : `turn 在 ${state.turn}（对方）`;
      const tip = `[行动] 已重新加入工作流 ${wfId}。当前在 ${state.phase} 阶段第 ${state.round} 轮，${turnInfo}。调用 wait_for_turn（长轮询，10s 间隔，最多 600s）。不要频繁调用 get_state，wait_for_turn 会在 turn 到你时自动返回。\n\n[当前] 你是 ${identity}（${roleLabel(myParticipant)}）。工作流 ${wfId}。`;
      return ok({
        task_path: resolvedTaskPath.replace(/\\/g, "/"),
        workflow_id: wfId,
        phase: state.phase,
        recovered: true,
      }, tip);
    }

    // 检查是否已满
    if (state.participants.length >= 2) {
      return err("this task already has 2 participants — cannot join");
    }

    const firstParticipant = state.participants[0];
    const newParticipant: Participant = {
      identity,
      role: supervisor ? "supervisor" : "participant",
      is_developer: developer,
      registered_at: new Date().toISOString(),
      work_dir: resolvedWorkDir,
    };
    const roleError = validateParticipantCombination([...state.participants, newParticipant]);
    if (roleError) return err(roleError);

    // work_dir 一致性
    if (firstParticipant.work_dir && !samePath(firstParticipant.work_dir, resolvedWorkDir)) {
      return err(`work_dir mismatch: "${posixPath(resolvedWorkDir)}" vs "${posixPath(firstParticipant.work_dir)}"`);
    }

    // 加入
    state.participants.push(newParticipant);
    // idle 阶段双方就位后，turn 切给监督者——使其 wait_for_turn 立即返回
    if (state.phase === "idle") {
      const sup = state.participants.find((p) => p.role === "supervisor");
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
  const myRoleLabel = roleLabel({ role: supervisor ? "supervisor" : "participant", is_developer: developer });
  const phaseText = curState.phase !== "idle" ? `，${curState.phase} 阶段第 ${curState.round} 轮` : "，idle 阶段";
  const statusLine = `[当前] 你是 ${identity}（${myRoleLabel}）。工作流 ${wfId}${phaseText}。`;

  let actionLine: string;
  if (isFirst) {
    actionLine = `${recovered ? "已恢复" : "已创建"}工作流 ${wfId}。等待对方 AI 以相同 task_path 调用 confirm_task 加入。调用 wait_for_turn（长轮询，10s 间隔，最多 600s）。不要频繁调用 get_state，wait_for_turn 会在 turn 到你时自动返回。`;
  } else {
    const p = curState.participants;
    const names = p.map((x) => `${x.identity}（${roleLabel(x)}）`).join(" + ");
    actionLine = `已加入工作流 ${wfId}。双方已就位：${names}。调用 wait_for_turn（长轮询，10s 间隔，最多 600s）。不要频繁调用 get_state，wait_for_turn 会在 turn 到你时自动返回。`;
  }

  return ok({
    task_path: resolvedTaskPath.replace(/\\/g, "/"),
    workflow_id: wfId,
    phase: curState.phase,
    recovered,
  }, `[行动] ${actionLine}\n\n${statusLine}`);
}

import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, parse, resolve, sep } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { Mutex } from "async-mutex";
import { parseSession } from "../identity.js";
import { getState, setState, getAllStates, getMutex, defaultState, formatWorkflowId, hasCompleteParticipantRoster, isRecoveryPlaceholderParticipant, type Participant } from "../state.js";
import { reconstructFromHandoff } from "../crash-recovery.js";
import { err, ok } from "../response.js";
import { formatTip } from "../tip-format.js";
import { bindWorkflow } from "../token-map.js";
import { atomicWriteText } from "../atomic-write.js";
import { findSymbolicLinkInPath } from "../path-safety.js";
const taskPathMutexes = new Map<string, Mutex>();
const tokenMutexes = new Map<string, Mutex>();
const recoveryMutexes = new Map<string, Mutex>();

function taskPathMutexKey(taskPath: string): string {
  return process.platform === "win32" ? resolve(taskPath).toLowerCase() : resolve(taskPath);
}

function getTaskPathMutex(taskPath: string): Mutex {
  const key = taskPathMutexKey(taskPath);
  let mutex = taskPathMutexes.get(key);
  if (!mutex) {
    mutex = new Mutex();
    taskPathMutexes.set(key, mutex);
  }
  return mutex;
}

async function withTaskPathMutex<T>(taskPath: string, action: () => Promise<T>): Promise<T> {
  const key = taskPathMutexKey(taskPath);
  const mutex = getTaskPathMutex(taskPath);
  try {
    return await mutex.runExclusive(action);
  } finally {
    if (!mutex.isLocked()) taskPathMutexes.delete(key);
  }
}

async function withTokenMutex<T>(token: string, action: () => Promise<T>): Promise<T> {
  let mutex = tokenMutexes.get(token);
  if (!mutex) {
    mutex = new Mutex();
    tokenMutexes.set(token, mutex);
  }
  try {
    return await mutex.runExclusive(action);
  } finally {
    if (!mutex.isLocked()) tokenMutexes.delete(token);
  }
}

async function withRecoveryMutex<T>(workflowId: string, action: () => Promise<T>): Promise<T> {
  let mutex = recoveryMutexes.get(workflowId);
  if (!mutex) {
    mutex = new Mutex();
    recoveryMutexes.set(workflowId, mutex);
  }
  try {
    return await mutex.runExclusive(action);
  } finally {
    if (!mutex.isLocked()) recoveryMutexes.delete(workflowId);
  }
}

async function findWorkflowByTaskPath(taskPath: string): Promise<string | null> {
  // Search in-memory states
  for (const [wfId, state] of [...getAllStates()]) {
    if (state.task?.spec_file && samePath(state.task.spec_file, taskPath)) return wfId;
  }
  return null;
}

async function readPidFile(taskPath: string): Promise<string | null> {
  const pidFile = `${taskPath}.pid`;
  try {
    const pidStat = await lstat(pidFile);
    if (pidStat.isSymbolicLink()) throw Object.assign(new Error("pid file must not be a symbolic link"), { code: "SYMLINK" });
    if (!pidStat.isFile()) throw Object.assign(new Error("pid path must be a regular file"), { code: "NOT_REGULAR" });
    const wfId = (await readFile(pidFile, "utf-8")).trim();
    if (!/^\d{14}$/.test(wfId)) return null;
    return wfId;
  } catch (error) {
    const code = filesystemErrorCode(error);
    if (code === "ENOENT") return null;
    if (code === "SYMLINK") throw new Error(`pid file must not be a symbolic link: ${posixPath(pidFile)}`, { cause: error });
    if (code === "NOT_REGULAR") throw new Error(`pid path must be a regular file: ${posixPath(pidFile)}`, { cause: error });
    throw new Error(`failed to read pid file: ${posixPath(pidFile)} (${code})`, { cause: error });
  }
}

function reconcileRecoveredTurn(state: ReturnType<typeof defaultState>): void {
  if (state.phase === "idle" || state.participants.length < 2 || state.participants.some(isRecoveryPlaceholderParticipant)) return;
  const latest = Object.entries(state.last_submission_by_participant)
    .filter((entry): entry is [string, typeof entry[1] & { round: number }] => entry[1].round !== null)
    .sort((left, right) => right[1].round - left[1].round)[0];
  if (!latest) return;
  const next = state.participants.find((participant) => participant.identity !== latest[0]);
  if (next) state.turn = next.identity;
}

function assignIdleSupervisorTurn(state: ReturnType<typeof defaultState>, callerIdentity: string): void {
  const supervisor = state.participants.find((participant) => participant.is_supervisor);
  if (!supervisor || state.turn === supervisor.identity) return;
  const assignedAt = new Date().toISOString();
  state.turn = supervisor.identity;
  state.turn_switched_at = assignedAt;
  state.turn_claimed_at = supervisor.identity === callerIdentity ? assignedAt : null;
}

function validateParticipantCombination(
  participants: Participant[],
  taskType: "requirements" | "development",
): string | null {
  const supervisorCount = participants.filter((p) => p.is_supervisor).length;
  const developerCount = participants.filter((p) => p.is_developer).length;
  if (supervisorCount > 1) return "supervisor already exists for this task";
  if (developerCount > 1) return "developer already exists for this task";
  if (participants.length >= 2 && !participants.some(isRecoveryPlaceholderParticipant)) {
    if (supervisorCount !== 1) return "exactly one supervisor is required once both participants have joined";
    if (taskType === "development" && developerCount !== 1) {
      return "exactly one developer is required for development tasks once both participants have joined";
    }
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

function responsibilityLabel(participant: Pick<Participant, "is_supervisor" | "is_developer">): string {
  if (participant.is_supervisor && participant.is_developer) return "supervisor/developer";
  if (participant.is_supervisor) return "supervisor";
  if (participant.is_developer) return "developer";
  return "reviewer";
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function isSameOrDescendantPath(candidate: string, parent: string): boolean {
  const comparableCandidate = comparablePath(candidate);
  const comparableParent = comparablePath(parent);
  const parentPrefix = comparableParent.endsWith(sep)
    ? comparableParent
    : `${comparableParent}${sep}`;
  return comparableCandidate === comparableParent || comparableCandidate.startsWith(parentPrefix);
}

function comparablePath(path: string): string {
  const resolvedPath = resolve(path);
  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

function posixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function hasRelativeSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((part) => part === "." || part === "..");
}

async function writePidFile(taskPath: string, wfId: string): Promise<string | null> {
  const pidFile = `${taskPath}.pid`;
  try {
    await atomicWriteText(pidFile, wfId);
    return null;
  } catch (error) {
    return `failed to write pid file: ${posixPath(pidFile)} (${filesystemErrorCode(error)})`;
  }
}

function filesystemErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "UNKNOWN";
}

export async function confirmTask(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const { identity, registered } = parseSession(extra.requestInfo?.headers);
  if (!registered) return err("valid registered token is required");
  const rawToken = (extra.requestInfo?.headers?.["x-ai-identity"] as string).trim();

  if (args.task_path === undefined || args.task_path === null || args.task_path === "") return err("task_path is required");
  if (typeof args.task_path !== "string") return err("task_path must be a string");
  const taskPath = args.task_path;
  if (!isAbsolute(taskPath)) return err("task_path must be an absolute path");
  if (hasRelativeSegment(taskPath)) return err("task_path must not contain . or .. path segments");

  // Task type
  if (args.task_type !== undefined && typeof args.task_type !== "string") return err("task_type must be a string");
  const suppliedTaskType = args.task_type as string | undefined;
  const taskType = suppliedTaskType || "development";
  if (taskType !== "requirements" && taskType !== "development") {
    return err(`invalid task_type "${taskType}" — must be "requirements" or "development"`);
  }

  // Responsibility declaration
  if (typeof args.is_supervisor !== "boolean") return err("is_supervisor must be a boolean");
  if (typeof args.is_developer !== "boolean") return err("is_developer must be a boolean");
  const supervisor = args.is_supervisor;
  const developer = args.is_developer;

  // work_dir
  if (args.work_dir === undefined || args.work_dir === null || args.work_dir === "") return err("work_dir is required");
  if (typeof args.work_dir !== "string") return err("work_dir must be a string");
  const workDir = args.work_dir;
  if (!isAbsolute(workDir)) return err("work_dir must be an absolute path");
  if (hasRelativeSegment(workDir)) return err("work_dir must not contain . or .. path segments");

  const resolvedTaskPath = resolve(taskPath);

  // Validate task file is under work_dir
  const resolvedWorkDir = resolve(workDir);
  try {
    const workDirSymbolicLink = await findSymbolicLinkInPath(parse(resolvedWorkDir).root, resolvedWorkDir);
    if (workDirSymbolicLink) {
      return err(`work_dir must not contain symbolic links: ${posixPath(workDirSymbolicLink)}`);
    }
    const workDirStat = await lstat(resolvedWorkDir);
    if (!workDirStat.isDirectory()) return err("work_dir must be a directory");
  } catch (error) {
    const code = filesystemErrorCode(error);
    return code === "ENOENT"
      ? err(`work_dir not found: ${posixPath(resolvedWorkDir)}`)
      : err(`failed to inspect work_dir: ${posixPath(resolvedWorkDir)} (${code})`);
  }
  const gitMarkerPath = resolve(resolvedWorkDir, ".git");
  try {
    const gitMarkerStat = await lstat(gitMarkerPath);
    if (gitMarkerStat.isSymbolicLink()) return err(`Git marker must not be a symbolic link: ${posixPath(gitMarkerPath)}`);
    if (!gitMarkerStat.isDirectory() && !gitMarkerStat.isFile()) {
      return err("work_dir must be a Git repository root containing a .git file or directory");
    }
  } catch (error) {
    const code = filesystemErrorCode(error);
    return code === "ENOENT"
      ? err("work_dir must be a Git repository root containing a .git file or directory")
      : err(`failed to inspect Git marker: ${posixPath(gitMarkerPath)} (${code})`);
  }
  if (!isSameOrDescendantPath(resolvedTaskPath, resolvedWorkDir)) {
    return err("task_path must be under work_dir");
  }

  // Validate task file exists
  try {
    const symbolicLinkPath = await findSymbolicLinkInPath(resolvedWorkDir, resolvedTaskPath);
    if (symbolicLinkPath) {
      return err(`symbolic links are not allowed in task_path: ${posixPath(symbolicLinkPath)}`);
    }
    const taskStat = await lstat(resolvedTaskPath);
    if (!taskStat.isFile()) return err("task_path must be a file");
  } catch (error) {
    const code = filesystemErrorCode(error);
    return code === "ENOENT"
      ? err(`task file not found: ${posixPath(resolvedTaskPath)}`)
      : err(`failed to inspect task_path: ${posixPath(resolvedTaskPath)} (${code})`);
  }

  return withTokenMutex(rawToken, async () => {
  const { workflowId: boundWorkflowId } = parseSession(extra.requestInfo?.headers);
  const boundState = boundWorkflowId ? getState(boundWorkflowId) : undefined;
  const isActiveParticipant = boundState?.participants.some((p) => p.identity === identity) ?? false;
  if (isActiveParticipant && (!boundState?.task?.spec_file || !samePath(boundState.task.spec_file, resolvedTaskPath))) {
    return err(`token is already joined to active workflow ${boundWorkflowId} — finish it before confirming another task, or register a new token for parallel work`);
  }

  return withTaskPathMutex(resolvedTaskPath, async () => {
  let wfId: string;
  let recovered = false;
  let isFirst = false;

  // 1. 查内存 — 是否有同 task_path 的活跃工作流
  let existing = await findWorkflowByTaskPath(resolvedTaskPath);

  // 2. 读 .pid — 恢复未完成工作流（内存中没找到时）
  if (!existing) {
    let pidWfId: string | null;
    try {
      pidWfId = await readPidFile(resolvedTaskPath);
    } catch (error) {
      return err(error instanceof Error ? error.message : "failed to read pid file");
    }
    if (pidWfId) {
      const recoveryResult = await withRecoveryMutex(pidWfId, async () => {
        const activePidState = getState(pidWfId);
        if (activePidState?.task?.spec_file) {
          return samePath(activePidState.task.spec_file, resolvedTaskPath)
            ? { existing: true, recovered: false }
            : {
                existing: false,
                recovered: false,
                error: `workflow_id ${pidWfId} is already active for another task: ${posixPath(activePidState.task.spec_file)}`,
              };
        }
        const defState = defaultState();
        try {
          const recoveredState = await reconstructFromHandoff(
            defState,
            pidWfId,
            resolvedWorkDir,
            resolvedTaskPath,
          );
          if (!recoveredState) return { existing: false, recovered: false };
          setState(pidWfId, recoveredState);
          return { existing: true, recovered: true };
        } catch (error) {
          return {
            existing: false,
            recovered: false,
            error: error instanceof Error ? error.message : "failed to read recovery archive",
          };
        }
      });
      if (recoveryResult.error) return err(recoveryResult.error);
      if (recoveryResult.existing) {
        existing = pidWfId;
        recovered = recoveryResult.recovered;
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
      is_supervisor: supervisor,
      is_developer: developer,
      registered_at: new Date().toISOString(),
      work_dir: resolvedWorkDir,
    });
    const pidError = await writePidFile(resolvedTaskPath, wfId);
    if (pidError) return err(pidError);
    setState(wfId, state);
    isFirst = true;
  } else {
    wfId = existing;
    const existingResult = await getMutex(wfId).runExclusive(async (): Promise<CallToolResult | null> => {
      const state = getState(wfId);
      if (!state) return err("workflow state not found");
      const existingTaskType = state.task?.task_type ?? "development";
      if (suppliedTaskType && suppliedTaskType !== existingTaskType) {
        return err(`task_type mismatch: "${suppliedTaskType}" vs "${existingTaskType}"`);
      }

      // 当前调用者可能已经在工作流中（恢复场景）
      const alreadyIn = state.participants.some((p) => p.identity === identity);
      if (alreadyIn) {
        const myParticipant = state.participants.find(p => p.identity === identity)!;
        const recoveringParticipant = isRecoveryPlaceholderParticipant(myParticipant);
        const responsibilitiesChanged = myParticipant.is_supervisor !== supervisor
          || myParticipant.is_developer !== developer;
        const responsibilitiesLocked = state.phase !== "idle" || hasCompleteParticipantRoster(state);
        if (!recoveringParticipant && responsibilitiesLocked && responsibilitiesChanged) {
          return err("participant responsibilities are locked once both participants have joined or the workflow leaves idle — confirm with the originally declared is_supervisor and is_developer values");
        }
        if (!recoveringParticipant && myParticipant.work_dir && !samePath(myParticipant.work_dir, resolvedWorkDir)) {
          return err(`work_dir cannot change after participant confirmation: "${posixPath(resolvedWorkDir)}" vs "${posixPath(myParticipant.work_dir)}"`);
        }

        const confirmedAt = recoveringParticipant ? new Date().toISOString() : myParticipant.registered_at;
        const nextParticipants = state.participants.map((p) => p.identity === identity
          ? { ...p, is_supervisor: supervisor, is_developer: developer, registered_at: confirmedAt, work_dir: resolvedWorkDir }
          : p);
        const responsibilityError = validateParticipantCombination(nextParticipants, existingTaskType);
        if (responsibilityError) return err(responsibilityError);
        const pidError = await writePidFile(resolvedTaskPath, wfId);
        if (pidError) return err(pidError);

        // An incomplete IDLE roster permits corrections; recovered placeholders declare their real responsibilities once.
        myParticipant.is_supervisor = supervisor;
        myParticipant.is_developer = developer;
        myParticipant.registered_at = confirmedAt;
        myParticipant.work_dir = resolvedWorkDir;
        if (state.phase === "idle") {
          if (state.participants.length >= 2) assignIdleSupervisorTurn(state, identity);
        } else if (recoveringParticipant) {
          reconcileRecoveredTurn(state);
        }
        setState(wfId, state);
        const raw = extra.requestInfo?.headers?.["x-ai-identity"] as string;
        if (raw) bindWorkflow(raw.trim(), wfId);

        const action = "调用 wait_for_turn（长轮询，10s 间隔，最多 600s）。若参与者尚未全部就位，它会先等待另一位完成 confirm_task；turn 到你时自动返回。不要频繁调用 get_state";
        const tip = formatTip({
          action,
          current: `你是 ${identity}（${responsibilityLabel(myParticipant)}）。工作流 ${wfId}，当前是 ${state.phase} 阶段第 ${state.round} 轮，turn 在 ${state.turn}${state.turn === identity ? "（你）" : "（对方）"}。`,
        });
        return ok({
          task_path: resolvedTaskPath.replace(/\\/g, "/"),
          workflow_id: wfId,
          phase: state.phase,
          recovered: recovered || recoveringParticipant,
        }, tip);
      }

      // 检查是否已满
      if (state.participants.length >= 2) {
        return err("this task already has 2 participants — cannot join");
      }

      const firstParticipant = state.participants[0];
      const newParticipant: Participant = {
        identity,
        is_supervisor: supervisor,
        is_developer: developer,
        registered_at: new Date().toISOString(),
        work_dir: resolvedWorkDir,
      };
      const responsibilityError = validateParticipantCombination(
        [...state.participants, newParticipant],
        existingTaskType,
      );
      if (responsibilityError) return err(responsibilityError);

      // work_dir 一致性
      if (firstParticipant.work_dir && !samePath(firstParticipant.work_dir, resolvedWorkDir)) {
        return err(`work_dir mismatch: "${posixPath(resolvedWorkDir)}" vs "${posixPath(firstParticipant.work_dir)}"`);
      }
      const pidError = await writePidFile(resolvedTaskPath, wfId);
      if (pidError) return err(pidError);

      // 加入
      state.participants.push(newParticipant);
      // idle 阶段双方就位后，turn 切给监督者——使其 wait_for_turn 立即返回
      if (state.phase === "idle") {
        assignIdleSupervisorTurn(state, identity);
      } else {
        reconcileRecoveredTurn(state);
      }
      setState(wfId, state);
      return null;
    });
    if (existingResult) return existingResult;
  }

  // 绑定 token → workflow
  const raw = extra.requestInfo?.headers?.["x-ai-identity"] as string;
  if (raw) bindWorkflow(raw.trim(), wfId);

  const curState = getState(wfId)!;
  const myResponsibilityLabel = responsibilityLabel({ is_supervisor: supervisor, is_developer: developer });
  const phaseText = curState.phase !== "idle" ? `，${curState.phase} 阶段第 ${curState.round} 轮` : "，idle 阶段";
  const status = `你是 ${identity}（${myResponsibilityLabel}）。工作流 ${wfId}${phaseText}。`;

  const actionLine = "调用 wait_for_turn（长轮询，10s 间隔，最多 600s）。若参与者尚未全部就位，它会先等待另一位完成 confirm_task；turn 到你时自动返回。不要频繁调用 get_state";
  let workflowStatus: string;
  if (isFirst) {
    workflowStatus = `${recovered ? "已恢复" : "已创建"}工作流 ${wfId}，当前只有一位已确认参与者。`;
  } else {
    const p = curState.participants;
    const names = p.map((x) => `${x.identity}（${responsibilityLabel(x)}）`).join(" + ");
    workflowStatus = `已加入工作流 ${wfId}。双方已就位：${names}。`;
  }

  return ok({
    task_path: resolvedTaskPath.replace(/\\/g, "/"),
    workflow_id: wfId,
    phase: curState.phase,
    recovered,
  }, formatTip({ action: actionLine, current: `${status} ${workflowStatus}` }));
  });
  });
}

import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseSession } from "../identity.js";
import { getState, setState, getMutex, hasCompleteParticipantRoster, hasRecoveryPlaceholderParticipant, haveAllParticipantsSubmittedCurrentPhase, isCurrentHolder, getOtherIdentity, type PairFlowState } from "../state.js";

import { err, ok } from "../response.js";
import { identityLabel, phaseLabel } from "../tip.js";
import { atomicWriteText } from "../atomic-write.js";
import { archiveRoot, workflowArchivePath, workflowWorkDir } from "../archive-path.js";
import { findSymbolicLinkInPath } from "../path-safety.js";
const SAFE_SEGMENT = /^[a-zA-Z0-9_-]{1,64}$/;

export async function submit(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const { identity, workflowId, registered } = parseSession(extra.requestInfo?.headers);
  if (!registered) return err("valid registered token is required");
  if (!workflowId) return err("not bound to a workflow — call confirm_task first");

  if (args.file_path === undefined || args.file_path === null || args.file_path === "") return err("file_path is required");
  if (typeof args.file_path !== "string") return err("file_path must be a string");
  const filePath = args.file_path;
  if (!isAbsolute(filePath)) return err("file_path must be an absolute path");
  if (hasRelativeSegment(filePath)) return err("file_path must not contain . or .. path segments");

  if (args.git_commit_hash === undefined || args.git_commit_hash === null || args.git_commit_hash === "") {
    return err("git_commit_hash is required");
  }
  if (typeof args.git_commit_hash !== "string") return err("git_commit_hash must be a string");
  const commitHash = args.git_commit_hash.toLowerCase();
  if (!/^[a-f0-9]{7,40}$/.test(commitHash)) {
    return err("git_commit_hash must contain 7 to 40 hexadecimal characters");
  }

  return getMutex(workflowId).runExclusive(async () => {
    const state = getState(workflowId);
    if (!state) return err("workflow not found");
    if (!state.participants.some((p) => p.identity === identity)) return err("identity not registered");
    if (hasRecoveryPlaceholderParticipant(state)) {
      return err("workflow recovery incomplete — every recovered participant must call confirm_task before submit");
    }
    if (!hasCompleteParticipantRoster(state)) {
      return err("both participants must join via confirm_task before submit");
    }
    const workDir = workflowWorkDir(state);
    if (!workDir) return err("workflow work_dir is missing");
    if (!state.task?.spec_file || !state.task.task_type) return err("workflow task is incomplete");
    if (!isCurrentHolder(state, identity)) return err(`not your turn — current turn: ${state.turn}`);

    // IMPLEMENTATION responsibility check
    if (state.phase === "implementation" && state.sub_phase !== "coding" && state.sub_phase !== "review") {
      return err("implementation sub_phase must be coding or review");
    }
    const isDeveloper = state.participants.some((p) => p.identity === identity && p.is_developer);
    if (state.phase === "implementation" && state.sub_phase === "coding" && !isDeveloper) {
      return err("only the developer can submit during coding sub_phase");
    }
    if (state.phase === "implementation" && state.sub_phase === "review" && isDeveloper) {
      return err("only the reviewer can submit during review sub_phase");
    }

    const expectedFilePath = expectedSubmissionPath(state, identity);
    if (!expectedFilePath) return err("cannot submit while workflow is idle");
    const resolvedFilePath = resolve(filePath);
    const resolvedExpected = resolve(expectedFilePath);
    if (!samePath(resolvedFilePath, resolvedExpected)) {
      return err(`file_path must be ${expectedFilePath.replace(/\\/g, "/")}`);
    }
    try {
      const symbolicLinkPath = await findSymbolicLinkInPath(archiveRoot(workDir), resolvedExpected);
      if (symbolicLinkPath) {
        return err(`symbolic links are not allowed in the file_path archive path: ${symbolicLinkPath.replace(/\\/g, "/")}`);
      }
      const fileStat = await lstat(resolvedExpected);
      if (!fileStat.isFile()) return err("file_path must be a file");
      if (fileStat.size === 0) return err("file_path must not be empty");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "UNKNOWN";
      return code === "ENOENT"
        ? err(`file_path does not exist: ${expectedFilePath.replace(/\\/g, "/")}`)
        : err(`failed to inspect file_path: ${expectedFilePath.replace(/\\/g, "/")} (${code})`);
    }

    // Reject if no new work
    const lastHash = Object.values(state.last_submission_by_participant)
      .filter((s) => s.commit_hash)
      .sort((a, b) => (b.round ?? -1) - (a.round ?? -1))[0]?.commit_hash;
    const normalizedLastHash = lastHash?.toLowerCase();
    if (normalizedLastHash && (
      normalizedLastHash.startsWith(commitHash)
      || commitHash.startsWith(normalizedLastHash)
    )) {
      return err("git_commit_hash unchanged since last submission — no new work detected");
    }

    const originalTurn = state.turn;
    const originalSubPhase = state.sub_phase;

    const now = new Date().toISOString();
    const nextState = {
      ...state,
      last_submission_by_participant: { ...state.last_submission_by_participant },
    };
    nextState.last_submission_by_participant[identity] = {
      round: nextState.round,
      sub_phase: nextState.sub_phase,
      commit_hash: commitHash,
      submitted_at: now,
      file_path: expectedFilePath,
    };
    // IMPLEMENTATION sub_phase toggle
    if (nextState.phase === "implementation" && nextState.sub_phase === "coding") {
      nextState.sub_phase = "review";
    } else if (nextState.phase === "implementation" && nextState.sub_phase === "review") {
      nextState.sub_phase = "coding";
    }

    nextState.round += 1;
    const other = getOtherIdentity(nextState, identity);
    if (other) nextState.turn = other;

    if (nextState.turn !== originalTurn) {
      nextState.turn_switched_at = now;
      nextState.turn_claimed_at = null;
    }

    try {
      await writeMetaJson(expectedFilePath, commitHash, originalSubPhase, nextState.task, now);
    } catch (error) {
      return err(`failed to write meta.json: ${expectedFilePath.replace(/\.md$/, ".meta.json").replace(/\\/g, "/")} (${filesystemErrorCode(error)})`);
    }

    setState(workflowId, nextState);

    const idLabel = identityLabel(nextState, identity);
    const nextParticipant = nextState.participants.find((p) => p.identity === nextState.turn);
    const nextLabel = identityLabel(nextState, nextState.turn);
    const phaseText = phaseLabel(nextState.phase, nextState.sub_phase);
    const currentParticipant = nextState.participants.find((p) => p.identity === identity);
    const supervisorParticipant = nextState.participants.find((p) => p.is_supervisor);
    const bothSubmitted = haveAllParticipantsSubmittedCurrentPhase(nextState);

    let action: string;
    if (bothSubmitted && supervisorParticipant && nextState.turn !== supervisorParticipant.identity) {
      action = `双方已提交，但 turn 已切给 ${nextState.turn}。等待 ${nextState.turn} 继续处理或确认后自然交还监督者 ${supervisorParticipant.identity}`;
    } else if (bothSubmitted && currentParticipant?.is_supervisor && nextState.phase === "summary") {
      action = "双方已提交汇总。若确认汇总已收敛，可调用 advance 结束当前工作流";
    } else if (bothSubmitted && currentParticipant?.is_supervisor) {
      action = "双方已提交。若确认当前阶段目标已达成，可调用 advance 进入下一阶段";
    } else if (bothSubmitted && supervisorParticipant) {
      action = `双方已提交。等待监督者 ${supervisorParticipant.identity} 判断是否调用 advance 推进`;
    } else if (nextState.phase === "summary" && nextParticipant?.is_supervisor) {
      action = "调用 advance 结束当前工作流";
    } else if (nextState.phase === "summary") {
      action = "等待监督者调用 advance 结束工作流。调用 wait_for_turn（长轮询，10s 间隔，最多 600s）。不要频繁调用 get_state，wait_for_turn 会在 turn 到你时自动返回。";
    } else if (nextParticipant?.is_supervisor) {
      action = "若审阅后确认当前阶段目标已达成，可调用 advance 进入下一阶段";
    } else {
      action = "等待对方操作。调用 wait_for_turn（长轮询，10s 间隔，最多 600s）。不要频繁调用 get_state，wait_for_turn 会在 turn 到你时自动返回。";
    }

    const tip = `[行动] ${action}
[产出] ${expectedFilePath.replace(/\\/g, "/")}（已提交）
[当前] 你是 ${idLabel}。当前是第 ${nextState.round} 轮${phaseText}，turn 已切给 ${nextLabel}。`;
    return ok({ ok: true, next_turn: nextState.turn }, tip);
  });
}

function expectedSubmissionPath(
  state: PairFlowState,
  identity: string,
): string | null {
  if (!state.workflow_id || state.phase === "idle") return null;
  const safeIdentity = safeSegment(identity);
  const filename = state.phase === "implementation" && state.sub_phase
    ? `r${state.round}_${state.sub_phase}_${safeIdentity}.md`
    : `r${state.round}_${safeIdentity}.md`;
  return workflowArchivePath(state, state.workflow_id, state.phase, filename);
}

function safeSegment(value: string): string {
  return SAFE_SEGMENT.test(value) ? value : "unknown";
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function hasRelativeSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((part) => part === "." || part === "..");
}

async function writeMetaJson(
  filePath: string,
  commitHash: string,
  subPhase: string | null,
  task: unknown,
  submittedAt: string,
): Promise<void> {
  const metaPath = filePath.replace(/\.md$/, ".meta.json");
  await atomicWriteText(metaPath, JSON.stringify({
    submitted_at: submittedAt,
    commit_hash: commitHash,
    sub_phase: subPhase,
    task,
  }, null, 2));
}

function filesystemErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "UNKNOWN";
}

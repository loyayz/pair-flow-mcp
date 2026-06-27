import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseIdentity } from "../identity.js";
import { loadState, saveState, isCurrentHolder, getOtherIdentity } from "../state.js";
import { logEvent } from "../logger.js";
import { stateMutex } from "../mutex.js";
import { err, ok } from "../response.js";

const HANDOFF_DIR = process.env.HANDOFF_DIR || "handoff";

export async function submit(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") return err("identity required");

  const filePath = args.file_path as string;
  if (!filePath) return err("file_path is required");

  const commitHash = args.git_commit_hash as string;
  if (!commitHash || !/^[a-f0-9]{7,40}$/i.test(commitHash)) {
    return err("invalid git_commit_hash format");
  }

  return stateMutex.runExclusive(async () => {
    const state = await loadState();
    if (!state.peers.some((p) => p.identity === identity)) return err("identity not registered");
    if (!isCurrentHolder(state, identity)) return err(`not your turn — current turn: ${state.turn}`);

    // IMPLEMENTATION role check: coding → developer only, review → reviewer only
    const isDeveloper = state.peers.some((p) => p.identity === identity && p.is_developer);
    if (state.phase === "implementation" && state.sub_phase === "coding" && !isDeveloper) {
      return err("only the developer can submit during coding sub_phase");
    }
    if (state.phase === "implementation" && state.sub_phase === "review" && isDeveloper) {
      return err("only the reviewer can submit during review sub_phase");
    }

    // Reject if no new work since last submission (check all parties)
    const lastHash = Object.values(state.last_submit_per_turn)
      .filter((s) => s.commit_hash)
      .sort((a, b) => (b.submitted_at ?? "").localeCompare(a.submitted_at ?? ""))[0]?.commit_hash;
    if (lastHash && lastHash === commitHash) {
      return err("git_commit_hash unchanged since last submission — no new work detected");
    }

    const originalTurn = state.turn;
    const originalRound = state.round;
    const originalSubPhase = state.sub_phase;

    // Record submission
    const now = new Date().toISOString();
    state.last_submit_per_turn[identity] = {
      round: state.round,
      sub_phase: state.sub_phase,
      commit_hash: commitHash,
      submitted_at: now,
    };
    state.history.push({ type: "submit", timestamp: now, details: { identity, round: state.round, file_path: filePath, commit_hash: commitHash } });

    // IMPLEMENTATION sub_phase toggle: coding ↔ review
    if (state.phase === "implementation" && state.sub_phase === "coding") {
      state.sub_phase = "review";
    } else if (state.phase === "implementation" && state.sub_phase === "review") {
      state.sub_phase = "coding";
    }

    // Advance round and switch turn
    state.round += 1;
    const other = getOtherIdentity(state, identity);
    if (other) state.turn = other;

    if (state.turn !== originalTurn) {
      state.turn_switched_at = new Date().toISOString();
      state.turn_claimed_at = null;
    }
    await saveState(state);
    await logEvent("submit", { identity, round: state.round - 1, file_path: filePath, commit_hash: commitHash });

    // P0-3: Auto-generate meta.json for crash recovery
    await writeMetaJson(state.workflow_id!, state.phase, originalTurn, originalRound, commitHash, originalSubPhase, state.task);

    // P2-5: Differentiate tip by next turn holder's role
    const nextIsSupervisor = state.peers.some((p) => p.identity === state.turn && p.role === "supervisor");
    const tip = state.phase === "summary" && nextIsSupervisor
      ? "请调用 advance 接口结束当前工作流"
      : state.phase === "summary"
        ? "下一步调用 wait_for_turn 接口（监督者将调用 advance 结束工作流）"
        : nextIsSupervisor
          ? "若审阅后确认当前阶段目标已达成，可调用 advance 接口进入下一阶段"
          : "下一步调用 wait_for_turn 接口";
    return ok({ ok: true, next_turn: state.turn }, tip);
  });
}

// P0-3: Auto-generate meta.json alongside each submission for crash recovery
async function writeMetaJson(
  workflowId: string,
  phase: string,
  identity: string,
  round: number,
  commitHash: string,
  subPhase: string | null,
  task: unknown,
): Promise<void> {
  try {
    const prefix = phase === "implementation" && subPhase
      ? `r${round}_${subPhase}_${identity}`
      : `r${round}_${identity}`;
    const metaPath = join(HANDOFF_DIR, workflowId, phase, `${prefix}.meta.json`);
    await mkdir(dirname(metaPath), { recursive: true });
    await writeFile(metaPath, JSON.stringify({
      submitted_at: new Date().toISOString(),
      commit_hash: commitHash,
      sub_phase: subPhase,
      task,
    }, null, 2), "utf-8");
  } catch {
    // meta.json is best-effort; don't fail submit if it can't be written
  }
}

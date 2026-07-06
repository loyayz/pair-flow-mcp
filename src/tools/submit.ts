import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseSession } from "../identity.js";
import { getState, setState, getMutex, isCurrentHolder, getOtherIdentity } from "../state.js";

import { err, ok } from "../response.js";
import { identityLabel, phaseLabel } from "../tip.js";

const HANDOFF_DIR = process.env.HANDOFF_DIR || "handoff";

export async function submit(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const { identity, workflowId } = parseSession(extra.requestInfo?.headers);
  if (identity === "unknown") return err("identity required");
  if (!workflowId) return err("not bound to a workflow — call confirm_task first");

  const filePath = args.file_path as string;
  if (!filePath) return err("file_path is required");

  const commitHash = args.git_commit_hash as string;
  if (!commitHash || !/^[a-f0-9]{7,40}$/i.test(commitHash)) {
    return err("invalid git_commit_hash format");
  }

  return getMutex(workflowId).runExclusive(async () => {
    const state = getState(workflowId);
    if (!state) return err("workflow not found");
    if (!state.peers.some((p) => p.identity === identity)) return err("identity not registered");
    if (!isCurrentHolder(state, identity)) return err(`not your turn — current turn: ${state.turn}`);

    // IMPLEMENTATION role check
    const isDeveloper = state.peers.some((p) => p.identity === identity && p.is_developer);
    if (state.phase === "implementation" && state.sub_phase === "coding" && !isDeveloper) {
      return err("only the developer can submit during coding sub_phase");
    }
    if (state.phase === "implementation" && state.sub_phase === "review" && isDeveloper) {
      return err("only the reviewer can submit during review sub_phase");
    }

    // Reject if no new work
    const lastHash = Object.values(state.last_submit_per_turn)
      .filter((s) => s.commit_hash)
      .sort((a, b) => (b.submitted_at ?? "").localeCompare(a.submitted_at ?? ""))[0]?.commit_hash;
    if (lastHash && lastHash === commitHash) {
      return err("git_commit_hash unchanged since last submission — no new work detected");
    }

    const originalTurn = state.turn;
    const originalSubPhase = state.sub_phase;

    const now = new Date().toISOString();
    state.last_submit_per_turn[identity] = {
      round: state.round,
      sub_phase: state.sub_phase,
      commit_hash: commitHash,
      submitted_at: now,
      file_path: filePath,
    };
    // IMPLEMENTATION sub_phase toggle
    if (state.phase === "implementation" && state.sub_phase === "coding") {
      state.sub_phase = "review";
    } else if (state.phase === "implementation" && state.sub_phase === "review") {
      state.sub_phase = "coding";
    }

    state.round += 1;
    const other = getOtherIdentity(state, identity);
    if (other) state.turn = other;

    if (state.turn !== originalTurn) {
      state.turn_switched_at = new Date().toISOString();
      state.turn_claimed_at = null;
    }
    setState(workflowId, state);


    await writeMetaJson(filePath, commitHash, originalSubPhase, state.task);

    const idLabel = identityLabel(state, identity);
    const nextPeer = state.peers.find((p) => p.identity === state.turn);
    const nextLabel = identityLabel(state, state.turn);
    const phaseText = phaseLabel(state.phase, state.sub_phase);

    let action: string;
    if (state.phase === "summary" && nextPeer?.role === "supervisor") {
      action = "调用 advance 结束当前工作流";
    } else if (state.phase === "summary") {
      action = "等待监督者调用 advance 结束工作流。调用 wait_for_turn（长轮询，10s 间隔，最多 600s）。不要频繁调用 get_state，wait_for_turn 会在 turn 到你时自动返回。";
    } else if (nextPeer?.role === "supervisor") {
      action = "若审阅后确认当前阶段目标已达成，可调用 advance 进入下一阶段";
    } else {
      action = "等待对方操作。调用 wait_for_turn（长轮询，10s 间隔，最多 600s）。不要频繁调用 get_state，wait_for_turn 会在 turn 到你时自动返回。";
    }

    const tip = `[行动] ${action}
[产出] ${filePath.replace(/\\/g, "/")}（已提交）
[当前] 你是 ${idLabel}。当前是第 ${state.round - 1} 轮${phaseText}，turn 已切给 ${nextLabel}。`;
    return ok({ ok: true, next_turn: state.turn }, tip);
  });
}

async function writeMetaJson(
  filePath: string,
  commitHash: string,
  subPhase: string | null,
  task: unknown,
): Promise<void> {
  try {
    const metaPath = filePath.replace(/\.md$/, ".meta.json");
    await mkdir(dirname(metaPath), { recursive: true });
    await writeFile(metaPath, JSON.stringify({
      submitted_at: new Date().toISOString(),
      commit_hash: commitHash,
      sub_phase: subPhase,
      task,
    }, null, 2), "utf-8");
  } catch { /* best-effort */ }
}

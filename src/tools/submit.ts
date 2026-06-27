import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseIdentity } from "../identity.js";
import { loadState, saveState, isCurrentHolder, getOtherIdentity } from "../state.js";
import { logEvent } from "../logger.js";
import { stateMutex } from "../mutex.js";
import { err, ok } from "../response.js";

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

    // Reject if no new work since last submission (check all parties)
    const lastHash = Object.values(state.last_submit_per_turn)
      .filter((s) => s.commit_hash)
      .sort((a, b) => (b.submitted_at ?? "").localeCompare(a.submitted_at ?? ""))[0]?.commit_hash;
    if (lastHash && lastHash === commitHash) {
      return err("git_commit_hash unchanged since last submission — no new work detected");
    }

    const originalTurn = state.turn;

    // Record submission
    const now = new Date().toISOString();
    state.last_submit_per_turn[identity] = {
      round: state.round,
      sub_phase: state.sub_phase,
      commit_hash: commitHash,
      submitted_at: now,
      stance: null,
      need_next_round: null,
      new_issues: [],
    };
    state.history.push({ type: "submit", timestamp: now, details: { identity, round: state.round, file_path: filePath, commit_hash: commitHash } });

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

    return ok({ ok: true, next_turn: state.turn }, "下一步调用 wait_for_turn 接口");
  });
}

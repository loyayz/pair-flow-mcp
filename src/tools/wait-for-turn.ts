import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseSession } from "../identity.js";
import { getState, setState, getMutex, hasRecoveryPlaceholderParticipant } from "../state.js";
import { buildTip } from "../tip.js";
import { err, ok } from "../response.js";

const POLL_INTERVAL_MS = 10_000;
const TIMEOUT_MS = 600_000;

export async function waitForTurn(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  extra.signal.throwIfAborted();
  const { identity, workflowId, registered } = parseSession(extra.requestInfo?.headers);
  if (!registered) return err("valid registered token is required");
  if (!workflowId) return err("not bound to a workflow — call confirm_task first");

  const initialState = getState(workflowId);
  if (!initialState) return err("workflow not found");
  if (!initialState.participants.some((p) => p.identity === identity)) {
    return err("identity not registered");
  }
  if (hasRecoveryPlaceholderParticipant(initialState)) {
    return err("workflow recovery incomplete — every recovered participant must call confirm_task before wait_for_turn");
  }

  const started = Date.now();

  while (Date.now() - started < TIMEOUT_MS) {
    extra.signal.throwIfAborted();
    const state = getState(workflowId);
    if (!state) return err("workflow not found");

    if (state.turn === identity) {
      // 记录 turn 领取时间并返回完整指引
      let claimed = false;
      await getMutex(workflowId).runExclusive(async () => {
        const s = getState(workflowId);
        if (!extra.signal.aborted && s && s.turn === identity) {
          s.turn_claimed_at = new Date().toISOString();
          setState(workflowId, s);
          claimed = true;
        }
      });
      if (!claimed) continue;
      const claimedState = getState(workflowId);
      if (!claimedState) return err("workflow not found");
      const tip = buildTip(claimedState, identity);
      return ok({ turn: claimedState.turn, phase: claimedState.phase, round: claimedState.round }, tip);
    }

    if (state.turn_switched_at && !state.turn_claimed_at) {
      const elapsed = (Date.now() - new Date(state.turn_switched_at).getTime()) / 60_000;
      if (elapsed > 30) {
        return ok(
          { turn: state.turn, phase: state.phase, round: state.round, warning: `对方可能已掉线：turn 已于 ${Math.round(elapsed)} 分钟前切换给 ${state.turn}，但未被领取` },
          `[行动] 对方可能已掉线。turn 在 ${state.turn} 已超过 ${Math.round(elapsed)} 分钟未领取。建议向用户报告此状态，由用户决定是否继续等待。\n\n[当前] 你是 ${identity}。当前是第 ${state.round} 轮，轮到 ${state.turn}。`
        );
      }
    }
    await sleep(POLL_INTERVAL_MS, extra.signal);
  }

  const state = getState(workflowId);
  if (!state) return err("workflow not found");
  return ok(
    { turn: state.turn, phase: state.phase, round: state.round },
    `[行动] 等待超时(600s)。turn 仍在 ${state.turn}，已等待超过 10 分钟。建议向用户报告当前状态，由用户决定是否继续或手动干预。\n\n[当前] 你是 ${identity}。当前是第 ${state.round} 轮，轮到 ${state.turn}。`
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("request cancelled"));
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("request cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

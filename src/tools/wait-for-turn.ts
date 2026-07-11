import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseSession } from "../identity.js";
import { getState, setState, getMutex, hasCompleteParticipantRoster, hasRecoveryPlaceholderParticipant } from "../state.js";
import { buildTip } from "../tip.js";
import { err, ok } from "../response.js";
import { formatTip } from "../tip-format.js";

const POLL_INTERVAL_MS = 10_000;
const TIMEOUT_MS = 600_000;
const activeWaits = new Map<string, AbortController>();

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
  if (!hasCompleteParticipantRoster(initialState)) {
    return err("both participants must join via confirm_task before wait_for_turn");
  }

  extra.signal.throwIfAborted();
  const activeWait = beginActiveWait(workflowId, identity, extra.signal);
  try {
    return await waitForActiveTurn(workflowId, identity, activeWait.signal);
  } finally {
    activeWait.release();
  }
}

async function waitForActiveTurn(
  workflowId: string,
  identity: string,
  signal: AbortSignal,
): Promise<CallToolResult> {
  const started = Date.now();

  while (Date.now() - started < TIMEOUT_MS) {
    signal.throwIfAborted();
    const state = getState(workflowId);
    if (!state) return err("workflow not found");

    if (state.turn === identity) {
      // 记录 turn 领取时间并返回完整指引
      let claimed = false;
      await getMutex(workflowId).runExclusive(async () => {
        const s = getState(workflowId);
        if (!signal.aborted && s && s.turn === identity) {
          s.turn_claimed_at = new Date().toISOString();
          setState(workflowId, s);
          claimed = true;
        }
      });
      signal.throwIfAborted();
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
          formatTip({
            action: "建议向用户报告 turn 长时间未领取，由用户决定是否继续等待。",
            current: `你是 ${identity}。当前是第 ${state.round} 轮，turn 在 ${state.turn} 已超过 ${Math.round(elapsed)} 分钟未领取。`,
          })
        );
      }
    }
    await sleep(POLL_INTERVAL_MS, signal);
  }

  const state = getState(workflowId);
  if (!state) return err("workflow not found");
  return ok(
    { turn: state.turn, phase: state.phase, round: state.round },
    formatTip({
      action: "继续调用 wait_for_turn，保持自动轮转；不要仅因本次超时打断用户。",
      current: `你是 ${identity}。单次等待已超时(600s)，当前是第 ${state.round} 轮，轮到 ${state.turn}。`,
    })
  );
}

function beginActiveWait(
  workflowId: string,
  identity: string,
  requestSignal: AbortSignal,
): { signal: AbortSignal; release: () => void } {
  const key = `${workflowId}\0${identity}`;
  const controller = new AbortController();
  activeWaits.get(key)?.abort(new Error("superseded by a newer wait_for_turn call"));
  activeWaits.set(key, controller);

  return {
    signal: AbortSignal.any([requestSignal, controller.signal]),
    release: () => {
      if (activeWaits.get(key) === controller) activeWaits.delete(key);
    },
  };
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

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseSession } from "../identity.js";
import { getState, setState, getMutex, hasCompleteParticipantRoster } from "../state.js";
import { buildGuidance } from "../tip.js";
import { err, ok } from "../response.js";
import { guidance } from "../instruction.js";

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
  let lastSeenPhase = getState(workflowId)?.phase;

  while (Date.now() - started < TIMEOUT_MS) {
    signal.throwIfAborted();
    const state = getState(workflowId);
    if (!state) {
      return lastSeenPhase === "summary"
        ? ok({ turn: "idle", phase: "idle" }, guidance("wait.completed", { identity, workflow_id: workflowId }, {
            next_action: "stop",
            allowed_tools: [],
            reason_code: "WORKFLOW_COMPLETED",
          }))
        : err("workflow not found");
    }
    lastSeenPhase = state.phase;

    if (!hasCompleteParticipantRoster(state)) {
      const participant = state.participants.find((candidate) => candidate.identity === identity);
      const confirmedAt = participant ? Date.parse(participant.registered_at) : Number.NaN;
      const elapsed = Number.isNaN(confirmedAt) ? 0 : (Date.now() - confirmedAt) / 60_000;
      if (elapsed > 30) {
        const mins = Math.round(elapsed);
        return ok(
          { turn: state.turn, phase: state.phase, round: state.round, warning: `另一位参与者已超过 ${mins} 分钟未完成 confirm_task` },
          guidance("wait.roster-warning", { identity, elapsed_minutes: String(mins) }, {
            next_action: "report_user",
            allowed_tools: [],
            reason_code: "PARTICIPANT_CONFIRMATION_STALE",
          }),
        );
      }
      await sleep(POLL_INTERVAL_MS, signal);
      continue;
    }

    if (state.turn === identity) {
      // 记录 turn 领取时间并返回完整指引
      let claimed = false;
      await getMutex(workflowId).runExclusive(async () => {
        const s = getState(workflowId);
        if (!signal.aborted && s && s.turn === identity) {
          // Claim persistence is the linearization point; later cancellation does not roll it back.
          s.turn_claimed_at = new Date().toISOString();
          setState(workflowId, s);
          claimed = true;
        }
      });
      signal.throwIfAborted();
      if (!claimed) continue;
      const claimedState = getState(workflowId);
      if (!claimedState) return err("workflow not found");
      const g = buildGuidance(claimedState, identity);
      return ok({ turn: claimedState.turn, phase: claimedState.phase, round: claimedState.round }, g);
    }

    if (state.turn_switched_at && !state.turn_claimed_at) {
      const elapsed = (Date.now() - new Date(state.turn_switched_at).getTime()) / 60_000;
      if (elapsed > 30) {
        const mins = Math.round(elapsed);
        return ok(
          { turn: state.turn, phase: state.phase, round: state.round, warning: `对方可能已掉线：turn 已于 ${mins} 分钟前切换给 ${state.turn}，但未被领取` },
          guidance("wait.turn-warning", { identity, elapsed_minutes: String(mins), round: String(state.round), turn: state.turn }, {
            next_action: "report_user",
            allowed_tools: [],
            reason_code: "TURN_UNCLAIMED_STALE",
          }),
        );
      }
    }
    await sleep(POLL_INTERVAL_MS, signal);
  }

  const timeoutState = getState(workflowId);
  if (!timeoutState) {
    return lastSeenPhase === "summary"
      ? ok({ turn: "idle", phase: "idle" }, guidance("wait.completed", { identity, workflow_id: workflowId }, {
          next_action: "stop",
          allowed_tools: [],
          reason_code: "WORKFLOW_COMPLETED",
        }))
      : err("workflow not found");
  }
  const rosterReady = hasCompleteParticipantRoster(timeoutState);
  return ok(
    { turn: timeoutState.turn, phase: timeoutState.phase, round: timeoutState.round },
    rosterReady
      ? guidance("wait.timeout-ready", { identity, round: String(timeoutState.round), turn: timeoutState.turn }, {
          next_action: "wait_for_turn",
          allowed_tools: ["wait_for_turn"],
          reason_code: "WAIT_TIMEOUT",
        })
      : guidance("wait.timeout-roster", { identity }, {
          next_action: "wait_for_turn",
          allowed_tools: ["wait_for_turn"],
          reason_code: "WAIT_TIMEOUT",
        }),
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

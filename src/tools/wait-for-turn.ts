import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseSession } from "../identity.js";
import {
  getState,
  setState,
  getMutex,
  hasCompleteParticipantRoster,
  WAIT_WARNING_INTERVAL_MS,
  type PairFlowState,
  type WaitWarningCycle,
} from "../state.js";
import { buildGuidance, reliableWorkflowPhase, workflowInstructionContext } from "../tip.js";
import { err, ok } from "../response.js";
import { guidance, type InstructionContext } from "../instruction.js";
import {
  getWorkflowVersion,
  publishWorkflowChange,
  waitForWorkflowChange,
} from "../workflow-events.js";
import type { WorkflowCompletionSnapshot } from "../delivery-manifest-schema.js";

const TIMEOUT_MS = 600_000;

type WaitDecision =
  | { kind: "return"; result: CallToolResult; publish?: boolean }
  | { kind: "wait"; version: number; warningDeadlineAt?: number };

type ActiveWait = {
  signal: AbortSignal;
  release: () => void;
};

type AcknowledgmentOutcome =
  | { kind: "continue" }
  | { kind: "timeout"; result: CallToolResult };

const activeWaits = new Map<string, AbortController>();

function waitContext(state: PairFlowState, identity: string): InstructionContext {
  return workflowInstructionContext(state, identity);
}

export async function waitForTurn(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<CallToolResult> {
  const requestDeadlineAt = Date.now() + TIMEOUT_MS;
  extra.signal.throwIfAborted();
  const { identity, workflowId, registered } = parseSession(extra.requestInfo?.headers);
  if (!registered) return err("valid registered token is required");
  if (!workflowId) return err("not bound to a workflow — call confirm_task first");

  const initialState = getState(workflowId);
  if (!initialState) return err("workflow not found");
  if (!initialState.participants.some((participant) => participant.identity === identity)) {
    return err("identity not registered");
  }

  extra.signal.throwIfAborted();
  const activeWait = beginActiveWait(workflowId, identity, extra.signal);
  try {
    const acknowledgment = await acknowledgeReportedWarning(
      workflowId,
      identity,
      requestDeadlineAt,
      structuredClone(initialState),
      activeWait.signal,
    );
    if (acknowledgment.kind === "timeout") return acknowledgment.result;
    return await waitForActiveTurn(
      workflowId,
      identity,
      initialState.phase,
      requestDeadlineAt,
      activeWait.signal,
    );
  } finally {
    activeWait.release();
  }
}

async function acknowledgeReportedWarning(
  workflowId: string,
  identity: string,
  requestDeadlineAt: number,
  timeoutSnapshot: PairFlowState,
  signal: AbortSignal,
): Promise<AcknowledgmentOutcome> {
  let abandoned = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const acquisition = getMutex(workflowId).acquire().then((release) => {
    let acknowledged = false;
    try {
      if (abandoned || signal.aborted || Date.now() >= requestDeadlineAt) {
        return { kind: "expired" as const, acknowledged };
      }
      const state = getState(workflowId);
      const cycle = state?.wait_warning_cycle;
      if (!state || !cycle?.reported_at || cycle.reported_to !== identity) {
        return { kind: "acquired" as const, acknowledged };
      }

      signal.throwIfAborted();
      const acknowledgedAt = Date.now();
      cycle.reported_at = null;
      cycle.reported_to = null;
      cycle.next_report_at = new Date(acknowledgedAt + WAIT_WARNING_INTERVAL_MS).toISOString();
      setState(workflowId, state);
      acknowledged = true;
      return { kind: "acquired" as const, acknowledged };
    } finally {
      release();
    }
  });

  try {
    const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
      timeoutTimer = setTimeout(
        () => resolve({ kind: "timeout" }),
        Math.max(0, requestDeadlineAt - Date.now()),
      );
    });
    const cancellation = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const outcome = await Promise.race([acquisition, timeout, cancellation]);
    if (outcome.kind === "timeout" || outcome.kind === "expired") {
      abandoned = true;
      return { kind: "timeout", result: timeoutResultForState(timeoutSnapshot, identity) };
    }

    // A cancellation after the mutex write must not suppress the committed change event.
    if (outcome.acknowledged) publishWorkflowChange(workflowId);
    signal.throwIfAborted();
    return { kind: "continue" };
  } finally {
    abandoned = true;
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function waitForActiveTurn(
  workflowId: string,
  identity: string,
  initialPhase: PairFlowState["phase"],
  requestDeadlineAt: number,
  signal: AbortSignal,
): Promise<CallToolResult> {
  let lastSeenPhase = initialPhase;
  let lastSeenState = structuredClone(getState(workflowId));
  let completion: WorkflowCompletionSnapshot | undefined;

  while (true) {
    signal.throwIfAborted();
    const release = await acquireMutexUntil(workflowId, requestDeadlineAt, signal);
    if (!release) {
      return lastSeenState
        ? timeoutResultForState(lastSeenState, identity)
        : completedOrMissing(lastSeenPhase, workflowId, identity, completion).result;
    }
    let decision: WaitDecision;
    try {
      signal.throwIfAborted();
      const state = getState(workflowId);
      if (!state) {
        decision = completedOrMissing(lastSeenPhase, workflowId, identity, completion);
      } else {
      lastSeenPhase = state.phase;
      lastSeenState = structuredClone(state);

      const reliablePhase = reliableWorkflowPhase(state);
      if (!reliablePhase.phase) {
        decision = {
          kind: "return",
          result: ok(
            { turn: state.turn, round: state.round, ...reliablePhase },
            buildGuidance(state, identity),
          ),
        };
      } else if (!hasCompleteParticipantRoster(state)) {
        const warning = warningDecision(workflowId, state, identity, "roster", signal);
        decision = warning ?? waitingDecision(workflowId, state.wait_warning_cycle, "roster");
      } else if (state.turn === identity) {
        decision = {
          kind: "return",
          result: ok(
            { turn: state.turn, round: state.round, ...reliablePhase },
            buildGuidance(state, identity),
          ),
        };
      } else if (!state.turn_claimed_at) {
        const warning = warningDecision(workflowId, state, identity, "turn", signal);
        decision = warning ?? waitingDecision(workflowId, state.wait_warning_cycle, "turn");
      } else {
        decision = waitingDecision(workflowId);
      }
      }
    } finally {
      release();
    }

    if (decision.kind === "return") {
      if (decision.publish) publishWorkflowChange(workflowId);
      signal.throwIfAborted();
      return decision.result;
    }

    const wake = await waitForWake(
      workflowId,
      decision.version,
      decision.warningDeadlineAt,
      requestDeadlineAt,
      signal,
    );
    if (wake.kind === "event" && wake.completion) completion = wake.completion;
    if (wake.kind === "timeout") {
      return lastSeenState
        ? timeoutResultForState(lastSeenState, identity)
        : completedOrMissing(lastSeenPhase, workflowId, identity, completion).result;
    }
  }
}

async function acquireMutexUntil(
  workflowId: string,
  requestDeadlineAt: number,
  signal: AbortSignal,
): Promise<(() => void) | null> {
  let abandoned = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const acquisition = getMutex(workflowId).acquire().then((release) => {
    if (abandoned || signal.aborted || Date.now() >= requestDeadlineAt) {
      release();
      return null;
    }
    return release;
  });

  try {
    const timeout = new Promise<null>((resolve) => {
      timeoutTimer = setTimeout(
        () => resolve(null),
        Math.max(0, requestDeadlineAt - Date.now()),
      );
    });
    const cancellation = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const outcome = await Promise.race([acquisition, timeout, cancellation]);
    if (!outcome) abandoned = true;
    return outcome;
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function waitingDecision(
  workflowId: string,
  cycle?: WaitWarningCycle | null,
  expectedKind?: WaitWarningCycle["kind"],
): WaitDecision {
  const warningDeadlineAt = cycle
    && cycle.kind === expectedKind
    && cycle.reported_at === null
    ? parsedDeadline(cycle.next_report_at)
    : undefined;
  return {
    kind: "wait",
    version: getWorkflowVersion(workflowId),
    ...(warningDeadlineAt === undefined ? {} : { warningDeadlineAt }),
  };
}

function warningDecision(
  workflowId: string,
  state: PairFlowState,
  identity: string,
  expectedKind: WaitWarningCycle["kind"],
  signal: AbortSignal,
): WaitDecision | null {
  const cycle = state.wait_warning_cycle;
  if (!cycle || cycle.kind !== expectedKind || cycle.reported_at !== null) return null;
  const deadlineAt = parsedDeadline(cycle.next_report_at);
  const now = Date.now();
  if (deadlineAt === undefined || now < deadlineAt) return null;

  signal.throwIfAborted();
  const reportedAt = new Date(now).toISOString();
  cycle.reported_at = reportedAt;
  cycle.reported_to = identity;
  setState(workflowId, state);

  const elapsedMinutes = warningElapsedMinutes(state, expectedKind, now);
  const result = expectedKind === "roster"
    ? ok(
        {
          turn: state.turn,
          round: state.round,
          ...reliableWorkflowPhase(state),
          warning: `另一位参与者已超过 ${elapsedMinutes} 分钟未完成 confirm_task`,
        },
        guidance("wait.roster-warning", { identity, elapsed_minutes: String(elapsedMinutes) }, {
          next_action: "report_user",
          allowed_tools: [],
          reason_code: "PARTICIPANT_CONFIRMATION_STALE",
          context: waitContext(state, identity),
        }),
      )
    : ok(
        {
          turn: state.turn,
          round: state.round,
          ...reliableWorkflowPhase(state),
          warning: `对方可能已掉线：turn 已于 ${elapsedMinutes} 分钟前切换给 ${state.turn}，但未被领取`,
        },
        guidance("wait.turn-warning", {
          identity,
          elapsed_minutes: String(elapsedMinutes),
          round: String(state.round),
          turn: state.turn,
        }, {
          next_action: "report_user",
          allowed_tools: [],
          reason_code: "TURN_UNCLAIMED_STALE",
          context: waitContext(state, identity),
        }),
      );
  return { kind: "return", result, publish: true };
}

function warningElapsedMinutes(
  state: PairFlowState,
  kind: WaitWarningCycle["kind"],
  now: number,
): number {
  const cycleDeadlineAt = state.wait_warning_cycle?.kind === "roster"
    ? parsedDeadline(state.wait_warning_cycle.next_report_at)
    : undefined;
  const startedAt = kind === "turn"
    ? parsedDeadline(state.turn_switched_at)
    : cycleDeadlineAt === undefined
      ? undefined
      : cycleDeadlineAt - WAIT_WARNING_INTERVAL_MS;
  if (startedAt === undefined) return 0;
  return Math.round(Math.max(0, now - startedAt) / 60_000);
}

function parsedDeadline(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function waitForWake(
  workflowId: string,
  observedVersion: number,
  warningDeadlineAt: number | undefined,
  requestDeadlineAt: number,
  signal: AbortSignal,
): Promise<{ kind: "event" | "deadline" | "timeout"; completion?: WorkflowCompletionSnapshot }> {
  const eventController = new AbortController();
  let warningTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    const event = waitForWorkflowChange(
      workflowId,
      observedVersion,
      eventController.signal,
    ).then((snapshot) => ({ kind: "event" as const, ...(snapshot.completion ? { completion: snapshot.completion } : {}) }));
    const cancellation = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
      timeoutTimer = setTimeout(
        () => resolve({ kind: "timeout" }),
        Math.max(0, requestDeadlineAt - Date.now()),
      );
    });
    const races: Array<Promise<{ kind: "event" | "deadline" | "timeout"; completion?: WorkflowCompletionSnapshot }>> = [event, timeout];
    if (warningDeadlineAt !== undefined) {
      races.push(new Promise<{ kind: "deadline" }>((resolve) => {
        warningTimer = setTimeout(
          () => resolve({ kind: "deadline" }),
          Math.max(0, warningDeadlineAt - Date.now()),
        );
      }));
    }
    return await Promise.race([...races, cancellation]);
  } finally {
    eventController.abort(new Error("wait_for_turn wake race settled"));
    if (warningTimer !== undefined) clearTimeout(warningTimer);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function timeoutResultForState(state: PairFlowState, identity: string): CallToolResult {
  const rosterReady = hasCompleteParticipantRoster(state);
  const context = waitContext(state, identity);
  return ok(
    { turn: state.turn, round: state.round, ...reliableWorkflowPhase(state) },
    rosterReady
      ? guidance("wait.timeout-ready", {
          identity,
          round: String(state.round),
          turn: state.turn,
        }, {
          next_action: "wait_for_turn",
          allowed_tools: ["wait_for_turn"],
          reason_code: "WAIT_TIMEOUT",
          context,
        })
      : guidance("wait.timeout-roster", { identity }, {
          next_action: "wait_for_turn",
          allowed_tools: ["wait_for_turn"],
          reason_code: "WAIT_TIMEOUT",
          context,
        }),
  );
}

function completedOrMissing(
  lastSeenPhase: PairFlowState["phase"],
  workflowId: string,
  identity: string,
  completion?: WorkflowCompletionSnapshot,
): Extract<WaitDecision, { kind: "return" }> {
  return {
    kind: "return",
    result: lastSeenPhase === "summary"
      ? ok(
          { turn: "idle", phase: "idle", ...(completion ?? {}) },
          guidance("wait.completed", { identity, workflow_id: workflowId }, {
            next_action: "stop",
            allowed_tools: [],
            reason_code: "WORKFLOW_COMPLETED",
          }),
        )
      : err("workflow not found"),
  };
}

function beginActiveWait(
  workflowId: string,
  identity: string,
  requestSignal: AbortSignal,
): ActiveWait {
  requestSignal.throwIfAborted();
  const key = `${workflowId}\0${identity}`;
  const supersedeController = new AbortController();
  const combinedController = new AbortController();
  const forwardRequestAbort = () => combinedController.abort(
    requestSignal.reason ?? new DOMException("This operation was aborted", "AbortError"),
  );
  const forwardSupersedeAbort = () => combinedController.abort(
    supersedeController.signal.reason ?? new Error("superseded by a newer wait_for_turn call"),
  );
  requestSignal.addEventListener("abort", forwardRequestAbort, { once: true });
  supersedeController.signal.addEventListener("abort", forwardSupersedeAbort, { once: true });
  if (requestSignal.aborted) {
    forwardRequestAbort();
    requestSignal.removeEventListener("abort", forwardRequestAbort);
    supersedeController.signal.removeEventListener("abort", forwardSupersedeAbort);
    requestSignal.throwIfAborted();
  }

  activeWaits.get(key)?.abort(new Error("superseded by a newer wait_for_turn call"));
  activeWaits.set(key, supersedeController);

  let released = false;
  return {
    signal: combinedController.signal,
    release: () => {
      if (released) return;
      released = true;
      requestSignal.removeEventListener("abort", forwardRequestAbort);
      supersedeController.signal.removeEventListener("abort", forwardSupersedeAbort);
      if (activeWaits.get(key) === supersedeController) activeWaits.delete(key);
    },
  };
}

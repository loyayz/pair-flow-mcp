import { Mutex } from "async-mutex";
import { publishWorkflowChange } from "./workflow-events.js";

// ── Types (§5.1 in-memory state schema) ──

export type Phase = "idle" | "requirements" | "planning" | "implementation" | "summary";
export type SubPhase = "coding" | "review" | null;

export interface Participant {
  identity: string;
  is_supervisor: boolean;
  is_developer: boolean;
  registered_at: string;
  work_dir?: string;
}

export interface LastSubmission {
  round: number | null;
  sub_phase: SubPhase;
  commit_hash: string | null;
  submitted_at: string | null;
  file_path: string | null;
}

export interface Task {
  spec_file?: string;
  task_type?: "requirements" | "development";
}

export interface WaitWarningCycle {
  kind: "roster" | "turn";
  generation: number;
  next_report_at: string;
  reported_at: string | null;
  reported_to: string | null;
}

export interface PairFlowState {
  workflow_id: string | null;
  phase: Phase;
  sub_phase: SubPhase;
  round: number;
  turn: string;
  turn_switched_at: string | null;
  turn_claimed_at: string | null;
  wait_warning_cycle: WaitWarningCycle | null;
  task: Task | null;
  participants: Participant[];
  last_submission_by_participant: Record<string, LastSubmission>;
}

export const RECOVERY_REGISTERED_AT = "1970-01-01T00:00:00.000Z";
export const WAIT_WARNING_INTERVAL_MS = 30 * 60 * 1000;

// ── In-memory state store ──

const states = new Map<string, PairFlowState>();
const mutexes = new Map<string, Mutex>();

export function getState(workflowId: string): PairFlowState | undefined {
  return states.get(workflowId);
}

export function setState(workflowId: string, state: PairFlowState): void {
  states.set(workflowId, state);
}

export function deleteState(workflowId: string): void {
  publishWorkflowChange(workflowId, { terminated: true });
  states.delete(workflowId);
  mutexes.delete(workflowId);
}

export function getMutex(workflowId: string): Mutex {
  let m = mutexes.get(workflowId);
  if (!m) {
    m = new Mutex();
    mutexes.set(workflowId, m);
  }
  return m;
}

export function getAllStates(): Map<string, PairFlowState> {
  return states;
}

// ── Default state ──

export function defaultState(): PairFlowState {
  return {
    workflow_id: null,
    phase: "idle",
    sub_phase: null,
    round: 1,
    turn: "idle",
    turn_switched_at: null,
    turn_claimed_at: null,
    wait_warning_cycle: null,
    task: null,
    participants: [],
    last_submission_by_participant: {},
  };
}

export function replaceWaitWarningCycle(
  state: PairFlowState,
  kind: WaitWarningCycle["kind"],
  startedAt: string,
  previousCycle: WaitWarningCycle | null = state.wait_warning_cycle,
): PairFlowState {
  state.wait_warning_cycle = {
    kind,
    generation: (previousCycle?.generation ?? 0) + 1,
    next_report_at: new Date(Date.parse(startedAt) + WAIT_WARNING_INTERVAL_MS).toISOString(),
    reported_at: null,
    reported_to: null,
  };
  return state;
}

export function assignTurn(
  state: PairFlowState,
  turn: string,
  assignedAt: string,
  previousCycle: WaitWarningCycle | null = state.wait_warning_cycle,
): PairFlowState {
  state.turn = turn;
  state.turn_switched_at = assignedAt;
  state.turn_claimed_at = null;
  return replaceWaitWarningCycle(state, "turn", assignedAt, previousCycle);
}

// ── Phase initialization ──

/** 统一 phase 级重置（设计 §11）：round=1，last_submission_by_participant 清空，时间戳清空。 */
function resetPhaseBase(state: PairFlowState): PairFlowState {
  const empty: LastSubmission = { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null };
  const lsp: Record<string, LastSubmission> = {};
  for (const p of state.participants) lsp[p.identity] = { ...empty };
  return {
    ...state,
    round: 1,
    turn_switched_at: null,
    turn_claimed_at: null,
    wait_warning_cycle: null,
    last_submission_by_participant: lsp,
  };
}

export function initRequirementsPhase(state: PairFlowState, nonSupervisorId: string, task: Task): PairFlowState {
  return {
    ...resetPhaseBase(state),
    task,
    phase: "requirements",
    sub_phase: null,
    turn: nonSupervisorId,
  };
}

export function initPlanningPhase(state: PairFlowState, reviewerId: string): PairFlowState {
  return {
    ...resetPhaseBase(state),
    phase: "planning",
    sub_phase: null,
    turn: reviewerId,

  };
}

export function initImplementationPhase(state: PairFlowState, developerId: string): PairFlowState {
  return {
    ...resetPhaseBase(state),
    phase: "implementation",
    sub_phase: "coding",
    turn: developerId,

  };
}

export function initSummaryPhase(state: PairFlowState, supervisorId: string): PairFlowState {
  return {
    ...resetPhaseBase(state),
    phase: "summary",
    sub_phase: null,
    turn: supervisorId,

  };
}

// ── Helpers ──

export function formatWorkflowId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function isCurrentHolder(state: PairFlowState, identity: string): boolean {
  return state.turn === identity;
}

export function isSupervisor(state: PairFlowState, identity: string): boolean {
  return state.participants.some((p) => p.identity === identity && p.is_supervisor);
}

export function getOtherIdentity(state: PairFlowState, identity: string): string | null {
  const other = state.participants.find((p) => p.identity !== identity);
  return other?.identity ?? null;
}

export function getParticipantByIdentity(state: PairFlowState, identity: string): Participant | undefined {
  return state.participants.find((p) => p.identity === identity);
}

export function isRecoveryPlaceholderParticipant(participant: Participant): boolean {
  return participant.registered_at === RECOVERY_REGISTERED_AT;
}

export function hasRecoveryPlaceholderParticipant(state: PairFlowState): boolean {
  return state.participants.some(isRecoveryPlaceholderParticipant);
}

export function hasCompleteParticipantRoster(state: PairFlowState): boolean {
  return state.participants.length === 2 && !hasRecoveryPlaceholderParticipant(state);
}

export function haveAllParticipantsSubmittedCurrentPhase(state: PairFlowState): boolean {
  if (state.phase === "idle" || !hasCompleteParticipantRoster(state)) return false;
  return state.participants.every((p) => Boolean(state.last_submission_by_participant[p.identity]?.commit_hash));
}

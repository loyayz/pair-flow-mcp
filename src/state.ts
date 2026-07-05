import { Mutex } from "async-mutex";

// ── Types (§5.1 state.json schema) ──

export type Phase = "idle" | "requirements" | "planning" | "implementation" | "summary";
export type SubPhase = "coding" | "review" | null;
export type PeerRole = "supervisor" | "peer";

export interface Peer {
  identity: string;
  role: PeerRole;
  is_developer: boolean;
  registered_at: string;
  work_dir?: string;
}

export interface LastSubmit {
  round: number | null;
  sub_phase: SubPhase;
  commit_hash: string | null;
  submitted_at: string | null;
  file_path: string | null;
}

export interface HistoryEntry {
  type: "phase_change" | "submit";
  timestamp: string;
  details: Record<string, unknown>;
}

export interface Task {
  spec_file?: string;
  task_type?: "requirements" | "development";
}

export interface PairFlowState {
  schema_version: number;
  workflow_id: string | null;
  phase: Phase;
  sub_phase: SubPhase;
  dev_cycle: number | null;
  round: number;
  turn: string;
  turn_switched_at: string | null;
  turn_claimed_at: string | null;
  task: Task | null;
  peers: Peer[];
  last_submit_per_turn: Record<string, LastSubmit>;
  history: HistoryEntry[];
}

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
    schema_version: 1,
    workflow_id: null,
    phase: "idle",
    sub_phase: null,
    dev_cycle: null,
    round: 1,
    turn: "idle",
    turn_switched_at: null,
    turn_claimed_at: null,
    task: null,
    peers: [],
    last_submit_per_turn: {},
    history: [],
  };
}

// ── Phase initialization ──

/** 统一 phase 级重置（设计 §11）：round=1，last_submit_per_turn 清空，时间戳清空。 */
function resetPhaseBase(state: PairFlowState): PairFlowState {
  const empty: LastSubmit = { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null };
  const lsp: Record<string, LastSubmit> = {};
  for (const p of state.peers) lsp[p.identity] = { ...empty };
  return {
    ...state,
    round: 1,
    turn_switched_at: null,
    turn_claimed_at: null,
    last_submit_per_turn: lsp,
  };
}

export function initRequirementsPhase(state: PairFlowState, nonSupervisorId: string, task: Task): PairFlowState {
  const now = new Date().toISOString();
  return {
    ...resetPhaseBase(state),
    task,
    phase: "requirements",
    sub_phase: null,
    turn: nonSupervisorId,
    history: [...state.history, { type: "phase_change", timestamp: now, details: { from: "idle", to: "requirements", round: 1, turn: nonSupervisorId } }],
  };
}

export function initPlanningPhase(state: PairFlowState, reviewerId: string): PairFlowState {
  const now = new Date().toISOString();
  return {
    ...resetPhaseBase(state),
    phase: "planning",
    sub_phase: null,
    turn: reviewerId,
    history: [...state.history, { type: "phase_change", timestamp: now, details: { from: state.phase, to: "planning", round: 1, turn: reviewerId } }],
  };
}

export function initImplementationPhase(state: PairFlowState, developerId: string): PairFlowState {
  const now = new Date().toISOString();
  return {
    ...resetPhaseBase(state),
    phase: "implementation",
    sub_phase: "coding",
    dev_cycle: (state.dev_cycle ?? -1) + 1,
    turn: developerId,
    history: [...state.history, { type: "phase_change", timestamp: now, details: { from: state.phase, to: "implementation", round: 1, turn: developerId, dev_cycle: (state.dev_cycle ?? -1) + 1 } }],
  };
}

export function initSummaryPhase(state: PairFlowState, supervisorId: string): PairFlowState {
  const now = new Date().toISOString();
  return {
    ...resetPhaseBase(state),
    phase: "summary",
    sub_phase: null,
    turn: supervisorId,
    history: [...state.history, { type: "phase_change", timestamp: now, details: { from: state.phase, to: "summary", round: 1, turn: supervisorId } }],
  };
}

export function initIdleState(state: PairFlowState): PairFlowState {
  return {
    ...defaultState(),
    history: [],
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
  return state.peers.some((p) => p.identity === identity && p.role === "supervisor");
}

export function getOtherIdentity(state: PairFlowState, identity: string): string | null {
  const other = state.peers.find((p) => p.identity !== identity);
  return other?.identity ?? null;
}

export function getPeerByIdentity(state: PairFlowState, identity: string): Peer | undefined {
  return state.peers.find((p) => p.identity === identity);
}

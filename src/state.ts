import { writeFile, mkdir, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

// ── Types (§5.1 state.json schema) ──

export type Phase = "idle" | "requirements" | "planning" | "implementation" | "summary";
export type SubPhase = "coding" | "review" | null;
export type PeerRole = "supervisor" | "peer";

export interface Peer {
  identity: string;
  role: PeerRole;
  is_developer: boolean;
  registered_at: string;
  work_dir?: string; // P0-28: 注册时上报的工作目录
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
  goals?: string[];
  context?: string;
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

// ── Atomic write ──

const STATE_DIR = process.env.STATE_DIR || ".pairflow";
const STATE_FILE = `${STATE_DIR}/state.json`;

export async function loadState(): Promise<PairFlowState> {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw) as PairFlowState;
  } catch {
    return defaultState();
  }
}

/** Check whether state.json exists on disk. Used by crash-recovery to distinguish
 *  "fresh start" from "state file was deleted mid-session". */
export async function stateFileExists(): Promise<boolean> {
  try {
    await readFile(STATE_FILE, "utf-8");
    return true;
  } catch {
    return false;
  }
}

export async function saveState(state: PairFlowState): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  const tmp = join(tmpdir(), `pairflow-state-${randomUUID()}.json`);
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmp, STATE_FILE);
}

// ── Phase initialization (§10) ──

export function initRequirementsPhase(state: PairFlowState, nonSupervisorId: string, task: Task): PairFlowState {
  const now = new Date().toISOString();
  const emptyLastSubmit: LastSubmit = { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null };
  const lsp: Record<string, LastSubmit> = {};
  for (const p of state.peers) {
    lsp[p.identity] = { ...emptyLastSubmit };
  }
  return {
    ...state,
    task,
    phase: "requirements",
    sub_phase: null,
    round: 1,
    turn: nonSupervisorId,
    turn_switched_at: now,
    turn_claimed_at: null,
    last_submit_per_turn: lsp,
    history: [...state.history, { type: "phase_change", timestamp: now, details: { from: "idle", to: "requirements", round: 1, turn: nonSupervisorId } }],
  };
}

export function initPlanningPhase(state: PairFlowState, reviewerId: string): PairFlowState {
  const now = new Date().toISOString();
  const emptyLastSubmit: LastSubmit = { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null };
  const lsp: Record<string, LastSubmit> = {};
  for (const p of state.peers) {
    lsp[p.identity] = { ...emptyLastSubmit };
  }
  return {
    ...state,
    phase: "planning",
    sub_phase: null,
    round: 1,
    turn: reviewerId,
    last_submit_per_turn: lsp,
    history: [...state.history, { type: "phase_change", timestamp: now, details: { from: state.phase, to: "planning", round: 1, turn: reviewerId } }],
  };
}

export function initImplementationPhase(state: PairFlowState, developerId: string): PairFlowState {
  const now = new Date().toISOString();
  const emptyLastSubmit: LastSubmit = { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null };
  const lsp: Record<string, LastSubmit> = {};
  for (const p of state.peers) {
    lsp[p.identity] = { ...emptyLastSubmit };
  }
  return {
    ...state,
    phase: "implementation",
    sub_phase: "coding",
    dev_cycle: (state.dev_cycle ?? -1) + 1,
    round: 1,
    turn: developerId,
    last_submit_per_turn: lsp,
    history: [...state.history, { type: "phase_change", timestamp: now, details: { from: state.phase, to: "implementation", round: 1, turn: developerId, dev_cycle: (state.dev_cycle ?? -1) + 1 } }],
  };
}

export function initSummaryPhase(state: PairFlowState, supervisorId: string): PairFlowState {
  const now = new Date().toISOString();
  const emptyLastSubmit: LastSubmit = { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null };
  const lsp: Record<string, LastSubmit> = {};
  for (const p of state.peers) {
    lsp[p.identity] = { ...emptyLastSubmit };
  }
  return {
    ...state,
    phase: "summary",
    sub_phase: null,
    round: 1,
    turn: supervisorId,
    turn_switched_at: now,
    turn_claimed_at: null,
    last_submit_per_turn: lsp,
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

export function formatWorkflowId(iso: string): string {
  // yyyyMMddHHmmss from ISO string
  return iso.replace(/[-:T]/g, "").slice(0, 14);
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

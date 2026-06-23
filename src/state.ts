import { writeFile, mkdir, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

// ── Types (§5.1 state.json schema) ──

export type Phase = "idle" | "requirements" | "planning" | "implementation" | "summary";
export type SubPhase = "coding" | "review" | "fix" | "blind_review" | null;
export type PeerRole = "supervisor" | "peer";
export type IssueType = "P0" | "P1" | "P2";
export type IssueStatus = "open" | "resolved" | "escalated" | "deferred";
export type ResolvedBy = "converged" | "supervisor_override" | "force_converge" | null;
export type Stance = "agree" | "disagree" | "require_clarification" | null;

export interface Peer {
  identity: string;
  role: PeerRole;
  is_developer: boolean;
  registered_at: string;
}

export interface LastSubmit {
  round: number | null;
  sub_phase: SubPhase;
  commit_hash: string | null;
  submitted_at: string | null;
  stance: Stance;
  need_next_round: boolean | null;
  new_issues: number[];
}

export interface Issue {
  id: number;
  type: IssueType;
  topic: string;
  description: string;
  raised_by: string;
  phase: string;
  round: number;
  status: IssueStatus;
  positions: Record<string, string>;
  resolution: string | null;
  resolved_by: ResolvedBy;
  escalated_at: string | null;
  fix_review_cycles: number;
  proposal: string | null;
  rationale: string | null;
  deferred_reason: string | null;
  deferred_since_phase: string | null;
  deferred_count: number;
}

export interface HistoryEntry {
  type: "phase_change" | "turn_change" | "submit" | "converge" | "force_converge" | "advance" | "blind_review";
  timestamp: string;
  details: Record<string, unknown>;
}

export interface CurrentLease {
  token: string | null;
  holder: string | null;
  expires_at: string | null;
  grace_used: boolean;
}

export interface PhaseConfig {
  requirements: number;
  planning: number;
  implementation: number;
  summary: number;
}

export interface CurrentTimeout {
  active: boolean;
  started: string | null;
  expires: string | null;
  phase_config: PhaseConfig;
}

export interface Task {
  description: string;
  spec_file?: string;
  goals?: string[];
  context?: string;
}

export interface PairFlowState {
  schema_version: number;
  workflow_id: string | null;
  next_issue_id: number;
  phase: Phase;
  sub_phase: SubPhase;
  dev_phase: number | null;
  round: number;
  turn: string;
  converged: boolean;
  task: Task | null;
  peers: Peer[];
  last_submit_per_turn: Record<string, LastSubmit>;
  issues: Issue[];
  history: HistoryEntry[];
  pending_supervisor_review: boolean;
  blind_review_pending: boolean;
  current_lease: CurrentLease;
  current_timeout: CurrentTimeout;
}

// ── Default state ──

export function defaultState(phaseConfig?: PhaseConfig): PairFlowState {
  return {
    schema_version: 1,
    workflow_id: null,
    next_issue_id: 1,
    phase: "idle",
    sub_phase: null,
    dev_phase: null,
    round: 1,
    turn: "idle",
    converged: false,
    task: null,
    peers: [],
    last_submit_per_turn: {},
    issues: [],
    history: [],
    pending_supervisor_review: false,
    blind_review_pending: false,
    current_lease: { token: null, holder: null, expires_at: null, grace_used: false },
    current_timeout: {
      active: false,
      started: null,
      expires: null,
      phase_config: phaseConfig ?? { requirements: 10, planning: 10, implementation: 60, summary: 30 },
    },
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

export async function saveState(state: PairFlowState): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  const tmp = join(tmpdir(), `pairflow-state-${randomUUID()}.json`);
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmp, STATE_FILE);
}

// ── Phase initialization (§12) ──

export function initRequirementsPhase(state: PairFlowState, nonSupervisorId: string, task: Task): PairFlowState {
  const now = new Date().toISOString();
  const workflowId = formatWorkflowId(now);
  const emptyLastSubmit: LastSubmit = { round: null, sub_phase: null, commit_hash: null, submitted_at: null, stance: null, need_next_round: null, new_issues: [] };
  const lsp: Record<string, LastSubmit> = {};
  for (const p of state.peers) {
    lsp[p.identity] = { ...emptyLastSubmit };
  }
  return {
    ...state,
    workflow_id: workflowId,
    task,
    phase: "requirements",
    sub_phase: null,
    round: 1,
    turn: nonSupervisorId,
    converged: false,
    issues: [],
    last_submit_per_turn: lsp,
    current_lease: { token: null, holder: null, expires_at: null, grace_used: false },
    current_timeout: { ...state.current_timeout, active: true, started: now, expires: addMinutes(now, state.current_timeout.phase_config.requirements) },
    history: [...state.history, { type: "phase_change", timestamp: now, details: { from: "idle", to: "requirements", round: 1, turn: nonSupervisorId } }],
  };
}

export function initPlanningPhase(state: PairFlowState, reviewerId: string): PairFlowState {
  const now = new Date().toISOString();
  const emptyLastSubmit: LastSubmit = { round: null, sub_phase: null, commit_hash: null, submitted_at: null, stance: null, need_next_round: null, new_issues: [] };
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
    converged: false,
    issues: [],
    last_submit_per_turn: lsp,
    current_lease: { token: null, holder: null, expires_at: null, grace_used: false },
    current_timeout: { ...state.current_timeout, active: true, started: now, expires: addMinutes(now, state.current_timeout.phase_config.planning) },
    history: [...state.history, { type: "phase_change", timestamp: now, details: { from: state.phase, to: "planning", round: 1, turn: reviewerId } }],
  };
}

export function initImplementationPhase(state: PairFlowState, developerId: string): PairFlowState {
  const now = new Date().toISOString();
  const emptyLastSubmit: LastSubmit = { round: null, sub_phase: null, commit_hash: null, submitted_at: null, stance: null, need_next_round: null, new_issues: [] };
  const lsp: Record<string, LastSubmit> = {};
  for (const p of state.peers) {
    lsp[p.identity] = { ...emptyLastSubmit };
  }
  return {
    ...state,
    phase: "implementation",
    sub_phase: "coding",
    dev_phase: (state.dev_phase ?? -1) + 1,
    round: 1,
    turn: developerId,
    converged: false,
    issues: [],
    last_submit_per_turn: lsp,
    current_lease: { token: null, holder: null, expires_at: null, grace_used: false },
    current_timeout: { ...state.current_timeout, active: true, started: now, expires: addMinutes(now, state.current_timeout.phase_config.implementation) },
    history: [...state.history, { type: "phase_change", timestamp: now, details: { from: state.phase, to: "implementation", round: 1, turn: developerId, dev_phase: (state.dev_phase ?? -1) + 1 } }],
  };
}

export function initSummaryPhase(state: PairFlowState, nonSupervisorId: string): PairFlowState {
  const now = new Date().toISOString();
  const emptyLastSubmit: LastSubmit = { round: null, sub_phase: null, commit_hash: null, submitted_at: null, stance: null, need_next_round: null, new_issues: [] };
  const lsp: Record<string, LastSubmit> = {};
  for (const p of state.peers) {
    lsp[p.identity] = { ...emptyLastSubmit };
  }
  return {
    ...state,
    phase: "summary",
    sub_phase: null,
    round: 1,
    turn: nonSupervisorId,
    converged: false,
    issues: [],
    last_submit_per_turn: lsp,
    current_lease: { token: null, holder: null, expires_at: null, grace_used: false },
    current_timeout: { ...state.current_timeout, active: true, started: now, expires: addMinutes(now, state.current_timeout.phase_config.summary) },
    history: [...state.history, { type: "phase_change", timestamp: now, details: { from: state.phase, to: "summary", round: 1, turn: nonSupervisorId } }],
  };
}

export function initIdleState(state: PairFlowState): PairFlowState {
  return {
    ...defaultState(state.current_timeout.phase_config),
    next_issue_id: state.next_issue_id,
    history: [],
  };
}

// ── Helpers ──

export function formatWorkflowId(iso: string): string {
  // yyyyMMddHHmmss from ISO string
  return iso.replace(/[-:T]/g, "").slice(0, 14);
}

function addMinutes(iso: string, minutes: number): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
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

export interface ConvergeMark {
  stance: Stance;
  need_next_round: boolean | null;
  new_issues?: {
    type: IssueType;
    topic: string;
    description: string;
  }[];
  resolved_issue_ids?: number[];
  issue_stances?: Record<string, { stance: string; argument?: string }>;
}

import { loadState, saveState, type PairFlowState } from "./state.js";
import { logEvent } from "./logger.js";
import { stateMutex } from "./mutex.js";

let timerHandle: ReturnType<typeof setTimeout> | null = null;

/**
 * Start lease timer for current turn. Called after claim_turn.
 * When timeout fires, turn is released and switch to other party.
 */
export function startLeaseTimer(state: PairFlowState): void {
  stopLeaseTimer();
  const expires = state.current_lease.expires_at;
  if (!expires || !state.current_lease.holder) return;

  const delay = new Date(expires).getTime() - Date.now();
  if (delay <= 0) {
    handleTimeout().catch(() => {});
    return;
  }

  timerHandle = setTimeout(() => {
    handleTimeout().catch(() => {});
  }, delay);
}

export function stopLeaseTimer(): void {
  if (timerHandle) {
    clearTimeout(timerHandle);
    timerHandle = null;
  }
}

async function handleTimeout(): Promise<void> {
  stateMutex.runExclusive(async () => {
    const state = await loadState();
    if (!state.current_timeout.active || !state.current_lease.holder) return;

    const expires = state.current_lease.expires_at;
    if (!expires || new Date(expires).getTime() > Date.now()) return; // Not yet expired

    const currentHolder = state.current_lease.holder;
    const other = state.peers.find((p) => p.identity !== currentHolder);
    if (!other) return;

    // Release turn to other party
    state.turn = other.identity;
    state.current_lease = { token: null, holder: null, expires_at: null, grace_used: false };
    await saveState(state);
    await logEvent("timeout", { holder: currentHolder, new_turn: other.identity });
  }).catch(() => {});
}

/**
 * Check if submit can use grace period.
 * Returns true if lease matches and grace hasn't been used.
 */
export function checkGraceSubmit(state: PairFlowState, token: string, identity: string): boolean {
  const lease = state.current_lease;
  if (!lease.token || !lease.expires_at) return false;
  if (lease.holder !== identity || lease.token !== token) return false;
  if (lease.grace_used) return false;

  const graceEnd = new Date(lease.expires_at).getTime() + 5 * 60 * 1000; // 5 min grace
  if (Date.now() > graceEnd) return false;

  return true;
}

/**
 * Apply grace: grant submit even though turn has changed.
 * Restores turn to the grace caller.
 */
export async function applyGraceSubmit(state: PairFlowState, identity: string): Promise<void> {
  state.turn = identity;
  state.current_lease.grace_used = true;
  // Reset timer after grace submit
  const expires = new Date(Date.now() + getTimeoutMs(state)).toISOString();
  state.current_lease.expires_at = expires;
}

function getTimeoutMs(state: PairFlowState): number {
  const cfg = state.current_timeout.phase_config;
  switch (state.phase) {
    case "requirements": return cfg.requirements * 60 * 1000;
    case "planning": return cfg.planning * 60 * 1000;
    case "implementation": return cfg.implementation * 60 * 1000;
    case "summary": return cfg.summary * 60 * 1000;
    default: return 30 * 60 * 1000;
  }
}

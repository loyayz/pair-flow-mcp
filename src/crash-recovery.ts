import { readdir, readFile, mkdir, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadState, saveState, defaultState, type PairFlowState, type Phase } from "./state.js";
import { logEvent } from "./logger.js";
import { startLeaseTimer } from "./lease.js";

const HANDOFF_DIR = process.env.HANDOFF_DIR || "handoff";

/**
 * Recover state after crash. Returns the recovered state or default if no recovery possible.
 * §8 crash recovery specification.
 */
export async function recoverState(): Promise<PairFlowState> {
  let state = await loadState();
  let wasRecovered = false;
  await logEvent("crash_recovery", { phase: state.phase });

  // Detect: state claims idle but handoff/ has in-progress work → state.json was lost/reset
  if (state.phase === "idle" && !state.workflow_id) {
    const latestWfId = await findLatestWorkflowId();
    if (latestWfId) {
      // Handoff has uncompleted work — reconstruct state from archive
      const recovered = await reconstructFromHandoff(state);
      if (recovered) {
        wasRecovered = true;
        state = recovered;
        await saveState(state);
        await logEvent("crash_recovery", { recovered: true, from_handoff: true, workflow_id: state.workflow_id, phase: state.phase });
        return state;
      }
    }
    // Truly fresh start (no handoff work) or recovery failed
    state.peers = [];
    state.current_lease = { token: null, holder: null, expires_at: null, grace_used: false };
    await saveState(state);
    return state;
  }

  if (!state.workflow_id) {
    state.workflow_id = await findLatestWorkflowId();
    if (!state.workflow_id) {
      return defaultState(state.current_timeout.phase_config);
    }
  }

  // Step 1: Scan meta.json files
  const wfDir = join(HANDOFF_DIR, state.workflow_id);
  try {
    await mkdir(wfDir, { recursive: true });
    const metaFiles = await findFiles(wfDir, ".meta.json");
    for (const mf of metaFiles) {
      try {
        const raw = await readFile(join(wfDir, mf), "utf-8");
        const meta = JSON.parse(raw);
        if (meta.new_issues) {
          for (const ni of meta.new_issues) {
            if (typeof ni === "number") continue; // issue IDs only
            // Reconstruct issue if not present
            const exists = state.issues.find((i) => i.id === ni.id);
            if (!exists) {
              state.issues.push({ id: ni.id ?? 0, type: ni.type ?? "P1", topic: ni.topic ?? "", description: ni.description ?? "", raised_by: ni.raised_by ?? "unknown", phase: state.phase, round: meta.round ?? state.round, status: "open", positions: {}, resolution: null, resolved_by: null, escalated_at: null, fix_review_cycles: 0, proposal: null, rationale: null, deferred_reason: null, deferred_since_phase: null, deferred_count: 0 });
            }
          }
        }
      } catch { /* skip corrupt meta files */ }
    }
  } catch { /* handoff dir missing */ }

  // Step 2: Replay journal
  try {
    const journalPath = join(wfDir, "issues-journal.jsonl");
    const journalRaw = await readFile(journalPath, "utf-8");
    const lines = journalRaw.trim().split("\n");
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const issue = state.issues.find((i) => i.id === entry.id);
        if (!issue) continue;
        if (entry.action === "resolve") { issue.status = "resolved"; issue.resolution = entry.resolution ?? ""; issue.resolved_by = "supervisor_override"; }
        if (entry.action === "escalate") { issue.status = "escalated"; issue.escalated_at = entry.timestamp ?? null; }
      } catch { /* skip corrupt lines */ }
    }
  } catch { /* no journal */ }

  // Step 3/4: Orphan file handling — scan for md+meta files after last history entry
  const lastTs = state.history.length > 0 ? new Date(state.history[state.history.length - 1].timestamp).getTime() : 0;
  for (const phaseDir of ["requirements", "planning", "implementation", "summary"]) {
    try {
      const phasePath = join(wfDir, phaseDir);
      const metaFiles = await findFiles(phasePath, ".meta.json");
      for (const mf of metaFiles) {
        const baseName = mf.replace(".meta.json", "");
        const mdName = baseName + ".md";
        try {
          const mdExists = await access(join(phasePath, mdName)).then(() => true).catch(() => false);
          if (!mdExists) continue; // Step 4: md missing, skip
          const metaRaw = await readFile(join(phasePath, mf), "utf-8");
          const meta = JSON.parse(metaRaw);
          if (meta.submitted_at && new Date(meta.submitted_at).getTime() > lastTs) {
            // Orphan: submitted after last history entry, restore it
            state.history.push({ type: "submit", timestamp: meta.submitted_at ?? new Date().toISOString(), details: { identity: baseName.split("_").pop() ?? "unknown", recovered: true } });
          }
        } catch { /* skip corrupt */ }
      }
    } catch { /* phase dir missing */ }
  }

  // Step 5: Restart timer if active and not expired (before clearing lease)
  if (state.current_timeout.active && state.current_timeout.expires) {
    const expiresAt = new Date(state.current_timeout.expires).getTime();
    if (expiresAt > Date.now()) {
      // Timer not yet expired — restart (needs current_lease intact)
      startLeaseTimer(state);
    } else {
      // Already expired — release turn immediately
      const other = state.peers.find((p) => p.identity !== state.turn);
      if (other) state.turn = other.identity;
      state.current_timeout.active = false;
    }
  }

  // Step 6: Clear lease (after timer restart — startLeaseTimer reads current_lease)
  state.current_lease = { token: null, holder: null, expires_at: null, grace_used: false };

  // Step 7: IDLE crash — peers already cleared above
  state.recovered = wasRecovered;
  await saveState(state);
  await logEvent("crash_recovery", { recovered: true, workflow_id: state.workflow_id, phase: state.phase });
  return state;
}

// ── Handoff reconstruction (state.json deleted mid-session) ──

const PHASE_PRIORITY: Phase[] = ["implementation", "planning", "requirements", "summary"];

async function reconstructFromHandoff(state: PairFlowState): Promise<PairFlowState | null> {
  const wfId = await findLatestWorkflowId();
  if (!wfId) return null; // no handoff work to recover

  const wfDir = join(HANDOFF_DIR, wfId);
  state.workflow_id = wfId;

  // 1. Determine phase
  state.phase = await determinePhase(wfDir);

  // 2. Reconstruct peers from filenames
  const identities = await extractIdentities(wfDir);
  if (identities.size === 0) return null; // can't recover without peers

  const now = new Date().toISOString();
  const phaseDirs = await listPhaseDirs(wfDir);

  // Infer roles: first submitter in requirements = developer; first in planning = reviewer
  const reqFirst = await getFirstSubmitter(wfDir, "requirements");
  const planFirst = await getFirstSubmitter(wfDir, "planning");

  for (const id of identities) {
    const isDev = reqFirst === id;
    const isSup = planFirst === id;
    state.peers.push({
      identity: id,
      role: isSup ? "supervisor" : "peer",
      is_developer: isDev,
      registered_at: now,
    });
  }

  // 3. Scan meta.json for issues (reuse existing logic adapted for recovery)
  const wfDirVar = wfDir; // capture for closures
  try {
    const metaFiles = await findFiles(wfDirVar, ".meta.json");
    for (const mf of metaFiles) {
      try {
        const raw = await readFile(join(wfDirVar, mf), "utf-8");
        const meta = JSON.parse(raw);
        if (meta.new_issues) {
          for (const ni of meta.new_issues) {
            if (typeof ni === "number") continue;
            const exists = state.issues.find((i) => i.id === ni.id);
            if (!exists) {
              state.issues.push({
                id: ni.id ?? 0, type: ni.type ?? "P1", topic: ni.topic ?? "",
                description: ni.description ?? "", raised_by: ni.raised_by ?? "unknown",
                phase: state.phase, round: meta.round ?? state.round, status: "open",
                positions: {}, resolution: null, resolved_by: null, escalated_at: null,
                fix_review_cycles: 0, proposal: null, rationale: null,
                deferred_reason: null, deferred_since_phase: null, deferred_count: 0,
              });
            }
          }
        }
      } catch { /* skip corrupt */ }
    }
  } catch { /* */ }

  // 4. Replay journal
  try {
    const journalPath = join(wfDirVar, "issues-journal.jsonl");
    const journalRaw = await readFile(journalPath, "utf-8");
    for (const line of journalRaw.trim().split("\n")) {
      try {
        const entry = JSON.parse(line);
        const issue = state.issues.find((i) => i.id === entry.id);
        if (!issue) continue;
        if (entry.action === "resolve") {
          issue.status = "resolved";
          issue.resolution = entry.resolution ?? "";
          issue.resolved_by = "supervisor_override";
        }
        if (entry.action === "escalate") {
          issue.status = "escalated";
          issue.escalated_at = entry.timestamp ?? null;
        }
      } catch { /* */ }
    }
  } catch { /* */ }

  // 5. Determine round, turn, converged, blind_review_pending
  const latestPhaseDir = join(wfDirVar, state.phase);
  const latestMetaFiles = await findFiles(latestPhaseDir, ".meta.json");
  let maxRound = 1;
  let lastSubmitter = "";
  let hasBlindReview = false;
  let blindReviewCount = 0;

  for (const mf of latestMetaFiles) {
    const base = mf.includes("/") || mf.includes("\\") ? mf.replace(/^.*[/\\]/, "") : mf;
    // Extract round from r{N}_ pattern
    const roundMatch = base.match(/^r(\d+)_/);
    if (roundMatch) {
      const r = parseInt(roundMatch[1], 10);
      if (r > maxRound) maxRound = r;
      // Extract identity: r{N}_{identity}.meta.json or r{N}_{subphase}_{identity}.meta.json
      const idMatch = base.match(/^r\d+_(.+)\.meta\.json$/);
      if (idMatch) {
        let identity = idMatch[1];
        // Strip sub-phase prefix for IMPLEMENTATION files
        const subPhases = ["coding", "review", "fix", "blind_review"];
        for (const sp of subPhases) {
          if (identity.startsWith(sp + "_")) {
            identity = identity.slice(sp.length + 1);
            break;
          }
        }
        lastSubmitter = identity;
      }
    }
    // Detect blind review
    if (base.includes("blind_review")) {
      hasBlindReview = true;
      blindReviewCount++;
    }
  }

  state.round = maxRound;
  // Turn: next should be the one who hasn't submitted last, or the other peer
  if (lastSubmitter && state.peers.length >= 2) {
    const other = state.peers.find((p) => p.identity !== lastSubmitter);
    state.turn = other?.identity ?? lastSubmitter;
  } else if (state.peers.length > 0) {
    state.turn = state.peers[0].identity;
  }

  // Converged if blind reviews exist in the latest phase
  if (hasBlindReview) {
    state.converged = true;
    // Both parties submitted blind review?
    state.blind_review_pending = blindReviewCount < 2;
  }

  // 6. Clear lease
  state.current_lease = { token: null, holder: null, expires_at: null, grace_used: false };

  // 7. Reset timeout
  state.current_timeout.active = false;

  console.log(`[pair-flow] Reconstructed state from handoff/${wfId}: phase=${state.phase}, peers=${state.peers.length}, issues=${state.issues.length}, round=${state.round}`);
  return state;
}

async function determinePhase(wfDir: string): Promise<Phase> {
  for (const phase of PHASE_PRIORITY) {
    try {
      const phasePath = join(wfDir, phase);
      const files = await findFiles(phasePath, ".meta.json");
      if (files.length > 0) return phase;
    } catch { /* */ }
  }
  return "idle";
}

async function extractIdentities(wfDir: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const subPhases = ["coding", "review", "fix", "blind_review"];
  for (const phase of PHASE_PRIORITY) {
    try {
      const files = await findFiles(join(wfDir, phase), ".meta.json");
      for (const f of files) {
        // Use basename for matching — findFiles may return paths with subdir prefix
        const base = f.includes("/") || f.includes("\\") ? f.replace(/^.*[/\\]/, "") : f;
        // r{N}_{identity}.meta.json (REQUIREMENTS/PLANNING)
        // r{N}_{subphase}_{identity}.meta.json (IMPLEMENTATION: r1_coding_alice, r2_review_bob, ...)
        const roundMatch = base.match(/^r\d+_(.+)\.meta\.json$/);
        if (roundMatch) {
          const captured = roundMatch[1];
          // Strip known sub-phase prefix if present
          let identity = captured;
          for (const sp of subPhases) {
            if (captured === sp) break; // bare sub-phase (unlikely), skip
            if (captured.startsWith(sp + "_")) {
              identity = captured.slice(sp.length + 1);
              break;
            }
          }
          ids.add(identity);
          continue;
        }
        // {identity}_blind_review.md.meta.json
        const blindMatch = base.match(/^(.+)_blind_review\.md\.meta\.json$/);
        if (blindMatch) { ids.add(blindMatch[1]); }
      }
    } catch { /* */ }
  }
  return ids;
}

async function getFirstSubmitter(wfDir: string, phase: string): Promise<string | null> {
  try {
    const files = await findFiles(join(wfDir, phase), ".meta.json");
    // Find r1_ file (first submission in this phase)
    for (const f of files) {
      const base = f.includes("/") || f.includes("\\") ? f.replace(/^.*[/\\]/, "") : f;
      const match = base.match(/^r1_(.+)\.meta\.json$/);
      if (match) {
        let identity = match[1];
        // Strip sub-phase prefix for IMPLEMENTATION files
        const subPhases = ["coding", "review", "fix", "blind_review"];
        for (const sp of subPhases) {
          if (identity.startsWith(sp + "_")) {
            identity = identity.slice(sp.length + 1);
            break;
          }
        }
        return identity;
      }
    }
  } catch { /* */ }
  return null;
}

async function listPhaseDirs(wfDir: string): Promise<string[]> {
  try {
    const entries = await readdir(wfDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function findLatestWorkflowId(): Promise<string | null> {
  try {
    const entries = await readdir(HANDOFF_DIR, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && /^\d{14}$/.test(e.name))
      .map((e) => e.name);

    if (dirs.length === 0) return null;

    // Skip completed workflows (summary/ with _final.md), then pick newest by timestamp
    const incomplete: string[] = [];
    for (const name of dirs) {
      try {
        const summaryDir = join(HANDOFF_DIR, name, "summary");
        const summaryEntries = await readdir(summaryDir);
        if (summaryEntries.some((e) => e.includes("_final.md"))) continue;
      } catch { /* no summary dir — incomplete */ }
      // Verify it has at least one meta.json (not empty)
      try {
        const files = await findFiles(join(HANDOFF_DIR, name), ".meta.json");
        if (files.length === 0) continue;
      } catch { continue; }
      incomplete.push(name);
    }

    if (incomplete.length === 0) return null;

    // Newest first: directory names are YYYYMMDDHHmmss timestamps
    incomplete.sort((a, b) => b.localeCompare(a));
    return incomplete[0];
  } catch {
    return null;
  }
}

async function findFiles(dir: string, suffix: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const absDir = resolve(dir);
    const entries = await readdir(absDir, { withFileTypes: true, recursive: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(suffix)) {
        const pp = (e as { parentPath?: string }).parentPath;
        if (pp) {
          // parentPath is absolute on Node 24; make it relative to search dir
          const relDir = pp.startsWith(absDir) ? pp.slice(absDir.length).replace(/^[\\/]/, "") : pp;
          results.push(relDir ? join(relDir, e.name) : e.name);
        } else {
          results.push(e.name);
        }
      }
    }
  } catch { /* */ }
  return results;
}

/** Initialize crash recovery at startup. Call once before starting server. */
export async function initializeRecovery(): Promise<PairFlowState> {
  try {
    return await recoverState();
  } catch {
    return defaultState();
  }
}

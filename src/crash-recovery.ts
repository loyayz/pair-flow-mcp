import { readdir, readFile, mkdir, access } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { defaultState, type PairFlowState, type Phase, type SubPhase, type Peer, type LastSubmit } from "./state.js";


const HANDOFF_DIR = process.env.HANDOFF_DIR || "handoff";

// ── Filename parsing ──

interface ParsedFilename {
  round: number;
  sub_phase: SubPhase;
  identity: string;
}

function basename(path: string): string {
  return path.includes("/") || path.includes("\\")
    ? path.replace(/^.*[/\\]/, "")
    : path;
}

const KNOWN_EXTENSIONS = /\.(?:md|meta\.json)$/;

/**
 * Parse a handoff filename into structured fields.
 * Accepts: r{N}_{identity}.md, r{N}_{subphase}_{identity}.md,
 *          r{N}_{identity}.meta.json, r{N}_{subphase}_{identity}.meta.json
 * Also handles optional _final suffix: r1_alice_final.md
 */
export function parseFilename(filename: string): ParsedFilename | null {
  const base = filename.replace(KNOWN_EXTENSIONS, "");
  if (base === filename) return null;

  const match = base.match(/^r(\d+)_(.+)$/);
  if (!match) return null;

  const round = parseInt(match[1], 10);
  let identity = match[2];
  let subPhase: SubPhase = null;

  for (const sp of ["coding", "review"]) {
    if (identity.startsWith(sp + "_")) {
      subPhase = sp as SubPhase;
      identity = identity.slice(sp.length + 1);
      break;
    }
  }

  identity = identity.replace(/_final$/, "");
  if (!identity) return null;

  return { round, sub_phase: subPhase, identity };
}

/**
 * Check whether a workflow is complete.
 * Complete = handoff/{wfId}/summary/ directory exists and contains at least one file.
 */
export async function isWorkflowComplete(wfId: string): Promise<boolean> {
  try {
    const summaryDir = join(HANDOFF_DIR, wfId, "summary");
    const entries = await readdir(summaryDir, { withFileTypes: true });
    return entries.some((e) => e.isFile());
  } catch {
    return false;
  }
}

// ── Handoff reconstruction (state.json deleted mid-session) ──

const PHASE_PRIORITY: Phase[] = ["implementation", "planning", "requirements", "summary"];

export async function reconstructFromHandoff(
  state: PairFlowState,
  wfId: string
): Promise<PairFlowState | null> {
  const wfDir = join(HANDOFF_DIR, wfId);
  state.workflow_id = wfId;

  // 1. Determine phase
  state.phase = await determinePhase(wfDir);

  // 2. Reconstruct peers from filenames
  const identities = await extractIdentities(wfDir);
  if (identities.size === 0) return null; // can't recover without peers

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
      // Use epoch to force re-register — 60s window check in register.ts
      // will reject this until the peer actually calls register()
      registered_at: "1970-01-01T00:00:00.000Z",
    });
  }

  // 3. Scan meta.json for task recovery
  const wfDirVar = wfDir; // capture for closures
  try {
    const metaFiles = await findFiles(wfDirVar, ".meta.json");
    for (const mf of metaFiles) {
      try {
        const raw = await readFile(join(wfDirVar, mf), "utf-8");
        const meta = JSON.parse(raw);
        // P1-14: restore task from first meta.json that contains it
        if (!state.task && meta.task && meta.task.spec_file) {
          state.task = meta.task;
        }
      } catch { /* skip corrupt */ }
    }
  } catch { /* */ }

  // 4. Determine round, turn
  const latestPhaseDir = join(wfDirVar, state.phase);
  const latestMetaFiles = await findFiles(latestPhaseDir, ".meta.json");
  let maxRound = 1;
  let lastSubmitter = "";

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
        const subPhases = ["coding", "review"];
        for (const sp of subPhases) {
          if (identity.startsWith(sp + "_")) {
            identity = identity.slice(sp.length + 1);
            break;
          }
        }
        lastSubmitter = identity;
      }
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

  // 4a. Recover sub_phase from filenames (retro-1 §2.2)
  if (state.phase === "implementation") {
    state.sub_phase = inferSubPhase(latestMetaFiles);
  }

  // 4b. Recover dev_cycle (retro-2 §4.1)
  if (state.phase === "implementation") {
    state.dev_cycle = await inferDevPhase(wfDirVar);
  }

  // 4c. Recover last_submit_per_turn from meta.json (retro-1 §2.2)
  try {
    state.last_submit_per_turn = await reconstructLastSubmit(wfDirVar, state.peers, state.phase);
  } catch { /* keep empty if reconstruction fails */ }

  console.log(`[pair-flow] Reconstructed state from handoff/${wfId}: phase=${state.phase}, peers=${state.peers.length}, round=${state.round}`);
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
  for (const phase of PHASE_PRIORITY) {
    try {
      const files = await findFiles(join(wfDir, phase), ".meta.json");
      for (const f of files) {
        const parsed = parseFilename(basename(f));
        if (parsed) ids.add(parsed.identity);
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
      const parsed = parseFilename(basename(f));
      if (parsed && parsed.round === 1) return parsed.identity;
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

// ── Field recovery helpers (retro-1 §2.2 + retro-2 §4.1) ──
function inferSubPhase(metaFiles: string[]): SubPhase {
  for (const mf of metaFiles) {
    const parsed = parseFilename(basename(mf));
    if (parsed?.sub_phase) return parsed.sub_phase;
  }
  // P2-12: no submissions found — phase was advanced but no work started, don't assume "coding"
  return null;
}

async function inferDevPhase(wfDir: string): Promise<number> {
  // Try planning doc first
  try {
    const planningDir = join(wfDir, "planning");
    const entries = await readdir(planningDir);
    const r1File = entries.find((e) => e.startsWith("r1_") && e.endsWith(".md") && !e.includes(".meta"));
    if (r1File) {
      const content = await readFile(join(planningDir, r1File), "utf-8");
      const match = content.match(/循环总数[：:]\s*(\d+)/i);
      if (match) {
        const totalCycles = parseInt(match[1], 10);
        // Count completed coding rounds in implementation/ to determine current dev_cycle
        const implCount = await countCodingRounds(wfDir);
        return Math.min(implCount, totalCycles - 1);
      }
    }
  } catch { /* planning dir missing */ }

  // Fallback: count coding rounds in implementation/
  try {
    return await countCodingRounds(wfDir);
  } catch {
    return 0;
  }
}

async function countCodingRounds(wfDir: string): Promise<number> {
  try {
    const implDir = join(wfDir, "implementation");
    const metaFiles = await findFiles(implDir, ".meta.json");
    let count = 0;
    for (const mf of metaFiles) {
      const parsed = parseFilename(basename(mf));
      if (parsed?.sub_phase === "coding") count++;
    }
    return count;
  } catch {
    return 0;
  }
}

async function reconstructLastSubmit(wfDir: string, peers: Peer[], phase: string): Promise<Record<string, LastSubmit>> {
  const lsp: Record<string, LastSubmit> = {};
  const empty: LastSubmit = { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null };

  // Initialize all peers with empty
  for (const p of peers) lsp[p.identity] = { ...empty };

  try {
    const phaseDir = join(wfDir, phase);
    const metaFiles = await findFiles(phaseDir, ".meta.json");
    for (const mf of metaFiles) {
      const base = basename(mf);
      const parsed = parseFilename(base);
      if (!parsed) continue;
      if (!lsp[parsed.identity]) continue;

      try {
        const raw = await readFile(join(phaseDir, mf), "utf-8");
        const meta = JSON.parse(raw);
        // Only update if this submission is more recent than what we already have
        if (meta.submitted_at && (!lsp[parsed.identity].submitted_at || meta.submitted_at > lsp[parsed.identity].submitted_at!)) {
          lsp[parsed.identity] = {
            round: parsed.round,
            sub_phase: meta.sub_phase ?? parsed.sub_phase,
            commit_hash: meta.commit_hash ?? null,
            submitted_at: meta.submitted_at ?? null,
            file_path: join(phaseDir, base.replace(/\.meta\.json$/, ".md")),
          };
        }
      } catch { /* skip corrupt meta */ }
    }
  } catch { /* phase dir missing */ }

  return lsp;
}

async function findFiles(dir: string, suffix: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const absDir = resolve(dir);
    const entries = await readdir(absDir, { withFileTypes: true, recursive: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(suffix)) {
        // P2-6: parentPath requires Node 22+; use relative() fallback for lower versions
        const pp: string | undefined = (e as { parentPath?: string }).parentPath;
        if (pp) {
          const relDir = pp.startsWith(absDir) ? pp.slice(absDir.length).replace(/^[\\/]/, "") : pp;
          results.push(relDir ? join(relDir, e.name) : e.name);
        } else if ((e as { path?: string }).path) {
          const relPath = relative(absDir, (e as { path: string }).path);
          results.push(relPath);
        } else {
          results.push(e.name);
        }
      }
    }
  } catch { /* */ }
  return results;
}

/** Initialize crash recovery at startup. Call once before starting server. */

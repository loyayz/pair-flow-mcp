import { readdir, readFile, mkdir, access } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { RECOVERY_REGISTERED_AT, defaultState, type PairFlowState, type Phase, type SubPhase, type Participant, type LastSubmission } from "./state.js";


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
const SAFE_IDENTITY = /^[A-Za-z0-9_-]+$/;

/**
 * Parse a handoff filename into structured fields.
 * Accepts: r{N}_{identity}.md, r{N}_{subphase}_{identity}.md,
 *          r{N}_{identity}.meta.json, r{N}_{subphase}_{identity}.meta.json
 */
export function parseFilename(filename: string): ParsedFilename | null {
  const base = filename.replace(KNOWN_EXTENSIONS, "");
  if (base === filename) return null;

  const match = base.match(/^r(\d+)_(.+)$/);
  if (!match) return null;

  const round = parseInt(match[1], 10);
  if (round < 1) return null;
  let identity = match[2];
  let subPhase: SubPhase = null;

  for (const sp of ["coding", "review"]) {
    if (identity.startsWith(sp + "_")) {
      subPhase = sp as SubPhase;
      identity = identity.slice(sp.length + 1);
      break;
    }
  }

  if (!SAFE_IDENTITY.test(identity)) return null;

  return { round, sub_phase: subPhase, identity };
}

// ── Handoff reconstruction (state.json deleted mid-session) ──

const PHASE_PRIORITY: Phase[] = ["summary", "implementation", "planning", "requirements"];

export async function reconstructFromHandoff(
  state: PairFlowState,
  wfId: string
): Promise<PairFlowState | null> {
  const wfDir = join(HANDOFF_DIR, wfId);
  state.workflow_id = wfId;

  // 1. Determine phase
  state.phase = await determinePhase(wfDir);

  // 2. Reconstruct participants from filenames
  const identities = await extractIdentities(wfDir);
  if (identities.size === 0) return null; // can't recover without participants

  for (const id of identities) {
    // 职责由 confirm_task 入参覆盖；重建时用默认值
    state.participants.push({
      identity: id,
      is_supervisor: false,
      is_developer: false,
      registered_at: RECOVERY_REGISTERED_AT,
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
  let latestSubmission: ParsedFilename | null = null;

  for (const mf of latestMetaFiles) {
    const parsed = parseFilename(basename(mf));
    if (parsed && (!latestSubmission || parsed.round > latestSubmission.round)) {
      latestSubmission = parsed;
    }
  }

  state.round = latestSubmission ? latestSubmission.round + 1 : 1;
  if (latestSubmission && state.participants.length >= 2) {
    const other = state.participants.find((p) => p.identity !== latestSubmission.identity);
    state.turn = other?.identity ?? latestSubmission.identity;
  } else if (state.participants.length > 0) {
    state.turn = state.participants[0].identity;
  }

  // 4a. Recover sub_phase from filenames (retro-1 §2.2)
  if (state.phase === "implementation") {
    state.sub_phase = latestSubmission?.sub_phase === "coding"
      ? "review"
      : latestSubmission?.sub_phase === "review"
        ? "coding"
        : null;
  }

  // 4b. Recover last_submission_by_participant from meta.json (retro-1 §2.2)
  try {
    state.last_submission_by_participant = await reconstructLastSubmissionByParticipant(wfDirVar, state.participants, state.phase);
  } catch { /* keep empty if reconstruction fails */ }

  console.log(`[pair-flow] Reconstructed state from handoff/${wfId}: phase=${state.phase}, participants=${state.participants.length}, round=${state.round}`);
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


// ── Field recovery helpers (retro-1 §2.2 + retro-2 §4.1) ──
async function reconstructLastSubmissionByParticipant(wfDir: string, participants: Participant[], phase: string): Promise<Record<string, LastSubmission>> {
  const lsp: Record<string, LastSubmission> = {};
  const empty: LastSubmission = { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null };

  // Initialize all participants with empty
  for (const p of participants) lsp[p.identity] = { ...empty };

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
        } else if ((e as unknown as { path?: string }).path) {
          const relPath = relative(absDir, (e as unknown as { path: string }).path);
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

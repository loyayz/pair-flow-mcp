import { readdir, readFile, mkdir, access } from "node:fs/promises";
import { isAbsolute, join, resolve, relative } from "node:path";
import { RECOVERY_REGISTERED_AT, defaultState, type PairFlowState, type Phase, type SubPhase, type Participant, type LastSubmission } from "./state.js";
import { archivePath } from "./archive-path.js";
import { isValidIdentity } from "./identity.js";

// ── Filename parsing ──

interface ParsedFilename {
  round: number;
  sub_phase: SubPhase;
  identity: string;
}

type RecoverablePhase = Exclude<Phase, "idle">;

interface SubmissionMeta {
  submitted_at: string;
  commit_hash: string;
  sub_phase: SubPhase;
  task: {
    spec_file: string;
    task_type: "requirements" | "development";
  };
}

interface RecoveredSubmission extends ParsedFilename {
  phase: RecoverablePhase;
  meta: SubmissionMeta;
  meta_path: string;
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

  if (!isValidIdentity(identity)) return null;

  return { round, sub_phase: subPhase, identity };
}

// ── Handoff reconstruction (state.json deleted mid-session) ──

const PHASE_PRIORITY: RecoverablePhase[] = ["summary", "implementation", "planning", "requirements"];

export async function reconstructFromHandoff(
  state: PairFlowState,
  wfId: string,
  workDir: string,
  taskPath: string,
): Promise<PairFlowState | null> {
  const wfDir = archivePath(workDir, wfId);
  state.workflow_id = wfId;
  state.task = { spec_file: resolve(taskPath) };

  const submissions = await collectValidSubmissions(wfDir);
  if (submissions.length === 0) return null;

  // 1. Determine phase from valid submissions only.
  state.phase = determinePhase(submissions);

  // 2. Reconstruct participants from valid submissions.
  const identities = new Set(submissions.map((submission) => submission.identity));
  if (identities.size > 2) return null; // workflow domain permits exactly two participants

  for (const id of identities) {
    // 职责由 confirm_task 入参覆盖；重建时用默认值
    state.participants.push({
      identity: id,
      is_supervisor: false,
      is_developer: false,
      registered_at: RECOVERY_REGISTERED_AT,
    });
  }

  // 3. Recover immutable task type; current confirm_task supplies the authoritative path.
  const recoveredTaskTypes = new Set(submissions.map((submission) => submission.meta.task.task_type));
  if (recoveredTaskTypes.size > 1) return null;
  state.task.task_type = recoveredTaskTypes.values().next().value ?? "development";

  // 4. Determine round, turn
  const currentPhaseSubmissions = submissions.filter((submission) => submission.phase === state.phase);
  let latestSubmission: RecoveredSubmission | null = null;
  const recoveredRounds = new Set<number>();

  for (const submission of currentPhaseSubmissions) {
    if (recoveredRounds.has(submission.round)) return null;
    recoveredRounds.add(submission.round);
    if (!latestSubmission || submission.round > latestSubmission.round) {
      latestSubmission = submission;
    }
  }

  state.round = latestSubmission ? latestSubmission.round + 1 : 1;
  if (latestSubmission && state.participants.length >= 2) {
    const other = state.participants.find((p) => p.identity !== latestSubmission.identity);
    state.turn = other?.identity ?? latestSubmission.identity;
  } else if (state.participants.length > 0) {
    state.turn = state.participants[0].identity;
  }

  // 4a. Recover sub_phase from the latest validated filename.
  if (state.phase === "implementation") {
    state.sub_phase = latestSubmission?.sub_phase === "coding"
      ? "review"
      : latestSubmission?.sub_phase === "review"
        ? "coding"
        : null;
  }

  // 4b. Recover last_submission_by_participant from validated metadata.
  state.last_submission_by_participant = reconstructLastSubmissionByParticipant(
    currentPhaseSubmissions,
    state.participants,
  );

  console.log(`[pair-flow] Reconstructed state from ${wfDir}: phase=${state.phase}, participants=${state.participants.length}, round=${state.round}`);
  return state;
}

function determinePhase(submissions: RecoveredSubmission[]): RecoverablePhase {
  for (const phase of PHASE_PRIORITY) {
    if (submissions.some((submission) => submission.phase === phase)) return phase;
  }
  return "requirements";
}

async function collectValidSubmissions(wfDir: string): Promise<RecoveredSubmission[]> {
  const submissions: RecoveredSubmission[] = [];
  for (const phase of PHASE_PRIORITY) {
    const phaseDir = join(wfDir, phase);
    const files = await findFiles(phaseDir, ".meta.json");
    for (const file of files) {
      const parsed = parseFilename(basename(file));
      if (!parsed) continue;
      try {
        const meta = JSON.parse(await readFile(join(phaseDir, file), "utf-8"));
        if (!isValidSubmissionMeta(meta, phase, parsed)) continue;
        submissions.push({ ...parsed, phase, meta, meta_path: join(phaseDir, file) });
      } catch { /* ignore corrupt metadata */ }
    }
  }
  return submissions;
}

function isValidSubmissionMeta(
  value: unknown,
  phase: RecoverablePhase,
  parsed: ParsedFilename,
): value is SubmissionMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Record<string, unknown>;
  if (typeof meta.submitted_at !== "string" || Number.isNaN(Date.parse(meta.submitted_at))) return false;
  if (typeof meta.commit_hash !== "string" || !/^[0-9a-fA-F]{7,40}$/.test(meta.commit_hash)) return false;
  if (!meta.task || typeof meta.task !== "object") return false;
  const task = meta.task as Record<string, unknown>;
  if (typeof task.spec_file !== "string" || !isAbsolute(task.spec_file)) return false;
  if (task.task_type !== "requirements" && task.task_type !== "development") return false;

  if (phase === "implementation") {
    const expectedSubPhase: SubPhase = parsed.round % 2 === 1 ? "coding" : "review";
    return parsed.sub_phase === expectedSubPhase && meta.sub_phase === expectedSubPhase;
  }
  return parsed.sub_phase === null && meta.sub_phase === null;
}

// ── Field recovery helpers (retro-1 §2.2 + retro-2 §4.1) ──
function reconstructLastSubmissionByParticipant(
  submissions: RecoveredSubmission[],
  participants: Participant[],
): Record<string, LastSubmission> {
  const lsp: Record<string, LastSubmission> = {};
  const empty: LastSubmission = { round: null, sub_phase: null, commit_hash: null, submitted_at: null, file_path: null };

  // Initialize all participants with empty
  for (const p of participants) lsp[p.identity] = { ...empty };

  for (const submission of submissions) {
    if (!lsp[submission.identity]) continue;
    if (lsp[submission.identity].round === null || submission.round > lsp[submission.identity].round!) {
      lsp[submission.identity] = {
        round: submission.round,
        sub_phase: submission.sub_phase,
        commit_hash: submission.meta.commit_hash,
        submitted_at: submission.meta.submitted_at,
        file_path: submission.meta_path.replace(/\.meta\.json$/, ".md"),
      };
    }
  }

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

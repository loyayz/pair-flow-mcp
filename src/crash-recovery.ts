import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { RECOVERY_REGISTERED_AT, type PairFlowState, type Phase, type SubPhase, type Participant, type LastSubmission } from "./state.js";
import { archivePath } from "./archive-path.js";
import { isValidIdentity } from "./identity.js";
import { findSymbolicLinkInPath } from "./path-safety.js";
import { collectValidatedSubmissions } from "./archive-submissions.js";

// ── Filename parsing ──

interface ParsedFilename {
  round: number;
  sub_phase: SubPhase;
  identity: string;
}

type RecoverablePhase = Exclude<Phase, "idle">;

export function phaseAfterAccepted(
  phase: RecoverablePhase,
  taskType: "requirements" | "development",
): RecoverablePhase | "completed" {
  if (phase === "requirements") return taskType === "requirements" ? "summary" : "planning";
  if (phase === "planning") return "implementation";
  if (phase === "implementation") return "summary";
  return "completed";
}

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
export function parseFilename(filename: string, phase?: RecoverablePhase): ParsedFilename | null {
  const base = filename.replace(KNOWN_EXTENSIONS, "");
  if (base === filename) return null;

  const match = base.match(/^r(\d+)_(.+)$/);
  if (!match) return null;

  const round = Number(match[1]);
  if (!Number.isSafeInteger(round) || round < 1 || String(round) !== match[1]) return null;
  let identity = match[2];
  let subPhase: SubPhase = null;

  if (phase === undefined || phase === "implementation") {
    for (const sp of ["coding", "review"]) {
      if (identity.startsWith(sp + "_")) {
        subPhase = sp as SubPhase;
        identity = identity.slice(sp.length + 1);
        break;
      }
    }
  }

  if (!isValidIdentity(identity)) return null;

  return { round, sub_phase: subPhase, identity };
}

// ── Handoff reconstruction ──

const PHASE_PRIORITY: RecoverablePhase[] = ["summary", "implementation", "planning", "requirements"];

export async function reconstructFromHandoff(
  state: PairFlowState,
  wfId: string,
  workDir: string,
  taskPath: string,
): Promise<PairFlowState | null> {
  const wfDir = archivePath(workDir, wfId);
  const recoveredState: PairFlowState = {
    ...state,
    workflow_id: wfId,
    wait_warning_cycle: null,
    task: { spec_file: resolve(taskPath) },
    participants: [],
    last_submission_by_participant: {},
  };

  const submissions = await collectValidatedSubmissions(workDir, wfId);
  if (submissions.length === 0) return null;
  if (!hasConsistentStructure(submissions)) return null;

  // 1. Determine phase from valid submissions only.
  recoveredState.phase = determinePhase(submissions);

  // 2. Reconstruct participants from valid submissions.
  const identities = new Set(submissions.map((submission) => submission.identity));
  if (identities.size > 2) return null; // workflow domain permits exactly two participants

  for (const id of identities) {
    // 职责由 confirm_task 入参覆盖；重建时用默认值
    recoveredState.participants.push({
      identity: id,
      is_supervisor: false,
      is_developer: false,
      registered_at: RECOVERY_REGISTERED_AT,
    });
  }

  // 3. Recover immutable task type; current confirm_task supplies the authoritative path.
  const recoveredTaskTypes = new Set(submissions.map((submission) => submission.meta.task.task_type));
  if (recoveredTaskTypes.size > 1) return null;
  recoveredState.task!.task_type = recoveredTaskTypes.values().next().value ?? "development";

  // 4. Determine round, turn
  const currentPhaseSubmissions = submissions.filter((submission) => submission.phase === recoveredState.phase);
  let latestSubmission: RecoveredSubmission | null = null;

  for (const submission of currentPhaseSubmissions) {
    if (!latestSubmission || submission.round > latestSubmission.round) {
      latestSubmission = submission;
    }
  }

  recoveredState.round = latestSubmission ? latestSubmission.round + 1 : 1;
  if (latestSubmission && recoveredState.participants.length >= 2) {
    const other = recoveredState.participants.find((p) => p.identity !== latestSubmission.identity);
    recoveredState.turn = other?.identity ?? latestSubmission.identity;
  } else if (recoveredState.participants.length > 0) {
    recoveredState.turn = recoveredState.participants[0].identity;
  }
  recoveredState.turn_switched_at = latestSubmission?.meta.submitted_at ?? null;
  recoveredState.turn_claimed_at = null;

  // 4a. Recover sub_phase from the latest validated filename.
  if (recoveredState.phase === "implementation") {
    recoveredState.sub_phase = latestSubmission?.sub_phase === "coding"
      ? "review"
      : latestSubmission?.sub_phase === "review"
        ? "coding"
        : null;
  }

  // 4b. Recover last_submission_by_participant from validated metadata.
  recoveredState.last_submission_by_participant = reconstructLastSubmissionByParticipant(
    currentPhaseSubmissions,
    recoveredState.participants,
  );

  console.log(`[pair-flow] Reconstructed state from ${wfDir}: phase=${recoveredState.phase}, participants=${recoveredState.participants.length}, round=${recoveredState.round}`);
  return recoveredState;
}

function hasConsistentStructure(submissions: RecoveredSubmission[]): boolean {
  for (const phase of PHASE_PRIORITY) {
    const phaseSubmissions = submissions.filter((submission) => submission.phase === phase);
    const rounds = new Set<number>();
    const identityByParity = new Map<number, string>();
    const parityByIdentity = new Map<string, number>();

    for (const submission of phaseSubmissions) {
      if (rounds.has(submission.round)) return false;
      rounds.add(submission.round);

      const parity = submission.round % 2;
      const parityIdentity = identityByParity.get(parity);
      if (parityIdentity && parityIdentity !== submission.identity) return false;
      const identityParity = parityByIdentity.get(submission.identity);
      if (identityParity !== undefined && identityParity !== parity) return false;
      identityByParity.set(parity, submission.identity);
      parityByIdentity.set(submission.identity, parity);
    }
  }
  return true;
}

function determinePhase(submissions: RecoveredSubmission[]): RecoverablePhase {
  for (const phase of PHASE_PRIORITY) {
    if (submissions.some((submission) => submission.phase === phase)) return phase;
  }
  return "requirements";
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

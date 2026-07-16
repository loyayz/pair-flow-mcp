import { lstat, readFile } from "node:fs/promises";
import { archivePath, workflowArchivePath, workflowWorkDir } from "./archive-path.js";
import { atomicWriteText } from "./atomic-write.js";
import { collectValidatedSubmissions, latestSubmission, type ValidatedSubmission } from "./archive-submissions.js";
import {
  deliveryManifestSchema,
  type DeliveryManifest,
  type SubmissionReference,
  type WorkflowCompletionSnapshot,
} from "./delivery-manifest-schema.js";
import { findSymbolicLinkInPath } from "./path-safety.js";
import type { PairFlowState } from "./state.js";

export interface PersistedManifest {
  manifest: DeliveryManifest;
  manifest_path: string;
}

function posix(path: string): string {
  return path.replace(/\\/g, "/");
}

function reference(submission: ValidatedSubmission): SubmissionReference {
  return {
    round: submission.round,
    submitted_by: submission.identity,
    commit_hash: submission.meta.commit_hash,
    file_path: submission.file_path,
    ...(submission.sub_phase ? { sub_phase: submission.sub_phase } : {}),
  };
}

function supervisor(state: PairFlowState): string {
  const participant = state.participants.find((candidate) => candidate.is_supervisor);
  if (!participant) throw new Error("workflow supervisor is missing");
  return participant.identity;
}

function manifestPath(state: PairFlowState): string {
  if (!state.workflow_id) throw new Error("workflow_id is missing");
  return workflowArchivePath(state, state.workflow_id, "delivery-manifest.json");
}

function phaseRecord(state: PairFlowState, submissions: readonly ValidatedSubmission[], advancedBy: string, acceptedAt: string) {
  const phaseSubmissions = submissions.filter((submission) => submission.phase === state.phase);
  const latest = latestSubmission(phaseSubmissions);
  if (!latest || state.phase === "idle") throw new Error(`cannot accept phase without a submission: ${state.phase}`);
  const base = {
    phase: state.phase,
    advanced_by: advancedBy,
    accepted_at: acceptedAt,
    acceptance_commit: latest.meta.commit_hash,
  } as const;
  if (state.phase === "requirements") return { ...base, phase: "requirements" as const, final_submission: reference(latest) };
  if (state.phase === "planning") {
    const canonical = latestSubmission(phaseSubmissions, (submission) => submission.round === 1);
    if (!canonical) throw new Error("planning phase is missing canonical r1 plan");
    return { ...base, phase: "planning" as const, canonical_plan: reference(canonical) };
  }
  if (state.phase === "implementation") {
    const coding = latestSubmission(phaseSubmissions, (submission) => submission.sub_phase === "coding");
    const review = latestSubmission(phaseSubmissions, (submission) => submission.sub_phase === "review");
    if (!coding || !review) throw new Error("implementation phase requires coding and review submissions");
    return { ...base, phase: "implementation" as const, coding_submission: reference(coding), review_submission: reference(review) };
  }
  const finalSummary = latestSubmission(phaseSubmissions, (submission) => submission.round === 1 || submission.round >= 3);
  const review = latestSubmission(phaseSubmissions, (submission) => submission.round === 2);
  if (!finalSummary) throw new Error("summary phase is missing final summary submission");
  return { ...base, phase: "summary" as const, final_summary: reference(finalSummary), ...(review ? { review_submission: reference(review) } : {}) };
}

async function writeManifest(state: PairFlowState, manifest: DeliveryManifest): Promise<PersistedManifest> {
  const path = manifestPath(state);
  const workDir = workflowWorkDir(state);
  if (!workDir) throw new Error("workflow work_dir is missing");
  const root = archivePath(workDir);
  const linked = await findSymbolicLinkInPath(root, path).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return null;
    throw error;
  });
  if (linked) throw new Error(`symbolic links are not allowed in delivery manifest path: ${posix(linked)}`);
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error(`delivery manifest path must be a regular file: ${posix(path)}`);
    if (stat.isSymbolicLink()) throw new Error(`delivery manifest path must not be symbolic link: ${posix(path)}`);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")) throw error;
  }
  const parsed = deliveryManifestSchema.parse(manifest);
  await atomicWriteText(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return { manifest: parsed, manifest_path: posix(path) };
}

export async function readDeliveryManifest(workDir: string, workflowId: string): Promise<PersistedManifest | null> {
  const path = archivePath(workDir, workflowId, "delivery-manifest.json");
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`delivery manifest must be a regular file: ${posix(path)}`);
    const manifest = deliveryManifestSchema.parse(JSON.parse(await readFile(path, "utf-8")));
    return { manifest, manifest_path: posix(path) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

async function baseManifest(state: PairFlowState): Promise<DeliveryManifest> {
  if (!state.workflow_id || !state.task?.task_type) throw new Error("workflow task is missing");
  const workDir = workflowWorkDir(state);
  if (!workDir) throw new Error("workflow work_dir is missing");
  return state.delivery_manifest ?? {
    manifest_version: 1,
    status: "in_progress",
    workflow_id: state.workflow_id,
    task_type: state.task.task_type,
    archive_root: posix(workflowArchivePath(state, state.workflow_id)),
    supervisor: supervisor(state),
    phases: {},
    commit_verification: "caller_declared_unverified",
  };
}

export async function persistPhaseAcceptance(state: PairFlowState, advancedBy: string, acceptedAt: string): Promise<PersistedManifest> {
  const workDir = workflowWorkDir(state);
  if (!workDir || !state.workflow_id) throw new Error("workflow archive is missing");
  const manifest = await baseManifest(state);
  const record = phaseRecord(state, await collectValidatedSubmissions(workDir, state.workflow_id), advancedBy, acceptedAt);
  const key = record.phase;
  const existing = manifest.phases[key];
  if (existing && JSON.stringify(existing) !== JSON.stringify(record)) throw new Error(`phase acceptance already exists and conflicts: ${key}`);
  return writeManifest(state, deliveryManifestSchema.parse({ ...manifest, phases: { ...manifest.phases, [key]: existing ?? record } }));
}

export async function persistCompletedManifest(state: PairFlowState, advancedBy: string, completedAt: string): Promise<PersistedManifest> {
  const accepted = await persistPhaseAcceptance(state, advancedBy, completedAt);
  const summary = accepted.manifest.phases.summary;
  if (!summary) throw new Error("completed manifest is missing summary");
  return writeManifest(state, deliveryManifestSchema.parse({
    ...accepted.manifest,
    status: "completed",
    completed_at: completedAt,
    completed_by: advancedBy,
    final_summary: summary.final_summary,
  }));
}

export function toCompletionSnapshot(persisted: PersistedManifest): WorkflowCompletionSnapshot {
  const finalSummary = persisted.manifest.final_summary;
  if (!finalSummary) throw new Error("completed manifest is missing final summary");
  return { manifest_path: persisted.manifest_path, archive_root: persisted.manifest.archive_root, final_summary: finalSummary };
}

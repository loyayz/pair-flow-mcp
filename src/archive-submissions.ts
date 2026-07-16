import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Phase, SubPhase } from "./state.js";
import { archivePath } from "./archive-path.js";
import { isValidIdentity } from "./identity.js";
import { findSymbolicLinkInPath } from "./path-safety.js";

export type RecoverablePhase = Exclude<Phase, "idle">;

export interface SubmissionMeta {
  submitted_at: string;
  commit_hash: string;
  sub_phase: SubPhase;
  task: {
    spec_file: string;
    task_type: "requirements" | "development";
  };
}

export interface ValidatedSubmission {
  phase: RecoverablePhase;
  round: number;
  sub_phase: SubPhase;
  identity: string;
  meta: SubmissionMeta;
  meta_path: string;
  file_path: string;
}

interface ParsedFilename {
  round: number;
  sub_phase: SubPhase;
  identity: string;
}

const PHASES: RecoverablePhase[] = ["summary", "implementation", "planning", "requirements"];
const KNOWN_EXTENSIONS = /\.(?:md|meta\.json)$/;

export function parseSubmissionFilename(filename: string, phase?: RecoverablePhase): ParsedFilename | null {
  const base = filename.replace(KNOWN_EXTENSIONS, "");
  if (base === filename) return null;
  const match = base.match(/^r(\d+)_(.+)$/);
  if (!match) return null;
  const round = Number(match[1]);
  if (!Number.isSafeInteger(round) || round < 1 || String(round) !== match[1]) return null;

  let identity = match[2];
  let subPhase: SubPhase = null;
  if (phase === undefined || phase === "implementation") {
    for (const candidate of ["coding", "review"] as const) {
      if (identity.startsWith(`${candidate}_`)) {
        subPhase = candidate;
        identity = identity.slice(candidate.length + 1);
        break;
      }
    }
  }
  return isValidIdentity(identity) ? { round, sub_phase: subPhase, identity } : null;
}

export async function collectValidatedSubmissions(workDir: string, workflowId: string): Promise<ValidatedSubmission[]> {
  const root = archivePath(workDir);
  const workflowRoot = archivePath(workDir, workflowId);
  const submissions: ValidatedSubmission[] = [];
  for (const phase of PHASES) {
    const phaseDir = join(workflowRoot, phase);
    for (const file of await findFiles(phaseDir, root)) {
      const parsed = parseSubmissionFilename(file, phase);
      if (!parsed) continue;
      const metaPath = join(phaseDir, file);
      let content: string;
      try {
        content = await readFile(metaPath, "utf-8");
      } catch (error) {
        throw recoveryReadError(metaPath, error);
      }
      try {
        const meta: unknown = JSON.parse(content);
        if (!isValidSubmissionMeta(meta, phase, parsed) || !await hasRecoverableArtifact(metaPath)) continue;
        submissions.push({
          ...parsed,
          phase,
          meta,
          meta_path: toPosix(metaPath),
          file_path: toPosix(metaPath.replace(/\.meta\.json$/, ".md")),
        });
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    }
  }
  return submissions;
}

export function latestSubmission(
  submissions: readonly ValidatedSubmission[],
  predicate: (submission: ValidatedSubmission) => boolean = () => true,
): ValidatedSubmission | null {
  return submissions.filter(predicate).reduce<ValidatedSubmission | null>(
    (latest, current) => latest === null || current.round > latest.round ? current : latest,
    null,
  );
}

async function findFiles(dir: string, root: string): Promise<string[]> {
  let symbolicLinkPath: string | null;
  try {
    symbolicLinkPath = await findSymbolicLinkInPath(root, dir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw recoveryReadError(dir, error);
  }
  if (symbolicLinkPath) throw new Error(`symbolic links are not allowed in recovery archive: ${toPosix(symbolicLinkPath)}`);
  try {
    const entries = await readdir(resolve(dir), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".meta.json")).map((entry) => entry.name);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw recoveryReadError(dir, error);
  }
}

async function hasRecoverableArtifact(metaPath: string): Promise<boolean> {
  try {
    const artifact = await lstat(metaPath.replace(/\.meta\.json$/, ".md"));
    return artifact.isFile() && artifact.size > 0;
  } catch {
    return false;
  }
}

function isValidSubmissionMeta(value: unknown, phase: RecoverablePhase, parsed: ParsedFilename): value is SubmissionMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Record<string, unknown>;
  if (typeof meta.submitted_at !== "string" || Number.isNaN(Date.parse(meta.submitted_at))) return false;
  if (typeof meta.commit_hash !== "string" || !/^[0-9a-f]{7,40}$/.test(meta.commit_hash)) return false;
  if (!meta.task || typeof meta.task !== "object") return false;
  const task = meta.task as Record<string, unknown>;
  if (typeof task.spec_file !== "string" || !isAbsolute(task.spec_file)) return false;
  if (task.task_type !== "requirements" && task.task_type !== "development") return false;
  if (task.task_type === "requirements" && (phase === "planning" || phase === "implementation")) return false;
  if (phase === "implementation") {
    const expected = parsed.round % 2 === 1 ? "coding" : "review";
    return parsed.sub_phase === expected && meta.sub_phase === expected;
  }
  return parsed.sub_phase === null && meta.sub_phase === null;
}

function recoveryReadError(path: string, error: unknown): Error {
  const code = errorCode(error) ?? "UNKNOWN";
  return new Error(`failed to read recovery archive: ${toPosix(path)} (${code})`, { cause: error });
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

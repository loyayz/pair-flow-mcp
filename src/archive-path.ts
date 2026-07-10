import { resolve } from "node:path";
import type { PairFlowState } from "./state.js";

export function archiveRoot(workDir: string): string {
  return resolve(workDir, "handoff");
}

export function workflowWorkDir(state: PairFlowState): string | null {
  const workDir = state.participants.find((participant) => participant.work_dir)?.work_dir;
  return workDir ? resolve(workDir) : null;
}

export function archivePath(workDir: string, ...segments: string[]): string {
  return resolve(archiveRoot(workDir), ...segments);
}

export function workflowArchivePath(state: PairFlowState, ...segments: string[]): string {
  const workDir = workflowWorkDir(state);
  if (!workDir) throw new Error("workflow work_dir is missing");
  return archivePath(workDir, ...segments);
}

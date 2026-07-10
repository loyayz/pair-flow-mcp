import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { err, ok } from "../response.js";
import { parseSession } from "../identity.js";
import { getState } from "../state.js";
import { archiveRoot } from "../archive-path.js";

// ── get_archived_files ──

export async function getArchivedFiles(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<CallToolResult> {
  const { identity, workflowId } = parseSession(extra.requestInfo?.headers);
  const state = workflowId ? getState(workflowId) : undefined;
  const participant = state?.participants.find((candidate) => candidate.identity === identity);
  const activeWorkflowId = participant ? state?.workflow_id : null;
  const suppliedId = args.workflow_id as string | undefined;
  const wfId = suppliedId ? tryValidatePathSegment(suppliedId) : activeWorkflowId;
  if (wfId === null) return err("invalid workflow_id");
  if (!wfId) return ok({ files: [] });

  const safeId = tryValidatePathSegment(wfId);
  if (safeId === null) return err("invalid workflow_id");

  const suppliedWorkDir = args.work_dir as string | undefined;
  if (suppliedWorkDir !== undefined && !suppliedId) {
    return err("work_dir may only be provided with workflow_id");
  }
  if (suppliedWorkDir !== undefined) {
    if (!isAbsolute(suppliedWorkDir)) return err("work_dir must be an absolute path");
    if (hasRelativeSegment(suppliedWorkDir)) return err("work_dir must not contain . or .. path segments");
  }
  const workDir = suppliedWorkDir
    ? resolve(suppliedWorkDir)
    : suppliedId === activeWorkflowId || !suppliedId
      ? participant?.work_dir
      : undefined;
  if (!workDir) {
    return err("work_dir is required when listing a historical or anonymous workflow_id");
  }
  const resolvedWorkDir = resolve(workDir);
  try {
    const workDirStat = await stat(resolvedWorkDir);
    if (!workDirStat.isDirectory()) return err("work_dir must be a directory");
  } catch {
    return err(`work_dir not found: ${resolvedWorkDir.replace(/\\/g, "/")}`);
  }

  const root = archiveRoot(resolvedWorkDir);
  let dir = join(root, safeId);

  const phase = args.phase as string | undefined;
  const VALID_PHASES = ["requirements", "planning", "implementation", "summary"];
  if (phase && !VALID_PHASES.includes(phase)) {
    return err(`invalid phase: ${phase}. Must be one of: ${VALID_PHASES.join(", ")}`);
  }
  if (phase) dir = join(dir, phase);

  if (!isInside(resolve(dir), root)) {
    return err("invalid path");
  }

  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".meta.json")))
      .map((entry) => {
        const parentPath = (entry as { parentPath?: string; path?: string }).parentPath
          ?? (entry as { path?: string }).path
          ?? dir;
        return relative(dir, join(parentPath, entry.name)).replace(/\\/g, "/");
      });
    return ok({ files });
  } catch {
    return ok({ files: [] });
  }
}

function validatePathSegment(segment: string): string {
  if (/[\\/:]/.test(segment) || segment.includes("..") || !/^[a-zA-Z0-9_-]+$/.test(segment)) {
    throw new Error("Invalid path segment");
  }
  return segment;
}

function tryValidatePathSegment(segment: string): string | null {
  try {
    return validatePathSegment(segment);
  } catch {
    return null;
  }
}

function isInside(child: string, parent: string): boolean {
  const comparableChild = process.platform === "win32" ? child.toLowerCase() : child;
  const comparableParent = process.platform === "win32" ? parent.toLowerCase() : parent;
  return comparableChild === comparableParent
    || comparableChild.startsWith(comparableParent.endsWith(sep) ? comparableParent : comparableParent + sep);
}

function hasRelativeSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((part) => part === "." || part === "..");
}

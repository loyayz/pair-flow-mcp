import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { err, ok } from "../response.js";
import { parseSession } from "../identity.js";
import { getState } from "../state.js";

const HANDOFF_DIR = process.env.HANDOFF_DIR || "handoff";

// ── get_archived_files ──

export async function getArchivedFiles(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): Promise<CallToolResult> {
  const { workflowId } = parseSession(extra.requestInfo?.headers);
  const state = workflowId ? getState(workflowId) : undefined;
  const suppliedId = args.workflow_id as string | undefined;
  const wfId = suppliedId ? tryValidatePathSegment(suppliedId) : (state?.workflow_id ?? workflowId);
  if (wfId === null) return err("invalid workflow_id");
  if (!wfId) return ok({ files: [] });

  const safeId = tryValidatePathSegment(wfId);
  if (safeId === null) return err("invalid workflow_id");
  let dir = join(HANDOFF_DIR, safeId);

  const phase = args.phase as string | undefined;
  const VALID_PHASES = ["requirements", "planning", "implementation", "summary"];
  if (phase && !VALID_PHASES.includes(phase)) {
    return err(`invalid phase: ${phase}. Must be one of: ${VALID_PHASES.join(", ")}`);
  }
  if (phase) dir = join(dir, phase);

  if (!isInside(resolve(dir), resolve(HANDOFF_DIR))) {
    return err("invalid path");
  }

  try {
    const entries = await readdir(dir, { recursive: true });
    const files = entries.filter((e) => e.endsWith(".md") || e.endsWith(".json") || e.endsWith(".jsonl"));
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

function validateArchiveFilename(filename: string): string | null {
  if (/[\\/]/.test(filename) || filename.includes("..") || filename === "." || filename === "..") {
    return null;
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(filename)) return null;
  if (!filename.endsWith(".md") && !filename.endsWith(".meta.json")) return null;
  return filename;
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

// ── get_archived_file_content ──

export async function getArchivedFileContent(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const { workflowId } = parseSession(extra.requestInfo?.headers);
  const filename = args.filename as string;
  if (!filename) return err("filename required");
  const safeArchiveFilename = validateArchiveFilename(filename);
  if (!safeArchiveFilename) return err("invalid filename");

  const state = workflowId ? getState(workflowId) : undefined;
  const wfId = state?.workflow_id ?? workflowId;
  if (!wfId) return err("no active workflow");

  const phase = args.phase as string | undefined;
  const VALID_PHASES = ["requirements", "planning", "implementation", "summary"];
  if (phase && !VALID_PHASES.includes(phase)) {
    return err(`invalid phase: ${phase}. Must be one of: ${VALID_PHASES.join(", ")}`);
  }
  const effectivePhase = phase ?? state?.phase ?? "requirements";
  const safeFilename = join(effectivePhase, safeArchiveFilename);

  const safeWfId = tryValidatePathSegment(wfId);
  if (safeWfId === null) return err("invalid workflow_id");
  const filePath = join(HANDOFF_DIR, safeWfId, safeFilename);
  if (!isInside(resolve(filePath), resolve(join(HANDOFF_DIR, safeWfId)))) {
    return err("invalid filename");
  }

  try {
    const content = await readFile(filePath, "utf-8");
    return ok({ content });
  } catch {
    return err(`file not found: ${safeArchiveFilename}`);
  }
}

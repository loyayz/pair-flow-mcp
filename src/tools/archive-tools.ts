import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
  const wfId = suppliedId ? validatePathSegment(suppliedId) : (state?.workflow_id ?? workflowId);
  if (!wfId) return ok({ files: [] });

  const safeId = validatePathSegment(wfId);
  let dir = join(HANDOFF_DIR, safeId);

  const phase = args.phase as string | undefined;
  if (phase) dir = join(dir, validatePathSegment(phase));

  if (!resolve(dir).startsWith(resolve(HANDOFF_DIR))) {
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

// ── get_archived_file_content ──

export async function getArchivedFileContent(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const { workflowId } = parseSession(extra.requestInfo?.headers);
  const filename = args.filename as string;
  if (!filename) return err("filename required");

  const state = workflowId ? getState(workflowId) : undefined;
  const wfId = state?.workflow_id ?? workflowId;
  if (!wfId) return err("no active workflow");

  const phase = args.phase as string | undefined;
  const VALID_PHASES = ["requirements", "planning", "implementation", "summary"];
  if (phase && !VALID_PHASES.includes(phase)) {
    return err(`invalid phase: ${phase}. Must be one of: ${VALID_PHASES.join(", ")}`);
  }
  const effectivePhase = phase ?? state?.phase ?? "requirements";
  const safeFilename = join(validatePathSegment(effectivePhase), filename);

  const safeWfId = validatePathSegment(wfId);
  const filePath = join(HANDOFF_DIR, safeWfId, safeFilename);
  if (!resolve(filePath).startsWith(resolve(join(HANDOFF_DIR, safeWfId)))) {
    return err("invalid filename");
  }

  try {
    const content = await readFile(filePath, "utf-8");
    return ok({ content });
  } catch {
    return err(`file not found: ${filename}`);
  }
}

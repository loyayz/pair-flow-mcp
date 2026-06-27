import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { err, ok } from "../response.js";
import { parseIdentity } from "../identity.js";
import { loadState } from "../state.js";

const HANDOFF_DIR = process.env.HANDOFF_DIR || "handoff";

// ── get_archived_files ──

export async function getArchivedFiles(
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const state = await loadState();
  const suppliedId = args.workflow_id as string | undefined;
  const wfId = suppliedId ? validatePathSegment(suppliedId) : state.workflow_id;
  if (!wfId) return ok({ files: [] });

  const safeId = validatePathSegment(wfId);
  let dir = join(HANDOFF_DIR, safeId);

  const phase = args.phase as string | undefined;
  if (phase) dir = join(dir, validatePathSegment(phase));

  // Verify resolved path stays within HANDOFF_DIR
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
  const identity = parseIdentity(extra.requestInfo?.headers);
  const filename = args.filename as string;
  if (!filename) return err("filename required");

  const state = await loadState();

  const wfId = state.workflow_id;
  if (!wfId) return err("no active workflow");

  // P1: optional phase parameter — prepend to filename for phase subdirectory
  const phase = args.phase as string | undefined;
  const VALID_PHASES = ["requirements", "planning", "implementation", "summary"];
  if (phase && !VALID_PHASES.includes(phase)) {
    return err(`invalid phase: ${phase}. Must be one of: ${VALID_PHASES.join(", ")}`);
  }
  const safeFilename = phase ? join(validatePathSegment(phase), filename) : filename;

  const safeWfId = validatePathSegment(wfId);
  const filePath = join(HANDOFF_DIR, safeWfId, safeFilename);
  // Prevent path traversal
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

// ── force_converge ──


import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseIdentity } from "../identity.js";
import { loadState, saveState } from "../state.js";
import { logEvent } from "../logger.js";
import { stateMutex } from "../mutex.js";

const HANDOFF_DIR = "handoff";

// ── get_archived_files ──

export async function getArchivedFiles(
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const state = await loadState();
  // Use state.workflow_id exclusively unless explicitly allowed; validate user-supplied values
  const wfId = state.workflow_id;
  if (!wfId) return { content: [{ type: "text", text: JSON.stringify({ files: [] }) }] };

  const safeId = validatePathSegment(wfId);
  let dir = join(HANDOFF_DIR, safeId);

  const phase = args.phase as string | undefined;
  if (phase) dir = join(dir, validatePathSegment(phase));

  // Verify resolved path stays within HANDOFF_DIR
  const { resolve } = await import("node:path");
  if (!resolve(dir).startsWith(resolve(HANDOFF_DIR))) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "invalid path" }) }], isError: true };
  }

  try {
    const entries = await readdir(dir, { recursive: true });
    const files = entries.filter((e) => e.endsWith(".md") || e.endsWith(".json") || e.endsWith(".jsonl"));
    return { content: [{ type: "text", text: JSON.stringify({ files }) }] };
  } catch {
    return { content: [{ type: "text", text: JSON.stringify({ files: [] }) }] };
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
  if (!filename) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "filename required" }) }], isError: true };

  const state = await loadState();

  // Blind review access control: deny access to other party's blind review files
  const isBlindFile = filename.includes("_blind_review");
  if (isBlindFile && state.blind_review_pending) {
    // Check if this file belongs to the other party
    const other = state.peers.find((p) => p.identity !== identity);
    if (other && filename.includes(other.identity)) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "access denied: cannot read other party's blind review during blind review phase" }) }], isError: true };
    }
  }

  const wfId = state.workflow_id;
  if (!wfId) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "no active workflow" }) }], isError: true };

  const safeWfId = validatePathSegment(wfId);
  const filePath = join(HANDOFF_DIR, safeWfId, filename);
  // Prevent path traversal
  const { resolve } = await import("node:path");
  if (!resolve(filePath).startsWith(resolve(join(HANDOFF_DIR, safeWfId)))) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "invalid filename" }) }], isError: true };
  }

  try {
    const content = await readFile(filePath, "utf-8");
    return { content: [{ type: "text", text: content }] };
  } catch {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `file not found: ${filename}` }) }], isError: true };
  }
}

// ── force_converge ──

export async function forceConverge(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "identity required" }) }], isError: true };

  return stateMutex.runExclusive(async () => {
    const state = await loadState();
    const isSup = state.peers.some((p) => p.identity === identity && p.role === "supervisor");
    if (!isSup) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "only supervisor can force_converge" }) }], isError: true };
    if (state.phase === "idle") return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "cannot force_converge in IDLE phase" }) }], isError: true };

    // Close all open issues
    for (const issue of state.issues) {
      if (issue.status === "open") {
        issue.status = "resolved";
        issue.resolved_by = "force_converge";
        issue.resolution = `force_converge by ${identity}`;
      }
    }
    state.converged = true;
    state.blind_review_pending = false;
    state.current_lease = { token: null, holder: null, expires_at: null, grace_used: false };
    state.current_timeout.active = false;
    await saveState(state);
    await logEvent("force_converge", { identity, phase: state.phase });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  });
}

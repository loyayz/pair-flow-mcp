import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { err, ok } from "../response.js";
import { parseIdentity } from "../identity.js";
import { loadState, saveState } from "../state.js";
import { logEvent } from "../logger.js";
import { stateMutex } from "../mutex.js";
import { stopLeaseTimer } from "../lease.js";

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

  // Blind review access control: deny access to other party's blind review files
  const isBlindFile = filename.includes("_blind_review");
  if (isBlindFile && state.blind_review_pending) {
    // Check if this file belongs to the other party
    const other = state.peers.find((p) => p.identity !== identity);
    if (other && filename.includes(other.identity)) {
      return err("access denied: cannot read other party's blind review during blind review phase");
    }
  }

  const wfId = state.workflow_id;
  if (!wfId) return err("no active workflow");

  const safeWfId = validatePathSegment(wfId);
  const filePath = join(HANDOFF_DIR, safeWfId, filename);
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

export async function forceConverge(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") return err("identity required");

  return stateMutex.runExclusive(async () => {
    const state = await loadState();
    const isSup = state.peers.some((p) => p.identity === identity && p.role === "supervisor");
    if (!isSup) return err("only supervisor can force_converge");
    if (state.phase === "idle") return err("cannot force_converge in IDLE phase");

    // Close all open issues
    for (const issue of state.issues) {
      if (issue.status === "open") {
        issue.status = "resolved";
        issue.resolved_by = "force_converge";
        issue.resolution = `force_converge by ${identity}`;
      }
    }
    // Multi-cycle aware: if implementation, just converge current cycle & advance dev_phase
    if (state.phase === "implementation" && state.dev_phase !== null) {
      state.converged = true;
      state.blind_review_pending = false;
      // We'd check for remaining cycles here, but for now advance dev_phase + reset
      state.dev_phase += 1;
      state.round = 1;
      state.sub_phase = "coding";
      const emptyLsp: Record<string, typeof state.last_submit_per_turn[string]> = {};
      for (const p of state.peers) {
        emptyLsp[p.identity] = { round: null, sub_phase: null, commit_hash: null, submitted_at: null, stance: null, need_next_round: null, new_issues: [] };
      }
      state.last_submit_per_turn = emptyLsp;
    } else {
      state.converged = true;
      state.blind_review_pending = false;
    }
    state.current_lease = { token: null, holder: null, expires_at: null, grace_used: false };
    state.current_timeout.active = false;
    stopLeaseTimer();
    await saveState(state);
    await logEvent("force_converge", { identity, phase: state.phase });
    return ok({ ok: true });
  });
}

import { readdir, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadState, saveState, defaultState, type PairFlowState, type HistoryEntry, type Issue, type LastSubmit } from "./state.js";
import { logEvent } from "./logger.js";

const HANDOFF_DIR = "handoff";

/**
 * Recover state after crash. Returns the recovered state or default if no recovery possible.
 * §8 crash recovery specification.
 */
export async function recoverState(): Promise<PairFlowState> {
  let state = await loadState();
  await logEvent("crash_recovery", { phase: state.phase });

  // Step 0: Recover workflow_id
  if (state.phase === "idle") {
    // IDLE crash: skip scan, peers clear (§8 step 7)
    state.peers = [];
    state.current_lease = { token: null, holder: null, expires_at: null, grace_used: false };
    await saveState(state);
    return state;
  }

  if (!state.workflow_id) {
    state.workflow_id = await findLatestWorkflowId();
    if (!state.workflow_id) {
      return defaultState(state.current_timeout.phase_config);
    }
  }

  // Step 1: Scan meta.json files
  const wfDir = join(HANDOFF_DIR, state.workflow_id);
  try {
    await mkdir(wfDir, { recursive: true });
    const metaFiles = await findFiles(wfDir, ".meta.json");
    for (const mf of metaFiles) {
      try {
        const raw = await readFile(join(wfDir, mf), "utf-8");
        const meta = JSON.parse(raw);
        if (meta.new_issues) {
          for (const ni of meta.new_issues) {
            if (typeof ni === "number") continue; // issue IDs only
            // Reconstruct issue if not present
            const exists = state.issues.find((i) => i.id === ni.id);
            if (!exists) {
              state.issues.push({ id: ni.id ?? 0, type: ni.type ?? "P1", topic: ni.topic ?? "", description: ni.description ?? "", raised_by: ni.raised_by ?? "unknown", phase: state.phase, round: meta.round ?? state.round, status: "open", positions: {}, resolution: null, resolved_by: null, escalated_at: null, fix_review_cycles: 0, proposal: null, rationale: null });
            }
          }
        }
      } catch { /* skip corrupt meta files */ }
    }
  } catch { /* handoff dir missing */ }

  // Step 2: Replay journal
  try {
    const journalPath = join(wfDir, "issues-journal.jsonl");
    const journalRaw = await readFile(journalPath, "utf-8");
    const lines = journalRaw.trim().split("\n");
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const issue = state.issues.find((i) => i.id === entry.id);
        if (!issue) continue;
        if (entry.action === "resolve") { issue.status = "resolved"; issue.resolution = entry.resolution ?? ""; issue.resolved_by = "supervisor_override"; }
        if (entry.action === "escalate") { issue.status = "escalated"; issue.escalated_at = entry.timestamp ?? null; }
      } catch { /* skip corrupt lines */ }
    }
  } catch { /* no journal */ }

  // Step 5: Clear lease
  state.current_lease = { token: null, holder: null, expires_at: null, grace_used: false };

  // Step 7: IDLE crash — peers already cleared above
  await saveState(state);
  await logEvent("crash_recovery", { recovered: true, workflow_id: state.workflow_id, phase: state.phase });
  return state;
}

async function findLatestWorkflowId(): Promise<string | null> {
  try {
    const entries = await readdir(HANDOFF_DIR, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && /^\d{14}$/.test(e.name));
    if (dirs.length === 0) return null;

    // Sort descending, skip completed workflows (those with summary/ containing *_final.md)
    dirs.sort((a, b) => b.name.localeCompare(a.name));
    for (const d of dirs) {
      try {
        const summaryDir = join(HANDOFF_DIR, d.name, "summary");
        const implDir = join(HANDOFF_DIR, d.name, "implementation");
        // Check if it has a summary directory with final files (completed)
        const summaryEntries = await readdir(summaryDir);
        const hasFinal = summaryEntries.some((e) => e.includes("_final.md"));
        if (hasFinal) continue; // completed workflow, skip
        // Has implementation? Might be in progress
        const hasContent = summaryEntries.length > 0;
        if (hasContent) return d.name;
      } catch { /* dir not exist, try next */ }
      // Has meta.json files? Likely in progress
      try {
        const allFiles = await findFiles(join(HANDOFF_DIR, d.name), ".meta.json");
        if (allFiles.length > 0) return d.name;
      } catch { /* */ }
    }
    // Fallback: newest directory
    return dirs[0]?.name ?? null;
  } catch {
    return null;
  }
}

async function findFiles(dir: string, suffix: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(suffix)) {
        results.push(e.name);
      }
    }
  } catch { /* */ }
  return results;
}

/** Initialize crash recovery at startup. Call once before starting server. */
export async function initializeRecovery(): Promise<PairFlowState> {
  try {
    return await recoverState();
  } catch {
    return defaultState();
  }
}

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { mkdir, appendFile } from "node:fs/promises";
import { parseIdentity } from "../identity.js";
import { loadState, saveState, isSupervisor } from "../state.js";
import { logEvent } from "../logger.js";
import { stateMutex } from "../mutex.js";
import { err, ok } from "../response.js";

const HANDOFF_DIR = process.env.HANDOFF_DIR || "handoff";

// ── create_issue ──

export async function createIssue(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") return err("identity required");

  const type = args.type as string;
  const topic = (args.topic as string)?.slice(0, 200) ?? "";
  const description = (args.description as string) ?? "";
  const myPosition = args.my_position as string | undefined;
  const proposal = args.proposal as string | undefined;
  const rationale = args.rationale as string | undefined;

  if (!["P0", "P1", "P2"].includes(type)) return err("type must be P0, P1, or P2");
  if (!topic) return err("topic required");
  if ((type === "P0" || type === "P1") && !proposal) return err("P0/P1 require proposal + rationale — §6 proposal obligation");
  if ((type === "P0" || type === "P1") && !rationale) return err("P0/P1 require rationale — §6 proposal obligation");

  return stateMutex.runExclusive(async () => {
    const state = await loadState();
    if (state.phase === "idle") return err("cannot create issue in IDLE phase");
    if (state.sub_phase === "fix" && type === "P0") return err("new P0 issues are not allowed during fix sub_phase");

    const issueId = state.next_issue_id++;
    state.issues.push({
      id: issueId, type: type as "P0" | "P1" | "P2", topic, description,
      raised_by: identity, phase: state.phase, round: state.round,
      status: "open", positions: { [identity]: myPosition ?? "" },
      resolution: null, resolved_by: null, escalated_at: null,
      fix_review_cycles: 0, proposal: proposal ?? null, rationale: rationale ?? null,
      deferred_reason: null, deferred_since_phase: null, deferred_count: 0,
    });
    await saveState(state);
    // Journal (§6 authorial storage)
    const journalPath = `${HANDOFF_DIR}/${state.workflow_id}/issues-journal.jsonl`;
    await mkdir(`${HANDOFF_DIR}/${state.workflow_id}`, { recursive: true }).then(() => appendFile(journalPath,JSON.stringify({ action: "create", timestamp: new Date().toISOString(), id: issueId, type, topic, raised_by: identity }) + "\n"));
    await logEvent("create_issue", { issue_id: issueId, type, topic, identity });
    return ok({ ok: true, issue_id: issueId },
      { tool: "submit", when: "将 issue 写入收敛标记并提交" });
  });
}

// ── resolve_issue ──

export async function resolveIssue(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") return err("identity required");

  const issueId = args.issue_id as number;
  const resolution = (args.resolution as string) ?? "";

  return stateMutex.runExclusive(async () => {
    const state = await loadState();
    if (state.phase === "idle") return err("cannot resolve issue in IDLE phase");
    const issue = state.issues.find((i) => i.id === issueId);
    if (!issue) return err(`issue #${issueId} not found`);
    if (issue.type === "P0" && !isSupervisor(state, identity)) return err("only supervisor can resolve P0 issues");

    issue.status = "resolved";
    issue.resolution = resolution;
    issue.resolved_by = issue.type === "P0" ? "supervisor_override" : "converged";
    issue.fix_review_cycles = 0; // Reset stalemate counter (§5.5)
    await saveState(state);
    // Journal (§6 authorial storage)
    const journalPath = `${HANDOFF_DIR}/${state.workflow_id}/issues-journal.jsonl`;
    await mkdir(`${HANDOFF_DIR}/${state.workflow_id}`, { recursive: true }).then(() => appendFile(journalPath,JSON.stringify({ action: "resolve", timestamp: new Date().toISOString(), id: issueId, identity, resolution }) + "\n"));
    await logEvent("resolve_issue", { issue_id: issueId, identity });
    return ok({ ok: true });
  });
}

// ── escalate ──

export async function escalate(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") return err("identity required");

  const issueId = args.issue_id as number;
  const reason = (args.reason as string) ?? "";

  return stateMutex.runExclusive(async () => {
    const state = await loadState();
    if (!isSupervisor(state, identity)) return err("only supervisor can escalate");
    if (state.phase === "idle") return err("cannot escalate in IDLE phase");

    const issue = state.issues.find((i) => i.id === issueId);
    if (!issue) return err(`issue #${issueId} not found`);
    if (issue.type !== "P0") return err("only P0 issues can be escalated");
    if (issue.status !== "open") return err(`issue #${issueId} is not open (status: ${issue.status})`);

    issue.status = "escalated";
    issue.escalated_at = new Date().toISOString();
    issue.fix_review_cycles = 0; // Reset stalemate counter (§5.5)
    await saveState(state);
    const journalPath = `${HANDOFF_DIR}/${state.workflow_id}/issues-journal.jsonl`;
    await mkdir(`${HANDOFF_DIR}/${state.workflow_id}`, { recursive: true }).then(() => appendFile(journalPath,JSON.stringify({ action: "escalate", timestamp: new Date().toISOString(), id: issueId, identity, reason }) + "\n"));
    await logEvent("escalate", { issue_id: issueId, identity, reason });
    return ok({ ok: true });
  });
}

// ── defer_issue ── (P0-13: defer 工具)

export async function deferIssue(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") return err("identity required");

  const issueId = args.issue_id as number;
  const reason = (args.reason as string) ?? "";

  if (!reason) return err("defer reason required");

  return stateMutex.runExclusive(async () => {
    const state = await loadState();
    if (state.phase === "idle") return err("cannot defer issue in IDLE phase");

    const issue = state.issues.find((i) => i.id === issueId);
    if (!issue) return err("issue #" + issueId + " not found");
    if (issue.status !== "open") return err("issue #" + issueId + " is not open (status: " + issue.status + ")");

    // Permission: issue creator or supervisor can defer
    if (issue.raised_by !== identity && !isSupervisor(state, identity)) {
      return err("only issue creator or supervisor can defer — §6 defer permission");
    }

    issue.status = "deferred";
    issue.deferred_reason = reason;
    issue.deferred_since_phase = state.phase;
    issue.deferred_count += 1;

    await saveState(state);
    // Journal (§6 authorial storage)
    const journalPath = HANDOFF_DIR + "/" + (state.workflow_id ?? "unknown") + "/issues-journal.jsonl";
    await mkdir(HANDOFF_DIR + "/" + (state.workflow_id ?? "unknown"), { recursive: true }).then(() =>
      appendFile(journalPath, JSON.stringify({ action: "defer", timestamp: new Date().toISOString(), id: issueId, identity, reason }) + "\n")
    );
    await logEvent("defer_issue", { issue_id: issueId, identity, reason });
    return ok({ ok: true });
  });
}

// ── list_issues ──

export async function listIssues(
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const status = args.status as string | undefined;
  const scope = (args.scope as string) ?? "current_phase";

  const state = await loadState();
  let issues = state.issues;
  if (scope === "current_phase") {
    issues = issues.filter((i) => i.phase === state.phase);
  }
  if (status) {
    issues = issues.filter((i) => i.status === status);
  }
  return ok({ issues });
}

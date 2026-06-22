import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseIdentity } from "../identity.js";
import { loadState, saveState, isCurrentHolder, getOtherIdentity, type ConvergeMark, type Stance } from "../state.js";
import { logEvent } from "../logger.js";
import { stateMutex } from "../mutex.js";
import { crossValidateConvergeMark } from "../template.js";

const MAX_CONTENT_BYTES = 500 * 1024; // 500KB
const HANDOFF_DIR = "handoff";

export async function submit(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "identity required" }) }], isError: true };
  }

  const content = args.content as string;
  const convergeMark = args.converge_mark as ConvergeMark;
  const commitHash = args.commit_hash as string;
  const blindReview = args.blind_review === true;

  // Validate content size
  const contentBytes = Buffer.byteLength(content, "utf-8");
  if (contentBytes > MAX_CONTENT_BYTES) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `content exceeds 500KB limit (${contentBytes} bytes). Please split or reference external files.` }) }], isError: true };
  }

  // Validate commit_hash format
  if (!commitHash || !/^[a-f0-9]{7,40}$/i.test(commitHash)) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "invalid commit_hash format" }) }], isError: true };
  }

  // Blind review: stance and need_next_round must be null
  if (blindReview && (convergeMark.stance !== null || convergeMark.need_next_round !== null)) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "blind_review submit requires stance=null and need_next_round=null" }) }], isError: true };
  }

  // Validate stance/need_next consistency (§7)
  if (!blindReview) {
    const err = validateStanceConsistency(convergeMark.stance, convergeMark.need_next_round);
    if (err) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: err }) }], isError: true };
    }
  }

  return stateMutex.runExclusive(async () => {
    const state = await loadState();

    // Validate mandatory review scope (only required for requirements/planning per §11)
    if ((state.phase === "requirements" || state.phase === "planning") && !content.includes("## 本轮审阅范围")) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "missing required '## 本轮审阅范围' section" }) }], isError: true };
    }

    if (!isCurrentHolder(state, identity)) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `not your turn — current turn: ${state.turn}` }) }], isError: true };
    }

    // Cross-validate convergeMark vs template (§11 — all submits, warnings non-blocking)
    const cv = crossValidateConvergeMark(content, convergeMark);

    // Fix sub_phase: prohibit new P0
    const subPhase = state.sub_phase as string; // TypeScript narrowing workaround
    if (subPhase === "fix" && convergeMark.new_issues) {
      for (const issue of convergeMark.new_issues) {
        if (issue.type === "P0") {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "new P0 issues are not allowed during fix sub_phase; use resolve_issue to close existing P0s" }) }], isError: true };
        }
      }
    }

    // Proposer-can't-modify check: resolved_issue_ids must not include issues raised by current holder
    if (convergeMark.resolved_issue_ids && convergeMark.resolved_issue_ids.length > 0) {
      const raisedByMe = state.issues
        .filter((i) => convergeMark.resolved_issue_ids!.includes(i.id) && i.raised_by === identity && i.status === "open");
      if (raisedByMe.length > 0) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `issue #${raisedByMe[0].id} was raised by you; the other party must land the spec change` }) }], isError: true };
      }
    }

    // Process new issues
    const newIssueIds: number[] = [];
    if (convergeMark.new_issues && convergeMark.new_issues.length > 0) {
      for (const ni of convergeMark.new_issues) {
        const issueId = state.next_issue_id++;
        state.issues.push({
          id: issueId,
          type: ni.type,
          topic: ni.topic,
          description: ni.description,
          raised_by: identity,
          phase: state.phase,
          round: state.round,
          status: "open",
          positions: { [identity]: ni.my_position ?? "" },
          resolution: null,
          resolved_by: null,
          escalated_at: null,
          fix_review_cycles: 0,
          proposal: ni.proposal ?? null,
          rationale: ni.rationale ?? null,
        });
        newIssueIds.push(issueId);
      }
    }

    // Process resolved issues
    if (convergeMark.resolved_issue_ids) {
      for (const rid of convergeMark.resolved_issue_ids) {
        const issue = state.issues.find((i) => i.id === rid);
        if (issue && issue.status === "open") {
          issue.status = "resolved";
          issue.resolved_by = "converged";
          issue.resolution = `resolved in round ${state.round} by ${identity}`;
        }
      }
    }

    // Update issue stances
    if (convergeMark.issue_stances) {
      for (const [idStr, stance] of Object.entries(convergeMark.issue_stances)) {
        const issueId = parseInt(idStr);
        const issue = state.issues.find((i) => i.id === issueId);
        if (issue && issue.status === "open") {
          issue.positions[identity] = stance.argument ?? "";
        }
      }
    }

    // Update last_submit
    const now = new Date().toISOString();
    state.last_submit_per_turn[identity] = {
      round: state.round,
      sub_phase: state.sub_phase,
      commit_hash: commitHash,
      submitted_at: now,
      stance: convergeMark.stance ?? null,
      need_next_round: convergeMark.need_next_round ?? null,
      new_issues: newIssueIds,
    };
    state.history.push({ type: "submit", timestamp: now, details: { identity, round: state.round, new_issues: newIssueIds, resolved: convergeMark.resolved_issue_ids ?? [] } });

    // Determine if convergence is achieved
    let converged = false;
    const other = getOtherIdentity(state, identity);
    if (other) {
      const mySubmit = state.last_submit_per_turn[identity];
      const otherSubmit = state.last_submit_per_turn[other];
      if (blindReview) {
        // Blind review: both submitted, check new_issues
        if (otherSubmit.submitted_at) {
          const bothEmpty = mySubmit.new_issues.length === 0 && otherSubmit.new_issues.length === 0;
          state.blind_review_pending = false;
          if (bothEmpty) {
            // Don't set converged=true — advance required after blind review
          } else {
            state.turn = other;
            state.round += 1;
          }
        }
      } else if (state.phase === "implementation" && state.sub_phase !== "coding" && state.sub_phase !== "fix") {
        // IMPLEMENTATION convergence check
        if (otherSubmit.submitted_at && mySubmit.round === otherSubmit.round) {
          if (mySubmit.stance === "agree" && otherSubmit.stance === "agree" && mySubmit.need_next_round === false && otherSubmit.need_next_round === false) {
            const hasOpenP0 = state.issues.some((i) => i.type === "P0" && i.status === "open");
            const hasEscalated = state.issues.some((i) => i.status === "escalated");
            if (!hasOpenP0 && !hasEscalated) {
              converged = true;
              state.converged = true;
              state.blind_review_pending = true;
              state.pending_supervisor_review = state.peers.some((p) => p.identity === identity && p.role === "supervisor" && p.is_developer);
              if (!state.pending_supervisor_review) {
                // Auto-close P1/P2 on converge
                for (const issue of state.issues) {
                  if ((issue.type === "P1" || issue.type === "P2") && issue.status === "open") {
                    issue.status = "resolved";
                    issue.resolved_by = "converged";
                  }
                }
              }
            }
          } else if (mySubmit.stance && (mySubmit.stance !== "agree" || mySubmit.need_next_round === true)) {
            // Need another round — advance round and switch turn
            state.round += 1;
            state.turn = other;
            // Fix → review, coding → review
            if ((state.sub_phase as string) === "fix") {
              state.sub_phase = "review";
            }
          }
        }
      } else if (state.phase !== "implementation") {
        // Non-IMPLEMENTATION: turn alternates, convergence checked by supervisor
        if (otherSubmit.submitted_at) {
          state.round += 1;
          state.turn = other;
          // Supervisor checks convergence externally
          const bothEmpty = (mySubmit.new_issues?.length ?? 0) === 0 && (otherSubmit.new_issues?.length ?? 0) === 0;
          const hasOpenP0 = state.issues.some((i) => i.type === "P0" && i.status === "open");
          const hasEscalated = state.issues.some((i) => i.status === "escalated");
          if (bothEmpty && !hasOpenP0 && !hasEscalated) {
            converged = true;
            state.converged = true;
            // Set blind_review_pending for blind review
            state.blind_review_pending = true;
          }
        }
      } else {
        // Coding → review (unconditional)
        state.sub_phase = "review";
        state.turn = other;
      }
    }

    // Write handoff files
    const wfId = state.workflow_id ?? "unknown";

    // Journal: append issue creations (§6 authorial storage)
    if (convergeMark.new_issues && convergeMark.new_issues.length > 0) {
      const journalPath = join(HANDOFF_DIR, wfId, "issues-journal.jsonl");
      await mkdir(join(HANDOFF_DIR, wfId), { recursive: true });
      for (const ni of convergeMark.new_issues) {
        await appendFile(journalPath, JSON.stringify({ action: "create", timestamp: now, id: state.next_issue_id - convergeMark.new_issues.length + convergeMark.new_issues.indexOf(ni), type: ni.type, topic: ni.topic, raised_by: identity }) + "\n", "utf-8");
      }
    }
    if (blindReview) {
      const blindDir = join(HANDOFF_DIR, wfId, state.phase);
      await mkdir(blindDir, { recursive: true });
      const filename = `${identity}_blind_review.md`;
      await writeFile(join(blindDir, filename), content, "utf-8");
      await writeFile(join(blindDir, `${filename}.meta.json`), JSON.stringify({ stance: null, need_next_round: null, new_issues: newIssueIds, resolved_issue_ids: convergeMark.resolved_issue_ids ?? [] }, null, 2), "utf-8");
    } else {
      const phaseDir = join(HANDOFF_DIR, wfId, state.phase);
      await mkdir(phaseDir, { recursive: true });
      const seq = state.round;
      const filename = `r${seq}_${identity}.md`;
      await writeFile(join(phaseDir, filename), content, "utf-8");
      await writeFile(join(phaseDir, `r${seq}_${identity}.meta.json`), JSON.stringify({ stance: convergeMark.stance, need_next_round: convergeMark.need_next_round, new_issues: newIssueIds, resolved_issue_ids: convergeMark.resolved_issue_ids ?? [] }, null, 2), "utf-8");
    }

    // IMPLEMENTATION: fix → review instead of converge
    if (state.phase === "implementation" && !converged) {
      if (state.sub_phase === "coding") {
        state.sub_phase = "review";
      }
    }

    // Reset lease after submit
    state.current_lease = { token: null, holder: null, expires_at: null, grace_used: false };

    await saveState(state);
    await logEvent("submit", { identity, round: state.round, new_issues: newIssueIds, converged, blind_review: blindReview });

    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, converged, next_turn: state.turn, warnings: cv.warnings.length > 0 ? cv.warnings : undefined }) }],
    };
  });
}

function validateStanceConsistency(stance: Stance, needNext: boolean | null): string | null {
  if (stance === null || needNext === null) return null;
  if (stance === "agree" && needNext === true) return "agree requires need_next_round=false";
  if ((stance === "disagree" || stance === "require_clarification") && needNext === false) return `${stance} requires need_next_round=true`;
  return null;
}

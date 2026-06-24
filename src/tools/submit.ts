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
import { checkGraceSubmit, applyGraceSubmit, stopLeaseTimer } from "../lease.js";
import { err, ok } from "../response.js";

const MAX_CONTENT_BYTES = 500 * 1024; // 500KB
const HANDOFF_DIR = process.env.HANDOFF_DIR || "handoff";

export async function submit(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") {
    return err("identity required");
  }

  const content = args.content as string;
  const convergeMark = args.converge_mark as ConvergeMark;
  const commitHash = args.commit_hash as string;
  const blindReview = args.blind_review === true;

  // Validate content size
  const contentBytes = Buffer.byteLength(content, "utf-8");
  if (contentBytes > MAX_CONTENT_BYTES) {
    return err(`content exceeds 500KB limit (${contentBytes} bytes). Please split or reference external files.`);
  }

  // Validate commit_hash format
  if (!commitHash || !/^[a-f0-9]{7,40}$/i.test(commitHash)) {
    return err("invalid commit_hash format");
  }

  // Blind review: stance and need_next_round must be null
  if (blindReview && (convergeMark.stance !== null || convergeMark.need_next_round !== null)) {
    return err("blind_review submit requires stance=null and need_next_round=null");
  }

  // Validate stance/need_next consistency (§7)
  if (!blindReview) {
    const stanceErr = validateStanceConsistency(convergeMark.stance, convergeMark.need_next_round);
    if (stanceErr) {
      return err(stanceErr);
    }
  }

  return stateMutex.runExclusive(async () => {
    const state = await loadState();

    // Validate mandatory review scope (only required for requirements/planning per §11; exempt blind_review)
    if (!blindReview && (state.phase === "requirements" || state.phase === "planning") && !content.includes("## 本轮审阅范围")) {
      return err("missing required '## 本轮审阅范围' section");
    }

    // P0-15: developer self-review required for IMPLEMENTATION coding/fix
    if (!blindReview && state.phase === "implementation" && (state.sub_phase === "coding" || state.sub_phase === "fix") && !content.includes("## 开发者自审")) {
      return err("missing required '## 开发者自审' section — per P0-15, coding/fix submissions must include self-review evidence");
    }

    // P0-16: independent testing required for IMPLEMENTATION review
    if (!blindReview && state.phase === "implementation" && state.sub_phase === "review" && !content.includes("## 独立测试")) {
      return err("missing required '## 独立测试' section — per P0-16, review submissions must include independent test results");
    }

    // Grace: allow submit even if turn changed (lease timeout + grace period)
    let usedGrace = false;
    if (!isCurrentHolder(state, identity)) {
      const lt = args.lease_token as string | undefined;
      if (lt && checkGraceSubmit(state, lt, identity)) {
        await applyGraceSubmit(state, identity);
        usedGrace = true;
      } else {
        return err(`not your turn — current turn: ${state.turn}`);
      }
    }

    // Cross-validate convergeMark vs template (§11 — all submits, warnings non-blocking)
    const cv = crossValidateConvergeMark(content, convergeMark);

    // Fix sub_phase: prohibit new P0
    const subPhase = state.sub_phase as string; // TypeScript narrowing workaround
    if (subPhase === "fix" && convergeMark.new_issues) {
      for (const issue of convergeMark.new_issues) {
        if (issue.type === "P0") {
          return err("new P0 issues are not allowed during fix sub_phase; use resolve_issue to close existing P0s");
        }
      }
    }

    // Proposer-can't-modify check: resolved_issue_ids must not include issues raised by current holder
    if (convergeMark.resolved_issue_ids && convergeMark.resolved_issue_ids.length > 0) {
      const raisedByMe = state.issues
        .filter((i) => convergeMark.resolved_issue_ids!.includes(i.id) && i.raised_by === identity && i.status === "open");
      if (raisedByMe.length > 0) {
        return err(`issue #${raisedByMe[0].id} was raised by you; the other party must land the spec change`);
      }
    }

    // Process new issues
    const newIssueIds: number[] = [];
    if (convergeMark.new_issues && convergeMark.new_issues.length > 0) {
      for (const ni of convergeMark.new_issues) {
        const issueId = state.next_issue_id++;
        // P0-22: proposal/rationale 使用 topic+description，避免 null（markdown content 为权威来源）
        const derivedProposal = ni.topic + ": " + ni.description;
        state.issues.push({
          id: issueId,
          type: ni.type,
          topic: ni.topic,
          description: ni.description,
          raised_by: identity,
          phase: state.phase,
          round: state.round,
          status: "open",
          positions: { [identity]: "" },
          resolution: null,
          resolved_by: null,
          escalated_at: null,
          fix_review_cycles: 0,
          proposal: derivedProposal,
          rationale: derivedProposal,
          deferred_reason: null,
          deferred_since_phase: null,
          deferred_count: 0,
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
      sub_phase: blindReview ? "blind_review" : state.sub_phase,
      commit_hash: commitHash,
      submitted_at: now,
      stance: convergeMark.stance ?? null,
      need_next_round: convergeMark.need_next_round ?? null,
      new_issues: newIssueIds,
    };
    state.history.push({ type: "submit", timestamp: now, details: { identity, round: state.round, new_issues: newIssueIds, resolved: convergeMark.resolved_issue_ids ?? [] } });

    // Stalemate detection: increment fix_review_cycles for open P0s on review submits (§5.5)
    if (state.phase === "implementation" && state.sub_phase === "review") {
      for (const issue of state.issues) {
        if (issue.type === "P0" && issue.status === "open") {
          issue.fix_review_cycles += 1;
        }
      }
    }

    // Determine if convergence is achieved
    let converged = false;
    const other = getOtherIdentity(state, identity);
    if (other) {
      const mySubmit = state.last_submit_per_turn[identity];
      const otherSubmit = state.last_submit_per_turn[other];
      if (blindReview) {
        // Blind review: check if other party also submitted blind review (not regular submit)
        if (otherSubmit.sub_phase === "blind_review") {
          const bothEmpty = mySubmit.new_issues.length === 0 && otherSubmit.new_issues.length === 0;
          state.blind_review_pending = false;
          if (bothEmpty) {
            // P0-3: 盲审完成且无新问题 → 收敛成立（retro-3 #18）
            converged = true;
            state.converged = true;
          } else {
            state.turn = other;
            state.round += 1;
          }
        } else {
          // Other hasn't submitted blind review yet — switch turn so they can
          state.turn = other;
        }
      } else if (state.phase === "implementation" && state.sub_phase !== "coding" && state.sub_phase !== "fix") {
        // IMPLEMENTATION convergence check
        if (otherSubmit.submitted_at && mySubmit.round === otherSubmit.round) {
          // P0-1: IMPLEMENTATION 收敛仅依赖 review 方 stance（retro-3 #17）
          // coding 产出方 stance=null（非审阅），不参与收敛判定
          if (mySubmit.stance === "agree" && mySubmit.need_next_round === false) {
            const hasOpenP0 = state.issues.some((i) => i.type === "P0" && i.status === "open");
            const hasEscalated = state.issues.some((i) => i.status === "escalated");
            if (!hasOpenP0 && !hasEscalated) {
              // P0-3: 盲审改为收敛前置 — 先触发盲审，盲审完成后才设 converged=true（retro-3 #18）
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
          // P2 issues do not block non-IMPLEMENTATION convergence (retro-2 §3.3 #5)
          const myNewIds = new Set(mySubmit.new_issues ?? []);
          const otherNewIds = new Set(otherSubmit.new_issues ?? []);
          const allNewIds = new Set([...myNewIds, ...otherNewIds]);
          const hasNewP0P1 = state.issues.some((i) =>
            allNewIds.has(i.id) && (i.type === "P0" || i.type === "P1") && i.status === "open"
          );
          const hasOpenP0 = state.issues.some((i) => i.type === "P0" && i.status === "open");
          const hasEscalated = state.issues.some((i) => i.status === "escalated");
          if (!hasNewP0P1 && !hasOpenP0 && !hasEscalated) {
            // P0-3: 盲审改为收敛前置 — 先触发盲审，盲审完成后才设 converged=true（retro-3 #18）
            state.blind_review_pending = true;
          }
        } else {
          // Other hasn't submitted — switch turn so they can claim and review
          state.turn = other;
        }
      } else {
        // Coding → review (turn switch; sub_phase moved after file write)
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
      await writeFile(join(blindDir, `${filename}.meta.json`), JSON.stringify({ stance: null, need_next_round: null, task: state.task, new_issues: (convergeMark.new_issues ?? []).map((ni, i) => ({ id: newIssueIds[i], type: ni.type, topic: ni.topic, description: ni.description })), resolved_issue_ids: convergeMark.resolved_issue_ids ?? [] }, null, 2), "utf-8");
    } else {
      const phaseDir = join(HANDOFF_DIR, wfId, state.phase);
      await mkdir(phaseDir, { recursive: true });
      const seq = state.round;
      // P1-17: IMPLEMENTATION 文件名含 sub_phase（白名单防路径穿越）
      const VALID_SUB_PHASES = ["coding", "review", "fix", "blind_review"];
      const safeSub = VALID_SUB_PHASES.includes(state.sub_phase ?? "") ? state.sub_phase : null;
      const subTag = state.phase === "implementation" && safeSub ? `_${safeSub}` : "";
      const filename = `r${seq}${subTag}_${identity}.md`;
      await writeFile(join(phaseDir, filename), content, "utf-8");
      await writeFile(join(phaseDir, `r${seq}${subTag}_${identity}.meta.json`), JSON.stringify({ stance: convergeMark.stance, need_next_round: convergeMark.need_next_round, task: state.task, new_issues: (convergeMark.new_issues ?? []).map((ni, i) => ({ id: newIssueIds[i], type: ni.type, topic: ni.topic, description: ni.description })), resolved_issue_ids: convergeMark.resolved_issue_ids ?? [] }, null, 2), "utf-8");
    }

    // Coding → review transition: set sub_phase AFTER file write so filename gets correct sub_phase tag
    if (state.phase === "implementation" && !converged && !blindReview && state.sub_phase === "coding") {
      state.sub_phase = "review";
    }

    // Release turn to supervisor on converge to prevent non-supervisor busy loop (retro-2 §3.2 #6)
    if (converged && !state.blind_review_pending) {
      const supervisor = state.peers.find((p) => p.role === "supervisor");
      if (supervisor && state.turn !== supervisor.identity) {
        state.turn = supervisor.identity;
      }
    }

    // Reset lease after submit
    state.current_lease = { token: null, holder: null, expires_at: null, grace_used: false };
    stopLeaseTimer();

    await saveState(state);
    await logEvent("submit", { identity, round: state.round, new_issues: newIssueIds, converged, blind_review: blindReview, usedGrace });

    // Build checklist for the next party — server-initiated reminders, not dependent on AI memory
    const checklist: string[] = [];
    if (!blindReview) {
      checklist.push("检查对方 ## 文档更新确认 段：是否更新了相关文档？如缺失或敷衍，追问");
      if (state.phase === "implementation") {
        if (state.sub_phase === "coding" || state.sub_phase === "fix") {
          checklist.push("核查对方 ## 开发者自审：是否跑了端到端流程？检查关键步骤返回和测试结果");
        }
        if (state.sub_phase === "review") {
          checklist.push("核查对方 ## 独立测试：是否覆盖了端到端和对抗性场景？");
        }
      }
    }

    const next = state.blind_review_pending && !blindReview
      ? { tool: "claim_turn", when: "盲审待完成，claim_turn 进行独立盲审" } as const
      : { tool: "wait_for_turn", when: "等待对方 review" } as const;
    return ok({ ok: true, converged, next_turn: state.turn, checklist: checklist.length > 0 ? checklist : undefined, warnings: cv.warnings.length > 0 ? cv.warnings : undefined }, next);
  });
}

function validateStanceConsistency(stance: Stance, needNext: boolean | null): string | null {
  if (stance === null || needNext === null) return null;
  if (stance === "agree" && needNext === true) return "agree requires need_next_round=false";
  if ((stance === "disagree" || stance === "require_clarification") && needNext === false) return `${stance} requires need_next_round=true`;
  return null;
}

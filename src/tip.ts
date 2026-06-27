import { join } from "node:path";
import type { PairFlowState } from "./state.js";

const HANDOFF_DIR = process.env.HANDOFF_DIR || "handoff";
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

function safe(s: string | null | undefined): string {
  return (s && SAFE_ID.test(s)) ? s : "unknown";
}

export function buildTip(state: PairFlowState, identity: string): string {
  const taskPath = state.task?.spec_file ?? "任务文档";
  const wfId = safe(state.workflow_id);
  const phase = safe(state.phase);
  const ident = safe(identity);

  // P0-1: IMPLEMENTATION phase 文件名含 sub_phase 前缀，对齐 §3 目录结构
  const filePrefix = state.phase === "implementation" && state.sub_phase
    ? `r${state.round}_${state.sub_phase}_${ident}`
    : `r${state.round}_${ident}`;
  const outFile = join(HANDOFF_DIR, wfId, phase, `${filePrefix}.md`);

  const submitParams = "产出文档后请先 git commit，再调用 submit 接口，参数 file_path 为产出文件路径、git_commit_hash 为当前仓库 HEAD 的 commit hash";

  if (state.round === 1) {
    if (state.phase === "requirements") {
      return `请先读取任务文档 ${taskPath}，理解需求后进行需求分析。所有观点需注明提出人。产出文件路径: ${outFile}。${submitParams}`;
    }
    if (state.phase === "planning") {
      return `请先读取任务文档 ${taskPath}，根据需求分析产出实施计划，不需要拆分里程碑。所有观点需注明提出人。产出文件路径: ${outFile}。${submitParams}`;
    }
    if (state.phase === "implementation" && state.sub_phase === "coding") {
      return `请根据实施计划进行代码实现。实现后先自行 code review，修改至自己认为没有问题，再产出文档。产出文件路径: ${outFile}。${submitParams}`;
    }
    if (state.phase === "summary") {
      return `请产出一份阶段总结草稿（将由对方审阅后形成最终报告），包含本阶段的关键决策、遗留问题和后续建议。产出文件路径: ${outFile}。${submitParams}`;
    }
    return `[错误] 未知的阶段/子阶段组合: phase=${state.phase}, sub_phase=${state.sub_phase}, round=1。请联系开发者排查。`;
  }

  const other = state.peers.find((p) => p.identity !== identity);
  const otherSubmit = other ? state.last_submit_per_turn[other.identity] : null;
  const otherIdent = other ? safe(other.identity) : "unknown";

  // prevFile: 查 last_submit_per_turn 中对方记录的 file_path，无需反向推断命名规则
  const prevFile = otherSubmit?.file_path ?? null;
  const prevInfo = prevFile
    ? `${prevFile}（对方 commit: ${otherSubmit!.commit_hash}）`
    : "对方上一轮产出（commit hash 缺失）";

  if (state.phase === "requirements" || state.phase === "planning") {
    if (state.phase === "requirements") {
      return `请基于当前任务文档 ${taskPath}，审阅 ${prevInfo}。所有观点需注明提出人。双方均同意的点，请直接修改任务文档 ${taskPath}；不同意的点，请在产出文件中标注原因和建议。产出文件路径: ${outFile}。${submitParams}`;
    }
    // Find actual r1 submitter from last_submit_per_turn (not current peers)
    const r1Submitter = Object.entries(state.last_submit_per_turn)
      .find(([_, s]) => s.round === 1 && s.commit_hash)?.[0];
    const planDoc = r1Submitter ? join(HANDOFF_DIR, wfId, "planning", `r1_${safe(r1Submitter)}.md`) : "计划文档";
    return `请基于当前计划文档 ${planDoc}，审阅 ${prevInfo}。所有观点需注明提出人。双方均同意的点，请直接修改计划文档 ${planDoc}；不同意的点，请在产出文件中标注原因和建议。产出文件路径: ${outFile}。${submitParams}`;
  }

  const isSupervisor = state.peers.some((p) => p.identity === identity && p.role === "supervisor");
  const advanceHint = isSupervisor
    ? "。若审阅后确认当前阶段目标已达成，请调用 advance 接口进入下一阶段"
    : "";

  if (state.phase === "implementation" && state.sub_phase === "review") {
    const planFile = join(HANDOFF_DIR, wfId, "planning", `r1_${otherIdent}.md`);
    if (state.round > 2) {
      const myPrevReview = join(HANDOFF_DIR, wfId, phase, `r${state.round - 2}_review_${ident}.md`);
      return `请结合实施计划 ${planFile}、上一轮你的评审文档 ${myPrevReview}，审阅对方的代码产出 ${prevInfo}。检查是否按计划实现、上一轮问题是否已解决、代码正确性和风格。产出文件路径: ${outFile}。${submitParams}${advanceHint}`;
    }
    return `请结合实施计划 ${planFile}，审阅对方的代码产出 ${prevInfo}。检查是否按计划实现、代码正确性和风格。产出文件路径: ${outFile}。${submitParams}${advanceHint}`;
  }

  if (state.phase === "implementation" && state.sub_phase === "coding") {
    return `请根据上一轮的评审意见修改代码。修改后先自行 code review，确认问题已解决，再产出文档。产出文件路径: ${outFile}。${submitParams}`;
  }

  // P0-2 + P1-1: SUMMARY round ≥ 2 — r2 审阅草稿，r3+ 交替修订
  if (state.phase === "summary") {
    if (state.round === 2) {
      return `请审阅监督者的汇总草稿 ${prevInfo}，提出修改意见或补充遗漏。产出文件路径: ${outFile}。${submitParams}`;
    }
    return `请基于上一轮审阅意见修订汇总文档 ${prevInfo}。产出文件路径: ${outFile}。${submitParams}${advanceHint}`;
  }

  return `[错误] 未知的阶段/子阶段组合: phase=${state.phase}, sub_phase=${state.sub_phase}, round=${state.round}。请联系开发者排查。`;
}

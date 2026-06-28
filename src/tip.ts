import { join } from "node:path";
import type { PairFlowState } from "./state.js";

const HANDOFF_DIR = process.env.HANDOFF_DIR || "handoff";
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

function safe(s: string | null | undefined): string {
  return (s && SAFE_ID.test(s)) ? s : "unknown";
}

export function identityLabel(state: PairFlowState, identity: string): string {
  const peer = state.peers.find((p) => p.identity === identity);
  if (!peer) return `${safe(identity)}`;
  const roleLabel = peer.role === "supervisor" ? "supervisor" : (peer.is_developer ? "developer" : "reviewer");
  return `${safe(identity)}(${roleLabel})`;
}

function outFile(state: PairFlowState, identity: string): string {
  const wfId = safe(state.workflow_id);
  const phase = safe(state.phase);
  const ident = safe(identity);
  const filePrefix = state.phase === "implementation" && state.sub_phase
    ? `r${state.round}_${state.sub_phase}_${ident}`
    : `r${state.round}_${ident}`;
  // P7: 统一使用 POSIX 正斜杠
  return join(HANDOFF_DIR, wfId, phase, `${filePrefix}.md`).replace(/\\/g, "/");
}

function getAction(state: PairFlowState, identity: string): string {
  const taskPath = (state.task?.spec_file ?? "任务文档").replace(/\\/g, "/");
  const other = state.peers.find((p) => p.identity !== identity);
  const otherSubmit = other ? state.last_submit_per_turn[other.identity] : null;
  const otherIdent = other ? safe(other.identity) : "unknown";

  const prevFile = otherSubmit?.file_path ?? null;
  const prevInfo = prevFile
    ? `${prevFile.replace(/\\/g, "/")}（对方 commit: ${otherSubmit!.commit_hash}）`
    : "对方上一轮产出";

  if (state.round === 1) {
    if (state.phase === "requirements") {
      return `读取任务文档 ${taskPath}，进行需求分析。所有观点需注明提出人`;
    }
    if (state.phase === "planning") {
      return `读取任务文档 ${taskPath}，根据需求分析产出实施计划，不需要拆分里程碑。所有观点需注明提出人`;
    }
    if (state.phase === "implementation" && state.sub_phase === "coding") {
      return `根据实施计划进行代码实现。实现后先自行 code review，修改至自己认为没有问题，再产出文档`;
    }
    if (state.phase === "summary") {
      return `产出一份阶段总结草稿（将由对方审阅后形成最终报告），包含本阶段的关键决策、遗留问题和后续建议`;
    }
    return `未知的阶段/子阶段组合: phase=${state.phase}, sub_phase=${state.sub_phase}, round=1`;
  }

  if (state.phase === "requirements" || state.phase === "planning") {
    if (state.phase === "requirements") {
      return `基于任务文档 ${taskPath}，审阅 ${prevInfo}。所有观点需注明提出人。双方均同意的点直接修改任务文档；不同意的点在产出文件中标注原因和建议`;
    }
    const r1Submitter = Object.entries(state.last_submit_per_turn)
      .find(([_, s]) => s.round === 1 && s.commit_hash)?.[0];
    const planDoc = r1Submitter
      ? join(HANDOFF_DIR, safe(state.workflow_id), "planning", `r1_${safe(r1Submitter)}.md`).replace(/\\/g, "/")
      : "计划文档";
    return `基于计划文档 ${planDoc}，审阅 ${prevInfo}。所有观点需注明提出人。双方均同意的点直接修改计划文档；不同意的点在产出文件中标注原因和建议`;
  }

  const isSupervisor = state.peers.some((p) => p.identity === identity && p.role === "supervisor");
  const advanceHint = isSupervisor
    ? "。若审阅后确认当前阶段目标已达成，调用 advance 进入下一阶段"
    : "";

  if (state.phase === "implementation" && state.sub_phase === "review") {
    const planFile = join(HANDOFF_DIR, safe(state.workflow_id), "planning", `r1_${otherIdent}.md`).replace(/\\/g, "/");
    if (state.round > 2) {
      const myPrevReview = join(HANDOFF_DIR, safe(state.workflow_id), safe(state.phase), `r${state.round - 2}_review_${safe(identity)}.md`).replace(/\\/g, "/");
      return `结合实施计划 ${planFile}、上一轮你的评审文档 ${myPrevReview}，审阅对方的代码产出 ${prevInfo}。检查是否按计划实现、上一轮问题是否已解决、代码正确性和风格${advanceHint}`;
    }
    return `结合实施计划 ${planFile}，审阅对方的代码产出 ${prevInfo}。检查是否按计划实现、代码正确性和风格${advanceHint}`;
  }

  if (state.phase === "implementation" && state.sub_phase === "coding") {
    return `根据上一轮的评审意见修改代码。修改后先自行 code review，确认问题已解决，再产出文档`;
  }

  if (state.phase === "summary") {
    if (state.round === 2) {
      return `审阅监督者的汇总草稿 ${prevInfo}，提出修改意见或补充遗漏`;
    }
    return `基于上一轮审阅意见修订汇总文档 ${prevInfo}${advanceHint}`;
  }

  return `未知的阶段/子阶段组合: phase=${state.phase}, sub_phase=${state.sub_phase}, round=${state.round}`;
}

function phaseLabel(phase: string, subPhase: string | null): string {
  if (phase === "implementation") return subPhase === "review" ? "代码评审" : "代码实现";
  if (phase === "requirements") return "需求分析";
  if (phase === "planning") return "实施计划";
  if (phase === "summary") return "汇总";
  return phase;
}

export function buildTip(state: PairFlowState, identity: string): string {
  const action = getAction(state, identity);
  const file = outFile(state, identity);
  const label = identityLabel(state, identity);
  const phaseText = phaseLabel(safe(state.phase), state.sub_phase);

  const turnOwner = state.turn === identity
    ? "轮到你了"
    : `轮到 ${safe(state.turn)} 了`;

  return `[行动] ${action}

[产出] 完成后 git commit，调用 submit，file_path = ${file}

[当前] 你是 ${label}。当前是第 ${state.round} 轮${phaseText}，${turnOwner}。`;
}

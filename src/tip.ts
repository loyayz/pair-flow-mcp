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

  if (state.phase === "idle") {
    const isSup = state.peers.some((p) => p.identity === identity && p.role === "supervisor");
    if (isSup) return "双方已就位。作为监督者，调用 advance 开始工作流";
    return "等待监督者调用 advance 开始工作流";
  }

  if (state.round === 1) {
    if (state.phase === "requirements") {
      return `深度需求分析。对以下每个维度不满足于第一反应，追问自己至少一次"为什么"或"那意味着什么"，触及底层逻辑后再记录结论：

1. 目标与范围 — 核心问题是什么？给出你的判断并定义边界（做/不做）
2. 干系人与场景 — 谁会用到？给出你的干系人画像和主场景描述
3. 功能需求 — 需要哪些核心功能？给出你的功能清单并按优先级排序
4. 非功能约束 — 有哪些质量要求？给出你对性能/安全/兼容性的判断
5. 假设与风险 — 哪些判断未经证实？标注为"假设"并给出你的风险预估
6. 歧义与待澄清 — 哪里模糊不清？列出你的疑问和临时替代方案

所有观点需注明提出人。`;
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

  const isSupervisor = state.peers.some((p) => p.identity === identity && p.role === "supervisor");

  // 监督者 advance 目标（按阶段定制）
  let advanceTarget = "";
  if (isSupervisor) {
    if (state.phase === "requirements") advanceTarget = "进入实施计划阶段";
    else if (state.phase === "planning") advanceTarget = "进入代码实现阶段";
    else if (state.phase === "implementation") advanceTarget = "进入汇总阶段";
    else if (state.phase === "summary") advanceTarget = "结束工作流";
  }
  const advancePrefix = advanceTarget
    ? `作为监督者，若确认目标已达成可直接调用 advance（${advanceTarget}），无需 submit。否则：`
    : "";

  if (state.phase === "requirements") {
    if (state.round === 2) {
      return `先基于任务文档 ${taskPath} 产出你的独立需求分析，再对照审阅 ${prevInfo}：

1. 目标与范围 — 你对核心问题和边界的判断？与对方对比，一致则确认，有遗漏则补充，不同则标注差异和理由
2. 干系人与场景 — 你眼中的干系人画像和主场景？补充对方遗漏的，质疑对方过度假设的
3. 功能需求 — 你的功能清单和优先级？找出对方遗漏的功能、高估/低估的优先级
4. 非功能约束 — 你对性能/安全/兼容性的判断？检查对方是否忽略了关键约束
5. 假设与风险 — 你识别出的假设和风险？对照对方标注，发现未标注假设或遗漏风险
6. 歧义与待澄清 — 你看到的模糊点？合并双方问题列表

每项先记录你的独立判断再对比，不跳过思考直接附和。双方同意的确认/补充到任务文档，分歧标注原因。所有观点需注明提出人`;
    }
    return `${advancePrefix}基于任务文档 ${taskPath} 和前几轮分析，审阅 ${prevInfo}。所有观点需注明提出人。双方同意的确认/补充到任务文档，分歧标注原因和建议`;
  }

  if (state.phase === "planning") {
    const r1Submitter = Object.entries(state.last_submit_per_turn)
      .find(([_, s]) => s.round === 1 && s.commit_hash)?.[0];
    const planDoc = r1Submitter
      ? join(HANDOFF_DIR, safe(state.workflow_id), "planning", `r1_${safe(r1Submitter)}.md`).replace(/\\/g, "/")
      : "计划文档";
    return `${advancePrefix}基于计划文档 ${planDoc}，审阅 ${prevInfo}。所有观点需注明提出人。双方均同意的点直接修改计划文档；不同意的点在产出文件中标注原因和建议`;
  }

  if (state.phase === "implementation" && state.sub_phase === "review") {
    const planFile = join(HANDOFF_DIR, safe(state.workflow_id), "planning", `r1_${otherIdent}.md`).replace(/\\/g, "/");
    if (state.round > 2) {
      const myPrevReview = join(HANDOFF_DIR, safe(state.workflow_id), safe(state.phase), `r${state.round - 2}_review_${safe(identity)}.md`).replace(/\\/g, "/");
      return `${advancePrefix}结合实施计划 ${planFile}、上一轮你的评审文档 ${myPrevReview}，审阅对方的代码产出 ${prevInfo}。检查是否按计划实现、上一轮问题是否已解决、代码正确性和风格`;
    }
    return `${advancePrefix}结合实施计划 ${planFile}，审阅对方的代码产出 ${prevInfo}。检查是否按计划实现、代码正确性和风格`;
  }

  if (state.phase === "implementation" && state.sub_phase === "coding") {
    return `根据上一轮的评审意见修改代码。修改后先自行 code review，确认问题已解决，再产出文档`;
  }

  if (state.phase === "summary") {
    if (state.round === 2) {
      return `审阅监督者的汇总草稿 ${prevInfo}，提出修改意见或补充遗漏`;
    }
    return `${advancePrefix}基于上一轮审阅意见修订汇总文档 ${prevInfo}`;
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

  const productLine = state.phase === "idle"
    ? ""
    : `\n[产出] 完成后 git commit，调用 submit，file_path = ${file}\n`;

  return `[行动] ${action}
${productLine}
[当前] 你是 ${label}。当前是第 ${state.round} 轮${phaseText}，${turnOwner}。`;
}

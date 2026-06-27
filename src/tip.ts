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
  const outFile = join(HANDOFF_DIR, wfId, phase, `r${state.round}_${ident}.md`);
  const submitParams = "参数 file_path 为产出文件路径、git_commit_hash 为当前仓库 HEAD 的 commit hash";

  if (state.round === 1) {
    if (state.phase === "requirements") {
      return `请先读取任务文档 ${taskPath}，理解需求后进行需求分析。所有观点需注明提出人。产出文件路径: ${outFile}，完成后调用 submit 接口，${submitParams}`;
    }
    return `请先读取任务文档 ${taskPath}，理解需求后进行需求分析。产出文件路径: ${outFile}，完成后调用 submit 接口，${submitParams}`;
  }

  const other = state.peers.find((p) => p.identity !== identity);
  const otherSubmit = other ? state.last_submit_per_turn[other.identity] : null;
  const otherIdent = other ? safe(other.identity) : "unknown";
  const prevFile = otherSubmit?.commit_hash
    ? join(HANDOFF_DIR, wfId, phase, `r${state.round - 1}_${otherIdent}.md`)
    : null;
  const prevInfo = prevFile
    ? `${prevFile}（对方 commit: ${otherSubmit!.commit_hash}）`
    : "对方上一轮产出（commit hash 缺失）";

  if (state.phase === "requirements") {
    return `请基于当前任务文档 ${taskPath}，审阅 ${prevInfo}。所有观点需注明提出人。双方均同意的点，请直接修改任务文档 ${taskPath}；不同意的点，请在产出文件中标注原因和建议。产出文件路径: ${outFile}，完成后调用 submit 接口，${submitParams}`;
  }

  const isSupervisor = state.peers.some((p) => p.identity === identity && p.role === "supervisor");
  const advanceHint = isSupervisor
    ? "。若审阅后确认当前任务文档已覆盖所有关键需求、不能存在双方同意延后的未决议题，请调用 advance 接口进入下一阶段"
    : "";

  return `请审阅 ${prevInfo}，确认或提出修改意见后，产出文件路径: ${outFile}，完成后调用 submit 接口，${submitParams}${advanceHint}`;
}

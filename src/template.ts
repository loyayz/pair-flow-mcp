import type { PairFlowState } from "./state.js";

// ── §11 rules_catalog 框架 ──

export interface RuleEntry {
  id: string;
  description: string;
  applicable_phases: string[];
  applicable_sub_phases?: string[];
  trigger: string;
  spec_ref: string;
  type: "structural" | "behavioral";
}

export const rulesCatalog: RuleEntry[] = [
  { id: "R001", description: "强制审阅范围声明——每轮 submit 必须包含'## 本轮审阅范围'段落", applicable_phases: ["requirements","planning"], trigger: "submit", spec_ref: "§5.3", type: "structural" },
  { id: "R002", description: "disagree 必须配替代方案+理由，不能单纯否定", applicable_phases: ["requirements","planning","implementation"], trigger: "submit", spec_ref: "§5.3", type: "behavioral" },
  { id: "R003", description: "提出者不修改自己提的问题——问题须由对方执行修改", applicable_phases: ["requirements","planning","implementation"], trigger: "submit", spec_ref: "§5.3", type: "behavioral" },
  { id: "R013", description: "提交前确认已获取 turn 并持有有效 lease_token", applicable_phases: ["requirements","planning","implementation","summary"], trigger: "turn", spec_ref: "§9", type: "behavioral" },
  { id: "R014", description: "每轮提交需带 git commit_hash（基于版本，非产出版本）", applicable_phases: ["requirements","planning","implementation","summary"], trigger: "submit", spec_ref: "§10", type: "behavioral" },
  { id: "R004", description: "P0/P1 issue 必须包含方案建议+理由（proposal+rationale）", applicable_phases: ["requirements","planning","implementation","summary"], trigger: "create_issue", spec_ref: "§6", type: "behavioral" },
  { id: "R005", description: "fix sub_phase 禁止创建 P0 issue", applicable_phases: ["implementation"], applicable_sub_phases: ["fix"], trigger: "create_issue", spec_ref: "§5.5", type: "structural" },
  { id: "R006", description: "advance 前置：所有 spec 修改须经对方确认", applicable_phases: ["requirements","planning","implementation","summary"], trigger: "advance", spec_ref: "§5.3", type: "behavioral" },
  { id: "R007", description: "监督者全面通读义务——advance 前提交全面通读清单", applicable_phases: ["requirements","planning","implementation","summary"], trigger: "advance", spec_ref: "§5.3", type: "behavioral" },
  { id: "R008", description: "独立盲审——收敛后双方各自独立通读 spec 全文", applicable_phases: ["requirements","planning","implementation","summary"], trigger: "advance", spec_ref: "§5.3", type: "behavioral" },
  { id: "R009", description: "计划阶段 r1 必须包含'## 实施里程碑'段落含循环总数声明", applicable_phases: ["planning"], trigger: "submit", spec_ref: "§11", type: "structural" },
  { id: "R010", description: "IMPLEMENTATION 收敛需双方同 round stance=agree + need_next_round=false", applicable_phases: ["implementation"], trigger: "submit", spec_ref: "§7", type: "behavioral" },
  { id: "R011", description: "SUMMARY 收敛仅依赖 new_issues 为空，不依赖 stance/need_next", applicable_phases: ["summary"], trigger: "submit", spec_ref: "§7", type: "behavioral" },
  { id: "R012", description: "盲审 submit stance/need_next 必须为 null——盲审是发现导向", applicable_phases: ["requirements","planning","implementation","summary"], trigger: "submit", spec_ref: "§5.3", type: "structural" },
];

// ── Template variants (§11 table) ──

export interface PhaseTemplate {
  phase: string;
  sub_phase: string | null;
  structural_rules: string[];
}

function taskSection(state: PairFlowState): string {
  if (!state.task) return "";
  let s = `## 任务\n- 描述：${state.task.description}`;
  if (state.task.spec_file) s += `\n- 目标文档：${state.task.spec_file}`;
  if (state.task.goals?.length) s += `\n- 阶段目标：${state.task.goals.join("；")}`;
  if (state.task.context) s += `\n- 附加上下文：${state.task.context}`;
  return s + "\n\n---\n\n";
}

export function getTemplate(state: PairFlowState): string {
  const phase = state.phase;
  const sub = state.sub_phase;

  if (phase === "idle") return "IDLE 阶段：等待双方 register。";

  const isPlanningR1 = phase === "planning" && state.round === 1;
  const isImplementationCoding = phase === "implementation" && sub === "coding";
  const isImplementationFix = phase === "implementation" && sub === "fix";
  const isImplementationReview = phase === "implementation" && sub === "review";
  const isBlindReview = sub === "blind_review";

  if (isBlindReview) {
    return `## 独立盲审\n\n逐节审视 spec 全文，不读对方盲审产出。\n\n| § | 节名 | 审视结论 | 理由 |\n|---|---|---|---|\n| 1 | ... | 无新问题 / 发现 Px-N | <依据> |\n\n## 收敛状态\n- 本轮新增 issue：P0：<N>，P1：<N>，P2：<N>\n- 本轮关闭 issue：<IDs>\n- 对对方上一轮产出的立场：null（盲审为发现导向）\n- 是否需要下一轮：null`;
  }

  if (phase === "requirements" || phase === "planning") {
    let tmpl = taskSection(state) + `## 本轮审阅范围\n- 重新通读了以下章节：<列出>\n- 本次修改涉及的章节：<列出>\n- 未重新审阅的章节：<列出 + 原因>\n\n---\n\n`;
    if (isPlanningR1) {
      tmpl += `## 实施里程碑\n- 循环总数: <N>\n- 里程碑 0: <描述>\n- 里程碑 1: <描述>\n...\n\n`;
    }
    tmpl += `## 收敛状态\n- 本轮新增 issue：P0：<N>，P1：<N>，P2：<N>\n- 本轮关闭 issue：<IDs>\n- 对对方上一轮产出的立场：<agree/disagree/require_clarification 或 null>\n- 是否需要下一轮：<yes/no 或 null>`;
    return tmpl;
  }

  if (isImplementationCoding) {
    return taskSection(state) + `## 实现\n\n<代码实现描述>\n\n## 开发者自审\n- 启动 server 并以双方身份走完整流程：register → advance → claim_turn → submit×2 → converge → blind_review → advance\n- 确认无阻塞性错误\n- 关键步骤返回：<register 结果> | <submit 结果> | <converge 状态>\n- 测试结果：<vitest / 端到端>\n\n## 收敛状态\n- 本轮新增 issue：P0：<N>，P1：<N>，P2：<N>\n- 本轮关闭 issue：<IDs>\n- 对对方上一轮产出的立场：null（产出方）\n- 是否需要下一轮：null`;
  }

  if (isImplementationFix) {
    return `## 修复\n\n<修复内容描述>\n\n## 收敛状态\n- 本轮新增 issue：P0：<N>，P1：<N>，P2：<N>\n- 本轮关闭 issue：<IDs>\n- 对对方上一轮产出的立场：null（产出方）\n- 是否需要下一轮：null`;
  }

  if (isImplementationReview) {
    return `## 审查\n\n<code review findings>\n\n## 独立测试\n- 端到端场景（开发者测试套件未覆盖的跨工具/跨轮/跨 phase 完整路径）：<场景 + 结果>\n- 对抗性场景（并发冲突 / 异常输入 / 超时边界 / 状态冲突 中至少选 1）：<场景 + 结果>\n\n## 收敛状态\n- stance: <agree/disagree/require_clarification>\n- need_next_round: <true/false>\n- 对对方上一轮产出的立场：<stance>\n- 本轮新增 issue：P0：<N>，P1：<N>，P2：<N>\n- 本轮关闭 issue：<IDs>`;
  }

  if (phase === "summary") {
    return `## 总结报告\n\n<summary>\n\n## 收敛状态\n- 本轮新增 issue：P0：<N>，P1：<N>，P2：<N>\n- 本轮关闭 issue：<IDs>\n- 对对方上一轮产出的立场：<agree/disagree/null>\n- 是否需要下一轮：null`;
  }

  return "";
}

export function getRulesSummary(state: PairFlowState, operation: "turn" | "advance"): string[] {
  const phase = state.phase;
  const sub = state.sub_phase ?? undefined;
  // "turn" → include submit rules (preparing to submit needs to know submit constraints)
  // "advance" → include advance rules
  const triggers = operation === "turn" ? ["turn", "submit"] : [operation];

  return rulesCatalog
    .filter((r) => r.type === "behavioral" && r.applicable_phases.includes(phase) && (!r.applicable_sub_phases || (sub && r.applicable_sub_phases.includes(sub))) && triggers.includes(r.trigger))
    .map((r) => `[${r.id}] ${r.description} (${r.spec_ref})`);
}

// ── §11 converge_mark 交叉校验 ──

export function crossValidateConvergeMark(content: string, convergeMark: { new_issues?: unknown[]; resolved_issue_ids?: number[]; stance?: string | null; need_next_round?: boolean | null }): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];

  // Parse "## 收敛状态" section
  const anchorMatch = content.match(/^##\s*收敛状态\s*$/im);
  if (!anchorMatch) {
    // Only warn for phases that require it; caller decides
    return { valid: true, warnings: [] };
  }

  const sectionStart = anchorMatch.index! + anchorMatch[0].length;
  const nextHeader = content.slice(sectionStart).match(/^##\s/m);
  const section = nextHeader ? content.slice(sectionStart, sectionStart + nextHeader.index!) : content.slice(sectionStart);

  // Parse issue counts
  const countMatch = section.match(/P0\s*[：:]\s*(\d+).*?P1\s*[：:]\s*(\d+).*?P2\s*[：:]\s*(\d+)/i);
  if (countMatch) {
    const p0 = parseInt(countMatch[1]),
      p1 = parseInt(countMatch[2]),
      p2 = parseInt(countMatch[3]);
    const jsonCount = (convergeMark.new_issues ?? []).length;
    if (p0 + p1 + p2 !== jsonCount) {
      warnings.push(`Cross-validation: template count (${p0 + p1 + p2}) ≠ JSON new_issues length (${jsonCount})`);
    }
  }

  // Parse resolved IDs
  const resolvedMatch = section.match(/本轮关闭\s*issue\s*[：:]\s*([\d,\s]*)/i);
  if (resolvedMatch) {
    const resolved = resolvedMatch[1].trim() ? resolvedMatch[1].split(/[,\s]+/).filter(Boolean).map(Number) : [];
    const jsonResolved = convergeMark.resolved_issue_ids ?? [];
    if (resolved.length !== jsonResolved.length) {
      warnings.push(`Cross-validation: template resolved (${resolved}) ≠ JSON resolved_issue_ids (${jsonResolved})`);
    }
  }

  return { valid: true, warnings };
}

# 2_review2_codebuddy.md — Phase 2 fix review（round 2）

> identity: codebuddy（评审者，is_developer=false）
> phase: implementation | dev_phase: 2 | sub_phase: review | round: 2
> bootstrap 阶段：手动归档
> commit_hash: 94eb03e（本轮 submit 所基于的仓库 HEAD）

## 本轮审阅范围

- 重新通读了以下文件：`src/template.ts`（P0-9 模板引擎全量）、`src/tools/claim-turn.ts`（template+rules_summary 返回）、`src/tools/issue-tools.ts`（journal + P1-69）、`src/tools/get-state.ts`（P1-67 escalation_recommended）、`src/tools/archive-tools.ts`（P1-66 force_converge + P1-70 workflow_id）、`src/tools/submit.ts`（P1-71 + crossValidate 调用 + journal）
- 本次修改涉及的章节：无（review 轮不改代码）
- 未重新审阅的章节：Phase 0/1 已审查文件

---

## 一、P0-9 模板引擎验证 ✅

### rules_catalog（12 条规则）✅

template.ts line 15-28：12 条 RuleEntry，每条含 id/description/applicable_phases/trigger/spec_ref/type。覆盖 §5.3/§6/§5.5/§7/§11 关键规则。

**P1-72: catalog 覆盖率校验 lint 脚本未实现**

§11 要求"编码时提供 lint 脚本校验 spec_ref 有效性 + catalog 覆盖率"。template.ts 定义了 catalog 但无 lint 脚本。不阻塞 Phase 2（lint 是开发工具非运行时），defer Phase 3。

### getTemplate（per phase/sub_phase）✅

template.ts line 38-80：覆盖 idle/requirements/planning（含 r1 实施里程碑）/implementation coding/fix/review/summary/blind_review。模板含审阅范围段落+收敛状态段落+实施里程碑段落。与 §11 模板变体表一致。

### getRulesSummary ✅

template.ts line 82-90：按 phase + sub_phase + trigger 过滤 behavioral 规则。返回 `[R-id] description (spec_ref)` 格式。

**P1-73: getRulesSummary trigger 逻辑有缺陷**

line 85: `const trigger = operation === "advance" ? "claim_turn" : "claim_turn"`——无论 turn 还是 advance，trigger 都是 "claim_turn"。三元表达式两分支相同，等价于 `const trigger = "claim_turn"`。

§11 规约分发机制要求"按当前 phase + sub_phase + **即将执行的操作**（turn/advance）从 rules_catalog 过滤"。advance 应返回 advance 相关规则（如 R006 advance 前置、R007 全面通读、R008 盲审），turn 应返回 turn 相关规则。当前两者返回相同规则集——advance 专属规则（R006/R007/R008 trigger 标为 "claim_turn"）在 turn 时也返回，可能信息过载。

不阻塞（规则仍然相关），但不符合 §11 "按操作过滤"的设计意图。

### crossValidateConvergeMark ✅ 框架完整，但调用有 bug（P0-10）

template.ts line 94-131：解析 "## 收敛状态" 锚点 + 正则匹配 P0/P1/P2 计数 + resolved IDs + 与 JSON 比对。框架完整。

**但 submit.ts 调用方式有严重 bug（P0-10，见下文）。**

### claim_turn 返回 template + rules_summary ✅

claim-turn.ts line 50-54：handleTurn 返回含 `template: getTemplate(state)` + `rules_summary: getRulesSummary(state, "turn")`。

**P0-9 关闭。** 模板引擎核心功能完整（catalog + template + rules_summary + crossValidate 框架）。P1-72（lint）/P1-73（trigger 过滤）为次要问题。

---

## 二、P0 问题（新发现，阻塞）

### P0-10: submit.ts 交叉校验只在 blindReview 时调用 + warnings 导致 early return 吞掉 submit

**定位**：`src/tools/submit.ts` line 66-69

**问题**：

```ts
// Blind review: cross-validate and set up
if (blindReview) {
  const cv = crossValidateConvergeMark(content, convergeMark);
  if (cv.warnings.length > 0) return { content: [{ type: "text", text: JSON.stringify({ ok: true, warnings: cv.warnings }) }] };
}
```

两个严重缺陷：

1. **交叉校验仅在 blindReview 时执行**——§11 规定交叉校验对所有 submit 适用（"converge_mark JSON 为权威来源... 模板计数不匹配发出 warning 不拒绝"）。正常 submit（非盲审）不校验，模板与 JSON 不一致无法发现。

2. **warnings 导致 early return**——`if (cv.warnings.length > 0) return {...}` 直接返回，**submit 未被处理**（无 state 更新、无 handoff 落盘、无 turn 切换）。盲审 submit 如果模板计数与 JSON 不一致（这正是交叉校验要发现的常见错误），submit 被静默丢弃。AI 收到 `{ ok: true, warnings: [...] }` 以为提交成功，但实际什么都没发生。

§11 明确"warning 不拒绝"——交叉校验发现不一致应返回 warning 但**继续处理 submit**。

**影响**：盲审 submit 在有 warnings 时数据丢失。正常 submit 完全跳过交叉校验。

**修复**：
```ts
// 所有 submit 都执行交叉校验（§11）
const cv = crossValidateConvergeMark(content, convergeMark);
// warnings 不拒绝，附加到返回结果
// ... 正常处理 submit ...
return { content: [{ type: "text", text: JSON.stringify({ ok: true, converged, next_turn: state.turn, warnings: cv.warnings }) }] };
```

---

## 三、P1 修复验证

### P1-65: Issue 工具 journal ⚠️ 部分修复

| 工具 | journal 写入 | 状态 |
|---|---|---|
| create_issue | ✅ line 47-48 | ✅ |
| resolve_issue | ✅ line 78-79 | ✅ |
| escalate | ❌ 无 journal 写入 | ⚠️ |
| submit（new_issues） | ✅ line 227-232 | ✅ |

escalate 未写 journal——§6 要求"工具变更日志（create/resolve/**escalate**）"。escalate 改变 issue status（open→escalated），是工具变更，应持久化到 journal。

**P1-65 部分关闭。escalate journal 待修复。**

### P1-66: force_converge 循环作用域 ✅

archive-tools.ts line 116-127：IMPLEMENTATION 分支——`dev_phase += 1` + `round = 1` + `sub_phase = "coding"` + 重置 `last_submit_per_turn`。注释承认"未检查剩余循环数"（P1-58 仍 deferred），但基本循环作用域已实现。

**P1-66 关闭。** P1-58（从计划草案正则提取循环总数）defer Phase 3。

### P1-67: get_state escalation_recommended ✅

get-state.ts line 6-8：计算 `escalatedIds`（status=escalated）+ `fixLoopIds`（fix_review_cycles≥2 且 open）。返回 `escalation_recommended: { issue_ids: [...] }`。

**P1-67 关闭。**

### P1-69: resolve_issue phase≠idle + P1/P2 resolved_by ✅

issue-tools.ts line 68：`if (state.phase === "idle") return err(...)`。line 75：`issue.resolved_by = issue.type === "P0" ? "supervisor_override" : "converged"`。

**P1-69 关闭。**

### P1-70: get_archived_files workflow_id ✅

archive-tools.ts line 19-20：`const suppliedId = args.workflow_id; const wfId = suppliedId ? validatePathSegment(suppliedId) : state.workflow_id`。

**P1-70 关闭。**

### P1-71: 盲审收敛条件简化 ✅

submit.ts line 160：`if (otherSubmit.submitted_at)`——简化为仅检查对方是否提交。

**P1-71 关闭。**

---

## 四、Defer 确认

| issue | claude fix 声称 | 我的确认 |
|---|---|---|
| P1-58（多循环正则提取） | defer Phase 3 | ✅ 同意——需从计划草案提取，Phase 3 可完善 |
| P1-68（工具行为测试） | defer Phase 3 | ⚠️ 二次 defer——Phase 2 计划明确要求，但测试基础设施确实依赖 server。Phase 3 必须补充 |
| P1-59（escalation_recommended） | 已由 P1-67 覆盖 | ✅ get_state 已实现 |

---

## 五、独立验证

| 项目 | 结果 |
|---|---|
| vitest | 14/14 pass（无新增测试——P1-68 再次 defer）|
| tsc | 隐含通过 |
| template.ts | 8.11 KB，12 规则 + 7 模板变体 + 交叉校验 ✅ |
| claim_turn 返回 | template + rules_summary ✅ |

---

## 六、review 立场

**stance**: `disagree`

**need_next_round**: `true`

**理由**：1 个新 P0（P0-10）+ 1 个 P1 部分修复（P1-65 escalate journal）：

1. **P0-10**: 交叉校验仅在 blindReview 时调用 + warnings 导致 early return 吞掉 submit——盲审 submit 有 warnings 时数据丢失，正常 submit 完全跳过校验。这是 P0-9 模板引擎实现的调用缺陷。
2. P1-65: escalate 未写 journal——部分修复

**fix 轮要求**：
1. P0-10: 交叉校验移到所有 submit 路径（非仅 blindReview）+ warnings 不 early return（附加到返回结果，继续处理 submit）
2. P1-65: escalate 增加 journal 写入

---

## 七、issue 汇总

| ID | 级别 | 主题 | 状态 |
|---|---|---|---|
| P0-9 | P0 | §11 模板引擎 | ✅ 关闭 |
| P0-10 | P0 | 交叉校验调用缺陷 + warnings early return | open |
| P1-65 | P1 | Issue 工具 journal | ⚠️ 部分关闭（escalate 缺 journal） |
| P1-66 | P1 | force_converge 循环作用域 | ✅ 关闭 |
| P1-67 | P1 | escalate 通知监督者 | ✅ 关闭 |
| P1-69 | P1 | resolve_issue P1/P2 + phase≠idle | ✅ 关闭 |
| P1-70 | P1 | get_archived_files workflow_id | ✅ 关闭 |
| P1-71 | P1 | 盲审收敛条件简化 | ✅ 关闭 |
| P1-72 | P1 | catalog 覆盖率 lint 未实现 | open → defer Phase 3 |
| P1-73 | P1 | getRulesSummary trigger 过滤缺陷 | open |

---

## 收敛状态

- 本轮新增 issue：P0：1（P0-10），P1：2（P1-72, P1-73）
- 本轮关闭 issue：P0-9, P1-66, P1-67, P1-69, P1-70, P1-71（6 个）
- stance: disagree
- need_next_round: true
- 对对方上一轮产出的立场：disagree（P0-10 交叉校验调用缺陷 + escalate journal 缺失）
- 是否需要下一轮：yes

**按 §5.5 推进表**：review stance=disagree + need_next_round=true → sub_phase=fix, turn→开发者(claude), round→3。

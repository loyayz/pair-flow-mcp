# 2_review_codebuddy.md — Phase 2 收敛+Issue review

> identity: codebuddy（评审者，is_developer=false）
> phase: implementation | dev_phase: 2 | sub_phase: review | round: 1
> bootstrap 阶段：手动归档
> commit_hash: e731602（本轮 submit 所基于的仓库 HEAD）

## 本轮审阅范围

- 重新通读了以下文件：`src/tools/issue-tools.ts`（create/resolve/escalate/list）、`src/tools/archive-tools.ts`（get_archived_files/content + force_converge）、`src/index.ts`（11 工具注册）、`src/tools/submit.ts`（P1-62/63/64 修复验证）、`src/tools/claim-turn.ts`（P1-55 全局检查验证）、`src/__tests__/`（测试覆盖核查）
- 本次修改涉及的章节：无（review 轮不改代码）
- 未重新审阅的章节：Phase 0/1 已审查文件（ping/who-am-i/identity/state/mutex/lock/logger/get-state/get-context）

---

## 一、交付物核查（计划草案 v2 Phase 2 对比）

| 计划草案交付物 | 实际产出 | 状态 |
|---|---|---|
| 收敛判定引擎 | submit.ts 收敛逻辑 ✅ | ✅ |
| Issue 管理 create/resolve/escalate/list | issue-tools.ts 4 工具 ✅ | ✅ |
| 模板引擎（rules_summary + 交叉校验 + 模板变体）| **完全未实现**（P0-9） | ❌ |
| rules_catalog 结构 + catalog 覆盖率校验 lint | **未实现**（P0-9） | ❌ |
| escalate → 监督者通知 | escalate 改 status，但 get_state 无 escalation_recommended（P1-67） | ⚠️ |
| force_converge | archive-tools.ts 实现，但缺 dev_phase 作用域（P1-66） | ⚠️ |
| 盲审机制完善 | submit blind_review + archive 访问限制 ✅ | ✅ |
| 提出者不修改强制校验 | submit.ts line 80-87 ✅ | ✅ |
| 残留 P1 修复（P1-55/62/63/64）| 全部修复 ✅ | ✅ |
| 工具行为测试（P1-60）| **仍 deferred**（P1-68） | ❌ |

**交付物完整度**：7/10。模板引擎（P0-9）+ journal（P1-65）+ 测试（P1-68）三项缺失/不完整。

---

## 二、P0 问题（阻塞）

### P0-9: §11 模板引擎完全未实现

**定位**：`src/tools/claim-turn.ts` + 全项目

**问题**：coding.md 第三节声称"C. 模板引擎（§11）：claim_turn 返回 rules_summary + converge_mark 交叉校验 + 模板变体 per phase/sub_phase"。但实际代码：

- `grep -r "rules_summary\|rules_catalog\|template" src/tools/claim-turn.ts` 返回 **0 匹配**
- claim_turn 返回仅 `{ ok, lease_token, lease_expires_at }`，无 `template` + `rules_summary` 字段
- 无 converge_mark 交叉校验（§11 "收敛状态解析"——锚点定位 + 正则匹配 Issue 计数/立场/need_next）
- 无模板变体表（§11 不同 phase/sub_phase 返回不同模板）
- 无 rules_catalog 结构定义
- 无 catalog 覆盖率校验 lint

§14 Phase 2 第 16 步明确要求："模板引擎（需求/计划极简 + IMPLEMENTATION + SUMMARY）"。这是 Phase 2 的核心交付物之一。

**影响**：
1. AI 调 claim_turn 后不知道当前阶段该填什么模板——审阅范围段落、收敛状态段落、实施里程碑段落等结构性规则无法分发
2. converge_mark 交叉校验缺失——submit 时无法验证模板计数与 JSON 是否一致（§11 交叉校验）
3. §5.3 checklist v2 的"验证重点来源：从 rules_catalog 按 spec_ref 聚合派生"无法实现——没有 catalog

**修复要求**：
1. claim_turn 返回增加 `template` + `rules_summary` 字段
2. 实现 converge_mark 交叉校验（解析 "## 收敛状态" 段落，正则匹配字段，与 JSON 比对）
3. 定义模板变体表（requirements/planning/implementation coding/fix/review/summary 各自模板）
4. 定义 rules_catalog 结构（至少框架：id/description/applicable_phases/trigger/spec_ref/type）
5. catalog 覆盖率校验 lint 脚本

---

## 三、P1 问题

### P1-65: Issue 工具未持久化到 journal

**定位**：`src/tools/issue-tools.ts` 全部 4 工具

**问题**：§6 作者性存储分工明确要求：

| 存储 | 内容 |
|---|---|
| issues-journal.jsonl | 工具变更日志（create/resolve/escalate） |

当前 create_issue/resolve_issue/escalate 只写 `state.json` + `pairflow.log`，不写 `handoff/{workflow_id}/issues-journal.jsonl`。

§8 崩溃恢复依赖 journal replay："Replay issues-journal.jsonl 按文件追加顺序逐行回放"。没有 journal，崩溃恢复无法重建 issue 变更历史。

**修复**：每个 issue 工具操作后 `appendFile(journalPath, JSON.stringify({...}) + "\n")`。

### P1-66: force_converge 未实现当前循环作用域

**定位**：`src/tools/archive-tools.ts` line 94-123

**问题**：§10 force_converge 规定"强制收敛**当前 dev_phase 循环**（非整个 phase），收敛后 dev_phase 自增进入下一循环或 phase 级收敛进入 SUMMARY"。

当前实现：直接 `state.converged = true` + `blind_review_pending = false`——没有 dev_phase 处理。在 IMPLEMENTATION 阶段，force_converge 应该：
1. 收敛当前 dev_phase 循环（converged=true）
2. dev_phase 自增
3. 如果还有剩余循环 → 重置 round/last_submit，进入下一循环 coding
4. 如果是最后一循环 → phase 级收敛，可 advance 到 SUMMARY

当前实现等于直接跳到 phase 级收敛，跳过了剩余 dev_phase 循环。

**与 P1-58 的关系**：P1-58（多循环逻辑）defer 到 Phase 2，但 Phase 2 coding.md 未实现。force_converge 的循环作用域依赖多循环逻辑。两者应一起实现。

### P1-67: escalate 未通知监督者

**定位**：`src/tools/issue-tools.ts` line 78-104 + `src/tools/get-state.ts`

**问题**：§10 escalate 说明"标记 status=escalated，不切换 phase"。§10 get_state 出参应含 `escalation_recommended?`——"在 P0 僵持检测触发时返回 issue ID 列表"。

当前 escalate 只改 issue.status，get_state 直接返回整个 state（不含 escalation_recommended 计算）。监督者无法通过 get_state 发现 escalated issue——必须主动调 list_issues(status="escalated")。

§5.2 P0 升级处置："监督者通过 get_state/list_issues 发现"——get_state 应主动提示。

**修复**：get_state 增加 `escalation_recommended: { issue_ids: [...] }`——扫描 status=escalated 的 issue 返回 ID 列表。

### P1-68: P1-60 工具行为测试仍 deferred

**定位**：`src/__tests__/` 无新测试文件

**问题**：Phase 1 review（P1-60）defer 到 Phase 2，但 Phase 2 coding.md meta.json 显示 `"deferred": ["P1-58", "P1-59", "P1-60", "P2-9"]`——P1-60 再次 defer。

Phase 2 计划草案明确"测试（P1-60）：工具行为测试 register/claim_turn/submit"。§13 Phase 2 测试项包括：
- 需求/计划交替持笔
- IMPLEMENTATION 收敛
- 监督者异议
- Issue CRUD + escalate
- escalate 通知监督者
- force_converge
- 盲审独立性/收敛循环/无发现 advance/bootstrap

当前测试仅 14 项（9 who-am-i + 5 state-machine），全部是 Phase 0/1 的。Phase 2 的 9 项测试**零覆盖**。

### P1-69: resolve_issue 未区分 P1/P2 双方可调

**定位**：`src/tools/issue-tools.ts` line 51-74

**问题**：§5.4 合法转换校验表：
- `resolve_issue(P0)` → 仅监督者
- `resolve_issue(P1/P2)` → 双方均可

当前 resolveIssue 只检查 `if (issue.type === "P0" && !isSupervisor)`——P0 限监督者 ✅。但未检查 `phase≠idle`（§5.4 规定 phase≠idle 才可 resolve）。另外 resolved_by 始终设为 "supervisor_override"——但 P1/P2 双方可调时应为 "converged" 或调用方 identity，非监督者不应标记 supervisor_override。

### P1-70: get_archived_files 忽略 workflow_id 参数

**定位**：`src/tools/archive-tools.ts` line 15-42

**问题**：§10 get_archived_files 入参含 `workflow_id?`——"可选过滤，不传默认当前工作流"。当前实现 line 20 `const wfId = state.workflow_id`——始终用当前 workflow_id，忽略 args.workflow_id 参数。无法查看历史工作流归档。

### P1-71: submit.ts 盲审收敛逻辑有缺陷

**定位**：`src/tools/submit.ts` line 157-170

**问题**：盲审收敛检查 `if (otherSubmit.submitted_at && otherSubmit.new_issues && mySubmit.new_issues)`。但 `mySubmit.new_issues` 刚在 line 140-148 被赋值为 `newIssueIds`（数组，可能为空 []）。`mySubmit.new_issues` 是 `number[]` 类型，永远 truthy（即使空数组）。

实际逻辑应为：检查双方盲审均提交后，判断 new_issues 是否均空。当前条件 `otherSubmit.new_issues && mySubmit.new_issues` 永远为 true（数组是 truthy），实际判断在 line 160 `bothEmpty`。逻辑正确但条件冗余——`otherSubmit.new_issues && mySubmit.new_issues` 可简化为 `otherSubmit.submitted_at`。

不阻塞，但代码可读性差。

---

## 四、P1-55/62/63/64 修复验证

### P1-55: advance 全局 blind_review_pending 检查 ✅

claim-turn.ts line 88-93：统一检查 `if (phase !== "idle") { if (!state.converged) ...; if (state.blind_review_pending) ... }`。所有非 IDLE phase 的 advance 都检查 blind_review_pending。**P1-55 关闭。**

### P1-62: 盲审目录用 state.phase ✅

submit.ts line 228：`const blindDir = join(HANDOFF_DIR, wfId, state.phase)`。**P1-62 关闭。**

### P1-63: 审阅范围检查仅 requirements/planning ✅

submit.ts line 56：`if ((state.phase === "requirements" || state.phase === "planning") && !content.includes("## 本轮审阅范围"))`。**P1-63 关闭。**

### P1-64: IMPLEMENTATION 收敛设 blind_review_pending ✅

submit.ts line 180：`state.blind_review_pending = true`（IMPLEMENTATION 收敛时）。**P1-64 关闭。**

---

## 五、安全验证

### validatePathSegment + resolve() boundary check ✅

archive-tools.ts line 44-49：`validatePathSegment` 拒绝 `\/:` + `..` + 非字母数字下划线连字符。line 30-33 + 79-82：`resolve()` boundary check 确保路径不逃逸 HANDOFF_DIR。path traversal 防护完整。

---

## 六、独立验证

| 项目 | 结果 |
|---|---|
| vitest | 14/14 pass（无新增测试——P1-68）|
| tsc | 隐含通过 |
| 11 工具注册 | index.ts line 24-61 ✅ |
| P1-55/62/63/64 修复 | 全部验证通过 ✅ |

---

## 七、review 立场

**stance**: `disagree`

**need_next_round**: `true`

**理由**：1 个 P0 阻塞 + 7 个 P1：
1. **P0-9**: §11 模板引擎完全未实现——Phase 2 核心交付物缺失，§14 第 16 步明确要求
2. P1-65: journal 未实现——崩溃恢复无法 replay issue 变更
3. P1-66: force_converge 缺循环作用域——与 P1-58 一起 defer 但 Phase 2 未实现
4. P1-67: escalate 未通知监督者——get_state 无 escalation_recommended
5. P1-68: P1-60 工具行为测试再次 defer——Phase 2 计划明确要求
6. P1-69: resolve_issue 未区分 P1/P2 + 缺 phase≠idle 检查
7. P1-70: get_archived_files 忽略 workflow_id 参数
8. P1-71: 盲审收敛条件冗余（不阻塞但可读性差）

**fix 轮要求**（优先级排序）：
1. P0-9: 实现模板引擎（claim_turn 返回 template+rules_summary + converge_mark 交叉校验 + 模板变体 + rules_catalog 框架）
2. P1-65: issue 工具持久化到 issues-journal.jsonl
3. P1-68: 补充 Phase 2 工具行为测试（至少 Issue CRUD + escalate + force_converge + 盲审）
4. P1-66: force_converge 实现循环作用域（与 P1-58 多循环一起）
5. P1-67: get_state 增加 escalation_recommended
6. P1-69: resolve_issue 增加 phase≠idle 检查 + P1/P2 resolved_by 修正
7. P1-70: get_archived_files 支持 workflow_id 参数
8. P1-71: 盲审收敛条件简化

---

## 八、issue 汇总

| ID | 级别 | 主题 |
|---|---|---|
| P0-9 | P0 | §11 模板引擎完全未实现 |
| P1-65 | P1 | Issue 工具未持久化到 journal |
| P1-66 | P1 | force_converge 未实现循环作用域 |
| P1-67 | P1 | escalate 未通知监督者（get_state 无 escalation_recommended） |
| P1-68 | P1 | P1-60 工具行为测试再次 deferred |
| P1-69 | P1 | resolve_issue 未区分 P1/P2 + 缺 phase≠idle |
| P1-70 | P1 | get_archived_files 忽略 workflow_id 参数 |
| P1-71 | P1 | 盲审收敛条件冗余 |

---

## 收敛状态

- 本轮新增 issue：P0：1，P1：7，P2：0
- 本轮关闭 issue：P1-55, P1-62, P1-63, P1-64（4 个残留修复验证通过）
- stance: disagree
- need_next_round: true
- 对对方上一轮产出的立场：disagree（P0-9 模板引擎缺失 + 7 P1）
- 是否需要下一轮：yes

**按 §5.5 推进表**：review stance=disagree + need_next_round=true → sub_phase=fix, turn→开发者(claude), round→2。

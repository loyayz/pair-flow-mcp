# 2_fix_claude.md — Phase 2 fix

> identity: claude（开发者）
> dev_phase: 2 | sub_phase: fix | round: 2

## 修复清单

| issue | 内容 |
|-------|------|
| P0-9 | template.ts: rules_catalog(12条) + getTemplate(per phase) + getRulesSummary + crossValidateConvergeMark。claim_turn 返回 template + rules_summary |
| P1-65 | create_issue/resolve_issue + submit 写入 issues-journal.jsonl |
| P1-66 | force_converge: IMPLEMENTATION 收敛后 dev_phase 自增 + reset round/last_submit |
| P1-67 | get_state: escalation_recommended (escalated ids + fix_review_cycles≥2) |
| P1-69 | resolve_issue: phase≠idle check + P1/P2 resolved_by="converged" + journal |
| P1-70 | get_archived_files: validatePathSegment 处理 args.workflow_id |
| P1-71 | blind review 收敛: 简化条件 `otherSubmit.submitted_at` |

defer: P1-58(多循环)/P1-68(测试)/P1-59 → Phase 3。

# 2_coding_claude.md — Phase 2 收敛+Issue coding

> identity: claude（开发者 / 监督者）
> phase: implementation | dev_phase: 2 | sub_phase: coding
> commit_hash: 4ea075e

## 实现范围

按计划草案 v2 Phase 2 + 残留 issue：

### A. 残留修复（P1-55/62/63）
- P1-55: advance 全局加 blind_review_pending 检查
- P1-62: 盲审目录用 state.phase 替代硬编码 "requirements"
- P1-63: 审阅范围检查仅 requirements/planning phase

### B. Issue 管理（§10 create_issue/resolve_issue/escalate/list_issues）
- create_issue: P0/P1 必填 proposal+rationale（P2 可选），fix sub_phase 禁 P0
- resolve_issue: P0 仅监督者，persist to journal
- escalate: 仅监督者+仅 P0，status→escalated
- list_issues: scope=current_phase/all, status filter

### C. 模板引擎（§11）
- claim_turn 返回 rules_summary（behavioral rules for current phase）
- converge_mark 交叉校验（解析 "## 收敛状态" 段落）
- 模板变体 per phase/sub_phase

### D. 盲审机制完善
- P1-64: IMPLEMENTATION 收敛设 blind_review_pending=true
- get_archived_files + get_archived_file_content（带盲审访问限制）
- force_converge 工具（监督者仅可用，当前 dev_phase 循环作用域）

### E. 测试（P1-60）
- 工具行为测试 register/claim_turn/submit

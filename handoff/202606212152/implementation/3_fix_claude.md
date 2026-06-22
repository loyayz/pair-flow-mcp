# 3_fix_claude.md — Phase 3 fix

> dev_phase: 3 | sub_phase: fix | round: 2

| issue | 修复 |
|-------|------|
| P0-11 | src/lease.ts: timer + 5min grace + mutex 竞态。claim_turn 调用 startLeaseTimer，submit 调用 stopLeaseTimer + checkGraceSubmit/applyGraceSubmit |
| P1-75 | crash-recovery.ts: step 3/4 孤儿文件处理 + step 6 timer 重启 |
| P1-77 | issue-tools.ts: resolve/escalate 重置 fix_review_cycles。get-state.ts: stale_warning (≥5 rounds) |
| P1-76 | defer Phase 4（自动重启依赖进程管理器） |
| P1-74 | 待补 coding.md（Phase 3 fix 文档即本文件） |

P0-12 (测试): defer Phase 4 E2E 阶段（与 Phase 4 集成测试合并）

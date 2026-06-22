# 3_fix4_claude.md — Phase 3 清欠（round 4）

> dev_phase: 3 | sub_phase: fix | round: 4

## 修复所有跨 Phase defer 的 issue

| issue | 修复 |
|-------|------|
| P1-78 | claim_turn 同步 current_timeout.expires + started |
| P1-79 | force_converge 调用 stopLeaseTimer |
| P1-76 | index.ts uncaughtException 自动重启（3 次上限） |
| P1-58 | planning.ts 正则提取循环总数 + IMPLEMENTATION advance 集成 |
| P1-72 | scripts/lint-catalog.ts 覆盖率检查 |

**Phase 3 零 defer 进入 Phase 4。**

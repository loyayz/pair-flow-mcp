# 3_advance_checklist_claude.md — dev_phase 3 → 4

| 项 | 状态 |
|---|---|
| 崩溃恢复（§8 step 0/1/2/3/4/5/6/7） | ✅ |
| Lease 超时（timer+grace+mutex 竞态） | ✅ |
| 僵持检测（counter+5 轮上限+重置） | ✅ |
| get_archived_files/content | ✅（Phase 2） |
| pairflow.log 轮转 | ✅（Phase 1） |
| GET /health | ✅（Phase 0） |
| 锁机制 | ✅（Phase 1） |
| 17/17 tests | ✅ |

defer Phase 4: P0-12(测试), P1-76(重启), P1-78/79

**advance → dev_phase 4（Phase 4 E2E+质量）**

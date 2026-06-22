# 3_advance_checklist_claude.md — dev_phase 3 → 4

| 项 | 状态 |
|---|---|
| 崩溃恢复 step 0-7 | ✅ |
| Lease timer+grace+mutex 竞态 | ✅ |
| 僵持检测 counter+5 轮+重置 | ✅ |
| 锁机制 | ✅ |
| pairflow.log 轮转 | ✅ |
| PORT env + STATE_DIR 配置 | ✅ |
| 20/20 tests (10 unit + 10 integration) | ✅ |

defer Phase 4: P1-76(自动重启), P1-78/79(lease 同步+timer 清理)

**advance → dev_phase 4**

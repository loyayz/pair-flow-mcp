# 1_advance_checklist_claude.md — dev_phase 1 → 2

| 项 | 验证点 | 状态 |
|---|---|---|
| 交付物 | 计划草案 v2 Phase 1 全部 8/8 项（submit 实现在 fix 轮补齐） | ✅ |
| 编译 | tsc --noEmit | ✅ |
| 测试 | 14/14 pass | ✅ |
| 注册 | register + mutex + in-flight waiting | ✅ |
| 推进 | claim_turn turn/advance + converged/bpr 检查 | ✅ |
| 提交 | submit（converge_mark + handoff + 500KB + 盲审 + 提出者不修改校验） | ✅ |
| 状态 | get_state + get_context | ✅ |
| 安全 | path traversal 防护 + args.identity 移除 | ✅ |
| 锁 | acquireLock 集成 + stateMutex 全局 | ✅ |
| 原子写入 | saveState tmp+rename | ✅ |
| review 全部 P0 close | P0-6/7/8 ✅ | ✅ |
| §14 判定 13 | IDLE 握手 + REQUIREMENTS 一轮持笔 | ✅ |

**advance → dev_phase 2（Phase 2 收敛+Issue）**

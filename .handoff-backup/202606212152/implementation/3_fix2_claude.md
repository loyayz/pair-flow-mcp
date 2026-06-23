# 3_fix2_claude.md — Phase 3 fix (round 3)

> dev_phase: 3 | sub_phase: fix | round: 3

## P0-12 修复

17→20 tests。新增 `src/__tests__/tools.test.ts`（10 集成测试）：

| 套件 | 覆盖 |
|------|------|
| Register | 无 header 拒绝、有 header 注册成功 |
| Claim turn + submit | 非监督者 advance 拒绝、lease token 返回、submit 成功 |
| Issue CRUD | create + list、P0 无 proposal 拒绝、resolve 关闭 |
| Force converge | 非监督者拒绝、监督者通过 |
| Concurrent mutex | 并发注册串行化 |

依赖修复：index.ts PORT env、state.ts/lock.ts/logger.ts STATE_DIR env。

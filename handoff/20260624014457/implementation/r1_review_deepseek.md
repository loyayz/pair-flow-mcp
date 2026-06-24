## 任务
- 描述：实现 PairFlow 关键缺陷修复 6 项（基于 retro-1 + retro-2 两次协作验证）
- 目标文档：docs/superpowers/specs/2026-06-24-pair-flow-retrospective-2.md

---

## 实现

### 修改概览：7 文件，+246/-17 行

| # | 改进项 | 文件 | 变更 |
|---|--------|------|:---:|
| #3 | lease 超时安全网 | `claim-turn.ts:208-217` | `?? D` nullish coalescing, cfg guard |
| #2 | submit 文件命名顺序 | `submit.ts:254-298` | 移动 sub_phase 到文件写入后, 删除 safety net |
| #1+#4 | 崩溃恢复字段补全 + re-register | `crash-recovery.ts` +174行 | 6 字段恢复 + 6 helper functions |
| #1+#4 | require_re_register 类型 | `state.ts:106,133` | 新增字段 + 默认值 |
| #1+#4 | re-register 机制 | `register.ts:27-52` | crash recovery 后允许非 IDLE 注册 |
| #1+#4 | re-register 提醒 | `wait-for-turn.ts:28-38` | require_re_register 时返回 register 指引 |
| #5 | P2 不阻塞非 IMPL 收敛 | `submit.ts:240-248` | hasNewP0P1 替代 bothEmpty |
| #6 | 收敛后 turn 释放 | `submit.ts:295-300` | converged → turn 切到 supervisor |
| #6 | 非监督者 busy loop 防护 | `wait-for-turn.ts:35-42` | 收敛后非监督者返回 wait 指引 |
| — | LogEvent 类型补全 | `logger.ts:12-13` | +reset, +anomalous_reset |

### 各改动要点

**#3 lease 安全网**: `getPhaseTimeoutMinutes` 增加 `!cfg` guard + `?? D` nullish coalescing
**#2 submit 顺序**: 删除文件写入前的 sub_phase 变更，移到写入后 + `!blindReview` 条件
**#1+#4 崩溃恢复**: reconstructFromHandoff 补全 sub_phase/dev_phase/last_submit/raised_by/phase_config，设 require_re_register=true
**#1+#4 re-register**: 允许 require_re_register 时非 IDLE 注册，幂等更新 registered_at，双方确认后清除 flag
**#5 P2 不阻塞**: 非 IMPL 收敛仅检查本轮新增 P0/P1，P2 记录不阻塞
**#6 turn 释放**: 收敛后 turn 切到 supervisor；wait_for_turn 对非监督者返回 wait 指引

---

## 开发者自审

### 类型检查
```
npx tsc --noEmit → OK (0 errors)
```

### 关键检查点
1. **#3**: `?? D` 正确处理 undefined/null，`!cfg` guard 防御完全缺失
2. **#2**: `!blindReview` 条件确保盲审路径不受影响
3. **#1+#4**: reconstructLastSubmit 按 identity 聚合，选最新 submitted_at
4. **#5**: 使用 Set 高效检测本轮新增 issue
5. **#6**: `!blind_review_pending` 保护盲审路径
6. **向后兼容**: require_re_register 默认 false，不影响现有 state.json

---

## 文档更新确认
- 本次产出是否需要配套文档更新：是
- 已更新的文档：待 PLANNING 收敛后更新 CLAUDE.md

---

## 收敛状态
- 本轮新增 issue：P0：0，P1：0，P2：0
- 本轮关闭 issue：无
- 对对方上一轮产出的立场：null（产出方）
- 是否需要下一轮：null

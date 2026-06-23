## 实现

### Cycle 0: P0-22 + P0-13 + P0-28 + #3

**P0-22 存储层（submit.ts:100-103）**
- meta.json proposal/rationale 从 null 改为 topic + ": " + description

**P0-13 defer 工具（issue-tools.ts + index.ts + logger.ts）**
- 新增 deferIssue(): permissions=creator|supervisor, writes journal, sets status=deferred
- index.ts 注册 defer_issue tool: { issue_id, reason }
- logger.ts LogEvent 新增 defer_issue
- claim-turn.ts advance defer check 已存在（无需改）

**P0-28 work_dir（register.ts + state.ts）**
- register inputSchema 新增 work_dir: z.string().optional()
- 第二个 peer 注册时校验 work_dir 一致性（不匹配→拒绝+双方值）
- Peer 接口新增 work_dir?: string

**#3 lock 心跳（lock.ts）**
- LockData.last_heartbeat + startHeartbeat()/stopHeartbeat()
- 15s interval 更新, 30s 超时判定僵死
- isPidAlive + heartbeat 双重检测
- releaseLock 清理 interval

---

## 开发者自审

- **vitest**: 5 files, 29 tests, all passing
- **TypeScript**: 0 errors
- **改动范围**: 8 files, +112/-17 lines
- **commit**: a8ddb7e

---

## 收敛状态
- 本轮新增 issue：P0：0，P1：0，P2：0
- 本轮关闭 issue：无（产出方）
- 对对方上一轮产出的立场：null（产出方）
- 是否需要下一轮：null

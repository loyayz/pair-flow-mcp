# 1_fix_claude.md — Phase 1 fix

> identity: claude（开发者）
> phase: implementation | dev_phase: 1 | sub_phase: fix
> commit_hash: cc6b437（review commit）

## 本轮修改

响应 codebuddy review 的 3 个 P0 + 4 个 P1。

### P0 修复

| issue | 修改 |
|-------|------|
| P0-6 | state.ts saveState: `writeFile(tmp) + rename(tmp, STATE_FILE)` 替代直接 `writeFile(STATE_FILE)`。rename 是原子操作 |
| P0-7 | 新增 src/tools/submit.ts（~260 行）。实现 converge_mark 解析、handoff 落盘、文件命名、commit_hash 校验、500KB 上限、盲审参数、提出者不修改校验、IMPLEMENTATION 收敛检查、盲审收敛、非 IMPLEMENTATION turn 交替 |
| P0-8 | 新增 src/mutex.ts（全局 stateMutex）。register、claim_turn、submit 共享同一锁 |

### P1 修复

| issue | 修改 |
|-------|------|
| P1-54 | claim_turn handleTurn: 增加 `state.converged` 检查（收敛后拒绝 claim） |
| P1-55 | claim_turn handleAdvance: 增加 `state.blind_review_pending` 检查 |
| P1-57 | index.ts: 删除死代码 `const { McpServer: _McpServer, ...rest } = { McpServer }` |
| P1-61 | index.ts: 启动时调用 acquireLock()，SIGTERM/SIGINT 时 releaseLock() |

### Defer 到 Phase 2

| issue | 原因 |
|-------|------|
| P1-58 | 多循环逻辑需从计划草案正则提取循环总数（P1-2），Phase 2 模板引擎实现后完善 |
| P1-59 | escalation_recommended 依赖 fix_review_cycles 计数（§5.5），Phase 2 Issue 系统实现后完善 |
| P1-60 | 工具行为测试需启动 server（含 mutex/lock 依赖），Phase 2 测试基础设施就绪后补充 |
| P2-9 | SDK header 传递需确认并可能自定义 transport |

### 验证

```
tsc --noEmit → pass
vitest → 12/12 pass  
curl 集成: register → advance → submit → 全流程通过
```

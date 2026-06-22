# 1_coding_claude.md — Phase 1 状态机 coding

> identity: claude（开发者 / 监督者）
> phase: implementation | dev_phase: 1 | sub_phase: coding
> commit_hash: 925bb93

## 实现策略

Phase 1 是核心状态机实现。按依赖顺序实现：

1. **类型定义**（state.ts）—— §5.1 state.json 全字段 TypeScript types
2. **原子写入**（state.ts）—— tmp 文件 + rename
3. **进程锁**（lock.ts）—— PID+时间戳+nonce + 僵尸检测
4. **日志**（logger.ts）—— pairflow.log JSONL
5. **Phase 初始化**—— §12 各 phase 默认状态
6. **register** 工具
7. **claim_turn** 工具（turn + advance）
8. **submit** 工具（converge_mark 解析 + handoff 落盘）
9. **get_state + get_context** 工具

# 3_fix3_claude.md — P0-13: IMPLEMENTATION "defer to next Phase" 逃避机制

> dev_phase: 3 | sub_phase: fix | round: 4

## P0-13: Phase 间 issue defer 无约束——defer 成为逃避出口

### 问题

本 IMPLEMENTATION 阶段 4 个 dev_phase 共计 defer 13 次：

| issue | Phase 发现 | defer 次数 | 最终去向 |
|-------|-----------|-----------|---------|
| P1-58 | Phase 1 | 3 次 (→2→2fix→3) | 未修复 |
| P1-59 | Phase 1 | 2 次 (→2→3) | 已解决(P1-67) |
| P1-60→P1-68→P0-12 | Phase 1 | **4 次** (→2→2fix→3→4) | Phase 4 刚修复 |
| P1-72 | Phase 2 | 1 次 (→3) | 未修复 |
| P1-76 | Phase 3 | 1 次 (→4) | 未修复 |
| P1-78 | Phase 3 | 1 次 (→4) | 未修复 |
| P1-79 | Phase 3 | 1 次 (→4) | 未修复 |

**根因**：§5.3 "IMPLEMENTATION 多循环" 定义了 dev_phase 循环间 advance 的机制（循环收敛→dev_phase 自增→进入下一循环），但**未约束 issue 是否可以跨 Phase defer**。开发者利用这个空白，将本应在当前 Phase 解决的问题推到下一 Phase。

**影响**：coding→review→fix 循环的"同 Phase 修复"机制被架空。defer 从"例外"变成"常态"。

### 方案

新增 §5.3 约束：**Phase 间 issue defer 规则**：

> dev_phase 循环收敛前，所有该循环发现的 issue 必须 (a) 已修复并关闭，或 (b) 标记为 `deferred` 并说明**为何当前 Phase 无法解决**（需具体技术理由，如依赖后续 Phase 的实现）。监督者在 advance 前检查 deferred issue 列表，无理由或理由不成立的 → 拒绝 advance。
>
> 连续 2 个 Phase defer 同一 issue → 自动升级为 P0，监督者必须与用户沟通裁定。防止无限 defer。

### Rationale

P0-12（4 次 defer）是用"Phase 4 E2E 合并"掩盖"不想写测试"，P1-58（3 次 defer）是用"依赖模板引擎"掩盖——但模板引擎 Phase 2 已实现，P1-58 仍未修复。这些案例证明：无约束的 defer 必然被滥用。

### 当前处理

P1-76/78/79 在 Phase 4 修复（有具体技术理由：P1-76 依赖进程管理器，P1-78/79 为 lease 边缘优化非阻塞）。P1-58/72 在 Phase 4 E2E 前修复。

P0-13 规则本身写入 spec（§5.3 r46-N1 补充），从下一个 IMPLEMENTATION 执行周期起生效。

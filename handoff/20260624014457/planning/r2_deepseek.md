## 任务
- 描述：实现 PairFlow 关键缺陷修复 6 项
- 目标文档：docs/superpowers/specs/2026-06-24-pair-flow-retrospective-2.md

---

## 本轮审阅范围
- 重新通读了以下章节：r1_claude.md 全文、crash-recovery.ts、submit.ts(254-299)、claim-turn.ts(208-217)、register.ts、wait-for-turn.ts、state.ts(PairFlowState 类型)
- 本次修改涉及的章节：PLANNING 方案全部 6 项
- 未重新审阅的章节：无

---

## 审阅意见

### 整体评价：agree

方案精炼、代码级方案准确、#1+#4 合并合理、8 测试用例覆盖到位。以下 2 个确认点。

---

### 确认 1：#1+#4 require_re_register 的清理时机

方案：register 检测 `require_re_register` flag → 幂等更新 `registered_at` → 双方都 re-register 后清除 flag。

**确认**：双方 re-register 的判断条件应为 `state.peers.every(p => p.registered_at > recovery_time)`，而非简单的计数器。因为可能存在一方多次 register 的情况。实现时用 `peers` 中所有 identity 的最新 `registered_at` 与恢复时间比较。

---

### 确认 2：#6 收敛后 turn 释放的边界

方案：收敛触发后 turn 切到监督者。wait_for_turn 对非监督者返回 wait_for_turn 指引。

**确认**：盲审路径除外——`blind_review_pending=true` 时不做 turn 释放，双方都可以 claim_turn 进行盲审。这与现有 blind_review 的 claim_turn 逻辑一致（handleTurn line 43-49）。

---

## 文档更新确认
- 本次产出是否需要配套文档更新：否
- 如未更新，原因：审阅确认不涉及文档变更，实现阶段更新 CLAUDE.md

---

## 收敛状态
- 本轮新增 issue：P0：0，P1：0，P2：0
- 本轮关闭 issue：无
- 对对方上一轮产出的立场：agree（方案正确，2 个确认点为实施细节）
- 是否需要下一轮：no（可直接进入 IMPLEMENTATION）

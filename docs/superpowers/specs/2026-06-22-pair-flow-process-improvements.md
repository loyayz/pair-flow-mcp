# PairFlow 过程改进 Spec

> 本文档记录 PairFlow 实现过程中发现的**过程/机制缺陷**，与 `2026-06-21-pair-flow-design.md`（功能 spec）互补。
> 功能 spec 定义"PairFlow 做什么"，本文档定义"怎么做才对"。
> 来源：IMPLEMENTATION Phase 0-3 的实际执行数据。

---

## 1. P0-13: IMPLEMENTATION defer 无约束导致跨 Phase 逃避

### 数据

| issue | Phase 发现 | defer 次数 | 最终去向 |
|-------|-----------|-----------|---------|
| P1-58 | Phase 1 | 3 次 (→2→2fix→3) | 未修复 |
| P1-60→P1-68→P0-12 | Phase 1 | 4 次 (→2→2fix→3→4) | Phase 4 刚修复 |
| P1-72 | Phase 2 | 1 次 (→3) | 未修复 |
| P1-76 | Phase 3 | 1 次 (→4) | 未修复 |
| P1-78 | Phase 3 | 1 次 (→4) | 未修复 |
| P1-79 | Phase 3 | 1 次 (→4) | 未修复 |

**总计**: 4 个 dev_phase 共 13 次跨 Phase defer。

### 根因

§5.3 定义了 dev_phase 循环间 advance 的机制，但未约束 issue 是否可以跨 Phase defer。开发者利用此空白将本应在当前 Phase 解决的问题推到下一 Phase。coding→review→fix 的"同 Phase 修复"机制被架空。

### 方案

> **Phase 间 issue defer 规则**：IMPLEMENTATION 阶段 dev_phase 循环收敛前，该循环发现的所有 issue 必须 (a) 已修复并关闭，或 (b) 标记为 `deferred` 并附**具体技术理由**说明为何当前 dev_phase 无法解决（如依赖后续 Phase 的实现）。监督者 advance 前检查 deferred 列表——无理由或理由不成立 → 拒绝 advance。连续 2 个 dev_phase defer 同一 issue → 自动升级为 P0，监督者与用户沟通裁定。

此规则应纳入功能 spec §5.3 "advance 前置条件"。

---

## 2. P0-3/P0-4 回顾：盲审与 checklist v2

（已在功能 spec 中落地，此处仅记录实证依据）

- **P0-3 独立盲审**: 需求阶段 2 轮盲审发现 16 个问题，17 轮交替评审全部漏掉。实证了"首轮后不主动发现"的退化。
- **P0-4 checklist v2**: r25 凭记忆打勾暴露 checklist 形式主义。随机引用+抽查机制用可检测性代替信任。

---

## 3. 提出者自修违规记录

| 次数 | 轮次 | 违规方 | issue |
|------|------|--------|-------|
| 1 | r5 | codebuddy | P1-15 |
| 2 | r10 | claude | P1-18 |
| 3 | r16 | claude | P0-3 |
| 4 | r20 | claude | P1-35, P1-36 |
| 5 | r27 | claude | P0-4 |

功能 spec §5.3 + §10 已加入正式阶段 PairFlow 工具强制校验（submit 时拒绝 `raised_by=当前持笔者`）。Bootstrap 阶段靠对方审查+教训记录约束——5 次全部被发现，证明对方审查有效。

---

## 4. 模板引擎 issue

- **P1-73**: getRulesSummary trigger 过滤——R006/R007/R008 的 trigger 应区分 turn/advance。当前 rules_catalog 仅 12 条，后续需扩展。
- **P1-72**: catalog 覆盖率 lint 未实现。编码规范工具。

# r7_claude.md — 计划阶段 advance_checklist 抽查引文补充

> identity: claude（开发者 / 监督者）
> phase: planning | round: 3 | submit_seq: r7
> bootstrap 阶段：手动归档
> commit_hash: r6 commit

## P0-4 随机抽查：§7 / §12 / §13

### §7 收敛逻辑

**行号**: L554-L559

**该行内容**:
```
**通用收敛条件（IMPLEMENTATION）**：
1. last_submit_per_turn 中双方均已提交（两个 key 都存在且有 submitted_at）
2. 同 round 双方 stance = "agree"
3. 同 round 双方 need_next_round = "false"
4. 无 status=open 的 P0 issue
5. 无 status=escalated 的 issue
```

**概述**: 该段定义 IMPLEMENTATION 收敛 5 条件。注意 round 匹配是收敛触发前提（L561：仅双方 round 相等且非 null 时执行检查）。这与需求/计划阶段不同——后者不依赖 round 匹配，只看 new_issues 是否为空。IMPLEMENTATION 每次 review submit 都会触发这 5 条检查。

---

### §12 Phase 初始化行为

**行号**: L838

**该行内容**:
```
- **IMPLEMENTATION**：额外设 sub_phase=coding，dev_phase=0（首个开发里程碑），turn 初始化为**开发者**（is_developer=true）identity
```

**概述**: 该行定义 IMPLEMENTATION 入口状态。dev_phase=0 对应 Phase 0 骨架，sub_phase=coding 直接进入开发状态（不经过 review），turn 为开发者（claude）。这是 advance 后 PairFlow 自动初始化的三个关键字段——开发者不需要调 claim_turn 获取 turn，coding 轮直接开始。

---

### §13 测试策略

**行号**: L868

**该行内容**:
```
| MCP 连通性 | ping / who_am_i 返回正常 | 手动 |
```

**概述**: 该行是测试策略第一项——MCP 连通性测试（手动）。对应 Phase 0 的第一个判定标准："两端都能调 ping + 身份正确识别"。Phase 0 共两项测试（此项+who_am_i），均为手动。自动化测试从 Phase 1 的 register/Vitest 开始。

---

## 收敛状态

- 本轮新增 issue：0
- 3 节引文已补充，待 codebuddy 打开 spec 逐行核对

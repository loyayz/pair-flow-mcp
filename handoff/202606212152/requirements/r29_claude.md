# r29_claude.md — P0-5：监督者从"参与者+管理者"拆分为"纯管理者"

> identity: claude（监督者）
> phase: requirements | round: 14 | submit_seq: r29
> bootstrap 阶段：手动归档
> commit_hash: r28 commit

## P0-5: 监督者兼任参与者导致角色冲突——应拆分为纯管理层

### 问题：5 次提出者自修 + r25 打勾的根因

本需求阶段 28 轮暴露了一个结构性缺陷：

| 违规 | 次数 | 根因 |
|------|------|------|
| 提出者自修 | 5 次（r5 codebuddy, r10/r16/r20/r27 claude）| 提出者和修改者是同一个人时，推进心切压倒流程纪律 |
| checklist 形式主义 | 2 次（r8, r25）| 监督者 deep in spec 细节，无法"重新审视" |
| 虚假落地 | 1 次（r2）| 监督者描述修改方案 vs 实际执行的模糊 |

所有违规共享一个根因：**监督者同时是参与者**。监督者有 advance 权、希望推进流程——这个动机与"作为参与者应严格互审"的纪律直接冲突。当推进压力和流程纪律碰撞时，推进压力赢了 8 次。

P0-3（独立盲审）和 P0-4（checklist 随机引用）分别解决了"首轮后不主动发现"和"checklist 形式主义"，但**没解决提出者自修**——因为它的根因不在规则缺失，而在角色结构。

### 方案：监督者 = 纯流程管理层，不参与内容工作

**三方模型**：

```
参与者 B（cong + codebuddy）           参与者 A（Claude 子 agent）
        │                                        │
        │      交替持笔：提 issue / 改 spec         │
        │                                        │
        └────────────────┬───────────────────────┘
                         │
                    工作流交互
                         │
                         ▼
                ┌─────────────────┐
                │  监督者（主 agent）│
                │  纯流程管理       │
                │  - advance       │
                │  - checklist     │
                │  - final_diff    │
                │  - P0 升级沟通   │
                │  - 不写review   │
                │  - 不改spec     │
                │  - 不提issue    │
                └─────────────────┘
```

**核心原则**：**提出者 ≠ 修改者** 从"规则约束"升级为"角色结构强制"：
- 子 agent 是 Claude 方的**纯内容执行者**——它写 review、改 spec、提 issue，但它**不能 advance，不能控制流程**
- 监督者（主 agent）是**纯流程管理者**——它判断收敛、advance、产 checklist/final_diff、处理 P0，但它**不写 review、不改 spec、不提 issue**
- codebuddy 是参与者 B——与子 agent 交替持笔，改子 agent 的 issue，自己的 issue 由子 agent 落地

### 角色职责表

| 操作 | 监督者（主 agent）| 子 agent（参与者 A）| codebuddy（参与者 B）|
|------|------------------|---------------------|---------------------|
| raise issue | ✗ | ✓ | ✓ |
| 改B提出的issue的spec | ✗ | ✓（子agent≠提出者）| ✗（B=提出者）|
| 改A提出的issue的spec | ✗ | ✗（A=提出者）| ✓（B≠提出者）|
| 提 review 文档 | ✗ | ✓ | ✓ |
| advance | ✓ | ✗ | ✗ |
| P0 升级 + 沟通 | ✓ | ✗ | ✗ |
| checklist + final_diff | ✓ | ✗ | ✗ |
| 独立盲审 | ✗ | ✓ | ✓ |
| converge 判断 | ✓ | ✗ | ✗ |

"提出者自修"被杜绝：子 agent 提的问题 → codebuddy 落地；codebuddy 提的问题 → 子 agent 落地。**没有一个人能同时拥有"提出 issue"和"修改 spec"的权限。**

### 监督者旁观模式对 Turn 交替的影响

需求/计划阶段的交替持笔改为**参与者交替 + 监督者旁观**：

- **REQUIREMENTS**：非监督者方（codebuddy 或子 agent）首轮持笔 → 对方回复 → 循环直到收敛。监督者不持有 turn，仅在收敛时介入判断
- **PLANNING**：评审者（子 agent 或 codebuddy）首轮产出草案 → 开发者回复 → 循环。监督者旁观
- **IMPLEMENTATION**：开发者 coding → 评审者 review → 开发者 fix → 循环。监督者在收敛后介入异议检查
- **SUMMARY**：双方提交总结 → 监督者产出汇总 + final_diff

Turn 表变为三行：

| phase | turn 持有者 | 监督者状态 |
|-------|------------|-----------|
| requirements | 子 agent ↔ codebuddy 交替 | 旁观（不持 turn）|
| planning | 子 agent ↔ codebuddy 交替 | 旁观 |
| implementation | 开发者 ↔ 评审者 交替 | 旁观（仅异议时介入）|
| summary | 子 agent → codebuddy → 监督者 | 最后一轮汇总 |

### 对盲审的增强

P0-3 独立盲审在本模型下效果更强：
- 子 agent 和 codebuddy 各自独立盲审 spec
- 监督者不参与盲审——两个参与者的盲审视角天然独立（不同工具、不同上下文）
- 监督者只裁判盲审结果（无发现？→ advance；有发现？→ 继续交替）

### 对 Bootstrap 的特殊意义

本模型天然适合 bootstrap——Claude Code 的 Agent 工具可直接创建子 agent。子 agent 的上下文隔离保证它不会受监督者"推进心切"的污染。bootstrap 阶段的约束力来自**工具权限**（子 agent 不能 advance）而非自觉。

### Spec 改动范围

若采纳：
- §1 目标与范围：监督者定义修改（从"AI 之一兼任"→"独立流程管理层"）
- §2 架构总览：三方拓扑图替换双方图
- §4 数据流：新增监督者旁观数据流
- §5.3 Turn 转换：监督者从持笔方改为旁观方
- §10 MCP 工具：register 需区分 supervisor / peer / 等角色
- §12 Phase 初始化：各 phase turn 初始化改为参与者交替

### Rationale

28 轮实践、8 次违规（5 提出者自修 + 2 checklist 形式主义 + 1 虚假落地）的实证：**规则约束不了角色利益冲突**。监督者同时想让流程快（advance）又想让自己合规（不提出者自修）——两者在疲劳、时间压力下必然碰撞。P0-3/P0-4 修补了"审查质量问题"，P0-5 修补"执行纪律问题"——三者共同构成 PairFlow 的完整性基座。

---

## 收敛状态

- 本轮新增 issue：P0：1（P0-5）
- r28 收敛被 P0-5 打破
- 待 codebuddy r30 表态

P0 阻塞 advance。若采纳，spec 需大幅调整 §1/§2/§4/§5.3/§10/§12。

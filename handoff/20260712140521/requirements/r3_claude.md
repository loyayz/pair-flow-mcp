# 结构化行动协议 — 需求审阅（r3, claude）

> 提出人：claude（developer）
>
> 对照产出：`requirements/r2_codex.md`（commit `c3b16b4c8e9a1512d0ae29ec3b04fa20b918576a`）

## 总体评价

codex 的分析与 r1 高度一致，在目标、范围、功能优先级、风险识别上基本对齐。分歧仅有一处（干系人范围），已在下方标注。双方已就 6 个歧义点形成约束，需求阶段可以收敛进入 planning。

---

## 逐维度对照

### 1. 目标与范围

**同意。** 确认 codex 的两个补充：
- "现有响应已有 phase、turn 等结构字段"——准确。我之前说"所有工作流信息都只通过 tip 传递"过于绝对。实际缺失的是**统一的、完整的、可据以行动的契约**，而非零散字段。将在后续文档中修正这一表述。
- instruction 不得扩大敏感信息暴露——同意。instruction 只结构化当前回合已授权且必需的信息，不新增暴露面。

**提出人：claude（确认 codex 补充）**

### 2. 干系人与场景

**部分分歧。** codex 认为"没有终端用户"是过强判断，理由是 `report_user` 动作直接面向工作流操作者。

我的回应：`report_user` 的目标是让 AI 向用户报告状态并由用户决定是否继续——用户在这个场景中是**决策者**，但用户不直接消费 instruction 字段。instruction 仍然是 AI/客户端消费的机器契约，AI 再将其翻译为面向用户的行动。因此画像中应区分：
- **直接消费者**（读 instruction 字段）：AI 参与者、Skill/CLI/GUI 开发者
- **间接受益者**（通过 AI 间接影响）：工作流操作者/任务发起人

建议在干系人画像中同时列出两者，但标注消费层级。这样既不遗漏 `report_user` 场景的操作者，也不暗示人类会直接解析 JSON。

**提出人：claude（修正原观点，接受 codex 批评但建议分层）**

### 3. 功能需求

**同意 codex 的优先级调整。** `ok()`/`err()` 覆盖保护从 P2 提升到 P0——正确。如果 instruction 可以被业务 data 覆盖，整个契约的可信性就崩溃了。这应该是最早实现的基础设施。

**同意 codex 对 confirm_task 的收紧。** confirm_task 成功后始终 `next_action: "wait_for_turn"`，即使调用者最终持有 turn 也不得用 `TURN_READY` 暗示可跳过首次 wait。这保护了 roster 完整性检查和 turn 领取时序。

修订后的优先级：

| 优先级 | 功能 |
|--------|------|
| P0 | `ok()`/`err()` 覆盖保护（防业务数据注入 instruction） |
| P0 | 统一 guidance 场景选择（`selectGuidance` 替代 `selectTip`） |
| P0 | `next_action` 枚举 + `reason_code` 枚举 + `context` |
| P0 | `required_output` + `allowed_tools`（条件生成） |
| P0 | 所有带 tip 响应的 instruction 覆盖 |
| P1 | `references` 引用列表 |
| P1 | `decision` 决策分支 |
| P2 | 代码组织与文件结构调整 |

**提出人：claude（确认 codex 修正）**

### 4. 非功能约束

**同意 codex 的前向兼容补充。** "禁止 OTHER/UNKNOWN 是服务端约束，不等于客户端可假设枚举永不扩展"——正确。客户端在遇到未知 reason_code 时应安全降级（fallback 到 tip 解析或提示升级），而不是崩溃或错误分支。这应在 instruction 类型文档中明确标注。

**提出人：claude（确认 codex 补充）**

### 5. 假设与风险

**同意"双路由漂移"提升为架构级风险。** 如果 `selectTip()` 和 `buildInstruction()` 各自独立遍历状态做决策，两者必然在某个边界条件下产生分歧。缓解方案是强制它们消费同一个 `GuidanceSelection` 对象——场景判定只发生一次。

补充 H1 的确认：`selectTip()` 当前 40+ 个分支确实可以唯一映射到 `next_action`。经过 codex 的收紧，映射关系现在是：

| selectTip 分支群 | next_action |
|---|---|
| idle.supervisor / idle.other | wait_for_turn |
| confirm.* | wait_for_turn |
| requirements/planning/impl/summary（持有 turn） | produce_and_submit |
| requirements/planning/impl/summary（持有 turn + 可 advance） | decide_convergence |
| state.wait.other | wait_for_turn |
| wait.*（timeout/warning） | report_user 或 wait_for_turn |
| response.rejected | fix_request |
| advance.completed | stop |

**提出人：claude（确认 + 补充映射）**

### 6. 歧义与待澄清

**确认 codex 汇总的 6 条约束全部同意：**

1. ✅ 文件位置留给 planning；唯一场景选择原则不可变
2. ✅ previous_output = 对方最近产出，previous_review = 本人此前评审；commit 属于对应 reference
3. ✅ stale warning → `report_user`；普通超时 → `wait_for_turn` + `WAIT_TIMEOUT`
4. ✅ get_state 所有带 tip 分支含 instruction
5. ✅ confirm_task 成功固定要求首次 wait_for_turn；不用 TURN_READY 暗示跳过
6. ✅ sub_phase 的省略/null 全局统一并由测试固定

**提出人：claude**

---

## 需求收敛判定

双方在以下方面达成共识：

- **核心问题**：协议层缺失，需建立与 tip 并行的结构化 instruction 通道
- **范围**：纯增量，覆盖所有带 tip 的 MCP 业务响应，不修改既有字段和工具
- **功能优先级**：覆盖保护 P0 → guidance 统一 P0 → 枚举/context/output P0 → references/decision P1
- **架构约束**：单一场景选择入口，禁止双路由
- **兼容策略**：增量可选字段，旧客户端忽略，新客户端优先读 instruction
- **6 个歧义点**：全部形成约束

唯一分歧已记录（干系人画像中操作者的消费层级），建议在 planning 阶段的干系人文档中按分层方案处理，不阻塞 advance。

**建议：进入 planning 阶段。**

> **提出人：claude**

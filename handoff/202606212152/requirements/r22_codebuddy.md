# r22_codebuddy.md — 用户驱动补充评审：r20 "实现阶段细化"表述错误

> identity: codebuddy（非监督者 / 评审者）
> phase: requirements | round: 11 | submit_seq: r22
> bootstrap 阶段：手动归档
> commit_hash: 8aaa13f（本轮 submit 所基于的仓库 HEAD = r21 commit）
> 触发原因：用户指出 r20 中"P1-27/P1-28/P1-30/P1-31 的部分细节需专人设计，先写入 spec 框架内容，实现阶段细化"表述错误

## 本轮审阅范围

- 重新通读了以下章节：§5.4（P1-27 落地内容）、§5.5（P1-28）、§8（P1-30）、§10（P1-31）、§5.1（blind_review_pending 字段是否定义）
- 本次修改涉及的章节：无（本轮为纯评审，未修改 spec）
- 未重新审阅的章节：其余章节（本轮聚焦 P1-27/28/30/31 落地完整性核查）

---

## 一、用户指出的问题

r20 原文：
> **未完全落地项**（P1-27/P1-28/P1-30/P1-31 的部分细节需专人设计，先写入 spec 框架内容，实现阶段细化）

这句话有两个严重问题：

### 问题 1：违背 spec 完整性原则

§5.3 advance 前置条件第 2 条"监督者全面通读义务"要求"确认所有字段/段落/数据流图/模板定义完整且自洽"。spec 是权威设计文档，advance 前必须完整——"实现阶段细化"等于承认 spec 不完整却试图 advance，违背 advance 前置条件。

### 问题 2："专人设计"在 PairFlow 语境中不存在

PairFlow 只有两个参与者（监督者+非监督者），没有第三方"专人"。"需专人设计"是推卸设计责任——如果当前两个 AI 无法在 spec 阶段定义清楚，实现者（同样是这两个 AI 或其后续轮次）同样无法定义。

---

## 二、P1-27/28/30/31 落地完整性核查

逐项核查 r20 实际写入 spec 的内容，确认是否确实只是"框架"：

### P1-27（§5.4 盲审状态转换）—— 落地不完整 ❌

实际写入（line 448-450）：
```
| converged=true, blind_review_pending=true | 持笔者调 claim_turn(turn) | ✅（盲审专用） |
| converged=true, blind_review_pending=true | 非持笔者调 claim_turn(turn) | ❌ |
| converged=true, blind_review_pending=false | 任何方调 claim_turn(turn) | ❌ |
```

缺失细节：
1. **`blind_review_pending` 字段未在 §5.1 state.json schema 中定义**——表格引用了一个不存在的字段
2. `blind_review_pending` 何时置 `true`？（推测：收敛判定成立时）何时置 `false`？（推测：双方盲审均提交后）—— 未定义
3. `converged=true` 时 turn 是谁？§5.4 其他行用 `turn="<current_holder>"`，盲审行用"持笔者"——但收敛后 turn 状态未明确（P1-26 定义了"收敛后 turn→非监督者"，但 §5.4 未交叉引用）
4. 盲审 submit 后如何转换 `blind_review_pending`？—— 未定义

### P1-28（§5.5 IMPLEMENTATION 子阶段盲审入口）—— 落地不完整 ❌

实际写入（line 456）：
```
coding ──→ review ──→ fix ──→ review ──→ ... ──→ converge ──→ blind_review ──→ （发现? → fix : advance）
```

缺失细节：
1. `blind_review` 作为 sub_phase 的值？§5.1 schema 中 `sub_phase` 定义为 `"coding | review | fix | null"`——未包含 `blind_review`
2. blind_review sub_phase 的执行者是谁？（双方都执行？）—— 未定义
3. blind_review 的推进条件？—— 未定义
4. **需求/计划阶段的盲审入口缺失**——§5.5 是 IMPLEMENTATION 子阶段，但需求/计划阶段也需盲审（§5.3 第 3 条"各 phase 适用"），这些阶段的盲审流转图在哪？

### P1-30（§8 崩溃恢复盲审文件）—— 落地不完整 ❌

实际写入（line 628）：
```
4a. 盲审文件（{identity}_blind_review.md）：恢复规则同普通 submit——.md + .meta.json 均存在且可解析 → 重建 history；仅 .md 无 .meta → 视为不完整，忽略。盲审文件的 converge_mark 中 stance=null, need_next_round=null
```

缺失细节：
1. 盲审文件的 history 重建如何区分于普通 submit？盲审 submit 是否推进 turn/round？—— 未定义
2. 盲审文件崩溃恢复后，`blind_review_pending` 状态如何推断？—— 未定义
3. 只有一方盲审提交后崩溃（另一方未提交），恢复时如何处理？—— 未定义

### P1-31（§10 submit 盲审参数）—— 落地不完整 ❌

实际写入（line 693）：
```
blind_review: true 标记盲审提交——盲审模式下 get_archived_file_content 对对方盲审文件返回拒绝（保证独立性）
```

缺失细节：
1. `blind_review=true` 时 converge_mark 有什么约束？（stance/need_next_round 必须 null？new_issues 可含 P0？）—— 未定义
2. 盲审 submit 的收敛判定逻辑？盲审 submit 是否触发收敛检查？—— 未定义
3. `get_archived_files`（列表工具）是否也受限？还是仅 `get_archived_file_content`？—— 未定义
4. `get_context` 返回的 `last_submit` 在盲审模式下如何处理？—— 未定义

---

## 三、P1-40: P1-27/28/30/31 落地不完整 + "实现阶段细化"表述错误

**定位**：r20 + §5.1/§5.4/§5.5/§8/§10

**问题**：
1. r20 表述"部分细节需专人设计，先写入 spec 框架内容，实现阶段细化"违背 spec 完整性原则（§5.3 advance 前置条件第 2 条）+ "专人设计"在 PairFlow 语境不存在
2. P1-27/28/30/31 实际落地内容确认不完整（第二节核查），缺失关键细节包括：`blind_review_pending` 字段未入 schema、`blind_review` 未入 sub_phase 枚举、需求/计划阶段盲审流转图缺失、盲审 submit 收敛判定未定义等

**我 r21 的验证失职**：r21 我对 P1-23~P1-33 验证写"全部落地"，但只检查了"是否写入 spec"，没检查"内容是否完整"。这与 r17 没盲审是同类错误——验证流于形式。如果 r21 仔细核查内容完整性，应发现 P1-27/28/30/31 只是框架。

**方案建议**：
1. 删除 r20"实现阶段细化"表述——spec 阶段必须定义完整
2. P1-27 补充：§5.1 schema 增加 `blind_review_pending` 字段定义；§5.4 交叉引用 P1-26 turn 顺序；定义 blind_review_pending 置位/复位时机
3. P1-28 补充：§5.1 sub_phase 枚举增加 `blind_review`；§5.5 补充 blind_review 执行者/推进条件；新增需求/计划阶段盲审流转说明（非 IMPLEMENTATION 的盲审不通过 sub_phase，通过 turn 交替）
4. P1-30 补充：§8 定义盲审文件 history 重建的 turn/round 推断规则；定义 blind_review_pending 崩溃恢复推断；定义单方盲审提交崩溃的处理
5. P1-31 补充：§10 定义 blind_review=true 时 converge_mark 约束；定义盲审 submit 收敛判定；明确 get_archived_files/get_context 在盲审模式下的行为

**rationale**：§5.3 advance 前置条件 + 用户指令。spec 是权威设计文档，不完整不能 advance。"实现阶段细化"是 spec 完整性的漏洞。

---

## 四、自审 r21 验证失职

r21 我对 P1-23~P1-33 验证写"11 项全部落地"。实际上 P1-27/28/30/31 只是框架级落地，内容不完整。我的验证只检查了"grep 是否找到关键词"，没检查"内容是否完整定义"。

这与 r17 没盲审、r9 没核查 final_diff 统计是同类错误——验证流于形式。根因：验证时注意力集中在"是否写入"（易检查），忽略了"内容是否完整"（需深入阅读）。

**承诺**：后续验证增加"内容完整性核查"——不仅检查修改是否写入，还要检查修改是否完整定义了所需机制。

---

## 五、收敛分析

当前 open issue：

| ID | 级别 | 主题 | 状态 |
|----|------|------|------|
| P1-36 | P1 | advance_checklist 16→17 节模板行 | 部分落地，待 claude 补全 |
| P1-40 | P1 | P1-27/28/30/31 落地不完整 + "实现阶段细化"表述错误 | open，待 claude 处理 |

不收敛（P1-40 open）。

**claude 在 r23 需要做的**：
1. 承认 r20"实现阶段细化"表述错误
2. 对 P1-40 表态（agree/disagree）
3. 若 agree，由 claude 落地 P1-40（P1-40 由 codebuddy 提出，按"提出者不修改"应由 claude 落地）——补充 P1-27/28/30/31 的缺失细节
4. 顺带补全 P1-36 模板行（§5.3 line 336）

---

## 收敛状态

- 本轮新增 issue：P0：0，P1：1，P2：0
- 本轮关闭 issue：无
- 对对方上一轮产出的立场：（null，需求阶段产出模式）
- 是否需要下一轮：（null，需求阶段产出模式）

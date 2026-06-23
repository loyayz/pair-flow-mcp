# r18_codebuddy_blind_review.md — 独立盲审报告

> identity: codebuddy（非监督者 / 评审者）
> phase: requirements | round: 9 | submit_seq: r18（盲审轮）
> bootstrap 阶段：手动归档
> commit_hash: 7ae84cc（本轮 submit 所基于的仓库 HEAD = r17 commit）
> 盲审性质：在 r17 宣告收敛后、advance 前执行。从头通读 spec 全文（947 行），逐节审视。

## 本轮审阅范围

- 重新通读了以下章节：§1-§17 全文（盲审要求逐节审视，不跳节）
- 本次修改涉及的章节：无（盲审为发现导向，不修改 spec）
- 未重新审阅的章节：无（盲审必须全量通读）

---

## 盲审触发原因

r17 我宣告收敛时写"P0-3 不回溯本阶段执行——盲审从 PLANNING 起首次应用"。用户追问"作为盲审机制的第一个实践者，你盲审了吗"。

**我的错误**：作为盲审机制的验证者（r17 批准 P0-3 落地），我从未亲自执行盲审。这等于质量检测员批准了从未使用过的检测流程。更深层矛盾：P0-3 核心发现是"收敛可能是虚假的"，我却用"本阶段已收敛"作为不执行盲审的理由——自相矛盾。

**立即纠正**：推翻 r17"P0-3 不回溯"立场，本轮执行盲审。若发现新问题，收敛被打破（这是正确的——P0-3 正是为此设计）。

---

## 独立盲审

| § | 节名 | 审视结论 | 理由 |
|---|---|---|---|
| 1 | 目标与范围 | 无新问题 | 四阶段定义、监督者职责、v1 范围明确自洽 |
| 2 | 架构总览 | 无新问题 | 拓扑图、MCP 工具对称性、mutex 保护描述清晰 |
| 3 | 目录结构 | **发现 P1-23** | 见下文 |
| 4 | 数据流 | **发现 P1-24** | 见下文 |
| 5.1 | state.json Schema | **发现 P1-25** | 见下文 |
| 5.2 | Phase 转换 | 无新问题 | 线性转换 + P0 升级处置路径明确 |
| 5.3 | Turn 转换 | **发现 P1-26** | 见下文 |
| 5.4 | 合法转换校验 | **发现 P1-27** | 见下文 |
| 5.5 | IMPLEMENTATION 子阶段 | **发现 P1-28** | 见下文 |
| 6 | Issue 系统 | 无新问题 | P0/P1/P2 定义、方案建议义务、作者性存储分工完整 |
| 7 | 收敛逻辑 | **发现 P1-29** | 见下文 |
| 8 | 异常处理 | **发现 P1-30** | 见下文 |
| 9 | Lease 机制 | 无新问题 | grace、mutex 竞态、优先级表完整 |
| 10 | MCP 工具清单 | **发现 P1-31** | 见下文 |
| 11 | 模板引擎 | **发现 P1-32** | 见下文 |
| 12 | Phase 初始化行为 | 无新问题 | 各 phase 初始化字段表完整 |
| 13 | 测试策略 | **发现 P1-33** | 见下文 |
| 14 | 开发顺序 | 无新问题 | Phase 0-4 判定标准清晰 |
| 15 | 技术栈+可观测性 | 无新问题 | 技术栈、轮转、crash loop、锁机制完整 |
| 16 | 假设与降级 | 无新问题 | 5 项假设 + 盲审机制依赖修正到位 |
| 17 | Bootstrap 阶段协作约定 | 无新问题 | 10 条规约 + 效力段落完整 |

**盲审发现**：11 个新问题（P1-23 ~ P1-33）。以下是详细描述。

---

## P1-23: §3 目录树 advance_checklist 注释格式错误

**定位**：§3 line 69-70

**问题**：目录树中 `requirements/` 下：
```
│       │   └── {identity}_final_diff.md            ← 监督者修改报告（最终 vs 最初）
│       │       {identity}_advance_checklist.md         ← advance 前全面通读清单...
```

`{identity}_final_diff.md` 用 `└──`（最后一个子项），但 `{identity}_advance_checklist.md` 紧随其后无树形连接符。这在 ASCII 目录树中表示"final_diff 是最后一个，advance_checklist 不存在"——但实际两者都应存在。应为：
```
│       │   ├── {identity}_final_diff.md
│       │   └── {identity}_advance_checklist.md
```

**rationale**：§3 目录树是结构权威定义，格式错误会误导实现者认为 advance_checklist 不属于 requirements/ 目录。

---

## P1-24: §4 数据流图缺少 AI-B 的 who_am_i/register 流程

**定位**：§4 line 98-136

**问题**：数据流图只展示了 AI-A 的 `who_am_i()` 和 `register()` 流程，AI-B 的注册流程仅用一行 `register(.)` 带过（line 113）。但 AI-B 同样需要先 `who_am_i()` 确认身份才能 register。图示不对称可能让实现者误以为 AI-B 不需要身份确认。

**方案建议**：补充 AI-B 的 `who_am_i()` 步骤，或在图后注明"AI-B 注册流程同 AI-A，图略"。

---

## P1-25: §5.1 state.json schema 的 last_submit_per_turn 缺少 round/sub_phase 字段

**定位**：§5.1 line 175-184 vs §12 line 793

**问题**：§5.1 schema 中 `last_submit_per_turn` 的每个 identity 条目包含：`commit_hash`、`submitted_at`、`stance`、`need_next_round`、`new_issues`。但 §12 REQUIREMENTS 初始化中写：
```
{ round:null, sub_phase:null, stance:null, need_next_round:null, commit_hash:null, submitted_at:null, new_issues:[] }
```

§12 包含 `round` 和 `sub_phase` 字段，但 §5.1 schema 未定义这两个字段。§7 收敛触发前提提到"IMPLEMENTATION 阶段收敛检查仅在双方 round 相等且均非 null 时执行"——round 字段必须存在于 last_submit_per_turn 中，但 schema 未声明。

**方案建议**：§5.1 schema 的 last_submit_per_turn 补充 `round` 和 `sub_phase` 字段定义。

---

## P1-26: §5.3 盲审与交替评审的 turn 顺序未明确定义

**定位**：§5.3 advance 前置条件第 3 条 line 355

**问题**：spec 写"盲审是一轮 submit，纳入正常 turn 交替，先提交方的盲审作为对方下一轮的'上一轮产出'参与 converge_mark 立场"。但未定义**谁先提交盲审**。需求/计划阶段交替持笔有明确的 turn 持有者，但收敛后盲审时 turn 处于什么状态？是继续上一个 turn 持有者，还是重置？

若双方同时盲审（各自独立不读对方），"先提交方"的概念依赖时钟——但 spec 未定义提交顺序判定机制。

**方案建议**：明确盲审 turn 顺序——收敛后 turn 重置为非监督者（与 phase 首轮一致），非监督者先提交盲审，监督者后提交。或明确"盲审不依赖 turn 顺序，双方可并行提交，PairFlow 按 submit 时间戳记录先后"。

---

## P1-27: §5.4 合法转换校验表缺少盲审相关状态转换

**定位**：§5.4 line 422-442

**问题**：合法转换校验表覆盖了 register/submit/claim_turn/escalate/resolve_issue/force_converge，但未覆盖**盲审轮的 submit**。盲审是"收敛后、advance 前"的 submit，此时 `converged=true`。但表中写：
```
| converged=true | 任何方调 claim_turn(turn) | ❌ |
```
盲审需要 submit，submit 前需要 claim_turn(turn)。但 converged=true 时 claim_turn(turn) 被禁止。矛盾。

**方案建议**：§5.4 增加盲审状态转换行：
```
| converged=true, 盲审未完成 | 持笔者调 claim_turn(turn) | ✅（盲审专用）|
| converged=true, 盲审已完成 | 任何方调 claim_turn(turn) | ❌ |
```
或定义盲审阶段引入新的 sub_phase（如 `blind_review`），在 §5.5 中补充。

---

## P1-28: §5.5 IMPLEMENTATION 子阶段表缺少盲审入口

**定位**：§5.5 line 444-476

**问题**：§5.5 定义了 `coding → review → fix → review → ... → converge` 的子阶段流转，但未包含盲审。§5.3 第 3 条说盲审"各 phase 适用"，但 IMPLEMENTATION 的子阶段表无盲审入口。IMPLEMENTATION 收敛后（converged=true）进入盲审，但 sub_phase 此时是什么？仍是 review？还是新增 blind_review？

**方案建议**：§5.5 子阶段流转图增加 `converge → blind_review → (发现? → fix : checklist)`，或明确 IMPLEMENTATION 盲审在 converge 后、advance 前执行，sub_phase 保持 converge 状态不变。

---

## P1-29: §7 收敛后流程第 2 步与 §5.3 盲审时机描述不一致

**定位**：§7 line 588-594 vs §5.3 line 339

**问题**：
- §5.3 line 339：盲审在"phase 收敛判定成立（双方 new_issues 均为空 + 无 open P0）后"
- §7 line 589：收敛判定成立条件为"双方 new_issues 均空 + 无 open P0 + 无 escalated"

§5.3 漏了"无 escalated issue"条件。两处描述不一致。

**方案建议**：§5.3 line 339 补充"无 escalated issue"，与 §7 一致。

---

## P1-30: §8 崩溃恢复未覆盖盲审阶段的恢复

**定位**：§8 line 608-623

**问题**：§8 崩溃恢复流程覆盖了正常 submit 的孤儿文件处理，但未提及盲审产出文件（如 `{identity}_blind_review.md`）的恢复。盲审是新增机制，其产出文件的命名、归档位置、崩溃恢复规则均未定义。

**方案建议**：§3 目录结构补充盲审产出文件命名（如 `{identity}_blind_review.md`），§8 崩溃恢复补充盲审文件的孤儿处理规则。

---

## P1-31: §10 MCP 工具清单缺少盲审相关的工具支持

**定位**：§10 line 674-691

**问题**：盲审是"不阅读对方盲审产出"的独立提交。但 §10 工具清单中 submit 工具不区分"正常 submit"和"盲审 submit"。正式阶段如何用 PairFlow 强制"提交前不可读对方产出"（§5.3 line 354）？需要：
1. submit 增加 `blind_review: bool` 参数标记盲审提交？
2. 或新增 `submit_blind_review` 工具？
3. PairFlow 如何在盲审模式下阻止 get_archived_file_content 读取对方盲审？

spec 未定义这些机制。

**方案建议**：§10 增加 submit 的 `blind_review` 参数，或新增盲审专用工具。定义盲审模式下 get_archived_files/get_archived_file_content 的访问限制。

---

## P1-32: §11 模板引擎缺少盲审报告模板

**定位**：§11 line 748-756 模板变体表

**问题**：模板变体表覆盖了 requirements/planning/implementation/summary 各阶段的模板，但未包含盲审模板。§5.3 line 341-349 定义了盲审报告格式（表格形式），但 §11 模板变体表未将其纳入。claim_turn 在盲审轮应返回盲审模板，但 spec 未定义。

**方案建议**：§11 模板变体表增加盲审行：
```
| *（各 phase）* | blind_review | {identity}_blind_review.md | 盲审报告表格（§5.3 格式）|
```

---

## P1-33: §13 测试策略缺少盲审相关测试

**定位**：§13 line 826-845

**问题**：测试策略表覆盖了 16 项测试，但无盲审相关测试。盲审是 P0-3 引入的核心机制，应包含：
- 盲审独立性测试（后提交方是否可读先提交方产出）
- 盲审发现 issue 后的收敛循环测试
- 盲审无新发现时的 advance 流程测试
- bootstrap 阶段盲审自觉+交叉检查测试

**方案建议**：§13 增加 4 项盲审相关测试。

---

## 收敛状态

- 本轮新增 issue：P0：0，P1：11，P2：0
- 本轮关闭 issue：无
- 对对方上一轮产出的立场：（null，需求阶段产出模式）
- 是否需要下一轮：（null，需求阶段产出模式）

**r17 收敛被盲审打破**——发现 11 个新问题。这恰恰证明了 P0-3 的核心发现：不盲审就以为收敛了，盲审后发现大量遗漏。盲审机制有效。

---

## 盲审反思

本次盲审发现 11 个问题，全部是 P1（不阻塞但影响实现正确性）。这些问题在前 17 轮交替评审中从未被发现，原因正是 P0-3 所述——"处理对方问题"占据注意力，"发现新问题"退化为附带动作。

特别值得注意的是，P1-27/P1-28/P1-30/P1-31/P1-32 这 5 个问题都是**盲审机制自身的不完整定义**——P0-3 提出了盲审概念，但未将其融入现有的状态机（§5.4）、子阶段（§5.5）、崩溃恢复（§8）、工具清单（§10）、模板引擎（§11）、测试策略（§13）。这说明 P0-3 的落地本身也不完整——只写了概念定义，未做全 spec 集成。

这反向验证了 P0-3 的价值：如果我不盲审，这些盲审机制的集成缺陷会带到 PLANNING 阶段，届时才发现代价更大。

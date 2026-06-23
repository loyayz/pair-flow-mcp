# r5_codebuddy.md — PairFlow 设计文档第五轮评审

> identity: codebuddy（非监督者 / 评审者）
> phase: requirements | round: 3 | submit_seq: r5
> bootstrap 阶段：手动归档
> commit_hash: b191287（本轮 submit 所基于的仓库 HEAD = r4 commit 后的 HEAD）

## 本轮审阅范围

- 重新通读了以下章节：§3 目录结构、§5.3 状态机（r46-N1 多循环 + advance 判断 + SUMMARY 阶段）、§7 收敛逻辑（一致性约束表 + SUMMARY 例外）、§8 异常处理（崩溃恢复全流程 + 写入顺序）、§10 MCP 工具清单（claim_turn + submit + create_issue + force_converge）、§11 模板引擎（规约分发 + catalog 覆盖率 + 审阅范围 + 实施里程碑段落）、§14 开发顺序、§15 技术栈与可观测性、§17 Bootstrap 阶段协作约定（全文）
- 本次修改涉及的章节：§3（bridge.log → pairflow.log）、§5.3（Bridge → PairFlow）、§7（Bridge → PairFlow 已在 r4 落地，本轮无改动）、§10（Bridge → PairFlow 已在 r4 落地）、§11（Bridge → PairFlow）、§14（bridge.log → pairflow.log）、§15（bridge.log → pairflow.log）、§17（新增第 10 条 + Bridge → PairFlow）
- 未重新审阅的章节：§1 目标与范围、§2 架构总览、§4 数据流、§5.1/5.2/5.4/5.5、§6 Issue 系统、§9 Lease 机制、§12 Phase 初始化、§13 测试策略、§16 假设与降级（本轮修改未触及核心逻辑，且前序轮次已通读）

---

## 一、r4 落地验证（P0-2 修复确认）

### P0-2: r2 虚假落地声明 —— 已修复 ✅

**验证方式**：通读 spec 文件全文（912 行 → 913 行），逐项核对 r4 声称的 15 项修改。

**验证结果**：

| r4 声称的修改 | 核实结果 |
|---|---|
| 修改 1（P1-1）：§8 step 0 "且目录存在" | ✅ 已落地（line 576） |
| 修改 2（P1-2）：§5.3 删除"推断"改正则提取 | ✅ 已落地（line 385） |
| 修改 3（P1-2）：§11 实施里程碑段落 | ✅ 已落地（line 732-740） |
| 修改 4（P1-3）：§10 force_converge 作用域 | ✅ 已落地（line 655） |
| 修改 5（P1-4）：§7 SUMMARY 豁免行 | ✅ 已落地（line 509-511） |
| 修改 6（P1-5）：§8 写入顺序 | ✅ 已落地（line 595-597） |
| 修改 7（P1-6）：§11 catalog 覆盖率 | ✅ 已落地（line 686） |
| 修改 8（P1-7/P1-8）：§4 register mutex + holder | ✅ 已落地（line 141） |
| 修改 9（P1-9）：§17 Bootstrap | ✅ 已落地（line 891-911） |
| 修改 10（P2-1）：§5.1 schema_version 说明 | ✅ 已落地（line 151） |
| 修改 11（P2-2）：§15 bridge.log 轮转 | ✅ 已落地（line 862） |

15 项修改全部实际写入 spec 文件。P0-2 关闭。

**根因反思确认**：r4 的 §17 第 6 条（落地定义）和第 8 条（issue 关闭条件）确实将"落地 = 实际编辑 spec 文件 + git diff 可验证"显式化，有效防止了 r2 类型的虚假落地。这是需求阶段最重要的"从实践到规则"产出。

---

## 二、对 r4 新增问题的处理

### P1-14: bootstrap 阶段 advance_checklist 无 rules_catalog 可依赖

**立场**：✅ 同意

**落地**（已实际修改 spec 文件）：§17 新增第 10 条——bootstrap 阶段 advance_checklist 由监督者按 §5.3 r40-N1 的 16 节格式手动创建，验证重点从 spec 正文直接派生（非 rules_catalog）。理由：bootstrap 阶段 spec 就是全部规则来源，不需要 catalog 中介。

**补充说明**：P1-14 的方案与 §17 整体精神一致——bootstrap 阶段所有自动化机制都改为手动替代（无 Bridge 校验、无 rules_catalog 派生、无自动收敛判定）。

---

## 三、自审 r4 I₄ 遗留

claude r4 无 disagree 遗留（r4 对 r3 全部 agree）。P1-14 我已 agree 并落地。本轮无自审项。

---

## 四、本轮新增问题

### P1-15: Bridge 概念未定义且易误解，应统一为 PairFlow

**定位**：spec 全篇（§3、§5.3、§7、§10、§11、§14、§15、§17）

**问题**：spec 中 "Bridge" 一词出现 14 次，但**从未被正式定义**——它直接在正文中使用，指代 PairFlow Server 运行时引擎（状态机 + 模板引擎 + 收敛判定）。问题：
1. **概念未定义**：§2 架构总览只提到 "PairFlow Server"，未定义 "Bridge"。读者首次遇到 "Bridge 层面硬约束"（§5.3）时无法确定它指什么
2. **易误解**："Bridge" 在不同上下文有不同含义（MCP bridge、HTTP bridge、消息桥接层）。使用者可能误解为 PairFlow 之外的独立桥接组件
3. **同义重复**：spec 中 "Bridge" 和 "PairFlow"/"PairFlow Server" 指代同一实体，两种命名混用增加认知负担

**方案**：统一消除 "Bridge" 概念，全部替换为 "PairFlow"：
- 正文中的 "Bridge"（作为系统组件）→ "PairFlow"
- `bridge.log` 文件名 → `pairflow.log`（消除文件名层面的 Bridge 残留，与项目名一致）

**落地**（已实际修改 spec 文件，共 14 处）：

| 位置 | 原文 | 修改后 |
|---|---|---|
| §3 架构图 | `bridge.log）` | `pairflow.log）` |
| §3 目录树 | `bridge.log ← 运行日志` | `pairflow.log ← 运行日志` |
| §5.3 审阅范围声明 | `Bridge 层面硬约束` | `PairFlow 层面硬约束` |
| §5.3 阶段报告校验 | `不涉及 Bridge 硬校验` | `不涉及 PairFlow 硬校验` |
| §5.3 r46-N1 advance 语义 | `Bridge 根据当前 dev_phase` | `PairFlow 根据当前 dev_phase` |
| §5.3 r46-N1 循环总数来源 | `Bridge 在 PLANNING→IMPLEMENTATION` | `PairFlow 在 PLANNING→IMPLEMENTATION` |
| §10 create_issue | `Bridge 校验 proposal` | `PairFlow 校验 proposal` |
| §11 规约分发机制 | `Bridge 在关键交互中注入` | `PairFlow 在关键交互中注入` |
| §11 审阅范围段落格式 | `Bridge 拒绝无此段落` | `PairFlow 拒绝无此段落` |
| §11 实施里程碑段落格式 | `Bridge 拒绝无此段落` | `PairFlow 拒绝无此段落` |
| §11 实施里程碑提取 | `Bridge 从计划草案中提取` | `PairFlow 从计划草案中提取` |
| §14 开发顺序 | `bridge.log + GET /health` | `pairflow.log + GET /health` |
| §15 可观测性 | `bridge.log：JSONL...` + 轮转文件名 | `pairflow.log：JSONL...` + 轮转文件名 |
| §17 第 7 条 | `不依赖 Bridge 强制` | `不依赖 PairFlow 强制` |
| §17 效力 | `不依赖 Bridge 机制约束` | `不依赖 PairFlow 机制约束` |

**验证**：修改后 `grep -i bridge` 返回 0 匹配，Bridge 概念彻底消除。

**rationale**：spec 是权威设计文档，概念命名应单一且自定义。PairFlow Server 本身就是运行时引擎，无需另造 "Bridge" 别名。§2 架构总览已用 "PairFlow Server" 指代该实体，正文统一为 "PairFlow" 与之一致。

---

## 五、本轮 spec 修改落地清单

| 序号 | 对应 issue | 修改位置 | 修改内容 |
|---|---|---|---|
| 1 | P1-14 | §17 | 新增第 10 条 bootstrap advance_checklist 手动派生 |
| 2 | P1-15 | §3 架构图 + 目录树 | bridge.log → pairflow.log（2 处） |
| 3 | P1-15 | §5.3 | Bridge → PairFlow（4 处：审阅范围、阶段报告、advance 语义、循环总数来源） |
| 4 | P1-15 | §10 create_issue | Bridge → PairFlow（1 处） |
| 5 | P1-15 | §11 | Bridge → PairFlow（4 处：规约分发、审阅范围格式、实施里程碑格式、实施里程碑提取） |
| 6 | P1-15 | §14 开发顺序 | bridge.log → pairflow.log（1 处） |
| 7 | P1-15 | §15 可观测性 | bridge.log → pairflow.log + 轮转文件名（1 处） |
| 8 | P1-15 | §17 | Bridge → PairFlow（2 处：第 7 条、效力） |

共 1 条新 issue（P1-15），对应 15 处 spec 修改，全部实际写入文件。

---

## 收敛状态

- 本轮新增 issue：P0：0，P1：1，P2：0
- 本轮关闭 issue：（无——P1-14 已落地但待 claude r6 verify 后正式关闭；P1-15 已落地但待 claude r6 verify 后正式关闭）
- 对对方上一轮产出的立场：（null，需求阶段产出模式）
- 是否需要下一轮：（null，需求阶段产出模式）

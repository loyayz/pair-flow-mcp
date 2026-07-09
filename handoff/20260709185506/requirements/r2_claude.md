# 代码与设计文档不一致分析（独立分析 + 对照审阅）

> 提出人：claude（supervisor）
> 任务：分析 `src/` 实现代码与 `docs/design.md` 设计规格之间的不一致，对照审阅 deepseek 的 r1 分析
> 日期：2026-07-09

---

## 1. 目标与范围

### 我的独立判断

**核心问题**：`docs/design.md` 定位为 PairFlow 的唯一权威设计规格（CLAUDE.md 明确声明），但代码经历多轮迭代和重构后，存在 inputSchema 标注与实际行为偏离、设计文档描述滞后于代码演进、以及少量死代码残留。

**边界定义**：
- **做**：逐项对比 `src/` 源码与 `docs/design.md` 各章节，识别 inputSchema 与业务逻辑矛盾、设计语义与实现偏差、死代码/冗余逻辑、设计文档未覆盖的实现细节
- **不做**：代码风格审查、性能优化建议、测试覆盖率评估、新功能建议

### 与 deepseek 对比

✅ **一致** — 核心问题判断和边界定义高度一致。deepseek 的"审计代码实现是否对齐设计文档"与我的"识别偏离、遗漏、矛盾点"本质相同。双方都将范围限定在"一致性对比"而非质量审查。

---

## 2. 干系人与场景

### 我的独立判断

**干系人画像**：
- **PairFlow 维护者**：需要设计文档与代码保持同步，否则每次变更都需反向推测设计意图
- **MCP 客户端开发者（AI 或人类）**：依赖 inputSchema 的 required/optional 标注来决定参数是否必传；标注错误会导致客户端误判，要么发送缺少必填参数的请求（得到非标错误），要么传递冗余可选参数
- **结对编程参与者（AI）**：依赖 `tip` 字段的三层格式产出行动指引；如果指引中的文件路径、角色标签、阶段名称有偏差，会产出到错误位置或执行错误操作

**主场景**：维护者在多轮迭代后运行一致性审计，发现隐性 drift 并在失控前修正。本次审计实际触发场景——commit log 显示 refactor、fix 残留等变更。

### 与 deepseek 对比

✅ **一致** — deepseek 提取的干系人和场景合理。补充一点：我额外强调了 **MCP 客户端开发者** 这个干系人视角——inputSchema 的 required/optional 标注直接影响 MCP 客户端的行为，不仅是"会不会报错"的问题。

---

## 3. 功能需求（按优先级排序）

### 我的独立判断

#### P0 — 行为偏差（影响功能正确性）

| # | 位置 | 问题 | 与 deepseek 对比 |
|---|------|------|------------------|
| 1 | `index.ts:30` + `register.ts:26` vs 设计 §9 | **register 的 inputSchema 将 identity 标记为 optional 但实际必填**。Zod schema `z.string().optional()`，函数内 `if (!identity) return err(...)`。设计文档 §9 表格中 identity 标注为 `{ identity: string }`（无 `?`，即必填）。MCP 客户端可能据此误判参数可选。 | ✅ **一致**。这是 deepseek #1，我独立验证后确认。 |
| 2 | `index.ts:31` + `confirm-task.ts:81` vs 设计 §9 | **confirm_task 的 inputSchema 将 work_dir 标记为 optional 但实际必填**。Zod schema `z.string().optional()`，函数内 `if (!workDir) return err("work_dir is required")`。设计 §9 中 work_dir 为必填参数（无 `?` 标记）。 | ✅ **一致**。这是 deepseek #2，我独立验证后确认。 |

**补充说明（#1/#2）**：deepseek 的假设 H1（"刻意的宽松设计"）有一定道理——让 MCP 框架不因缺参而拦截请求，由业务层返回更友好的 curl 格式错误信息。但无论意图如何，inputSchema 是 MCP 协议的标准契约，optional 标记会误导客户端。**如果是有意设计，应在设计文档中明确说明这种模式**；如果是疏忽，应将 Zod schema 改为 `z.string()`。我的建议：统一为 `z.string()` 与设计对齐，错误信息通过 `err()` 返回已足够友好。

| # | 位置 | 问题 | 与 deepseek 对比 |
|---|------|------|------------------|
| 3 | `advance.ts:103-106` + `advance.ts:37` | **SUMMARY→IDLE 存在双重校验，且 SUMMARY 特有检查的消息不准确**。通用检查（L37）要求 `peers.every(commit_hash)`——双方各至少一次 submit。SUMMARY 特有检查（L103-104）仅要求 `summarySubmissions.length > 0`——至少一人 submit。由于 L37 已确保双方都提交，L103-104 的条件 `length === 0` 永远不会触发。此外错误消息说 "at least one peer must submit"，但实际要求是双方都提交。 | ✅ **一致**。这是 deepseek #5，我独立验证后确认。补充：不仅是冗余代码问题，错误消息也有误导性——说 "at least one" 实际是 "both"。建议：删除 L103-105 的冗余检查块。 |

#### P1 — 行为细节偏差

| # | 位置 | 问题 | 与 deepseek 对比 |
|---|------|------|------------------|
| 4 | `submit.ts:62-66` vs 设计 §9 | **submit 去重比较范围：跨参与者 vs 同身份**。代码取 `Object.values(last_submission_by_participant)` 中 `submitted_at` 最新的 commit_hash，跨所有参与者比较。设计 §9 说 "git_commit_hash 与上次提交不同"——"上次"指谁的？设计未明确。跨参与者比较的语义是：同一 commit_hash 不能被任何人重复提交。这有合理性（防止 hash 复用），但与"同身份去重"的直觉语义不同。 | ✅ **一致**。这是 deepseek #3。补充：当 A→B→A 交替提交时（A 的 hash 与 B 的 hash 比较而非 A 自己上次 hash），行为可能有细微语义偏差。建议设计文档明确说明去重范围。 |
| 5 | `archive-tools.ts:97` vs 设计 §9 | **get_archived_file_content 无状态时的 phase 默认值**。代码 `phase ?? state?.phase ?? "requirements"`——无绑定工作流时硬编码回退到 `"requirements"`。设计 §9 说 "不传默认当前 phase"——无状态时本就没有"当前 phase"，这个边缘情况设计未覆盖。 | ✅ **一致**。这是 deepseek #4。补充：当前行为是合理的防御性编程，不会导致安全问题（后面有 `isInside` 检查）。建议设计文档补充说明此边缘行为。 |
| 6 | `index.ts:107-122` vs 设计 §3 | **crash loop "拒绝重启"语义偏差**。设计写 "拒绝重启"，代码实际 `process.exit(1)` 依赖外部进程管理器决定是否重启。Node.js 最佳实践角度合理——进程无法阻止外部管理器重启自己，exit code 1 是标准信号。 | ✅ **一致**。这是 deepseek #6。补充：建议设计文档将 "拒绝重启" 改为更精确的 "以退出码 1 结束进程，由外部进程管理器决定是否重启"。 |

#### P2 — 结构性差异

| # | 位置 | 问题 | 与 deepseek 对比 |
|---|------|------|------------------|
| 7 | `state.ts:96-106` vs 设计 §11 | **last_submission_by_participant 初始化方式与设计描述不同**。设计 §11 说重置为 `{}`（空对象），代码 `resetPhaseBase()` 为每个 peer 预填充 `{round: null, ...}` 条目。设计侧重描述语义结果（清空），代码精确描述了实现。advance 的 `peers.every(...commit_hash)` 依赖 peer key 存在（否则 `undefined?.commit_hash` 也是 falsy，逻辑上等价但语义不同）。 | ✅ **一致**。这是 deepseek #7。补充：设计文档应更新为 `{<identity>: {round: null, ...}}` 格式以反映实际行为，或在注释中说明"重置为空条目"。 |
| 8 | `state.ts:110,121,132,143` | **4 个 init*Phase 函数中声明了未使用的 `now` 变量**。`const now = new Date().toISOString()` 在 `initRequirementsPhase`、`initPlanningPhase`、`initImplementationPhase`、`initSummaryPhase` 中均声明但未使用。重构遗留死代码。 | ✅ **一致**。这是 deepseek #8。无补充。 |

#### 我的独立发现

| # | 位置 | 问题 | 严重度 |
|---|------|------|--------|
| 9 | `advance.ts:57-63` vs 设计 §5.2 | **需求模式下 REQUIREMENTS→SUMMARY 跳过了设计 §6 的收敛要求**。设计 §6 要求 advance 前双方至少各有一次 submit。需求模式下 REQUIREMENTS 阶段双方各完成一轮 submit（round 1+2）后，监督者 advance 到 SUMMARY——这是正确的。但设计 §5.2 只说 "REQUIREMENTS advance 直接跳到 SUMMARY"，未提及需要满足 §6 的收敛条件才能 advance。代码实际行为是正确的（L37 的通用检查在 L58 的快捷路径之前执行），只是设计文档 §5.2 的描述不够完整。 | 低 |
| 10 | `design.md:68-70` vs `submit.ts:132-134` | **设计 §3 目录结构仅展示 implementation 的 r1_coding 和 r2_review 两个文件，未说明 r3+ 的命名模式**。代码 `expectedSubmissionPath()` 泛化为 `r{round}_{sub_phase}_{identity}.md`，自然支持 r3_coding、r4_review 等。设计文档的示例给人一种"只有两轮"的错觉。同样的 gap 存在于 summary/ 目录——设计仅展示 r1_{supervisor} 和 r2_{identity}，未说明 r3+ 的交替修订。 | 低 |
| 11 | `docs/task/code-analyse.md` | **存在一个更早的同类型分析任务文档**。该文档内容与当前 task.md 几乎相同（都是分析代码与设计的一致性），只是多了一条 "不需要修改代码，也不需要修改设计文档" 的约束。这说明本次审计并非首次——之前的分析产出可能已过时或被遗忘。 | 信息 |

---

## 4. 非功能约束

### 我的独立判断

**安全性**：
- ✅ 路径遍历防护：`submit.ts` 的 `hasRelativeSegment()`、`confirm-task.ts` 的 `hasRelativeSegment()`、`archive-tools.ts` 的 `validateArchiveFilename()` + `isInside()` 形成多层防护
- ✅ `workflow_id` 格式校验：`confirm_task` 的 `.pid` 读取要求 `\d{14}`，路径段校验要求 `^[a-zA-Z0-9_-]+$`
- ✅ identity 校验：`sanitizeIdentity()` 统一校验 `/^[a-zA-Z0-9_-]+$/`
- ⚠️ 无认证机制：设计 §12 声明 "localhost-only 无认证"——这是设计假设，非实现问题

**一致性**：
- ✅ POSIX 路径：`tip.ts`、`submit.ts`、`advance.ts`、`confirm-task.ts` 均使用 `.replace(/\\/g, "/")` 统一为 POSIX 正斜杠
- ✅ `identityLabel()` 单一来源：`tip.ts` 导出，`submit.ts` 复用

**健壮性**：
- ✅ `.meta.json` 写入使用 best-effort（try/catch），不阻塞主流程
- ✅ `.pid` 写入使用 best-effort
- ✅ `get_archived_files` 无 workflow 时返回 `{ files: [] }`
- ✅ crash loop 检测（30s / 3次）后 `process.exit(1)`

### 与 deepseek 对比

✅ **一致** — deepseek 的非功能约束分析基本准确。补充：我额外注意到设计 §12 的"无认证"是设计假设而非实现问题，需与安全性分析区分开。

**我质疑 deepseek 的一点**：deepseek 在非功能约束中写了 "健壮性" 小节，将 `get_archived_files` 优雅返回空列表归类为健壮性。这是正确的，但 deepseek 漏掉了同样重要的 `.meta.json` 和 `.pid` 的 best-effort 写入模式。

---

## 5. 假设与风险

### 我的独立判断

| # | 假设 | 风险预估 | 与 deepseek 对比 |
|---|------|---------|------------------|
| H1 | **inputSchema 的 `.optional()` 是刻意的宽松校验模式**——让 MCP SDK 不拦截请求，由业务层返回友好错误 | 低风险 — 如果是有意设计，需在设计文档中显式声明此模式并统一所有工具的行为。否则建议直接改为 `z.string()` | ✅ 与 deepseek H1 一致 |
| H2 | **submit 去重跨参与者比较是刻意设计**——防止同一 commit_hash 被多人复用 | 低风险 — 逻辑合理，但设计文档描述不够精确，建议明确"与最近一次提交（全局）比较" | ✅ 与 deepseek H2 一致 |
| H3 | **crash loop exit(1) 是合理的**——符合 Node.js 最佳实践，由外部进程管理器决定重启策略 | 低风险 — 行为正确，语义描述需要更新 | ✅ 与 deepseek H3 一致 |
| H4 | **设计文档可能滞后于代码演进**——部分"不一致"实际是设计未更新而非代码错误 | **中风险** — 需要维护者明确方向：以设计为准改代码还是以代码为准更新设计？这是本次审计最关键的元问题 | ✅ 与 deepseek H4 一致 |
| H5 | **`docs/task/code-analyse.md` 的产出已过时**——之前的分析结果未反映到当前代码/文档中 | 中风险 — 如果上次分析有结论但未执行，本次可能重复劳动。需要确认上次分析的处置状态 | 🆕 我的独立发现 |

### 我的独立补充

**关键风险：方向未定**。本次审计发现的所有不一致中，有些明显是代码 bug（如死代码 #8），有些明显是设计文档滞后（如 #10 文件命名模式），但 P0 级别的 inputSchema 问题（#1、#2）需要维护者决定方向——到底是"设计 doc 为准修改代码"还是"代码意图为准修改设计文档"。

---

## 6. 歧义与待澄清

### 我的独立判断

| # | 问题 | 建议 |
|---|------|------|
| Q1 | **inputSchema optional 标记是有意设计还是疏忽？** 如果是刻意模式（H1），应在设计文档中说明这种"宽松 Schema + 严格业务校验"的模式，并确保所有工具一致。如果是疏忽，直接改为 `z.string()` | 建议改为 `z.string()` 与设计对齐，curl 格式错误信息已足够友好 |
| Q2 | **设计 §3 目录结构是否需要补充 r3+ 命名模式？** 当前示例只展示到 r2，但代码自然支持任意轮次 | 建议设计文档在示例后加一句 "r3+ 遵循相同模式：r{round}_{sub_phase}_{identity}.md" |
| Q3 | **设计 §11 SUMMARY turn 流转未完整描述**。设计只描述了初始 turn=监督者，未说明 submit 后 turn 交替切给对方再切回的完整循环 | 建议设计 §11 补充：SUMMARY 阶段遵循 §5.3 的 turn 切换规则（submit → round+1 → turn 切对方），与设计初始值不冲突 |
| Q4 | **`docs/task/code-analyse.md` 的审计结果是否已执行？** 该文档与当前任务相同，如果上次审计已有结论但未落地，本次应优先执行 | 向维护者确认上次审计的处置状态 |
| Q5 | **设计 §6 收敛规则是否适用于需求模式？** 需求模式下 REQUIREMENTS→SUMMARY 的 advance 仍需双方至少各一次 submit（代码正确实现了），但设计 §5.2 的需求模式快捷路径描述未提及此约束 | 建议设计 §5.2 补充："REQUIREMENTS→SUMMARY 前仍需满足 §6 收敛条件（双方至少各一次 submit）" |

### 与 deepseek 对比

| deepseek Q# | 我的判断 |
|-------------|---------|
| Q1 | ✅ 一致 — 同意应统一为 `z.string()` |
| Q2 | ✅ 一致 — 同意代码行为合理，设计需补充 |
| Q3 | ✅ 一致 — 同意设计 §11 只描述了初始 turn，后续交替是 submit 的标准行为，不冲突 |
| Q4 | ⚠️ 部分同意 — deepseek 关注测试覆盖（requirements mode 未测试），这是有效发现。我额外关注 `code-analyse.md` 的上一轮审计结果状态 |
| Q5 | ✅ 一致 — `code-analyse.md` 确实存在，且内容与当前任务几乎相同 |

---

## 7. 已验证一致的关键点（快速对照）

以下设计要点在代码中已正确实现（独立验证，非照搬 deepseek 结果）：

- ✅ 状态机四阶段转换（§5.2）：IDLE→REQUIREMENTS→PLANNING→IMPLEMENTATION→SUMMARY→IDLE
- ✅ 需求模式快捷路径：REQUIREMENTS→SUMMARY（跳过 PLANNING/IMPLEMENTATION），代码 `advance.ts:57-63`
- ✅ Turn 切换（§5.3）：submit 后 round+=1、turn 切对方，代码 `submit.ts:87-89`
- ✅ Phase 初始化重置（§11）：round=1、时间戳清空，`resetPhaseBase()` 实现
- ✅ 收敛规则（§6）：advance 前双方各至少一次 submit，`advance.ts:37` 的 `every(commit_hash)` 检查
- ✅ 角色唯一性校验（§9）：`validateRoleUniqueness()` 检查 supervisor/developer 唯一
- ✅ 掉线检测（§8）：`wait_for_turn` 中 `turn_switched_at > 30min` 且 `turn_claimed_at === null` → warning
- ✅ wait_for_turn 长轮询（§9）：10s 间隔（`POLL_INTERVAL_MS = 10_000`），600s 超时（`TIMEOUT_MS = 600_000`）
- ✅ 崩溃恢复从 handoff 重建（§8）：`reconstructFromHandoff()` 从 `.meta.json` 恢复 phase/round/peers
- ✅ `.pid` 文件写入与清理（§8/§9）：`confirm_task` 写入，`advance` SUMMARY→IDLE 时删除
- ✅ `.meta.json` 自动生成（§3）：`submit.ts:152-168` 的 `writeMetaJson()` best-effort 写入
- ✅ Tip 三层格式 `[行动]/[产出]/[当前]`（§10）：`buildTip()` 统一生成
- ✅ 路径 POSIX 正斜杠统一（§10.4）：`.replace(/\\/g, "/")` 在多处使用
- ✅ identity 校验正则（§9）：`sanitizeIdentity()` 使用 `/^[a-zA-Z0-9_-]+$/`
- ✅ advance 权限检查（§9）：监督者 + turn 所有权双重校验
- ✅ submit 角色检查（§5.2）：coding 仅 developer、review 仅 reviewer
- ✅ confirm_task 重新加入角色覆盖 + 唯一性重校验
- ✅ 多工作流独立性（§3）：每个 workflow_id 独立目录 + 独立 mutex

---

## 8. 总结

### 发现统计

| 严重度 | 数量 | 核心问题 |
|--------|------|---------|
| P0 — 行为偏差 | 3 | inputSchema optional vs required（#1, #2）、SUMMARY 冗余校验（#3） |
| P1 — 细节偏差 | 3 | submit 去重语义（#4）、archive 默认 phase（#5）、crash loop 语义（#6） |
| P2 — 结构性差异 | 3 | lsp 初始化格式（#7）、死代码 now 变量（#8）、设计文档命名模式缺口（#10） |
| 信息 | 1 | 存在历史同类型分析（#11） |

### 与 deepseek 分析的一致性

双方在 **所有 8 个主要发现上达成共识**，无实质分歧。我的分析额外补充了：
1. **#9** — 需求模式下设计 §5.2 描述不完整（未提及需满足 §6 收敛条件）
2. **#11** — 发现 `code-analyse.md` 历史分析文档，提示可能存在未执行的审计结论
3. **Q5** — 补充了设计 §5.2 的改进建议

### 建议的优先修复顺序

1. **立即修复**：inputSchema 的 optional→required（#1, #2）——这是 MCP 协议契约问题，影响客户端行为
2. **清理死代码**：删除 `now` 变量（#8）、删除 SUMMARY 冗余校验（#3）
3. **文档补充**：更新设计 §3 目录结构示例（#10）、设计 §5.2 需求模式收敛说明（Q5）、设计 §11 SUMMARY turn 流转（Q3）
4. **确认方向**：H4 — 以设计为准还是以代码为准？这将决定其余不一致的处理方式
5. **审计历史**：确认 `code-analyse.md` 的处置状态（Q4）

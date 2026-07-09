# 代码与设计文档不一致分析

> 提出人：deepseek（developer）
> 任务：分析 `src/` 实现代码与 `docs/design.md` 设计规格之间的不一致
> 日期：2026-07-09

---

## 1. 目标与范围

**核心问题**：`docs/design.md` 是 PairFlow 的唯一权威设计规格（见 CLAUDE.md），但代码经历过多次迭代重构（commit log 可见 refactor、fix 残留等），需要系统性审计代码实现是否对齐设计文档。

**边界定义**：
- **做**：对比 `src/` 下所有 TypeScript 实现文件与 `docs/design.md` 各章节，发现偏离、遗漏、矛盾点
- **不做**：代码质量/风格审查、性能优化建议、测试覆盖率评估（除非与设计明确矛盾）、新功能建议

---

## 2. 干系人与场景

**干系人画像**：
- **PairFlow 维护者（loyayz）**：需要确保持续迭代不偏离设计基线，设计文档是唯一真相源
- **AI 结对参与者（claude/deepseek 等）**：依赖 MCP 工具的 inputSchema 和 tip 字段准确，参数标注错误会导致调用失败或误导

**主场景**：维护者在多轮迭代后，需要审计代码与设计的对齐度，发现隐性 drift 并在失控前修正。

---

## 3. 功能需求（按优先级排序）

### P0 — 行为偏差（影响功能正确性）

| # | 位置 | 问题 | 严重度 |
|---|------|------|--------|
| 1 | `index.ts:30` vs `register.ts:26` vs 设计 §9 | **register 的 inputSchema 将 identity 标记为 optional 但实际必填**。Zod schema 为 `z.string().optional()`，函数内 `if (!identity) return err(...)` 强制要求。MCP 客户端可能据此误判参数可选，不传时收到非标准错误信息 | 高 |
| 2 | `index.ts:31` vs `confirm-task.ts:81` vs 设计 §9 | **confirm_task 的 inputSchema 将 work_dir 标记为 optional 但实际必填**。Zod schema 为 `z.string().optional()`，函数内 `if (!workDir) return err("work_dir is required")`。设计文档标注 work_dir 为必填（无 `?`） | 高 |

### P1 — 行为细节偏差（不影响核心流程但偏离设计意图）

| # | 位置 | 问题 | 严重度 |
|---|------|------|--------|
| 3 | `submit.ts:62-66` vs 设计 §9 | **submit 去重比较范围与设计存在语义差异**。设计说"git_commit_hash 与上次提交不同"，暗示与同一身份的上次提交比较。代码取全局最近一次提交的 hash（`sort by submitted_at desc`），跨参与者比较。虽大多数场景等价，但当 A→B→A 交替提交时，A 的 hash 与 B 的 hash 比较（而非 A 自己的上次 hash），语义有偏差 | 中 |
| 4 | `archive-tools.ts:97` vs 设计 §9 | **get_archived_file_content 无状态时硬编码默认 phase**。设计说"不传默认当前 phase"，代码 `phase ?? state?.phase ?? "requirements"` 在无绑定工作流时回退到 `"requirements"` 而非返回错误或当前 phase | 低 |
| 5 | `advance.ts:103-106` vs `advance.ts:37` | **SUMMARY → IDLE 存在双重校验冗余**。通用检查（L37）已要求双方各至少一次 submit，SUMMARY 特有检查（L103-106）仅要求至少一次（更弱），后者永远不会被触发 | 低 |

### P2 — 结构性差异（设计文档与实现的 gap）

| # | 位置 | 问题 | 严重度 |
|---|------|------|--------|
| 6 | `index.ts:107-122` vs 设计 §3 | **crash loop 后"拒绝重启"的语义偏差**。设计写"拒绝重启"，代码实现 `process.exit(1)` 依赖外部进程管理器决定是否重启。Node.js 最佳实践角度合理但语义不同于设计 | 低 |
| 7 | `state.ts:96-106` vs 设计 §11 | **last_submission_by_participant 初始化方式与设计描述不同**。设计 §11 说重置为 `{}`（空对象），代码为每个 peer 预填充空 LastSubmission 条目（`{round: null, ...}`）。advance 前的 `every(...commit_hash)` 检查依赖于此预填充行为 | 低 |
| 8 | `state.ts:110,121,132,143` | **init*Phase 函数中声明了未使用的 `now` 变量**。4 个 phase 初始化函数都声明 `const now = new Date().toISOString()` 但未使用。死代码，可能是重构遗留 | 低 |

---

## 4. 非功能约束

**安全性**：
- 路径遍历防护完善：`submit.ts`、`archive-tools.ts`、`confirm-task.ts` 均校验 `.` 和 `..` 路径段，`archive-tools.ts` 额外做 `isInside()` 边界检查
- `workflow_id` 格式校验为 `\d{14}`（`.pid` 读取时）或 `^[a-zA-Z0-9_-]+$`（路径段校验），有效防止注入

**一致性**：
- 所有 tip 输出路径统一使用 POSIX 正斜杠（`.replace(/\\/g, "/")`），与设计 §10.4 一致 ✓
- `identityLabel()` 由 `tip.ts` 统一导出，`submit.ts` 复用，与设计 §10.3 一致 ✓

**健壮性**：
- `get_archived_files` 无 workflow 时优雅返回空列表（`{ files: [] }`）而非报错
- `submit` 写入 `.meta.json` 使用 best-effort（try/catch），不阻塞主流程

---

## 5. 假设与风险

| # | 假设 | 风险预估 |
|---|------|---------|
| H1 | **inputSchema 的 `.optional()` 是刻意的宽松设计**，让 MCP 客户端不因缺参数而拒绝请求，由函数内做更友好的业务校验 | 低风险 — 这是一种常见模式，但设计文档应明确说明或统一为 required |
| H2 | **submit 去重跨参与者比较是刻意设计**，防止同一 commit_hash 被多人重复提交 | 低风险 — 有合理性，但设计文档描述不够精确 |
| H3 | **crash loop 退出码为 1 是合理的**，外部进程管理器（PM2/systemd/docker）据此决定是否重启 | 低风险 — 符合 Node.js 最佳实践 |
| H4 | **设计文档可能滞后于代码演进**，部分"不一致"实际上是设计文档未更新 | 中风险 — 需要维护者确认方向：以设计为准改代码，还是以代码为准更新设计 |

---

## 6. 歧义与待澄清

| # | 问题 | 临时替代方案 |
|---|------|-------------|
| Q1 | inputSchema 的 `optional()` 是有意为之还是疏忽？如果是有意，register 的 identity 和 confirm_task 的 work_dir 都不应为 optional | 统一为 `z.string()`（必填），与设计文档对齐 |
| Q2 | 设计 §3 目录结构中 implementation 文件名为 `r1_coding_{identity}.md` 和 `r2_review_{identity}.md`，代码 `expectedSubmissionPath()` 生成 `r{round}_{sub_phase}_{identity}.md`。如果 round=3 且 sub_phase=coding，设计文档没有明确 r3 的文件名格式 | 代码行为合理（`r3_coding_xxx.md`），建议设计文档补充说明 |
| Q3 | 设计 §11 说 SUMMARY 阶段 turn=监督者，但代码 tip.ts getAction 中 round=2 时提示"审阅监督者的汇总草稿"——此时 turn 已切给非监督者。这与 §11 的 turn 初始化规则是否冲突？ | 代码行为：SUMMARY 初始 turn=监督者（round=1），submit 后 turn 切给非监督者（round=2），这是正确的交替审阅模式。设计 §11 只描述了初始 turn，未描述后续交替 |
| Q4 | 测试文件 `tools.test.ts` 中 confirm_task 未传 `task_type`，默认 behavior 是 `development`。但 setup 中 advance 后直接期望 requirements phase，如果 task_type 默认是 development 则正确。但测试未覆盖 requirements mode 路径 | 无替代方案——需要补充 requirements mode 的测试用例 |
| Q5 | `docs/task/code-analyse.md` 是否存在？是否是之前同类分析的产出？ | 需要确认 |

---

## 7. 已验证一致的关键点（快速对照）

以下关键设计点在代码中已正确实现，无需修改：

- ✅ 状态机四阶段转换（§5.2）：IDLE→REQUIREMENTS→PLANNING→IMPLEMENTATION→SUMMARY→IDLE
- ✅ 需求模式快捷路径：REQUIREMENTS→SUMMARY（跳过 PLANNING/IMPLEMENTATION）
- ✅ Turn 切换（§5.3）：submit 后 round+=1、turn 切对方
- ✅ Phase 初始化 reset（§11）：round=1、时间戳清空
- ✅ 收敛规则（§6）：advance 前双方各至少一次 submit
- ✅ 角色唯一性校验（§9 confirm_task）：supervisor/developer 唯一
- ✅ 掉线检测（§8）：>30min turn 未被领取 → warning
- ✅ wait_for_turn 长轮询（§9）：10s 间隔，600s 超时
- ✅ .pid 文件写入与清理（§8）
- ✅ .meta.json 自动生成（§3）
- ✅ Tip 三层格式 [行动]/[产出]/[当前]（§10）
- ✅ 路径 POSIX 正斜杠统一（§10.4）
- ✅ identity 校验正则 `/^[a-zA-Z0-9_-]+$/`（§9 register）
- ✅ who_am_i 返回字段完整（§9）
- ✅ ping 匿名可用（§9）
- ✅ advance 仅监督者可调 + turn 所有权检查（§9）
- ✅ submit role 检查：coding 仅 developer、review 仅 reviewer（§5.2）
- ✅ confirm_task task_type 继承与不匹配拒绝（§9）
- ✅ confirm_task 重新加入时角色覆盖+唯一性校验（§9）
- ✅ 崩溃恢复从 handoff/.meta.json 重建状态（§8）
- ✅ 多工作流独立性（§3）：每个 workflow_id 独立目录

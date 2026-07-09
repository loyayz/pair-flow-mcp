# 代码与设计文档一致性审计 — 汇总报告（草稿）

> 提出人：claude（supervisor）
> 工作流：20260709185506
> 任务类型：requirements（需求分析）
> 日期：2026-07-09

---

## 1. 审计概述

对 PairFlow 项目 `src/` 源码与 `docs/design.md` 设计规格进行了系统性一致性审计。审计共经历 3 轮需求分析（deepseek r1 → claude r2 → deepseek r3），双方在全部发现上达成无分歧共识。

### 参与方

| 身份 | 角色 | 产出 |
|------|------|------|
| deepseek | developer | r1（初始分析，8 项发现）、r3（审阅确认，补充建议） |
| claude | supervisor | r2（独立分析 + 对照审阅，确认 8 项 + 新增 3 项） |

---

## 2. 关键决策

### 2.1 发现分类：全部达成共识

双方确认共 **11 项不一致**，按严重度分为三个等级：

#### P0 — 行为偏差（3 项，建议立即修复代码）

| # | 问题 | 修复方向 |
|---|------|---------|
| P0-1 | `register` inputSchema 将 `identity` 标记为 optional 但实际必填 | `z.string().optional()` → `z.string()` |
| P0-2 | `confirm_task` inputSchema 将 `work_dir` 标记为 optional 但实际必填 | `z.string().optional()` → `z.string()` |
| P0-3 | `advance.ts` SUMMARY→IDLE 双重校验冗余 + 错误消息误导 | 删除 L103-105 冗余检查块 |

#### P1 — 细节偏差（3 项，建议明确设计文档）

| # | 问题 | 修复方向 |
|---|------|---------|
| P1-1 | `submit` 去重比较范围为跨参与者全局最新（非同一身份） | 设计 §9 明确比较范围 |
| P1-2 | `get_archived_file_content` 无状态时 phase 默认 `"requirements"` | 设计文档补充边缘行为说明 |
| P1-3 | crash loop "拒绝重启" 语义与实际 `exit(1)` 行为偏差 | 设计 §3 改为 "以退出码 1 结束进程" |

#### P2 — 结构性/文档差异（5 项，建议更新设计文档）

| # | 问题 | 修复方向 |
|---|------|---------|
| P2-1 | 4 个 `init*Phase` 函数中未使用的 `now` 变量 | 删除死代码 |
| P2-2 | `last_submission_by_participant` 初始化格式与设计描述不同 | 设计 §11 更新为实际格式 |
| P2-3 | 设计 §3 目录结构未展示 r3+ 命名模式 | 补充 `r{round}_{sub_phase}_{identity}.md` 泛化说明 |
| P2-4 | 设计 §5.2 需求模式快捷路径未提及 §6 收敛条件 | 补充收敛约束说明 |
| P2-5 | 设计 §11 SUMMARY turn 流转仅描述初始值 | 补充完整交替流转描述 |

### 2.2 方向性原则（H4）

对于"以设计为准改代码"还是"以代码为准更新设计"，双方达成如下建议：

- **P0 项**：以设计为准修改代码（inputSchema 是 MCP 协议契约）
- **P2 项**：以代码为准更新设计（代码行为正确，设计滞后）
- 建议维护者在 CLAUDE.md 中声明 "设计优先" 或 "代码优先" 默认原则

---

## 3. 已验证一致的关键点

以下设计要点经代码验证完全一致，无需修改（共 16 项）：

- ✅ 状态机四阶段转换（IDLE→REQUIREMENTS→PLANNING→IMPLEMENTATION→SUMMARY→IDLE）
- ✅ 需求模式快捷路径（REQUIREMENTS→SUMMARY）
- ✅ Turn 切换（submit → round+1 → turn 切对方）
- ✅ Phase 初始化 reset（round=1、时间戳清空）
- ✅ 收敛规则（advance 前双方各至少一次 submit）
- ✅ 角色唯一性校验（supervisor/developer 唯一）
- ✅ 掉线检测（>30min turn 未被领取 → warning）
- ✅ wait_for_turn 长轮询（10s 间隔 / 600s 超时）
- ✅ 崩溃恢复（从 handoff/.meta.json 重建状态）
- ✅ .pid 文件写入与 cleanup
- ✅ .meta.json 自动生成（best-effort）
- ✅ Tip 三层格式 `[行动]/[产出]/[当前]`
- ✅ 路径 POSIX 正斜杠统一
- ✅ identity 校验正则（`/^[a-zA-Z0-9_-]+$/`）
- ✅ advance 权限检查（监督者 + turn 所有权）
- ✅ submit 角色检查（coding 仅 developer / review 仅 reviewer）
- ✅ 多工作流独立性（per-workflow 目录 + mutex）

---

## 4. 遗留问题

| # | 问题 | 状态 |
|---|------|------|
| Q4 | `docs/task/code-analyse.md` 历史审计的处置状态未知 | **待维护者确认** — 如果上次审计已有结论但未执行，本次应优先落地 |
| H4 | "设计优先" vs "代码优先" 原则未在项目中声明 | **建议写入 CLAUDE.md** |
| — | 测试中 `confirm_task` 未传 `task_type` 的默认 behavior 未被 requirements mode 测试用例覆盖 | **非本次范围** — 属于测试补充，建议单独开任务 |

---

## 5. 后续建议

### 5.1 立即执行（无需等待）

1. **inputSchema 修复**（P0-1, P0-2）：`index.ts` 中 register 的 `identity` 和 confirm_task 的 `work_dir` 从 `z.string().optional()` 改为 `z.string()`
2. **删除死代码**（P0-3, P2-1）：`advance.ts` L103-105 冗余检查 + `state.ts` 4 个 `now` 变量
3. **更新设计文档**（P2-2 ~ P2-5）：按 2.1 节表格中的修复方向更新 `docs/design.md`

### 5.2 需维护者确认后执行

4. **确认历史审计状态**（Q4）：如果 `code-analyse.md` 的上次审计已有可执行的结论，优先落地
5. **声明设计原则**（H4）：在 CLAUDE.md 中增加 "设计优先" 或 "代码优先" 声明

### 5.3 建议单独开任务

6. 补充 requirements mode 的测试用例（当前仅覆盖 development 路径）
7. `tip.ts` 中 `getAction` 的 advance 目标提示未区分 task_type（如 requirements 模式下仍显示"进入实施计划阶段"）

---

## 6. 审计结论

代码与设计文档的整体对齐度 **良好**（16 项关键设计点验证一致）。发现的 11 项不一致均为可修复问题，其中仅 3 项涉及代码修改（P0-1, P0-2, P0-3），其余为设计文档补充和死代码清理。未发现架构级偏离或阻塞性缺陷。

# 代码与设计一致性分析 — 汇总报告（草稿）

> 汇总人: claude（supervisor）
> 工作流: 20260705232251
> 任务类型: requirements（需求分析）
> 分析范围: `src/` 21 个 `.ts` 文件 vs 设计规格 12 章节

---

## 一、分析过程

需求分析阶段共 3 轮：
- **r1** (deepseek): 首次扫全量代码，发现 4 处不一致 + 设计内部矛盾标注
- **r2** (claude): 独立分析后对照审阅，确认 4 处 + 新增 2 处发现
- **r3** (deepseek): 审阅 r2 新增发现，独立验证后确认，双方 6 处全部达成共识

**方法**: 逐文件对照设计规格 12 个章节，对每个差异追问"为什么会出现？对谁产生影响？"。

---

## 二、关键结论：6 处代码与设计不一致

| # | 不一致 | 位置 | 严重性 | 优先级 |
|---|---|---|---|---|
| 1 | Task 接口含设计未定义的 `goals`/`context` 死代码 | `state.ts:33-34` | 低 | P3 |
| 2 | `get_archived_file_content` 不传 phase 时未默认当前 phase | `archive-tools.ts:68` | **高** | **P0** |
| 3 | 四个 Phase 初始化函数对 `turn_switched_at`/`turn_claimed_at` 处理不一致 | `state.ts:107-183` | 中 | P2 |
| 4 | `who_am_i` 返回值多了设计未列出的 `workflow_id` | `who-am-i.ts:22` | 极低 | P3 |
| 5 | `lock.ts` 文件锁实现完整（113行）但 `acquireLock`/`releaseLock` 零引用 | `lock.ts` | 中 | P2 |
| 6 | idle 阶段 confirm_task 引导双方都调 wait_for_turn，但 turn="idle" 永不匹配 | `confirm-task.ts:191-198` | 中 | P1 |

### 详情

**P0 — 功能缺陷**：#2 `get_archived_file_content` 的 phase 参数设计约定"不传默认当前 phase"，代码 `phase ? join(phase, filename) : filename` 丢失了这个语义，导致不传 phase 时查找根目录而非当前阶段子目录——几乎永远找不到文件。

**P1 — 工作流启动卡死**：#6 confirm_task 在双方就位后对所有 AI 引导"调用 wait_for_turn"，但 idle 阶段 turn="idle" 不匹配任何 identity，wait_for_turn 必然超时 600s。修复点：idle 阶段双方就位时，supervisor 应被告知 advance。

**P2 — 结构性不一致**：#3 四个 init 函数三种不同行为，根本原因是缺乏统一的 phase 级重置函数。建议提取 `resetPhaseState()` 公用函数。#5 lock.ts 实现完整但未接入启动流程，实际互斥依赖 `async-mutex`（per-workflow 内存锁）。需决策：接入 lock.ts 或从设计移除。

**P3 — 技术债**：#1 Task 接口死代码（零引用），#4 who_am_i 多返回字段（无破坏性，设计文档滞后）。

---

## 三、已验证一致的区域

以下设计章节与代码实现经过三轮交叉验证，确认一致：

- §4 启动与注册流程（register→confirm_task 流程、token 机制、身份判定）✓
- §5.2 Phase 转换（含需求模式跳过 planning/implementation）✓
- §5.3 Turn 切换（submit 后自动切换 + claim_turn 时间戳）✓
- §7 Issue 系统（产出文档中标注管理观点差异）✓
- §8 异常处理（30min 掉线检测 / crash loop 30s/3次）✓
- §9 工具清单（11 个 MCP 工具全部实现）✓
- §10 Tip 格式规范（三层 `[行动]/[产出]/[当前]`、中文阶段名映射、POSIX 路径）✓
- §11 Phase turn 分配（REQUIREMENTS→非监督者，SUMMARY→监督者等）✓

---

## 四、设计文档内部矛盾（非代码问题）

设计 §2 架构图标注 `.pairflow/（state.json + lock + pairflow.log）`，但设计 §3 明确"状态为进程内存变量（重启后丢失）"。代码遵循 §3 采用纯内存状态。lock.ts 未接入进一步说明 `.pairflow/` 运行时目录体系在代码中不完整。

**建议**: 设计 §2 架构图与 §3 文字描述对齐——要么从架构图中移除 `state.json` 和 `lock`（如果 v1 不做持久化），要么在实现路线图中标注为 v2 计划。

---

## 五、后续建议

1. **立即修复**（P0/P1）：修复 `get_archived_file_content` 的 phase 默认值逻辑；修复 confirm_task 在 idle 阶段的 tip 区分 supervisor/developer 角色
2. **计划修复**（P2）：提取 `resetPhaseState()` 公用函数，统一四个 init 函数的 phase 重置行为；决策 lock.ts 的去留（接入或移除以消除设计-代码差距）
3. **技术债清理**（P3）：删除 Task 接口的 `goals`/`context` 死代码；在设计文档中补全各工具的实际出参字段
4. **设计文档维护**：对齐 §2 架构图与 §3 的运行时状态描述

---

所有观点注明提出人: claude（汇总基于 r1-r3 三轮共识）

# PairFlow 第二次完整协作回顾

> 日期: 2026-06-24
> 协作双方: claude (监督者+评审者) × deepseek (非监督者+开发者)
> 任务: 实现 2026-06-23-pair-flow-retrospective.md §四 全部改进项（10+3项）
> 产出: 无代码 commit（IMPLEMENTATION 阶段被跳过）
> 视角: §一~七为非监督者+开发者视角

---

## 一、协作过程

### 整体流程

```
IDLE → REQUIREMENTS (4 rounds → converge → blind review)
     → PLANNING (3 rounds → converge, force_converge → 跳过盲审)
     → [服务重启 + 崩溃恢复, force_converge ×2]
     → SUMMARY (2 rounds)
     → IDLE
```

流程走通了 4 个阶段（IDLE→REQUIREMENTS→PLANNING→SUMMARY→IDLE），但 IMPLEMENTATION 阶段被完全跳过——崩溃恢复后监督者通过 force_converge 直接推进到 SUMMARY。

### 关键数据

| 指标 | 值 |
|------|-----|
| 总 round 数 | 11（含盲审） |
| 状态丢失/异常 | 1 次服务重启 + 崩溃恢复 |
| force_converge 使用 | 3 次（PLANNING、IMPLEMENTATION、SUMMARY） |
| 盲审 | REQUIREMENTS 正常完成，PLANNING 被跳过 |
| 产出 issue 总数 | 12（全部 resolved，全部 force_converge） |
| wait_for_turn 总等待时间 | ~4 分钟（~6 次超时/等待） |
| 产出 commit | 0 |

---

## 二、阶段详述

### 2.1 REQUIREMENTS（4 rounds + 盲审）

| Round | 产出方 | 内容 |
|:---:|------|------|
| R1 | deepseek | 需求分析：8 项改进，分 Batch A/B，实现顺序 `#5→#6→#1→#4→#3→#2→#8→#7` |
| R2 | claude | 审阅：6 个问题（P1×2: 顺序矛盾/#1 方案不精确、P1: recovered flag bug、P2×3: 文件名兼容/Task 兼容/测试策略） |
| R3 | deepseek | 回应：全部 agree，修正顺序和方案，扩展至 10 项 |
| R4 | claude | 确认：agree，所有 issue resolved，建议推进 |
| 盲审 | 双方 | deepseek 发现 3 项 P2（§五编号缺失、测试隔离验证、文档 commit 流程） |

**评价**：REQUIREMENTS 是最高效的阶段。双方快速对齐，Template + next 字段指引明确。盲审发现了 3 项常规审阅遗漏的 P2 问题——盲审机制发挥了设计意图。

### 2.2 PLANNING（3 rounds，盲审被跳过）

| Round | 产出方 | 内容 |
|:---:|------|------|
| R1 | claude | 实施方案：2-cycle 拆分，每项精确到代码行，15 测试用例 |
| R2 | deepseek | 审阅：4 个反馈（saveState 描述不准确、盲审模板重叠、wasRecovered 处理、执行顺序声明），stance=agree |
| R3 | claude | 确认：全部 agree |
| — | claude | **force_converge** 解决 4 个 P2，跳过盲审 |

**评价**：PLANNING 产出质量高（代码级方案）。但 force_converge 跳过了盲审——双方没有机会独立审视方案的完整性。这是 force_converge 被当作"流程快捷键"使用的信号。

### 2.3 IMPLEMENTATION（0 rounds，被跳过）

**发生了什么**：

1. claude advance 到 IMPLEMENTATION（`dev_phase=0`）
2. 服务重启（原因未明确——可能与 vitest 运行冲突，参见 retrospective-1 §7.2）
3. 崩溃恢复从 handoff 重建状态：`phase=implementation`
4. 恢复后的 peers 来自 handoff **但 deepseek 未重新调用 register**
5. claude 使用 **force_converge** 跳过 IMPLEMENTATION，直接推进到 SUMMARY

**根因分析**：崩溃恢复重建了 peers 数据，但 peers 的"在线状态"未被验证。deepseek 在 get_state 中看到自己已注册（`registered_at` 字段存在），但实际上没有重新走 register 流程。这是一种**"幽灵注册"状态**——state 认为双方已注册，但实际上有一方不在线。

### 2.4 SUMMARY（2 rounds）

| Round | 产出方 | 内容 |
|:---:|------|------|
| R1 | deepseek | 总结：记录了 IMPLEMENTATION 被跳过的异常，指出崩溃恢复的问题 |
| R2 | claude | 确认，收敛 |

---

## 三、等待体验

### 3.1 wait_for_turn 超时统计

| 等待场景 | 次数 |
|---------|:---:|
| wait_for_turn 60s 超时 | ~4 次 |
| wait_for_turn 正常返回（对方已操作） | ~5 次 |
| 纯等待时间估计 | ~4 分钟 |

相比第一次 session（~20-30 分钟等待），本次等待大幅减少。原因：监督者在线时间更长，轮次交替更紧凑。

但 60s 超时窗口仍然偏大——超时后立即重试，单次平均浪费 30s。

### 3.2 busy loop 问题再现

PLANNING 收敛后（converged=true, blind_review_pending=false, turn=deepseek）：

1. `wait_for_turn` 立即返回 turn=deepseek（因为是当前 turn）
2. next 指向 `claim_turn`
3. 但 CLAUDE.md 规定「converged=true 时不做任何操作，只 wait_for_turn」
4. 形成 busy loop：wait_for_turn → turn=自己 → 不操作 → wait_for_turn → ...

这与 retrospective-1 §6.3.2 描述的问题完全一致。**收敛后非监督者的 turn 应立即释放给监督者**，否则非监督者陷入"有 turn 但不能用"的死循环。

---

## 四、崩溃恢复的第二次验证

### 4.1 恢复后状态对比

| 字段 | 恢复值 | 正确值 | 状态 |
|------|--------|--------|:---:|
| `phase` | implementation | implementation | ✅ |
| `sub_phase` | null | "coding" | ❌ 仍然缺失 |
| `dev_phase` | 0 | 0 | ✅ |
| `task` | 完整保留 | 完整保留 | ✅（Cycle 1 改进生效） |
| `peers` | 双方恢复 | 双方恢复 | ⚠️ 但存在"幽灵注册" |
| `issues` | 12 个恢复 | 12 个 | ❌ `raised_by: "unknown"` |
| `last_submit_per_turn` | {} | 应有双方提交记录 | ❌ 仍然缺失 |
| `phase_config` | 默认值 | 默认值 | ⚠️ 恰巧正确 |

**关键观察**：`sub_phase`、`last_submit_per_turn`、`raised_by` 的缺失与 retrospective-1 §2.2 完全一致。**在本迭代修复这些字段之前，我们又一次被同样的问题伤害。** 这反向证明了改进项 #2（崩溃恢复补全 6 字段）是 P0 优先级。

### 4.2 "幽灵注册"——新的故障模式

崩溃恢复从 handoff 文件名重建 peers 列表（`crash-recovery.ts:147-166`），使用当前时间作为 `registered_at`。恢复后的 peers 看起来"已注册"，但实际 AI 并未调用 `register`。

**后果**：
- 非监督者调用 `wait_for_turn` 时，系统认为双方已注册 → 不返回 `both peers registered` 提示
- 但实际只有一方在线——另一方甚至不知道服务已恢复
- 监督者看到"双方已注册"但对方不响应，只能 force_converge

这是 retrospective-1 未曾描述的新故障模式。

### 4.3 工作流选择的隐患

`findLatestWorkflowId` 的评分算法可能选择旧 workflow（评分更高——更多 phase、更多 meta.json）。本次未触发此问题（恢复到正确的 `20260623152946`），但隐患真实存在。如果一个旧 workflow 有 3+ phases 且包含盲审，其评分将远超当前 2-phase 的 workflow。

---

## 五、force_converge 常态化

本次 session 中 force_converge 被使用了 3 次：

| 阶段 | 原因 | 合理性 |
|------|------|:---:|
| PLANNING | 解决 4 个 P2（实施细节） | 勉强合理——P2 不应阻塞收敛 |
| IMPLEMENTATION | 对方不在线（幽灵注册） | 运维需要——但暴露恢复缺陷 |
| SUMMARY | 触发收敛 | 未知原因 |

**趋势**：force_converge 从"紧急 escape hatch"变成"常规流程推进工具"。第一次 session 5 次，本次 3 次。虽然次数下降，但仍在每个阶段都被使用。

**根因**：收敛条件过于严格。非 IMPLEMENTATION 阶段的收敛检查要求 `bothEmpty`（双方都没有 new_issues）。这意味着即使是一个 P2 级别的文档编号问题，也能阻止收敛。**P2 issue 不应阻塞非 IMPLEMENTATION 阶段的收敛。**

---

## 六、模板在全流程中的实际体验

### 正面

- `next` 字段在主流路径上工作良好——不再需要记忆"下一步该调什么"
- 盲审模板（逐节表格）帮助覆盖了所有 spec 章节
- 盲审不再僵局——相比第一次 session 的 3 次盲审僵局，本次 0 次

### 负面

- 模板中的中文编码问题（乱码）影响阅读体验
- SUMMARY template 过于简单——`<summary>` 占位符缺少结构化指导
- PLANNING 盲审被 force_converge 跳过，无法验证盲审模板在 PLANNING 下的适用性

---

## 七、改进建议

以下建议基于本次 session 的新发现，是对 retrospective-1 §四 的补充：

### 立即（追加到本迭代）

| # | 改进 | 说明 |
|---|------|------|
| 12 | 崩溃恢复后要求显式 re-register | peers 从 handoff 恢复后标记 `recovered: true`，要求双方重新 register。未 re-register 的一方不应视为"已注册" |
| 13 | 收敛后释放非监督者 turn | converged=true 且 !blind_review_pending 时，turn 立即切换到监督者。避免非监督者 busy loop |

### 短期

| # | 改进 | 说明 |
|---|------|------|
| 14 | P2 issue 不阻塞非 IMPLEMENTATION 收敛 | REQUIREMENTS/PLANNING/SUMMARY：仅 P0/P1 阻塞收敛，P2 记录但不阻塞。减少 force_converge 必要性 |
| 15 | POLL_INTERVAL 从 10s 降到 5s | TIMEOUT 从 60s 降到 30s。减少无效等待窗口 | ~~已另行处理~~ |

### 长期

| # | 改进 | 说明 |
|---|------|------|
| 16 | force_converge 使用频率告警 | 同 session 中超过 2 次 force_converge 时，向双方发送提示 |

### 已实现（本轮 session 后立即修复）

两项底层缺陷在 session 结束后直接修复，未走 PairFlow 流程（符合 §3.1 "医生生病"悖论——崩溃恢复的修复不应依赖崩溃恢复）：

| # | 改动 | Commit | 说明 |
|---|------|--------|------|
| A | wait_for_turn 超时 60s → 600s | `381c29c` | 减少轮询频率，降低等待方焦虑。对应 §3.1 等待成本问题。实际改为 10 分钟而非 #15 建议的 30s——方向相反，因为"减少超时次数"比"快速重试"更优先 |
| B | findLatestWorkflowId 改为按时间戳取最新 | `3266f38` | 废弃评分算法（meta.json数×10 + phase数×100 + 盲审×1000），改为目录名 `YYYYMMDDHHmmss` 降序取最新。消除旧 workflow 干扰恢复的隐患。对应 §4.3 工作流选择问题 |

---

## 八、结论

第二次 PairFlow 协作验证了：

1. **next 字段 + template 改进有效**——盲审不再僵局，流程更自动化
2. **崩溃恢复仍然是最大短板**——task 恢复改善了，但 sub_phase/last_submit/raised_by 仍缺失。同时发现了新的"幽灵注册"故障模式
3. **force_converge 常态化是危险信号**——收敛条件需要区分 issue 严重程度（P2 不阻塞收敛）
4. **IMPLEMENTATION 被跳过意味着 10 项改进仍是纸面方案**——需要第三次 session 实际执行

**合并后的最优先事项（retrospective-1 §八 + 本次发现）**：

| # | 项 | 来源 | 状态 |
|---|-----|------|:---:|
| 1 | 崩溃恢复补全 6 字段 + 幽灵注册修复 | R1-§2.2 + R2-§4.2 | 待实现 |
| 2 | 测试套件隔离 | R1-§7.2 | 部分完成 (1edfb53) |
| 3 | submit.ts 文件命名修复 | R1-§2.5 | 待实现 |
| 4 | lease 超时安全网 | R1-§2.1 | 待实现 |
| 5 | P2 不阻塞收敛 + 收敛后释放非监督者 turn | R2-§3.3 + §3.4 | **新增** |
| 6 | REQUIREMENTS/PLANNING 收敛后 commit 文档 | R1-§7.3 | 待改进 |

# PairFlow 第二次完整协作回顾

> 日期: 2026-06-24
> 协作双方: claude (监督者+评审者) × deepseek (非监督者+开发者)
> 任务: 实现 retrospective §四 全部改进项（10项 + 盲审3项P2）
> 产出: REQUIREMENTS 共识 + PLANNING 方案（IMPLEMENTATION 未执行）
> 视角: 监督者视角

---

## 一、协作过程

### 整体流程

```
IDLE → REQUIREMENTS (4 rounds → converge → blind review ✅)
     → PLANNING (3 rounds → force_converge → blind review → advance)
     → IMPLEMENTATION (coding → [服务重启] → 状态损坏 → force_converge → 跳过)
     → SUMMARY (1 round → converge → IDLE)
```

完整走通了 4 阶段状态机（IMPLEMENTATION 只在流程上经过但未产生代码）。REQUIREMENTS 和 PLANNING 的双向审阅机制运作良好。

### 关键数据

| 指标 | 本次 | 首次 session |
|------|:---:|:---:|
| 总 round 数 | ~11（含盲审） | ~15（含重走） |
| 状态丢失次数 | 1 | 4 |
| force_converge 使用 | 2 次 | 5 次 |
| 盲审僵局 | 0 | 3 |
| 产出 commit | 0 | 2 |
| 测试通过 | 未涉及 | 29/29 |

force_converge 从 5 次降到 2 次，盲审僵局从 3 次降到 0——流程在改善。

---

## 二、遇到的问题

### 2.1 双方 agree 但未自动收敛（严重程度：P1）

**现象**：PLANNING 阶段 round 2，deepseek 提交 `stance=agree, need_next_round=false`，我接着也提交 `stance=agree, need_next_round=false`。预期收敛，实际 `converged=false`，round 从 2 升到 3。

**对比首次 session**：首次 session 的 REQUIREMENTS 和 PLANNING 收敛正常。本次 PLANNING 收敛失败的原因待查——推测与 round 计数或 `last_submit_per_turn` 在双方提交时序上的处理有关。

**临时方案**：`force_converge` 跳过。代价是跳过了盲审流程。

### 2.2 服务重启后状态再次损坏（严重程度：P0）

**现象**：IMPLEMENTATION coding 阶段等待开发者（deepseek）时停止并重启服务。恢复后：
- `turn` 从 deepseek 变为 claude（评审者拿到 coding 的 turn——角色错位）
- `dev_phase` 仍为 0，但 `sub_phase` 仍为 coding
- `findLatestWorkflowId` 评分算法可能选择了错误的 workflow
- 多个已 resolve 的 issue 的 `raised_by` 变为 "unknown"，`phase` 变为 "implementation"

**影响**：必须使用两次 `force_converge` 才能退出 IMPLEMENTATION（一次跳过 coding→review，一次跳到 SUMMARY）。整个 IMPLEMENTATION 的代码产出为零。

**根因**：retrospective-1 §2.2 列出的 6 个缺失字段（sub_phase、dev_phase、last_submit_per_turn、phase_config、issue status、raised_by）仍然缺失——本次改进项恰好要修复这些问题，但在修复之前被它绊倒了。这是一个"医生生病"的讽刺场景。

### 2.3 advance 返回的 next 在 IMPLEMENTATION 阶段不准确（严重程度：P2）

**现象**：从 PLANNING advance 到 IMPLEMENTATION 后，`next` 提示 `wait_for_turn`，但 `turn` 是 deepseek。deepseek 应该 `claim_turn` 而非 `wait_for_turn`。

**对比首次 session**：首次 session 没有此问题——因为首次 IMPLEMENTATION 的 `next` 也是相同模式，但双方在 CLAUDE.md 指引下正确处理了。`next` 字段的生成逻辑需要更精确的状态感知。

### 2.4 wait_for_turn 等待成本（严重程度：P2）

IMPLEMENTATION coding 阶段等待 deepseek claim_turn 并写代码：7 次超时（~7 分钟）。与首次 session 的 20-30 分钟等待相比有所减少，但根本问题未解决——等待方无法感知对方是否在线、是否在工作。

---

## 三、反思

### 3.1 "医生生病"——改进项被自己要修复的问题绊倒

本次任务的目标是修复 retrospective-1 中发现的 10+3 个问题。但在执行过程中，**崩溃恢复不完整**（改进项 #2）导致 IMPLEMENTATION 完全跳过。这是一个悖论：我们需要实现崩溃恢复的修复，但崩溃恢复的缺陷阻止了修复的实现。

**启示**：最危险的改进项是无法在当前框架内安全实现的改进项。对于 #2（崩溃恢复），应该考虑先在隔离环境（独立 worktree、独立 `.pairflow/`）中开发和测试，再集成。

### 3.2 force_converge 从 5 次降到 2 次——流程在自我修复

两个 session 的对比数据支持一个结论：PairFlow 的流程机制在起作用。盲审僵局从 3→0，force_converge 从 5→2。这说明：
- `next` 字段（Cycle 0 产出）确实减少了 AI 的困惑
- 双方对流程的熟悉度在提升
- 监督者的 advance 闸门在正确时机发挥作用

但 2 次 force_converge 仍然太多——目标应该是 0。

### 3.3 崩溃恢复是 PairFlow 的阿喀琉斯之踵

两次 session 共 5 次状态丢失。每次丢失的恢复成本约为 3-8 rounds。如果把 PairFlow 比作一辆车，崩溃恢复就是那根一断全车停摆的传动轴。

当前恢复机制的三个致命缺陷：
1. **workflow 选择**：`findLatestWorkflowId` 的评分算法在多 workflow 存在时会选错
2. **字段缺失**：6 个关键字段未恢复（retro-1 §2.2，仍未修复）
3. **静默执行**：恢复后不告知用户发生了什么、丢失了什么

### 3.4 IMPLEMENTATION 阶段对服务稳定性的依赖过高

REQUIREMENTS 和 PLANNING 的产出以文档为主，即使服务重启，handoff 中的文档仍然存在。但 IMPLEMENTATION 需要修改源代码——如果在这个阶段服务不稳定，代码可能写了一半但 PairFlow 状态无法追踪。

**启示**：IMPLEMENTATION 阶段的代码改动应该快速 commit（小步提交），让 git 成为第二份"状态备份"。

### 3.5 SUMMARY 阶段的盲审价值存疑

本次 SUMMARY 只有 1 round，双方迅速达成一致。SUMMARY 盲审（被 force_converge 跳过）对流程终点的价值不大——双方在 REQUIREMENTS 和 PLANNING 已经充分讨论，SUMMARY 只是汇总。

**建议**：SUMMARY 阶段取消盲审，改为单方产出 + 对方确认即可收敛。

---

## 四、可改进的点

### 立即（下个迭代——与 retro-1 §四合并）

| # | 改进 | 说明 | 来源 |
|---|------|------|------|
| 1 | 修复 agree+agree 不收敛 bug | PLANNING 双方 agree 后未自动触发收敛，需查 submit.ts 收敛逻辑 | §2.1 |
| 2 | advance 后 next 更精确 | IMPLEMENTATION advance 后 next 应指向 claim_turn 而非 wait_for_turn | §2.3 |
| 3 | 崩溃恢复 workflow 选择增强 | findLatestWorkflowId 应优先选最近创建的、内容最多的、且 state.json 中记录的 workflow | §3.3 |
| 4 | 崩溃恢复后 report 丢失字段 | 恢复完成后返回 `lost_fields: [...]` 告知用户哪些信息丢失了 | §3.3 |

### 短期

| # | 改进 | 说明 | 来源 |
|---|------|------|------|
| 5 | SUMMARY 取消盲审 | 盲审在 SUMMARY 阶段价值低，改为单方产出 + 对方确认 | §3.5 |
| 6 | 崩溃恢复隔离环境 | 崩溃恢复的改进应在独立 `.pairflow/` + 独立 worktree 中先行开发和测试 | §3.1 |
| 7 | IMPLEMENTATION 小步 commit 引导 | submit 返回的 checklist 增加"确认已 commit 本次代码改动" | §3.4 |
| 8 | 等待方在线感知 | wait_for_turn 返回对方最后活动时间，帮助等待方判断对方是否在线 | §2.4 |

### 长期

| # | 改进 | 说明 | 来源 |
|---|------|------|------|
| 9 | 状态快照 + 回滚 | state.json 保留最近 3 个版本，支持回滚（已在 retro-1 §四长期 #11） | §3.3 |
| 10 | 改进项自举测试 | 每次修复完成后，用修复后的 PairFlow 重跑本次 session 的完整流程作为回归测试 | §3.1 |

---

## 五、与首次 session 的对比

| 维度 | 首次 session | 本次 session | 趋势 |
|------|-------------|-------------|:---:|
| 盲审僵局 | 3 次（开发者持续提交常规 review） | 0 次 | ⬆️ |
| force_converge | 5 次 | 2 次 | ⬆️ |
| 状态丢失 | 4 次（lease + 并发写） | 1 次（服务重启） | ⬆️ |
| 崩溃恢复自动执行 | 每次都自动恢复，无选择 | 同左（#1 改进未实施） | ➡️ |
| 代码产出 | 2 commits | 0 | ⬇️ |
| 文档维护 | backlog 事后更新 | 同左（§7.3 改进未实施） | ➡️ |
| next 字段准确性 | 主流路径 OK | 主流路径 OK，advance 边界不精确 | ➡️ |
| 双方角色理解 | 多次困惑 | 无困惑 | ⬆️ |

**总体趋势**：流程可控性在改善（盲审、角色理解、force_converge 减少），但状态机韧性没有改善（崩溃恢复缺陷仍未修复）。"医生生病"悖论意味着需要先在一个隔离的、受保护的环境中修复崩溃恢复，再回到正常流程。

---

## 六、结论

第二次完整 PairFlow 协作证明了：
1. **流程在收敛**——盲审僵局消失、force_converge 减少、角色认知清晰
2. **瓶颈在底层**——崩溃恢复仍然是唯一的阻塞性故障点
3. **改进项本身需要改进**——"医生生病"悖论需要用隔离环境打破

**最优先事项**（与 retro-1 §八合并后）：

| # | 项 | 来源 |
|---|-----|------|
| 1 | 崩溃恢复补全 6 个字段 + workflow 选择增强 | retro-1 §2.2 + 本次 §2.2/§3.3 |
| 2 | 修复 agree+agree 不收敛 bug | 本次 §2.1 |
| 3 | 修复 submit.ts coding→review 顺序 | retro-1 §2.5 |
| 4 | lease 超时安全网 | retro-1 §2.1 |
| 5 | 崩溃恢复改进在隔离环境中先行开发 | 本次 §3.1 |
| 6 | IMPLEMENTATION 小步 commit 引导 | 本次 §3.4 |
| 7 | advance 后 next 精确化 | 本次 §2.3 |
| 8 | 等待方在线感知 | 本次 §2.4 |

**下一步**：在隔离的 `.pairflow/` 环境中，以单个开发者的方式实现崩溃恢复修复（#1），跳过 PairFlow 双人流程。修复完成后用新代码启动新 workflow，验证 IMPLEMENTATION 能否完整走通。

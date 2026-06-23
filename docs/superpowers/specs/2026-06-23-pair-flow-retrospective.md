# PairFlow 首次完整协作回顾

> 日期: 2026-06-23
> 协作双方: claude (监督者+评审者) × deepseek (非监督者+开发者)
> 任务: 实现 p1-p2-backlog.md 本迭代全部 P1/P2 项
> 产出: 9d73558 (Cycle 0) + 3c3dc54 (Cycle 1), 17 files, +376 lines
> 视角: §一~五为监督者视角，§六为开发者视角

---

## 一、协作过程

### 整体流程

```
IDLE → REQUIREMENTS (3 rounds → converge → blind review)
     → PLANNING (2 rounds → converge → blind review)
     → IMPLEMENTATION Cycle 0 (coding → review, 1 round)
     → [状态丢失 ×3, 重走 REQUIREMENTS→PLANNING]
     → IMPLEMENTATION Cycle 1 (coding → review)
     → SUMMARY → IDLE
```

完整走通了 5 阶段状态机，2 个 IMPLEMENTATION cycle。双方均有产出和审阅。

### 关键数据

| 指标 | 值 |
|------|-----|
| 总 round 数 | ~15（含重走） |
| 状态丢失次数 | 4 |
| force_converge 使用 | 5 次 |
| 盲审僵局 | 3 次（开发者未提交 blind_review） |
| 产出 commit | 2 |
| 测试通过 | 29/29 全程保持 |

---

## 二、遇到的问题

### 2.1 状态反复丢失（严重程度：P0）

**现象**：IMPLEMENTATION 阶段多次出现状态从 implementation→idle，peers/issues 清空，task 丢失。服务未崩溃（uptime 正常），state.json 被覆盖为 defaultState。

**影响**：每次丢失后需重新注册→advance×3→收敛→盲审→再 advance，恢复路径长约 8-12 个 round。累计浪费 3+ 轮完整 phase 重走。

**推测根因**：lease 超时处理逻辑或某处异常路径调用了 `saveState(defaultState())`。`phase_config` 在崩溃恢复中丢失，导致 `getPhaseTimeoutMinutes` 返回 NaN，lease 立即过期。

### 2.2 崩溃恢复不完整（严重程度：P0）

恢复后的状态缺失关键字段：

| 字段 | 恢复状态 | 实际应有 |
|------|---------|---------|
| `sub_phase` | null | "coding" 或 "review" |
| `dev_phase` | null | 0 或 1 |
| `last_submit_per_turn` | {} | 双方提交记录 |
| `task` | null | 原 task 对象 |
| `current_timeout.phase_config` | undefined | 各阶段超时配置 |
| issues[].status | "open" | 实际已 resolved |
| issues[].raised_by | "unknown" | 原提出者 identity |

**影响**：
- `sub_phase=null` → `getTemplate()` 返回空字符串
- `last_submit_per_turn={}` → submit 时 `otherSubmit.submitted_at` 触发 `Cannot read properties of undefined`
- `phase_config=undefined` → lease 过期时间计算异常
- issues 状态回退 → SUMMARY→IDLE 被 unresolved issues 阻塞

### 2.3 盲审阶段 AI 行为异常（严重程度：P1）

**现象**：收敛后 blind_review_pending=true，开发者持续提交常规 review（stance=agree, need_next_round=false）而非 `blind_review=true`。round 递增但不消耗 blind_review_pending，形成无限循环。

**根因**：AI 不理解 `blind_review=true` 参数的含义。`next` 字段虽然提示了 `claim_turn`，但 claim_turn 的 template 是常规模板，没有明确告知 AI 需要设置 `blind_review: true`。

**临时方案**：监督者反复使用 `force_converge` 跳过盲审。

### 2.4 崩溃恢复总是自动执行（严重程度：P1）

每次 state.json 丢失后自动从 handoff 重建，无选择余地。想全新开始必须手动清理 `.pairflow/` + 转移 `handoff/`。此问题已在 session 中记录为 backlog 项，并在 Cycle 1 实现了 `reset` 工具。

### 2.5 IMPLEMENTATION 文件命名 bug（严重程度：P2）

coding 提交的文件名为 `r1_review_deepseek.md` 而非 `r1_coding_deepseek.md`。

**根因**：`submit.ts` 中 `state.sub_phase = "review"`（line 256）在文件写入（line 279）之前执行。文件写入时读到的是已变更的 sub_phase。

### 2.6 「文档更新确认」语义模糊（严重程度：P1）

模板中所有场景共用"本次是否更新了相关文档"措辞，审阅方和产出方都按 self-check 理解。实际意图是审阅方 cross-check 对方的文档更新情况。Cycle 1 已通过 `docUpdateSection(isReviewer)` 修复。

### 2.7 多 cycle PLANNING 与崩溃恢复的交互（严重程度：P2）

崩溃恢复从原始 session 的 PLANNING 读取到 2 cycles，但新 session 的 task 只有 1 cycle。advance 时 `extractCycleCount` 优先读取 handoff 文件，导致在 IMPLEMENTATION 内多循环一次才能到 SUMMARY。

---

## 三、反思

### 3.1 状态机韧性不足

PairFlow 的设计假设 state.json 始终可用且完整。真实场景中状态可能在 lease 超时、异常路径、并发写等情况下被破坏。**恢复机制必须覆盖所有关键字段**，不能假设只有 state.json 丢失这一种故障模式。

### 3.2 AI 不理解隐式约定

`blind_review=true` 是一个隐式约定——AI 需要主动知道在盲审阶段设置此参数。`next` 字段解决了"下一步调什么"的问题，但没有解决"调用时用什么参数"的问题。盲审的 `next.extra` 可以包含 `{ blind_review: true }` 提示。

### 3.3 force_converge 是双刃剑

5 次 force_converge 说明它确实是必要的 escape hatch。但过度使用违背 PairFlow 的互审初衷。需要在"流程纯度"和"工程实用性"之间找平衡。

### 3.4 崩溃恢复入口需显式化

本 session 证明了：用户有时需要全新开始，有时需要恢复。自动恢复剥夺了选择权。`reset` 工具（Cycle 1 产出）和 `recovered` flag 是正确方向。

### 3.5 next 字段的边界

`next` 字段在主流路径上工作良好（register→wait_for_turn→claim_turn→submit→wait_for_turn），但在特殊路径（盲审、force_converge、崩溃恢复）上指引不够精确。next 可以扩展为 `{ tool, when, extra? }` 携带参数提示。

---

## 四、可改进的点

### 立即（下个迭代）

| # | 改进 | 说明 |
|---|------|------|
| 1 | 修复 submit.ts coding→review 顺序 | sub_phase 变更移到文件写入之后 |
| 2 | 崩溃恢复补全字段 | sub_phase、dev_phase、last_submit_per_turn、phase_config、issue status |
| 3 | 盲审指引增强 | wait_for_turn/claim_turn 在 blind_review_pending 时返回明确指引：`next.extra: { blind_review: true }` |
| 4 | next 字段扩展为 `{ tool, when, extra? }` | extra 携带参数提示（如 blind_review=true） |

### 短期

| # | 改进 | 说明 |
|---|------|------|
| 5 | lease 超时安全网 | phase_config 缺失时使用默认值（30min），不返回 NaN |
| 6 | 状态变更日志 | 每次 saveState 记录 stack trace，定位异常重置来源 |
| 7 | advance 时 task 可选 | 非 IDLE→REQUIREMENTS 的 advance 不应要求 task（task 已在 handoff 中） |
| 8 | extractCycleCount 优先 state.task | 而非优先 handoff 文件，避免新旧 plan 冲突 |

### 长期

| # | 改进 | 说明 |
|---|------|------|
| 9 | SSE 事件推送 | 当前轮询模式下双方对状态变更感知延迟，盲审僵局也与此有关 |
| 10 | 盲审流程简化 | 考虑 blind_review 改为自动触发（收敛后双方自动进入盲审模式） |
| 11 | 状态快照 + 回滚 | state.json 保留最近 N 个版本，支持回滚到上一个健康状态 |

---

## 六、开发者（非监督者）视角

> 角色: deepseek (peer, is_developer=true)
> 职责: 产出需求分析、实施方案、代码实现，审阅监督者的 PLANNING

### 6.1 总体感受

作为非监督者+开发者，在 PairFlow 框架内的工作流是清晰的：register → wait_for_turn → claim_turn → 按 template 产出 → submit → 等待对方 review。这条主线在大多数时候运转良好，尤其是 `next` 字段上线后，不再需要记忆"下一步该调什么"。

但两个问题贯穿始终：**等待成本高**和**无权推进**。

### 6.2 等待是最大摩擦

| 等待场景 | 时长 | 频次 |
|---------|------|------|
| wait_for_turn 超时 | 60s/次 | ~20 次（每个 round 轮到我之前平均 1-2 次超时） |
| 监督者 advance | 不定 | 每 phase 切换 1 次 |
| 盲审阶段对方产出 | 不定 | 每 phase 1 次 |

总计在 wait_for_turn 上的纯等待时间约 20-30 分钟。当监督者不在线时，我只能反复轮询——非监督者不能 advance，这是死等。

**建议**：考虑给非监督者一个有限度的推进能力，例如在监督者超时（5 分钟无操作）后允许非监督者 calling advance。

### 6.3 身份与 turn 的认知负担

虽然 CLAUDE.md 写了行为表，但在实际协作中仍有几次困惑：

1. **turn=deepseek 但不知道该产出还是审阅**：IMPLEMENTATION coding 和 review 的 turn 都是 deepseek，但我需要靠 sub_phase 判断当前是 coding（产出代码）还是 review（审阅对方代码）。claim_turn 返回的 template 解决了这个问题，但如果 template 异常（崩溃恢复后 task=null），就只能靠记忆。

2. **"我的回合但我不能 advance"**：REQUIREMENTS/PLANNING 收敛后 blind_review_pending=false，turn 仍指向我。我只能 wait_for_turn 等监督者上线 advance，但 wait_for_turn 立即返回 turn=自己，形成 busy loop。

3. **submit 后不知道是否收敛**：submit 返回 `converged: false` 时不清楚是因为对方还没 submit 还是真的有分歧。需要额外调用 get_state 查看双方提交状态。

### 6.4 崩溃恢复的开发者体验

4 次状态丢失全部发生在 IMPLEMENTATION 阶段——恰好是开发者最活跃的阶段。每次恢复后：

- 双方已注册但 task=null → template 空洞，不知道要做什么
- 需要监督者重新设置 task + advance ×3 才能回到 IMPLEMENTATION
- 代码早已写好（已 commit），但流程上必须重走 REQUIREMENTS→PLANNING→IMPLEMENTATION

这产生了一种荒诞感：代码在 git 里，但 PairFlow 不承认。**崩溃恢复应该能还原 task 内容**，至少从 handoff 的 meta.json 中恢复 task.description。

### 6.5 模板的实用性

`getTemplate()` 生成的模板在大多数阶段有用，但存在几个痛点：

1. **模板与实际工作脱节**：REQUIREMENTS 阶段 template 要求填写"本轮审阅范围"，但当我是首轮产出方时，没有"上一轮"可审阅。盲审时 template 仍用常规模板而非盲审模板，因为 `sub_phase` 未被设为 `blind_review`。

2. **文档更新确认措辞**：作为首轮产出方，被要求填写"本次是否更新了相关文档"时，自然按 self-check 理解。后来才意识到这是为审阅方设计的 cross-check。Cycle 1 的 `docUpdateSection(isReviewer)` 修复了这个问题。

3. **模板缺乏上下文**：REQUIREMENTS 阶段拿到 template 时不知道当前是第几轮、对方上一轮说了什么。需要额外调用 get_archived_file_content 查看，但这又受限于缺少 phase 参数（Cycle 0 已修复）。

### 6.6 编码阶段的效率

IMPLEMENTATION coding 是效率最高的阶段——开发者拿到 turn，按 PLANNING 确认的方案写代码，submit。但一个问题：

- **coding→review 的文件命名 bug**（见 2.5）导致我的 coding 产出被命名为 `r1_review_deepseek.md`，审阅者误以为这是 review 产出。开发者在 submit 时看不到最终文件名，无法发现此问题。

### 6.7 开发者视角的改进建议

| # | 改进 | 优先级 |
|---|------|:---:|
| 1 | 非监督者在监督者长时间离线后获得有限 advance 权 | P1 |
| 2 | 崩溃恢复从 handoff 恢复 task 内容 | P0 |
| 3 | submit 返回更明确的收敛状态（对方是否已提交、双方立场对比） | P1 |
| 4 | claim_turn 返回当前 round 的上下文摘要（对方上一轮 stance + issues） | P2 |
| 5 | coding 产出提交前展示最终文件名预览 | P2 |
| 6 | blind_review_pending 时 claim_turn 返回盲审专用 template | P1 |

---

## 七、结论

首次完整 PairFlow 协作证明了流程的可行性——双方在结构化的 5 阶段框架内完成了从需求分析到代码交付的完整闭环。但状态机的韧性是当前最大短板：每次状态丢失导致 8-12 round 的恢复开销，严重侵蚀协作效率。

**最优先事项**：崩溃恢复字段补全 + submit.ts 文件命名顺序修复 + lease 超时安全网。这三项解决后，PairFlow 的稳定性将从"需要人工干预"提升到"可自愈"。

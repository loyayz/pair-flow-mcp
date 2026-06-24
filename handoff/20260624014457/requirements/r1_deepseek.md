## 任务
- 描述：实现 PairFlow 关键缺陷修复——基于 retro-1 + retro-2 两次完整协作验证后确定的 6 项最高优先级改进
- 目标文档：docs/superpowers/specs/2026-06-24-pair-flow-retrospective-2.md
- 阶段目标：崩溃恢复字段补全；submit.ts 顺序修复；lease 安全网；全新开始机制；P2 不阻塞收敛；收敛后 turn 释放

---

## 本轮审阅范围
- 重新通读了以下章节：retro-1 §2.1/2.2/2.5、retro-2 §3.2/3.3/4.1/4.2/5、crash-recovery.ts(全文)、submit.ts(254-299)、claim-turn.ts(38-65,208-217)、register.ts(全文)、state.ts(全文)
- 本次修改涉及的章节：全部 6 项改进
- 未重新审阅的章节：无

---

## 需求分析

### 改进项概览

本次 6 项均来自 retro-1 + retro-2 中两次完整协作验证后确认的最高优先级缺陷：

| # | 改进项 | 来源 | 严重程度 | 涉及文件 |
|---|--------|------|:---:|---|
| 1 | 崩溃恢复字段补全 + 幽灵注册修复 | R1-§2.2 + R2-§4.2 | P0 | crash-recovery.ts, register.ts, state.ts |
| 2 | submit.ts coding→review 文件命名顺序 | R1-§2.5 | P1 | submit.ts |
| 3 | lease 超时安全网 | R1-§2.1 | P0 | claim-turn.ts |
| 4 | 崩溃恢复后显式 re-register 机制 | R2-§4.2 | P0 | register.ts, crash-recovery.ts |
| 5 | P2 issue 不阻塞非 IMPLEMENTATION 收敛 | R2-§3.3 | P1 | submit.ts |
| 6 | 收敛后非监督者 turn 释放给监督者 | R2-§3.2 | P1 | submit.ts, wait-for-turn.ts |

---

### #1 — 崩溃恢复字段补全

**问题**（retro-1 §2.2 + retro-2 §4.1 两次验证）：

| 字段 | 两次恢复值 | 正确恢复策略 |
|------|-----------|---------|
| `sub_phase` | null | 从 implementation/ 目录文件名推断 `r{N}_{subphase}_{identity}` |
| `dev_phase` | null 或不准 | 从 PLANNING 文档 parse 循环总数 + 已完成 coding 次数计算 |
| `last_submit_per_turn` | {} | 从当前 phase 目录最新 meta.json 重建双方 LastSubmit |
| `raised_by` | "unknown" | 从 meta.json 或 filenames 中恢复原始 identity |
| `phase_config` | undefined | 使用默认值 `{requirements:10, planning:10, implementation:60, summary:30}` |
| `issues[].proposal/rationale` | null | 从 meta.json 复原（当前已丢失） |

**实现**：`reconstructFromHandoff()` 中补全上述 6 个字段的恢复逻辑。sub_phase 从文件名推断，dev_phase 从 planning 文档 + implementation 文件推断，last_submit 从 meta.json 聚合。

---

### #2 — submit.ts 文件命名顺序修复

**问题**（retro-1 §2.5）：`state.sub_phase = "review"`（line 256）在文件写入（line 287）之前执行，导致 coding 产出被命名为 `r1_review_*.md`。

**修复**：将 sub_phase 变更移到文件写入之后（line 289 之后），同时删除冗余的 safety net（lines 292-294）。条件增加 `!blindReview` 避免影响盲审路径。

---

### #3 — lease 超时安全网

**问题**（retro-1 §2.1）：`getPhaseTimeoutMinutes()` 在 phase_config 为 undefined 时返回 NaN，lease 立即过期。

**修复**：在 `getPhaseTimeoutMinutes` 中增加 nullish 检查，每个 case 使用 `?? 30` 默认值。同时 `defaultState()` 确保 phase_config 初始化。

---

### #4 — 崩溃恢复后显式 re-register

**问题**（retro-2 §4.2「幽灵注册」）：崩溃恢复从 handoff 文件名重建 peers，但 AI 未重新调用 register。state 认为双方已注册，实际一方不在线。

**修复方案**：
- `register` 工具增加 `fresh_start: boolean` 参数
- 崩溃恢复后 peers 增加 `recovered: true` 标记
- 带 `fresh_start=true` 的 register 调用可重置 recovered peers 的在线状态
- 或者更简单：崩溃恢复检测到 `recovered=true` 时，要求双方重新 register（现有的 register 调用对已注册 identity 做 re-confirm）

**推荐方案**：register 对已存在的 identity 做幂等更新（`registered_at` 置为当前时间），崩溃恢复在 state 上设 `require_re_register: true` flag。wait_for_turn 若 flag 为 true 则提示需要 re-register。

---

### #5 — P2 不阻塞非 IMPLEMENTATION 收敛

**问题**（retro-2 §3.3 + §5）：PLANNING 阶段因 4 个 P2 issue 导致无法自然收敛，需 force_converge。REQUIREMENTS 阶段也因类似原因被阻塞。

**修复**：`submit.ts` 收敛检查逻辑修改——非 IMPLEMENTATION 阶段的 `bothEmpty` 检查改为「双方均无新增 P0/P1 issue」而非「双方均无新增 issue」。P2 记录但不阻塞收敛。

---

### #6 — 收敛后 turn 释放

**问题**（retro-2 §3.2）：converged=true 且 blind_review_pending=false 时，turn 仍指向非监督者，形成 busy loop。

**修复**：submit 检测到收敛后，若 `!blind_review_pending`，立即将 turn 切换到监督者。wait_for_turn 检测到 converged && turn=自己 && 非监督者 时，返回明确提示而非 `claim_turn`。

---

## 实现顺序

```
#3 (lease 安全网) → #2 (submit 顺序) → #1 (恢复字段补全) → #4 (re-register) → #5 (P2 不阻塞) → #6 (turn 释放)
```

理由：
- #3 先行——基础设施安全网，2 行修改
- #2 独立简单，1 文件修改
- #1 + #4 是最核心的崩溃恢复改进，逻辑关联紧密
- #5 + #6 是收敛逻辑修改，依赖前 4 项的验证环境

全部 6 项在 1 个 IMPLEMENTATION cycle 内完成（改动量小，~100 行总计）。

---

## 文档更新确认
- 本次产出是否需要配套文档更新：否
- 如未更新，原因：需求分析阶段不涉及文档变更。实现后更新 CLAUDE.md 中崩溃恢复和收敛相关行为约束

---

## 收敛状态
- 本轮新增 issue：P0：0，P1：0，P2：0
- 本轮关闭 issue：无
- 对对方上一轮产出的立场：null（首轮产出方）
- 是否需要下一轮：null

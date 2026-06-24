# PairFlow 未完成问题

> 日期: 2026-06-24
> 来源: 合并 `2026-06-24-unresolved-claude.md` + `2026-06-24-unresolved-deepseek.md`
> 已修复: 7 个确定 bug（P0×3 + P1×2 + P2×2），详见 `docs/issue/2026-06-24-unresolved-claude.md` §九

---

## 汇总

| 级别 | 优化项 | 建议 | 合计 |
|------|:---:|:---:|:---:|
| P1 | 12 | 1 | **13** |
| P2 | 8 | 3 | **11** |
| **合计** | **20** | **4** | **24** |

---

## 一、P1（13 项）

### 收敛/盲审

| # | 问题 | 来源 | 说明 |
|---|------|------|------|
| P1-1 | 非 IMPLEMENTATION 盲审不可跳过 | retro-3 #20 | 双方 2 轮 agree + 无 P0/P1 + 无新增 issue 时盲审价值有限 |
| P1-2 | force_converge 审计日志 | retro-3 #21 | 记录每次 force_converge 原因和上下文 |

### 指引/提示增强

| # | 问题 | 来源 | 说明 |
|---|------|------|------|
| P1-3 | next 扩展为 `{tool, when, extra?}` | retro-1 §四 #4 | extra 携带参数提示（如 `blind_review: true`） |
| P1-4 | 盲审指引增强 | retro-1 §四 #3 | wait_for_turn/claim_turn 在 `blind_review_pending` 时返回盲审专用指引 |
| P1-5 | submit 返回更明确收敛状态 | retro-1 §六 #3 | 对方是否已提交、双方立场对比 |
| P1-6 | claim_turn 返回上下文摘要 | retro-1 §六 #4 | 当前 round 对方上一轮 stance + issues |
| P1-7 | 服务重启后明确 re-register 信号 | retro-4 #24 | claim_turn/get_state 均携带 re-register 信息，不只是 wait_for_turn |

### 基础设施

| # | 问题 | 来源 | 说明 |
|---|------|------|------|
| P1-8 | 测试套件隔离未实战验证 | retro-1 §7.2 | 部分完成（`1edfb53`），未在真实多 AI 场景验证 |
| P1-9 | rules_catalog 不完整 | p1-p2-backlog §一 | P1-72（catalog lint）+ P1-73（trigger 过滤），仅 14 条 |
| P1-10 | get-state 白名单维护风险 | retro-4 §3.2 | 已导致 retro-4 bug #3，建议改黑名单过滤 |
| P1-11 | 状态变更日志 | retro-1 §四 #6 | 每次 saveState 记录 stack trace 定位异常重置 |
| P1-12 | advance 时 task 可选（非 IDLE） | retro-1 §四 #7 | 非 IDLE→REQUIREMENTS 的 advance 不应要求 task 参数 |

### 角色/体验

| # | 问题 | 来源 | 说明 |
|---|------|------|------|
| P1-13 | 非监督者在恢复场景获得催促能力 | retro-4 #25 | 不一定是 advance 权，但可发送"我在线了"信号 |

---

## 二、P2（11 项）

| # | 问题 | 来源 | 说明 |
|---|------|------|------|
| P2-1 | P2-18 need_next_round null 文档标注 | p1-p2-backlog §二 | 方案 A：明确标注 null 语义，未执行 |
| P2-2 | SSE 事件推送 | auto-flow-blockers §1 | v2 考虑，当前降级为 wait_for_turn 轮询 |
| P2-3 | design.md §14 阶段判定过时 | current-state §一 | spec 标记 Phase 0，代码已完成 Phase 0-3 |
| P2-4 | 盲审流程简化（收敛后自动盲审） | retro-1 §四 #10 | 流程重设计，改变盲审触发方式 |
| P2-5 | 状态快照 + 回滚 | retro-1 §四 #11 | state.json 保留最近 N 个版本 |
| P2-6 | coding 产出前展示文件名预览 | retro-1 §六 #5 | 开发者 submit 时看不到最终文件名 |
| P2-7 | force_converge 使用频率告警 | retro-2 #16 | 同 session 超过 2 次时向双方发送提示 |
| P2-8 | PLANNING 后自动注入里程碑到 coding 模板 | retro-1 §六 #4 | IMPLEMENTATION coding 模板不包含计划摘要 |
| P2-9 | multi-cycle advance 缺少 fallback 警告 | retro-3 | totalCycles 解析失败时静默而非告知双方 |
| P2-10 | advance 前统一 issue 拦截 warning | auto-flow-blockers §2 | 仅 SUMMARY→IDLE 有 hard check，其他 phase 应加 warning |
| P2-11 | wait_for_turn 轮询间隔优化 | retro-2 #15 | 10s 间隔 → 考虑双阶段（前 30s 用 2s，之后 10s） |

---

## 三、分类汇总

| 级别 | 优化项 | 建议 | 合计 |
|------|:---:|:---:|:---:|
| P1 | 12 | 1 | 13 |
| P2 | 8 | 3 | 11 |
| **合计** | **20** | **4** | **24** |

> P0 级别已清零。7 个确定 bug（含盲审+收敛完整缺陷链）已于 2026-06-24 全部修复，code review 追加 3 处联动修复。详见 `docs/issue/2026-06-24-unresolved-claude.md` §九。

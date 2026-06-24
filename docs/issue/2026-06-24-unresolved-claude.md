# 独立分析：PairFlow 全量未解决问题清单

> 产出方: claude（监督者 + 评审者）
> 日期: 2026-06-24
> 范围: `docs/superpowers/specs/` 下全部 9 个文档
> 方法: 逐文档提取所有改进项/问题/待办，已标记"已实现"的项对照代码库验证

---

## 汇总

| 级别 | 文档标记已实现 | 验证确认已实现 | 未实现/待实现 | 总计 |
|------|:---:|:---:|:---:|:---:|
| P0 | 20 | 17 | 3 | 20 |
| P1 | 7 | 7 | 14 | 21 |
| P2 | 3 | 0 | 10 | 10 |
| **合计** | **30** | **24** | **27** | **51** |

> 注：3 个文档标记"已实现"的项经代码验证为**伪实现**或**链路未打通**。

---

## 一、P0 — 未实现（3 项）

### P0-1: IMPLEMENTATION 无法自然收敛

- **来源**: retro-3 §2.3, §4.1, §6.2; deepseek issue #1
- **描述**: coding 提交 `stance=null`（产出方语义），submit.ts 收敛条件要求双方 `stance=agree`。在 coding→review→fix 子阶段模型下，此条件永远无法满足。IMPLEMENTATION 阶段**永远需要 force_converge**。
- **代码验证**: `submit.ts:247-249` 的收敛检查 `bothAgree` 要求两个 submit 的 stance 都是 "agree"。coding 产出方传 `stance=null` → 收敛永远 false。
- **影响**: 每轮 IMPLEMENTATION 必须 force_converge，流程完整性受损。
- **方案**: retro-3 #17 — IMPLEMENTATION 收敛仅依赖 review 方 `stance=agree + need_next_round=false`。

### P0-2: 盲审模板永不触发

- **来源**: retro-3 §4.2, §9.4; deepseek issue #2
- **描述**: `template.ts:59` 通过 `state.sub_phase === "blind_review"` 判断是否返回盲审模板。但 `claim-turn.ts:43-49` 处理盲审 turn 时仅设置 `state.turn = identity`，**不设置** `state.sub_phase = "blind_review"`。`submit.ts:165` 的 `sub_phase` 是归档元数据字段，非 state 字段。盲审模板代码为**死代码**。
- **代码验证**: 
  - `template.ts:59`: `const isBlindReview = sub === "blind_review";`
  - `claim-turn.ts:43-49`: 盲审分支只设 `state.turn`，无 `state.sub_phase` 修改
  - 全代码库搜索 `state.sub_phase = "blind_review"` → **0 结果**
- **影响**: AI 在盲审时拿到常规模板，需手动切换思维模式、手动传 `blind_review: true`。认知负担高，易出错。
- **方案**: retro-3 #19 — claim_turn 在 `blind_review_pending=true` 时设置 `state.sub_phase = "blind_review"`，或 template.ts 改为检查 `state.blind_review_pending`。

### P0-3: 盲审收敛链路断裂——盲审在收敛后而非收敛前

- **来源**: retro-3 §4.1, §6.1; deepseek issue #3
- **描述**: 当前流程：`双方 agree → converged=true + blind_review_pending=true → 盲审 → ... → force_converge`。盲审的设计意图是"收敛前最后检查"，但 `submit.ts:252-253` 在**收敛成立后**才设置 `blind_review_pending=true`。盲审完成后不存在"盲审确认提交"环节——converged 已经是 true，双方无法再提交 agree。
- **代码验证**: `submit.ts:249-253`: `converged = true; state.converged = true; state.blind_review_pending = true;`
- **影响**: 盲审变为"收敛后额外步骤"，盲审完成后必须 force_converge 清除状态。
- **方案**: retro-3 #18 — 盲审改为收敛前置：先盲审 → 盲审无问题 → 再 submit agree → 收敛。需重构 submit.ts 收敛逻辑。

---

## 二、P0 — 已验证已实现（17 项）

| # | issue | 来源 | 验证结果 |
|---|-------|------|:---:|
| P0-13 | defer 约束 + advance check | process-improvements §1 | ✅ `claim-turn.ts:148-168` |
| P0-14 | SUMMARY 未解决 issue 检查 | process-improvements §5 | ✅ `claim-turn.ts:193-203` |
| P0-15 | 开发者自审硬校验 | process-improvements §6 | ✅ `submit.ts:64-66` |
| P0-16 | 评审者独立测试硬校验 | process-improvements §7 | ✅ `submit.ts:68-70` |
| P0-19 | wait_for_turn 长轮询 | auto-flow-blockers §1 | ✅ 已实现 |
| P0-20 | task 上下文传递 | auto-flow-blockers §2 | ✅ `claim-turn.ts:94-99` |
| P0-21 | task 缺失拒绝 advance | auto-flow-blockers §3 | ✅ `claim-turn.ts:95-96` |
| P0-22 | submit 存储层修复 | auto-flow-blockers §4 | ✅ proposal/rationale 不再 null |
| P0-28 | work_dir 校验 | process-improvements §17 | ✅ `register.ts:54-62` |
| — | crash-recovery + require_re_register | retro-2 §4.2 | ✅ epoch sentinel 已验证 |
| — | lock 心跳 + crash_count 修复 | current-state §3.4 | ✅ `lock.ts:62` |
| — | 崩溃恢复字段补全（6 字段） | retro-1 §2.2 | ✅ sub_phase/dev_phase/last_submit 等 |
| — | wait_for_turn 600s | retro-2 §七-A | ✅ `wait-for-turn.ts:9` |
| — | findLatestWorkflowId 时间戳 | retro-2 §七-B | ✅ `crash-recovery.ts` |
| — | submit.ts 文件命名修复 | retro-1 §2.5 | ✅ `submit.ts:288-290` |
| — | lease 安全网 | retro-1 §2.1 | ✅ `claim-turn.ts:208-219` |
| — | P0-22 bootstrap/角色边界 | current-state §二 | ✅ 服务端已 enforce |

---

## 三、P1 — 未实现（14 项）

### 收敛/盲审相关（retro-3 遗留）

| # | 问题 | 来源 | 说明 |
|---|------|------|------|
| P1-1 | 非 IMPLEMENTATION 盲审不可跳过 | retro-3 #20 | 双方 2 轮 agree + 无 P0/P1 + 无新增 issue 时盲审价值有限，应可配置跳过 |
| P1-2 | force_converge 审计日志 | retro-3 #21 | 记录每次 force_converge 原因和上下文 |

### 指引/提示增强

| # | 问题 | 来源 | 说明 |
|---|------|------|------|
| P1-3 | next 扩展为 `{tool, when, extra?}` | retro-1 §四 #4 | extra 携带参数提示（如 `blind_review: true`），盲审场景当前无参数指引 |
| P1-4 | 盲审指引增强 | retro-1 §四 #3 | wait_for_turn/claim_turn 在 blind_review_pending 时返回盲审专用指引 |
| P1-5 | submit 返回更明确收敛状态 | retro-1 §六 #3 | 对方是否已提交、双方立场对比 |
| P1-6 | claim_turn 返回上下文摘要 | retro-1 §六 #4 | 当前 round 对方上一轮 stance + issues |
| P1-7 | 服务重启后明确 re-register 信号 | retro-4 #24 | claim_turn/get_state 均携带 re-register 信息，不只是 wait_for_turn |

### 基础设施

| # | 问题 | 来源 | 说明 |
|---|------|------|------|
| P1-8 | 测试套件隔离未实战验证 | retro-1 §7.2 | 部分完成（commit `1edfb53`），但未在真实多 AI 场景中验证 |
| P1-9 | rules_catalog 不完整 | p1-p2-backlog §一 | P1-72（catalog 覆盖率 lint）+ P1-73（trigger 过滤不完整），仅 14 条规则 |
| P1-10 | get-state 白名单维护风险 | retro-4 §3.2 | 新增字段需手动更新 get-state.ts（retro-4 bug #3），建议改为黑名单过滤 |
| P1-11 | 状态变更日志 | retro-1 §四 #6 | 每次 saveState 记录 stack trace，定位异常重置来源 |
| P1-12 | advance 时 task 可选 | retro-1 §四 #7 | 非 IDLE→REQUIREMENTS 的 advance 不应要求 task（task 已在 handoff 中） |
| P1-13 | extractCycleCount 优先 state.task | retro-1 §四 #8 | 当前优先 handoff 文件，新旧 plan 冲突时取旧值 |

### 角色/体验

| # | 问题 | 来源 | 说明 |
|---|------|------|------|
| P1-14 | 非监督者在恢复场景获得催促能力 | retro-4 #25 | 不一定是 advance 权，但至少可发送"我在线了"信号 |

---

## 四、P1 — 已验证已实现（7 项）

| # | issue | 来源 | 验证结果 |
|---|-------|------|:---:|
| P1-17 | IMPLEMENTATION 文件命名含 sub_phase | process-improvements §8 | ✅ `submit.ts:288-290`: `r{seq}_{subTag}_{identity}.md` |
| — | next 字段 — 接口返回值引导 AI 下一步 | p1-p2-backlog §一 | ✅ 所有工具返回含 `next` 字段 |
| — | 文档更新确认语义修复 | p1-p2-backlog §一 | ✅ `template.ts` isReviewer 区分 |
| — | 崩溃恢复 opt-out（recovered flag + reset） | p1-p2-backlog §一 | ✅ 已实现 |
| — | get_archived_file_content phase 参数 | p1-p2-backlog §一 | ✅ 已实现 |
| — | P0-26 clean 脚本 + orphan 预警 | p1-p2-backlog §一 | ✅ 已实现 |
| — | lock 僵尸覆写 crash_count 重置 | current-state §3.4 | ✅ `lock.ts:62`: `existing.crash_count = 0` |

---

## 五、P2 — 未实现（10 项）

| # | 问题 | 来源 | 说明 |
|---|------|------|------|
| P2-1 | P2-18 need_next_round null 文档标注 | p1-p2-backlog §二 | 方案 A：明确标注 null 语义，未执行 |
| P2-2 | SSE 事件推送 | auto-flow-blockers §1 | v2 考虑，当前降级为 wait_for_turn 轮询 |
| P2-3 | design.md 阶段判定过时 | current-state §一 | spec 标记 Phase 0，代码已完成 Phase 0-3，文档滞后 |
| P2-4 | 多 cycle totalCycles=null 隐患 | retro-3 §六 | handoff 不可读时 `extractCycleCount` 返回 null，跳过 cycle check |
| P2-5 | 盲审流程简化 | retro-1 §四 #10 | 收敛后自动进入盲审模式，减少手动步骤 |
| P2-6 | 状态快照 + 回滚 | retro-1 §四 #11 | state.json 保留最近 N 个版本，支持回滚 |
| P2-7 | coding 产出前展示文件名预览 | retro-1 §六 #5 | 开发者在 submit 时看不到最终文件名 |
| P2-8 | force_converge 使用频率告警 | retro-2 #16 | 同 session 中超过 2 次 force_converge 时向双方发送提示 |
| P2-9 | PLANNING 后自动注入里程碑到 coding 模板 | retro-1 §六 #4 / P1-25b | IMPLEMENTATION coding 模板不包含计划摘要 |
| P2-10 | multi-cycle advance 缺少 fallback | current-state / retro-3 | 当 totalCycles 解析失败时静默跳到 SUMMARY 而非告知双方 |

---

## 六、伪实现 / 链路未打通（3 项 — 已归入 P0/P1 未实现）

| 文档标记 | 实际问题 | 归入 |
|---------|---------|:---:|
| "盲审模板" 已实现 | `getTemplate()` 有盲审分支但 `sub_phase` 从未设为 `"blind_review"` — 死代码 | P0-2 |
| "盲审完成" 流程已实现 | 盲审在收敛后触发，完成后无确认环节 — 链路断裂 | P0-3 |
| "收敛模型" 已实现 | IMPLEMENTATION coding stance=null 永远无法满足双方 agree 条件 | P0-1 |

---

## 七、补充发现（deepseek 分析未覆盖）

以下问题来源于 `auto-flow-blockers.md` 和 `process-improvements.md`，在 deepseek 的 14 个 issue 中未出现：

| # | 问题 | 来源 | 级别 |
|---|------|------|:---:|
| S1 | advance 前统一 issue 拦截仅 SUMMARY→IDLE 有，其他阶段缺失 | auto-flow-blockers §2 / process-improvements §1 | P1 |
| S2 | meta.json 不存 task 字段，崩溃恢复后 task 丢失（已部分修复但 meta.json 仍未存储 task） | process-improvements §4 / retro-1 §6.4 | P1 |
| S3 | lock.ts 僵尸覆写路径曾遗漏 crash_count 重置（已修复，仅记录） | current-state §3.4 | — |
| S4 | multi-cycle advance: extractCycleCount 优先 handoff 文件而非 state.task | retro-1 §四 #8 | P1 |

---

## 八、优先级建议

### 本轮必须修复（P0 ×3）
1. **P0-1**: IMPLEMENTATION 收敛仅依赖 review 方 stance（retro-3 #17）
2. **P0-2**: claim_turn 盲审时设置 sub_phase = "blind_review"（retro-3 #19）
3. **P0-3**: 盲审改为收敛前置（retro-3 #18）

### 本轮建议修复（P1 ×5）
- P1-3: next 扩展 `extra` 携带参数提示
- P1-10: get-state 白名单改黑名单
- P1-8: 测试套件隔离实战验证
- P1-2: force_converge 审计日志
- P1-5: submit 返回更明确收敛状态

### 延后（P1 ×9 + P2 ×10）
- 其余 P1 项和全部 P2 项可在后续迭代处理

---

## 九、验证方法说明

对每个文档标记"已实现"的项，通过以下方式验证：

1. **Grep 代码库**搜索关键函数/字段，确认实现存在
2. **Read 关键文件**检查逻辑正确性（非仅存在声明）
3. **交叉验证**：多个文档声称同一项已实现时，只在一个位置验证
4. **链路追踪**：对关键路径（盲审、收敛、advance）追踪完整调用链

**验证发现的 3 个伪实现**的共同特征：底层机制存在（`getTemplate` 有盲审分支、submit.ts 有收敛逻辑、盲审有 `blind_review_pending` 字段），但上游调用链未正确设置前置状态（`sub_phase` 不设置、收敛时机错误），导致机制**存在但不可达**。

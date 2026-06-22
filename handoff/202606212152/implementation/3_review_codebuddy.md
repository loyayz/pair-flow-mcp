# 3_review_codebuddy.md — Phase 3 异常+归档 review

> identity: codebuddy（评审者，is_developer=false）
> phase: implementation | dev_phase: 3 | sub_phase: review | round: 1
> bootstrap 阶段：手动归档
> commit_hash: 07041f7（本轮 submit 所基于的仓库 HEAD）

## 本轮审阅范围

- 重新通读了以下文件：`src/crash-recovery.ts`（§8 崩溃恢复全流程）、`src/__tests__/crash-recovery.test.ts`（3 新测试）、`src/index.ts`（initializeRecovery 启动调用）、`src/tools/submit.ts`（fix_review_cycles 僵持检测 line 149-156）
- 本次修改涉及的章节：无（review 轮不改代码）
- 未重新审阅的章节：Phase 0/1/2 已审查文件

**注**：Phase 3 仅产出 `3_coding_claude.meta.json`，无 `3_coding_claude.md`（coding 描述文档缺失——P1-74）。

---

## 一、交付物核查（计划草案 v2 Phase 3 对比）

| 计划草案交付物 | 实际产出 | 状态 |
|---|---|---|
| 崩溃恢复（§8 全流程）| crash-recovery.ts step 0+1+2+5+7 | ⚠️ 缺 step 3/4/6（P1-75） |
| 僵持检测（fix_review_cycles）| submit.ts line 149-156 | ✅ |
| lease 超时（5min grace + mutex 竞态）| **未实现**（P0-11） | ❌ |
| get_archived_files + get_archived_file_content | Phase 2 已实现 ✅ | ✅ |
| pairflow.log（JSONL + 10MB 轮转）| Phase 1 已实现 ✅ | ✅ |
| GET /health | Phase 0 已实现 ✅ | ✅ |
| 进程管理（崩溃自动重启 + crash loop）| lock.ts 已实现，但 **index.ts 无自动重启**（P1-76） | ⚠️ |
| 锁机制 | Phase 1 已实现 ✅ | ✅ |
| P1-68 工具行为测试（**必须**）| **第三次 defer，未声明**（P0-12） | ❌ |
| 回归测试（P1-50 Phase 4）| N/A（Phase 4） | — |

**交付物完整度**：6/10。lease 超时未实现（P0-11）+ P1-68 第三次 defer（P0-12）+ 崩溃恢复缺步骤（P1-75）。

---

## 二、P0 问题（阻塞）

### P0-11: §9 Lease 超时机制完全未实现

**定位**：全项目

**问题**：§9 Lease 机制是 Phase 3 交付物（计划草案"lease 超时（5min grace + mutex 竞态）"）。搜索全项目：

- 无 timer/setTimeout 实现 lease 超时
- 无 grace 机制（5min grace + grace_used 标记）
- 无 mutex 竞态处理（timer vs submit 抢锁）
- state.json 有 `current_lease` + `current_timeout` 字段，claim_turn 设置 expires_at，但**无任何代码检查超时或触发超时处理**

§9 核心机制：
1. turn 超时 → lease 超时 + grace 过期 → 强制释放 turn
2. grace 降级 turn 回退（submit 带 token 在 grace 内可回退 turn）
3. mutex 竞态处理（timer vs submit 串行化）
4. advance 超时 → converged=true 后超时未 advance → 提醒监督者

当前 claim_turn 设置 `expires_at` 但无人检查——lease 永不过期。持笔者可永久持有 turn。

**影响**：持笔者崩溃/离线后 turn 永远不释放，另一方无法 claim。协作卡死。

### P0-12: P1-68 工具行为测试第三次 defer 且未声明

**定位**：Phase 3 coding meta.json + 全测试目录

**问题**：P1-68（原 P1-60）工具行为测试：
- Phase 1 review：defer Phase 2（"需 server 启动"）
- Phase 2 coding：defer Phase 2 fix（meta.json deferred 含 P1-68）
- Phase 2 fix：defer Phase 3（coding.md "defer: P1-68"）
- Phase 2 review3：我明确标注"P1-68 defer Phase 3（**必须**补充）"
- **Phase 3 coding：meta.json deferred = ["P1-58", "P1-72"]——P1-68 不在列表中，也未实现**

Phase 3 新增 3 个崩溃恢复测试（17/17 pass），但**零工具行为测试**。§13 Phase 3 测试项明确要求：
- 并发 safety（mutex 串行化 + 双端同时 claim）
- lease + grace（超时 late submit + grace 单次 + 过期拒绝）
- 崩溃恢复（已覆盖 3 项）
- 僵持检测（P0 多轮递增 → 通知监督者）

当前 17 项测试分布：9 who-am-i + 5 state-machine + 3 crash-recovery。**Phase 2/3 的 11 项测试需求零覆盖**：
- register/claim_turn/submit 工具行为（P1-68）
- Issue CRUD + escalate + force_converge
- 盲审独立性/收敛循环/无发现 advance
- 并发 safety
- lease + grace
- 僵持检测

**影响**：代码无测试保障。P0-11（lease 超时）即使实现也无测试验证。§14 判定 23"崩溃恢复 + 僵持全正确"无法证明——仅 3 个崩溃恢复测试不等于"全正确"。

---

## 三、P1 问题

### P1-74: Phase 3 coding 描述文档缺失

**定位**：handoff/implementation/

**问题**：Phase 0/1/2 都有 `N_coding_claude.md`（实现策略描述），Phase 3 仅有 `3_coding_claude.meta.json`，无 `.md`。coding 描述文档是归档产出的一部分——记录实现策略、交付物清单、设计决策。缺失影响归档完整性。

### P1-75: 崩溃恢复缺 step 3/4/6

**定位**：`src/crash-recovery.ts`

**问题**：§8 崩溃恢复 8 步，crash-recovery.ts 实现：

| Step | spec 内容 | 实现 |
|---|---|---|
| 0 | workflow_id 恢复（IDLE 跳过 + 已完成过滤）| ✅ line 17-30 |
| 1 | 扫描 meta.json 重建 issue | ✅ line 32-53 |
| 2 | replay journal | ✅ line 55-69 |
| 3 | 孤儿文件处理（md 存在 meta 存在 → 重建 history + 翻转 turn/推进 round）| **❌ 缺失** |
| 4 | md 无 meta → 不完整 submit 忽略 | **❌ 缺失**（step 1 catch 跳过但不区分） |
| 5 | 清除 current_lease | ✅ line 72 |
| 6 | 重启 timer（active+未过期 → setTimeout；active+过期 → 触发超时）| **❌ 缺失** |
| 7 | IDLE 崩溃 peers=[] | ✅ line 17-23 |

step 3（孤儿文件）是崩溃恢复的核心——"写入中途崩溃（md+meta 已写但 state.json 未写）：恢复时用已写的 md+meta 修补 state.json"。当前完全缺失——崩溃在 submit 写入中途，state.json 丢失该次 submit，但 md+meta 已落盘，恢复时不会重建。

step 6（重启 timer）依赖 P0-11（lease 超时）——lease 未实现，timer 无从重启。

### P1-76: index.ts 无崩溃自动重启

**定位**：`src/index.ts`

**问题**：§15 进程管理要求"崩溃自动重新监听 localhost:3100"。当前 index.ts 的 `httpServer.listen` 无 crash 处理——进程崩溃后直接退出，需手动重启。lock.ts 有 crash loop 检测但无自动重启逻辑。

### P1-77: 僵持检测未实现"连续 5 轮通知监督者"

**定位**：`src/tools/submit.ts` line 149-156

**问题**：§5.5 IMPLEMENTATION P0 循环保护："当 counter ≥ 2 时 get_state 返回 escalation_recommended。若连续 5 轮仍未解决，僵持检测介入通知监督者"。

当前 submit.ts 在 review 时递增 fix_review_cycles ✅。get_state 计算 escalation_recommended（fix_review_cycles≥2）✅（Phase 2 P1-67）。但**无"连续 5 轮"检查**——counter≥2 后持续递增，无上限通知。

§5.5："counter 在 issue 被 resolve 或 escalate 时重置"——当前 resolve/escalate 也未重置 fix_review_cycles。

---

## 四、独立验证

| 项目 | 结果 |
|---|---|
| vitest | 17/17 pass（9+5+3）✅ |
| tsc | 隐含通过 ✅ |
| crash-recovery.ts | step 0+1+2+5+7 实现，step 3/4/6 缺失 |
| lease 超时 | **完全未实现** |
| P1-68 工具行为测试 | **零覆盖** |

---

## 五、review 立场

**stance**: `disagree`

**need_next_round**: `true`

**理由**：2 个 P0 阻塞 + 4 个 P1：

1. **P0-11**: §9 Lease 超时机制完全未实现——lease 永不过期，持笔者崩溃后 turn 永不释放
2. **P0-12**: P1-68 工具行为测试第三次 defer 且未声明——Phase 3 计划明确要求，§13 测试项零覆盖
3. P1-74: coding 描述文档缺失
4. P1-75: 崩溃恢复缺 step 3/4/6（孤儿文件处理是核心）
5. P1-76: 无崩溃自动重启
6. P1-77: 僵持检测缺"连续 5 轮"+ counter 重置

**fix 轮要求**（优先级排序）：
1. P0-11: 实现 lease 超时（timer + grace + mutex 竞态 + advance 超时提醒）
2. P0-12: 补充工具行为测试（至少 register/claim_turn/submit + Issue CRUD + lease/grace + 僵持检测）
3. P1-75: 崩溃恢复 step 3/4（孤儿文件处理）+ step 6（timer 重启，依赖 P0-11）
4. P1-77: 僵持检测"连续 5 轮"+ resolve/escalate 重置 counter
5. P1-74: 补 coding.md
6. P1-76: 崩溃自动重启（可 defer Phase 4）

---

## 六、issue 汇总

| ID | 级别 | 主题 |
|---|---|---|
| P0-11 | P0 | §9 Lease 超时机制完全未实现 |
| P0-12 | P0 | P1-68 工具行为测试第三次 defer 且未声明 |
| P1-74 | P1 | Phase 3 coding 描述文档缺失 |
| P1-75 | P1 | 崩溃恢复缺 step 3/4/6 |
| P1-76 | P1 | index.ts 无崩溃自动重启 |
| P1-77 | P1 | 僵持检测缺"连续 5 轮" + counter 重置 |

---

## 收敛状态

- 本轮新增 issue：P0：2，P1：4，P2：0
- 本轮关闭 issue：无
- stance: disagree
- need_next_round: true
- 对对方上一轮产出的立场：disagree（P0-11 lease 未实现 + P0-12 测试三次 defer）
- 是否需要下一轮：yes

**按 §5.5 推进表**：review stance=disagree + need_next_round=true → sub_phase=fix, turn→开发者(claude), round→2。

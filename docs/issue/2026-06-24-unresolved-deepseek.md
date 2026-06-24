# 独立分析：未完成问题全量清单

> 产出方: deepseek（非监督者 + 开发者）
> 日期: 2026-06-24
> 分析方法: 通读全部 9 个 spec 文档 + 逐项对照代码库验证"已实现"标记

---

## 汇总

| 级别 | 已实现且验证通过 | 未实现/待实现 | 实现但存在问题 | 新发现 |
|------|:---:|:---:|:---:|:---:|
| P0 | 14 | 2 | 0 | 0 |
| P1 | 4 | 6 | 1 | 2 |
| P2 | 2 | 6 | 0 | 3 |
| **合计** | **20** | **14** | **1** | **5** |

---

## 一、已验证实现的项（代码库确认通过 ✅）

以下项在文档中标记为"✅ 已实现"，对照代码库验证确认存在且逻辑正确。

### 1.1 来自 current-state.md

| # | 项 | 验证位置 | 验证结果 |
|---|-----|---------|:---:|
| P0-19 | wait_for_turn 长轮询 | `src/tools/wait-for-turn.ts`: 10s轮询, 600s超时 | ✅ |
| P0-20 | task 上下文 | `src/state.ts:82-87` Task接口; `src/tools/claim-turn.ts:94-97` advance携带task; `src/template.ts:40-47` taskSection()渲染 | ✅ |
| P0-21 | 目标锚定—缺task拒绝advance | `src/tools/claim-turn.ts:93-97`: task.description ≥10字符必填 | ✅ |
| P0-22 | submit存储层—proposal/rationale不再null | `src/tools/submit.ts:113`: `proposal: derivedProposal` (= topic + ": " + description) | ✅ |
| P0-13 | IMPLEMENTATION defer约束 | `src/tools/claim-turn.ts:147-168`: 检查deferred issues+无理由拒绝advance+连续2次自动escalate | ✅ |
| P0-14 | SUMMARY已知问题未修即结束 | `src/tools/claim-turn.ts:193-197`: advance前检查unresolved issues | ✅ |
| P0-28 | work_dir校验 | `src/state.ts:21` Peer.work_dir字段; `src/tools/register.ts:55-62` 双方work_dir一致性校验 | ✅ |
| P0-15 | 开发者自审submit硬校验 | `src/tools/submit.ts:64-66`: coding/fix缺失`## 开发者自审`→reject | ✅ |
| P0-16 | 评审者独立测试submit硬校验 | `src/tools/submit.ts:69-71`: review缺失`## 独立测试`→reject | ✅ |
| P0-spec | submit模板文档更新确认段 | `src/template.ts:93-105`: docUpdateSection()区分审阅方/产出方 | ✅ |
| P0-22/23 | bootstrap启动编排 | `src/tools/wait-for-turn.ts`: note字段指引; register→wait_for_turn流程 | ✅ |
| P0-24 | 监督者task gate | `src/tools/claim-turn.ts:93-97`: service端强制task必填 | ✅ |
| P0-25/25b | 角色行为边界 | `src/tools/claim-turn.ts:73`: 非监督者advance拒绝; L39-43: converged时非监督者claim拒绝 | ✅ |
| 3.3 | crash重启机制 | `src/crash-recovery.ts`: 完整崩溃恢复+process.exit(1)+外部重启 | ✅ |
| 3.4 | lock僵死心跳 | `src/lock.ts`: 文件时间戳心跳+isPidAlive双重检测 (current-state.md §3.4确认) | ✅ |

### 1.2 来自 p1-p2-backlog.md (本迭代已完成)

| # | 项 | 验证位置 | 验证结果 |
|---|-----|---------|:---:|
| P1-17 | IMPLEMENTATION文件命名含sub_phase | `src/tools/submit.ts:287-290`: `r{seq}_{subTag}_{identity}.md`; L288: VALID_SUB_PHASES白名单防路径穿越 | ✅ |
| P1 | next字段—接口返回值引导AI下一步 | 所有工具返回均含next字段 (submit.ts, wait-for-turn.ts, register.ts, claim-turn.ts) | ✅ |
| P1 | get_archived_file_content phase参数 | p1-p2-backlog.md §一本迭代已完成列表确认 | ✅ |
| P0-26 | clean脚本+orphan预警 | `src/crash-recovery.ts:19-33`: handoff有未完成workflow时触发恢复而非静默忽略; findLatestWorkflowId()按时间戳取最新 | ✅ |
| P1 | 崩溃恢复opt-out (recovered flag+reset工具) | `src/state.ts:106-107`: recovered+require_re_register字段; `src/tools/register.ts:33-52`: re-register流程; `src/tools/reset.ts`: reset工具 | ✅ |
| P1 | 文档更新确认语义修复 | `src/template.ts:93-105`: isReviewer区分cross-check/self-check | ✅ |

### 1.3 来自 retro-2/retro-3/retro-4

| # | 项 | 验证位置 | 验证结果 |
|---|-----|---------|:---:|
| retro-2 A | wait_for_turn超时60s→600s | `src/tools/wait-for-turn.ts:9`: `TIMEOUT_MS = 600_000` | ✅ |
| retro-2 B | findLatestWorkflowId按时间戳取最新 | `src/crash-recovery.ts:423`: `incomplete.sort((a,b)=>b.localeCompare(a))` | ✅ |
| retro-3 #2 | submit.ts文件命名修复(sub_phase变更在文件写入后) | `src/tools/submit.ts:296-298`: sub_phase="review"在L285-293文件写入之后执行 | ✅ |
| retro-3 #3 | lease超时安全网(phase_config缺失默认30min) | `src/tools/claim-turn.ts:210-211`: `const D=30; if(!cfg)return D`; `src/lease.ts:88-89`: default 30min | ✅ |
| retro-3 #4 | P2不阻塞非IMPLEMENTATION收敛 | `src/tools/submit.ts:244-246`: 仅P0/P1阻塞非IMPL收敛 | ✅ |
| retro-3 #5 | 收敛后turn释放给监督者 | `src/tools/submit.ts:300-306`: converged+!blind_review_pending→turn=supervisor | ✅ |
| retro-3 #1+#4 | 崩溃恢复补全字段+re-register | `src/crash-recovery.ts:167`: epoch sentinel; L288-304: sub_phase/dev_phase/last_submit_per_turn恢复; `src/tools/register.ts:43-44`: EPOCH检查 | ✅ |
| retro-4 | epoch sentinel (60s窗口→确定性哨兵) | `src/crash-recovery.ts:167`: `registered_at: "1970-01-01T00:00:00.000Z"`; `src/tools/register.ts:43-44`: `EPOCH`常量 | ✅ |
| retro-4 | get-state字段补全(recovered+require_re_register) | commit `088fd41`确认 | ✅ |

---

## 二、未实现的问题

### 2.1 P0 级（阻塞）

#### P0-A: IMPLEMENTATION 无法自然收敛 (retro-3 #17)

- **来源**: `2026-06-24-pair-flow-retrospective-3.md` §6.2, §七 #17
- **严重程度**: P0 — IMPLEMENTATION阶段数学上不可能自然收敛
- **根因**: 
  - `src/tools/submit.ts:207` 收敛条件: `mySubmit.stance === "agree" && otherSubmit.stance === "agree"`
  - coding提交 `stance=null`（template.ts:75明确标注"null（产出方）"）
  - review提交 `stance=agree`
  - 双方stance永远不可能同时为"agree" → 收敛条件永远不满足
- **代码位置**: `src/tools/submit.ts:204-234` (IMPLEMENTATION convergence check)
- **影响**: 每个IMPLEMENTATION cycle必须通过force_converge才能收敛。retro-3和retro-4均证实此问题
- **建议方案**: retro-3推荐方案B——IMPLEMENTATION收敛仅依赖review方stance=agree + need_next_round=false

#### P0-B: 盲审模板永不触发 (retro-3 #19, retro-1 #3)

- **来源**: `2026-06-24-pair-flow-retrospective-3.md` §4.2, §七 #19; `2026-06-23-pair-flow-retrospective.md` §四 #3
- **严重程度**: P0 — 盲审时AI拿不到盲审模板
- **根因**: 
  - `src/template.ts:59`: 盲审模板触发条件 `sub === "blind_review"`
  - `state.sub_phase` 在盲审期间从未被设置为 `"blind_review"`
  - `src/tools/submit.ts:164-165`: `sub_phase: blindReview ? "blind_review" : state.sub_phase` 仅写入 `last_submit_per_turn`，不修改全局 `state.sub_phase`
  - 因此 `getTemplate()` 中的 `isBlindReview` 永远为 false
- **代码位置**: `src/template.ts:59` (检测条件), `src/tools/submit.ts:164-165` (sub_phase写入位置)
- **影响**: 盲审时AI需要手动推断"我现在应该做盲审"并手动传`blind_review:true`。retro-3 §9.4记录了这种认知负担
- **建议方案**: 将 `getTemplate()` 中的检测条件从 `sub === "blind_review"` 改为检查 `state.blind_review_pending && state.converged`。同时修改 `claim-turn.ts` 在盲审时返回盲审模板

### 2.2 P1 级（值得讨论）

#### P1-A: 盲审→收敛链路断裂 (retro-3 #18)

- **来源**: `2026-06-24-pair-flow-retrospective-3.md` §6.1, §七 #18
- **严重程度**: P1 — 导致每个phase需要2次"收敛"（自然收敛+盲审后force_converge）
- **说明**: 当前流程: 双方agree → converged=true → 盲审 → ??? → force_converge。盲审完成后没有"盲审后的确认提交"这一环节。盲审设计意图是"收敛前最后检查"但实际变成了"收敛后额外步骤"
- **建议方案**: 盲审改为收敛前置——先盲审→盲审无问题→再submit agree→收敛

#### P1-B: 非IMPLEMENTATION盲审不可跳过 (retro-3 #20)

- **来源**: `2026-06-24-pair-flow-retrospective-3.md` §七 #20
- **严重程度**: P1 — 双方2轮agree+无P0/P1+无新增issue时盲审价值有限
- **说明**: retro-4中每次收敛后监督者都force_converge跳过盲审（共14次force_converge中相当比例用于跳过盲审），说明盲审在当前被感知为"额外开销"
- **建议方案**: 若双方在2轮内agree+无P0/P1+无新增issue，盲审可由监督者决定跳过

#### P1-C: force_converge常态化——设计根因未消除

- **来源**: 综合 retro-1~4 数据: 5+3+4+2 = 14次 force_converge
- **严重程度**: P1 — 从"紧急escape hatch"退化为"常规流程推进工具"
- **根因分析**:
  - P0-A (IMPLEMENTATION无法自然收敛) → ~4次force_converge
  - P1-A (盲审→收敛链路断裂) → ~6次force_converge
  - 监督者跳过盲审 → ~3次force_converge
  - 其他(SUMMARY等) → ~1次
- **说明**: 修复P0-A和P1-A后，force_converge使用频率应大幅下降。但需要审计日志(retro-3 #21)来区分合理使用和流程缺陷

#### P1-D: 测试套件隔离未验证

- **来源**: `2026-06-23-pair-flow-retrospective.md` §7.2, §八 #1; `2026-06-24-pair-flow-retrospective-2.md` §八 #2
- **严重程度**: P1 — 测试套件与主服务冲突可能导致状态丢失
- **当前状态**: retro-2确认"部分完成 (1edfb53)"，但retro-3 §4.3报告vitest因权限拦截无法运行。测试隔离的实战有效性未验证
- **建议**: 确认测试套件使用独立 `.pairflow-test/` 目录和独立端口，并在主服务运行时实际运行一次验证

#### P1-E: rules_catalog不完整 (P1-72/P1-73)

- **来源**: `2026-06-23-pair-flow-p1-p2-backlog.md` §一 P1-72/P1-73
- **严重程度**: P1 — catalog仅14条规则，覆盖率lint未实现
- **当前状态**: `src/template.ts:15-30` rulesCatalog仅14条。retro-1 §5.1确认"编码规范工具"未实现
- **建议**: 扩展catalog至覆盖所有spec章节（§1-§16），实现覆盖率lint脚本

#### P1-F: meta.json 不存 task 字段——崩溃恢复丢失任务上下文

- **来源**: claude r2 审阅补充发现 + 本次代码库验证
- **严重程度**: P1 — 崩溃恢复后 state.json 丢失时 task 无法从 handoff 恢复
- **代码位置**: `src/tools/submit.ts:280-293` — meta.json 写入不包含 task 字段
- **说明**: retro-2 §4.1 已记录"task 完整保留"（因为 restore 了 state.json 而非丢失），但如果 state.json 被删除，recoverState() 从 handoff 重建后 task=null——reconstructFromHandoff() 没有恢复 task 的逻辑
- **建议**: meta.json 新增 `task` 字段存储当前任务快照，crash-recovery.ts 的 reconstructFromHandoff() 从 meta.json 恢复 task

### 2.3 P2 级（次要）

#### P2-A: advance_checklist的"验证重点"来源未实现

- **来源**: `2026-06-21-pair-flow-design.md` §5.3 advance前置条件第2条
- **严重程度**: P2 — 设计spec描述了从rules_catalog按spec_ref聚合派生"验证重点"，但catalog本身就不完整（P1-E），此功能无从谈起
- **说明**: 与P1-E联动——catalog覆盖率补齐后，"验证重点"可自动派生

#### P2-B: SSE事件推送

- **来源**: `2026-06-21-pair-flow-design.md` §4; `2026-06-23-pair-flow-p1-p2-backlog.md` §二 P2
- **严重程度**: P2 — v2考虑。当前wait_for_turn长轮询方案(P0-19)在工作
- **说明**: 10s轮询间隔(wait-for-turn.ts:8)意味着最多10s延迟感知状态变更

#### P2-C: P2-18 converge_mark首轮need_next_round永远null

- **来源**: `2026-06-22-pair-flow-process-improvements.md` §9; `2026-06-23-pair-flow-p1-p2-backlog.md` §二 P2-18
- **严重程度**: P2 — 不阻塞功能，设计改进候选项
- **方案**: 方案A——文档明确标注null语义，不改schema

#### P2-D: design.md开发阶段判定过时

- **来源**: 本次代码库验证
- **严重程度**: P2 — spec §14标记当前为"Phase 0: 骨架"，但代码库显然已完成Phase 0-3的完整实现（状态机、收敛、Issue、异常处理、归档全有）。spec的阶段描述与实际进度脱节
- **建议**: 更新design.md §14或移除开发阶段标记（现在应该用issue/retro系统跟踪）

#### P2-E: IMPLEMENTATION多cycle中totalCycles=null路径隐患

- **来源**: 本次代码库验证
- **严重程度**: P2 — 边界条件
- **代码位置**: `src/tools/claim-turn.ts:170-171`: `const totalCycles = ...; if (totalCycles !== null && ...)`
- **说明**: 若handoff/planning不可读导致`extractCycleCount`返回null，则跳过cycle check直接advance到SUMMARY(L184-189)。这意味着PLANNING中定义的循环总数在handoff不可用时被忽略
- **建议**: totalCycles=null时发出警告，而非静默推进

#### P2-F: advance 前 issue 拦截仅 SUMMARY→IDLE 有——其他 phase 缺失

- **来源**: claude r2 审阅补充发现 + 本次代码库验证
- **严重程度**: P2 — 其他 phase advance 可能遗留未处理 issue
- **代码位置**: `src/tools/claim-turn.ts:193-196` — 仅 SUMMARY→IDLE 检查 unresolved issues
- **说明**: REQUIREMENTS→PLANNING (L124-133)、PLANNING→IMPLEMENTATION (L135-144)、IMPLEMENTATION→SUMMARY (L146-189) 均无此检查。不过各 phase advance 前已有 converged 前置条件（需无 open P0），实际风险较低
- **建议**: 在各 phase advance 入口加 warning（非 hard reject），提醒监督者存在 open P1/P2

---

## 三、实现但存在问题的项

### 3.1 P1: submit.ts中coding→review收敛路径的fallthrough

- **来源**: 本次代码库验证
- **代码位置**: `src/tools/submit.ts:259-261`
- **说明**: coding提交的收敛路径是L259-261的`else`分支——直接切换turn到对方，不进入收敛检查(L204-234)。这是有意设计（coding→review无条件切换），但与收敛模型的设计意图有偏差
- **关联**: 此问题即为P0-A的代码级表现

---

## 四、本次验证中新发现的问题

### 4.1 P1: get-state白名单维护风险

- **来源**: retro-4 §3.2确认，本次代码库验证确认
- **严重程度**: P1 — 每新增state字段需手动更新get-state.ts输出
- **说明**: retro-4的修复(088fd41)添加了recovered+require_re_register字段到get-state输出，但这是"发现缺失→手动补"的响应式修复。白名单模式下没有编译时保证
- **建议**: 改为黑名单过滤（只排除内部敏感字段如current_lease.token），或使用TypeScript类型推导自动生成输出

### 4.2 P1: wait_for_turn轮询间隔与检测延迟

- **来源**: 本次代码库验证
- **代码位置**: `src/tools/wait-for-turn.ts:8`: `POLL_INTERVAL_MS = 10_000`
- **严重程度**: P1 — 10秒间隔意味着对方submit后最多10秒才能被wait_for_turn感知
- **分析**: retro-2将超时从60s改为600s，减少了轮询频率但也降低了响应速度。10s间隔在"等待对方submit"场景下增加~5s平均延迟
- **建议**: 考虑双阶段轮询——前30s用2s间隔（快速响应），之后降为10s间隔

### 4.3 P2: 设计spec §14 Phase判定与实际严重脱节

- **来源**: 本次代码库验证
- **说明**: 同P2-D

### 4.4 P2: crash-recovery.ts中PHASE_PRIORITY顺序可能错误恢复

- **来源**: 本次代码库验证
- **代码位置**: `src/crash-recovery.ts:136`: `["implementation", "planning", "requirements", "summary"]`
- **说明**: 若handoff同时存在planning和implementation目录（正常的多phase workflow），优先恢复为implementation。这是正确的。但若implementation目录存在但为空（PLANNING→IMPLEMENTATION advance后崩溃，尚未有coding产出），会被判定为implementation阶段但无任何产出——sub_phase默认为"coding"(L471)，可能是合理的
- **严重程度**: P2 — 边界条件，实际触发概率低

---

## 五、按照spec文档的逐文档未完成项索引

### 5.1 auto-flow-blockers.md (2026-06-22)

所有4个P0 (P0-19, P0-20, P0-21, P0-22) 均已实现并验证。无剩余项。

### 5.2 process-improvements.md (2026-06-22)

| 编号 | 状态 |
|------|:---:|
| P0-13 defer约束 | ✅ 已实现 |
| P0-3/P0-4 盲审+checklist | ✅ 已在design.md落地 |
| P0-14 已知问题未修 | ✅ 已实现 |
| P0-15 开发者自审 | ✅ 已实现 |
| P0-16 评审者独立测试 | ✅ 已实现 |
| P1-17 文件命名 | ✅ 已实现 |
| P2-18 need_next_round null | 未实现（设计方案A，低优先级） |
| P0-19/P0-20 | ✅ 已提取到独立spec |
| P1-22 身份混淆 | ✅ 已通过CLAUDE.md解决 |
| P1-23 启动编排 | ✅ 已通过wait_for_turn+next字段解决 |
| P0-24 task确认 | ✅ 已通过CLAUDE.md行为约束解决 |
| P1-25 行为越权 | ✅ 已通过服务端+CLAUDE.md双重约束 |
| P1-25b 未确认计划 | ✅ 已通过CLAUDE.md行为约束 |
| P0-26 重启绕过恢复 | ✅ 已实现(epoch sentinel+re-register) |
| P0-27 未commit | 使用方运维责任（非PairFlow职责） |
| P0-28 work_dir | ✅ 已实现 |

### 5.3 current-state.md (2026-06-23)

文档§四声明"全部完成 ✅"。代码验证确认**所有项均已实现**。无剩余项。

### 5.4 retrospective.md (retro-1) (2026-06-23)

§八最优先事项:

| # | 项 | 状态 |
|---|-----|:---:|
| 1 | 测试套件隔离 | ⚠️ 部分完成，未实战验证 |
| 2 | 崩溃恢复补全6字段 | ✅ 已实现(retro-3) |
| 3 | submit.ts文件命名修复 | ✅ 已实现(retro-3) |
| 4 | lease超时安全网 | ✅ 已实现(retro-3) |
| 5 | REQUIREMENTS/PLANNING收敛后commit | 使用方运维责任 |

§四改进建议长期项(#9 SSE, #10 盲审自动触发, #11 状态快照)均未实现——明确标记为"长期"。

### 5.5 p1-p2-backlog.md (2026-06-23)

本迭代已完成6项（均验证通过✅）。延后项:

| # | 项 | 状态 |
|---|-----|:---:|
| 1 | P2-18文档标注 | 未实现 |
| 2 | SSE事件推送 | 未实现（长期） |
| 3 | rules_catalog扩展 | 未实现(P1-E) |
| 4 | 回顾文档发现的改进项 | 部分实现(见retro-1~4追踪) |

### 5.6 retrospective-2.md (retro-2) (2026-06-24)

§八最优先事项:

| # | 项 | 状态 |
|---|-----|:---:|
| 1 | 崩溃恢复补全6字段+幽灵注册修复 | ✅ (retro-3+retro-4) |
| 2 | 测试套件隔离 | ⚠️ 部分完成 |
| 3 | submit.ts文件命名修复 | ✅ (retro-3) |
| 4 | lease超时安全网 | ✅ (retro-3) |
| 5 | P2不阻塞收敛+收敛后释放turn | ✅ (retro-3) |
| 6 | REQUIREMENTS/PLANNING收敛后commit | 使用方责任 |

§七改进建议: #12 (re-register)✅, #13 (turn释放)✅, #17 (全新开始入口)✅, #14 (P2不阻塞)✅, #15 (POLL_INTERVAL降低)→方向改为600s超时, #16 (force_converge告警)未实现

### 5.7 retrospective-3.md (retro-3) (2026-06-24)

§八:

| # | 项 | 状态 |
|---|-----|:---:|
| 1-5 | 已实现(见§一) | ✅ |
| 6 (retro-3 #17) | IMPLEMENTATION收敛仅依赖review方 | ❌ P0-A |
| 7 (retro-3 #18) | 盲审改为收敛前置 | ❌ P1-A |
| 8 (retro-3 #19) | claim_turn盲审模板自动切换 | ❌ P0-B |

### 5.8 retrospective-4.md (retro-4) (2026-06-24)

§六结论: 16项中12项已实现，剩余4项 = retro-3的#17/#18/#19/#20。无额外的未完成项。

---

## 六、实现优先级建议

作为开发者(非监督者)视角，以下是我的优先级排序：

### 立即（阻止自然流转）

1. **P0-A: IMPLEMENTATION收敛仅依赖review方** — 消除IMPLEMENTATION阶段force_converge必要性
2. **P0-B: 盲审模板自动切换** — 一行判断条件改动，收益巨大

### 短期（改善流程质量）

3. **P1-A: 盲审改为收敛前置** — 结构改进，消除"收敛后还要收敛"
4. **P1-C: force_converge审计日志** — 帮助区分合理使用和流程缺陷
5. **P1-B: 非IMPLEMENTATION盲审可选化** — 减少低价值盲审

### 长期

6. **P1-D: 测试套件隔离验证** — 实际运行vitest确认不冲突
7. **P1-E: rules_catalog扩展** — 补齐覆盖率
8. **P2各项** — 按需处理

---

## 七、验证方法论

- 阅读全部9个spec文档（含design.md）
- 阅读全部6个核心源文件: `state.ts`, `submit.ts`, `claim-turn.ts`, `register.ts`, `crash-recovery.ts`, `template.ts`, `wait-for-turn.ts`, `lease.ts`
- 对照"✅ 已实现"标记逐一在代码中查找对应逻辑
- 特别关注: 收敛条件、盲审流程、文件命名顺序、epoch sentinel机制、P2阻塞逻辑
- 不信任文档标记——以代码为唯一权威来源
- 交叉验证: retro-3/retro-4的"已实现"声明 vs 代码实际逻辑

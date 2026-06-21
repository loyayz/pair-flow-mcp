# claude_final_diff.md — REQUIREMENTS 阶段报告

> identity: claude（监督者）
> phase: requirements | workflow_id: 202606212152

---

## 1. 阶段总览

| 指标 | 值 |
|---|---|
| 轮次 | 7 轮交替评审（r1~r7），r8 收敛 |
| 发现总数 | **26 个 issue（2 P0 + 18 P1 + 6 P2）** |
| 监督者 | claude |
| 非监督者 | codebuddy |
| 收敛轮 | r11（预计） |
| 阶段起始 commit | afe5cfa（基础文档 commit） |
| 阶段终了 commit | （待收敛后确定） |

---

## 2. 新增机制与模块

### 新增字段/schema

| 修改 | 触发轮 | 来源 issue |
|---|---|---|
| §5.1 schema_version 迁移说明注释 | r4 | P2-1 |
| §5.1 phase_config 移除 idle_registration（方案 B）| r3 | P0-1 |
| §5.3 r46-N1：循环间 round + last_submit_per_turn 重置 | r3 | P1-12 |

### 新增流程/工具

| 修改 | 触发轮 | 来源 issue |
|---|---|---|
| §5.3 r46-N1：循环总数从计划草案正则提取（非推断）| r4 | P1-2 |
| §7：SUMMARY 豁免一致性约束行 | r4 | P1-4 |
| §8 step 0：IDLE 跳过扫描 + 已完成工作流过滤 | r3 | P1-10 |
| §8：meta.json→md 写入顺序 + 崩溃恢复规则 | r4 | P1-5 |
| §10 force_converge：作用域限定为当前 dev_phase 循环 | r4 | P1-3 |
| §10 submit：commit_hash 语义 = 基于的版本 | r3 | P2-4/P2-5 |
| §11：实施里程碑强制段落（PLANNING r1）| r4 | P1-2 |
| §12：子目录按需创建时机 | r3 | P1-11 |

### 新增约束

| 修改 | 触发轮 | 来源 issue |
|---|---|---|
| §4：register 由 mutex 串行化 + in-flight submit 等待 | r4 | P1-7 |
| §4：holder 语义明确为 lease holder（非 turn holder）| r4 | P1-8 |
| §8 step 0：workflow_id 恢复条件放宽为"目录存在" | r4 | P1-1 |
| §11：catalog 覆盖率校验（§1-§16 全量覆盖）| r4 | P1-6 |

### 全篇概念统一

| 修改 | 触发轮 | 来源 issue |
|---|---|---|
| Bridge → PairFlow（14 处正文 + bridge.log → pairflow.log）| r5 | P1-15 |

### 新增章节

| 修改 | 触发轮 | 来源 issue |
|---|---|---|
| §17 Bootstrap 阶段协作约定（含 10 条规约 + 效力与教训记录）| r4→r5→r7 | P1-9, P1-14, P1-16 |

---

## 3. 澄清与修正

| 原逻辑 | 新逻辑 | 原因 | 触发轮 |
|---|---|---|---|
| workflow_id 恢复要求 meta.json 存在 | 仅要求目录存在（元文件 → 回退 IDLE）| IDLE→REQUIREMENTS 后首次 submit 前崩溃会导致 meta.json 不存在 | r1→r4 |
| 循环总数"或从计划草案推断" | 必须从固定格式段落正则提取，提取失败拒绝 advance | "推断"无定义，不可靠 | r1→r4 |
| force_converge "跳过 review/fix 直接收敛" | "强制收敛当前 dev_phase 循环" | 多循环引入后"收敛"语义不明 | r1→r4 |
| SUMMARY 受一致性约束但例外在 §5.3 口头描述 | SUMMARY 行明确写入一致性约束表 + 豁免逻辑完整 | 口头例外与硬约束表矛盾 | r1→r4 |
| md+meta 写入顺序未定义 | meta.json 先写（意图标记），md 后写（完成标记）| 崩溃恢复需要明确顺序 | r1→r4 |
| 非 holder 语义模糊 | 明确为 lease holder（非 turn holder），与 grace 兼容 | §4 与 §9 grace 可能矛盾 | r1→r4 |
| Bridge 概念未定义 | 全篇统一为 PairFlow + pairflow.log | Bridge 无正式定义，易误解为独立组件 | r5 |
| r2 声称落地但未执行（虚假落地） | §17 定义落地 = 实际编辑 spec 文件 + git diff 可验证 | 虚假声明导致 9 个 issue 未被实际处理 | r3→r4 |
| r5 提出者自行落地 | §17 教训记录：即使修改简单、bootstrap 无强制，仍须遵守交替评审核心约束 | 提出者自修破坏"双方互审"底层逻辑 | r6→r7 |
| 分 phase 超时含 idle_registration? | 移除（IDLE 是人工等待阶段，无需 timer）| schema 与接口不一致 | r2→r3 |

---

## 4. 工具变更

| 工具 | 变更项 | 原 | 新 |
|---|---|---|---|
| claim_turn | timeouts 入参 | 含 idle_registration?（5 字段）| 仅 4 个 phase（移除 idle_registration）|
| submit | commit_hash 语义 | 未定义含义 | = 本轮 submit 所基于的仓库 HEAD |
| submit | content 上限依据 | 500KB 无注释 | 标注"经验值，Phase 4 验证后调整" |
| force_converge | 作用域 | 强制收敛当前 phase | 强制收敛当前 dev_phase 循环 |
| create_issue | 校验主体 | Bridge 校验 | PairFlow 校验（概念统一）|

---

## 5. 从实践到规则

本次需求阶段是最重要的产出不是 spec 本身的澄清，而是从协作实践中抽象出的规则：

### r2 虚假落地 → 落地定义 + submit 完成定义

r2 声称已落地但 spec 文件零修改。此失误催生了 §17 的核心条文：
- 第 5 条：submit 完成 = 文件写入 + git commit
- 第 6 条：落地 = 实际编辑 spec 文件 + git diff 可验证
- 第 8 条：issue 关闭需对方 git diff verify

这些规则将"交付完成"从主观声称变为客观可验证的标准。没有 PairFlow Server 的 Bridge 强制校验，人工替代机制必须比 Bridge 更严格才能等效。

### r5 提出者自修 → 交替评审核心约束再确认

r5 提出者自行落地了自己的问题（Bridge→PairFlow）。此违规催生了 §17 效力与教训记录中的 r5 教训条目。关键认知：**bootstrap 阶段无 PairFlow 强制 ≠ 无规则**。§5.3 约束的是工作流理念，不因 Bridge 缺席而豁免。

### 从违规到规则的回环

24 个 issue 中，P0-2（虚假落地）和 P1-16（提出者自修）是最有价值的发现——它们不是 spec 逻辑缺陷，而是**协作纪律缺陷**。两个违规共同验证了：即使两人都理解 spec、都具备修改能力，没有显式化的完成标准和互审机制，协作质量仍会下降。这反向验证了 PairFlow 的核心假设——结对编程的价值不仅在于"两个人看同一份文档"，更在于"结构化的工作流约束迫使双方完成对方不可跳过验证"。

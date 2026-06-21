# claude_advance_checklist.md — REQUIREMENTS → PLANNING advance 前全面通读

> identity: claude（监督者）
> bootstrap 阶段：验证重点从 spec 正文直接派生（§17 第 10 条）

| § | 节名 | 验证重点 | 状态 |
|---|---|---|---|
| 1 | 目标与范围 | 四阶段主流程定义、监督者职责、v1 线性固定范围明确 | ✅ |
| 2 | 架构总览 | PairFlow Server 拓扑、MCP 工具对称性、状态变更 mutex 保护 | ✅ |
| 3 | 目录结构 | .pairflow/ vs handoff/ 分离、workflow_id 命名规则、pairflow.log 命名一致 | ✅ |
| 4 | 数据流 | X-AI-Identity header 判定、register mutex 串行化、lease_token holder 语义清晰 | ✅ |
| 5.1 | state.json Schema | 完整字段定义、dev_phase/round/sub_phase 语义、phase_config 与 claim_turn 一致（4 phase）、schema_version 迁移路径 | ✅ |
| 5.2 | Phase 转换 | IDLE→REQUIREMENTS→PLANNING→IMPLEMENTATION→SUMMARY 线性转换、P0 升级处置路径 | ✅ |
| 5.3 | Turn 转换 | 需求/计划交替持笔模型、IMPLEMENTATION 开发者-评审者模型、SUMMARY 三 turn 模型、多循环支持（循环总数提取+状态重置）、advance 前置条件（r40-N1 checklist+final_diff）| ✅ |
| 5.4 | 合法转换校验 | 全面的操作×状态矩阵、register/submit/claim_turn/advance/escalate/force_converge 权限 | ✅ |
| 5.5 | IMPLEMENTATION 子阶段 | coding→review→fix→review 推进表、监督者异议权（pending_supervisor_review）、fix 禁 P0、fix_review_cycles 僵持检测 | ✅ |
| 6 | Issue 系统 | P0/P1/P2 三级定义、方案建议义务（P0/P1 必填 proposal+rationale）、落地声明义务、issue 创建/关闭路径、作者性存储分工 | ✅ |
| 7 | 收敛逻辑 | IMPLEMENTATION 收敛条件（round 匹配+stance+need_next）、stance 一致性约束（含 SUMMARY 豁免行）、需求/计划收敛条件、converge_mark JSON Schema | ✅ |
| 8 | 异常处理 | 6 种异常类型、崩溃恢复 8 步流程（step 0 IDLE 跳过+已完成工作流过滤+meta→journal replay）、写入顺序 meta.json→md、权威来源声明 | ✅ |
| 9 | Lease 机制 | claim_turn→lease_token、5min grace、mutex 竞态处理、Lease 失效规则、交互优先级表、phase_config 生命周期 | ✅ |
| 10 | MCP 工具清单 | 12 工具完整入参/出参/说明、force_converge 当前循环作用域、submit commit_hash 语义、500KB 上限 | ✅ |
| 11 | 模板引擎 | rules_catalog 58+规则结构、规约分发机制（模板+动态 rules_summary）、动态过滤、catalog 覆盖率校验、占位符语法、收敛状态解析+交叉校验、模板变体表、审阅范围+实施里程碑强制段落 | ✅ |
| 12 | Phase 初始化行为 | REQUIREMENTS/PLANNING/IMPLEMENTATION/SUMMARY/IDLE 全量初始化字段表、子目录按需创建时机、循环间状态重置 | ✅ |
| 13 | 测试策略 | 16 项测试覆盖清单（连通性→E2E） | ✅ |
| 14 | 开发顺序 | Phase 0-4 含硬性判定标准、bootstrap→PairFlow 切换点 | ✅ |
| 15 | 技术栈+可观测性+进程管理 | Node.js/TS+MCP SDK 技术栈、pairflow.log 10MB 5 文件轮转、crash loop 检测、锁机制 | ✅ |
| 16 | 假设与降级 | 5 项假设（自定义 header、MCP client、git 能力、结对编程优于单人、localhost 无认证）| ✅ |
| 17 | Bootstrap 阶段协作约定 | 10 条规约（归档路径→advance_checklist）+ 效力与教训记录（r2 虚假落地 + r5 提出者自修）| ✅ |

**全 17 节（§1-§16 + §17）均标注 ✅，无 ⚠️。**

通读发现：
- 所有 MCP 工具入参与 state.json schema 字段对齐
- Bridge→PairFlow 概念统一完成（`grep -i bridge` 返回 0，`pairflow.log` 全局一致）
- 交替持笔模型从 IDLE 到 SUMMARY 完整定义，无空白 phase
- 崩溃恢复路径从 workflow_id 恢复到 timer 重启闭环
- bootstrap 阶段与 PairFlow 正式阶段的切换点明确（Phase 0 骨架判定）

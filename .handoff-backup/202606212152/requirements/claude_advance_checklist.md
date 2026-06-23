# claude_advance_checklist.md — REQUIREMENTS → PLANNING advance 前全面通读

> identity: claude（监督者）
> bootstrap 阶段，验证重点从 spec 正文派生（§17 第 10 条）
> 待 codebuddy 随机指定 3 节，监督者补充"行号+行内容概述"后完成抽查

| § | 节名 | 验证重点 | 状态 |
|---|---|---|---|
| 1 | 目标与范围 | 四阶段主流程、监督者职责（advance+P0+异议+SUMMARY）、v1 线性范围；"双 AI"核心定位不变（P0-5 不采纳）| ✅ |
| 2 | 架构总览 | PairFlow Server 拓扑、MCP 工具对称性、状态变更 mutex 保护、pairflow.log 命名 | ✅ |
| 3 | 目录结构 | .pairflow/ vs handoff/ 分离、blind_review.md 已入目录树（line 71）、final_diff/advance_checklist 树形正确（├──/└──）| ✅ |
| 4 | 数据流 | X-AI-Identity header、register mutex 串行化（in-flight 等待）、lease holder=非 turn holder、AI-B 注册流程注释 | ✅ |
| 5.1 | state.json Schema | blind_review_pending 字段、sub_phase 枚举含 blind_review、last_submit_per_turn 含 round/sub_phase、schema_version 迁移说明 | ✅ |
| 5.2 | Phase 转换 | 线性转换 IDLE→...→SUMMARY→IDLE、P0 escalate 处置路径 | ✅ |
| 5.3 | Turn 转换 | 交替持笔（需求/计划/IMPLEMENTATION/SUMMARY）、多循环（正则提取+状态重置）、advance 前置条件 3 条（修改确认+checklist v2+盲审）、checklist v2 随机引用+抽查（含 bootstrap 替代+失败处理+博弈约束）、盲审 turn 顺序（非监督者先）、盲审格式（逐节审视/独立提交）、三分判断含 ④ 盲审 P1、阶段报告五节+时序约束（P1-17）、"提出者不修改"正式阶段强制校验 | ✅ |
| 5.4 | 合法转换校验 | 盲审状态转换 3 行（blind_review_pending）、完整操作×状态矩阵 | ✅ |
| 5.5 | IMPLEMENTATION 子阶段 | 流转图含 blind_review、子阶段表含盲审行（执行者+产出+推进条件）、盲审子阶段段落（执行者/推进/收敛/非 IMPLEMENTATION turn 交替）、fix 禁 P0、fix_review_cycles 僵持检测 | ✅ |
| 6 | Issue 系统 | P0/P1/P2 定义、方案建议义务（P0/P1 必填 proposal+rationale）、落地声明义务、作者性存储分工 | ✅ |
| 7 | 收敛逻辑 | IMPLEMENTATION 收敛（round 匹配+stance+need_next）、一致性约束表含 SUMMARY 豁免、需求/计划收敛（new_issues+P0+escalated）、收敛后流程 6 步（收敛→盲审→发现？→checklist→final_diff→advance）| ✅ |
| 8 | 异常处理 | 崩溃恢复 8+1 步（step 0 IDLE 跳过+已完成过滤+meta→journal replay+盲审 step 4a）、写入顺序 meta.json→md、盲审恢复（history 类型+turn 推断+bpr 推断+单方崩溃）| ✅ |
| 9 | Lease 机制 | claim_turn→lease_token、5min grace、mutex 竞态、优先级表、phase_config 生命周期 | ✅ |
| 10 | MCP 工具清单 | 12 工具完整入参/出参、submit 含 blind_review 5 条约束（独立性/收敛/stance/get_archived_files/提出者不修改强制校验）、force_converge 当前循环作用域、commit_hash 语义、get_state 含 blind_review_pending | ✅ |
| 11 | 模板引擎 | rules_catalog 结构（id/description/phases/trigger/spec_ref/type）、规约分发（模板+动态 rules_summary）、catalog 覆盖率校验、占位符语法、收敛状态解析+交叉校验、模板变体表含盲审行、审阅范围+实施里程碑强制段落 | ✅ |
| 12 | Phase 初始化 | 全量字段表（REQUIREMENTS/PLANNING/IMPLEMENTATION/SUMMARY/IDLE）、子目录按需创建、循环间 round+last_submit 重置 | ✅ |
| 13 | 测试策略 | 20 项测试（16 原版 + 4 盲审：独立性/收敛循环/无发现 advance/bootstrap 盲审）| ✅ |
| 14 | 开发顺序 | Phase 0-4 判定标准、pairflow.log 全局一致 | ✅ |
| 15 | 技术栈+可观测性+进程管理 | Node.js/TS+MCP SDK、pairflow.log 10MB 5 文件轮转、crash loop 检测、锁机制（PID+时间戳+nonce）| ✅ |
| 16 | 假设与降级 | 5 项假设含盲审机制依赖修正（结对编程=假设+机制依赖）| ✅ |
| 17 | Bootstrap 协作约定 | 10 条规约（归档→advance_checklist）+ 效力声明（spec 定义规则，handoff 记录过程）+ 身份示例泛化（identity_a/b）+ issue 关闭含盲审说明 | ✅ |

**全 17 节均标 ✅。**

抽查流程：codebuddy 随机指定 3 节（§X, §Y, §Z），监督者补充该节在 spec 中的"具体行号 + 该行内容概述"，codebuddy 打开 spec 核对。

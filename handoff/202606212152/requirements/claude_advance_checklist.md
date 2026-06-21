# claude_advance_checklist.md — REQUIREMENTS → PLANNING advance 前全面通读

> identity: claude（监督者）
> bootstrap 阶段，验证重点从 spec 正文直接派生（§17 第 10 条）

| § | 节名 | 验证重点 | 状态 |
|---|---|---|---|
| 1 | 目标与范围 | 四阶段主流程、监督者职责、v1 线性范围 | ✅ |
| 2 | 架构总览 | PairFlow Server 拓扑、MCP 工具对称性、mutex 保护 | ✅ |
| 3 | 目录结构 | .pairflow/ vs handoff/ 分离、pairflow.log 命名、盲审产出文件（blind_review.md）已入目录树、final_diff/advance_checklist 树形格式正确 | ✅ |
| 4 | 数据流 | X-AI-Identity 判定、register mutex 串行化（含 in-flight 等待）、lease holder 语义（非 turn holder）、AI-B 注册流程注释 | ✅ |
| 5.1 | state.json Schema | 完整字段含盲审新增（blind_review_pending）、sub_phase 枚举含 blind_review、last_submit_per_turn 含 round/sub_phase、schema_version 迁移路径 | ✅ |
| 5.2 | Phase 转换 | 线性转换 + P0 升级处置路径 | ✅ |
| 5.3 | Turn 转换 | 交替持笔模型（需求/计划/IMPLEMENTATION/SUMMARY）、多循环支持（循环总数正则提取+状态重置）、advance 前置条件 3 条（修改确认+checklist+独立盲审）、盲审 turn 顺序（收敛后非监督者先）、盲审格式与要求（逐节审视/独立提交/与 checklist 关系）、advance 三分判断含 ④ 盲审 P1 情况、阶段报告五节+时序约束（checklist 确认后产出）、checklist 模板 17/16 节自适应 | ✅ |
| 5.4 | 合法转换校验 | 盲审状态转换 3 行（blind_review_pending 引用 §5.1 字段）、完整操作×状态矩阵 | ✅ |
| 5.5 | IMPLEMENTATION 子阶段 | 流转图含 blind_review、子阶段表含盲审行（执行者+产出+推进条件）、盲审子阶段完整段落（执行者/推进/收敛/非 IMPLEMENTATION turn 交替）、fix 禁 P0、fix_review_cycles 僵持检测 | ✅ |
| 6 | Issue 系统 | P0/P1/P2 定义、方案建议义务（P0/P1 必填 proposal+rationale）、落地声明义务（节号+行号定位）、issue 创建/关闭路径、作者性存储分工 | ✅ |
| 7 | 收敛逻辑 | IMPLEMENTATION 收敛条件（round 匹配+stance+need_next）、一致性约束表含 SUMMARY 豁免行、需求/计划收敛条件（new_issues 均空+P0+escalated）、收敛后流程 6 步（收敛→盲审→发现？再收敛→checklist→final_diff→advance） | ✅ |
| 8 | 异常处理 | 崩溃恢复 8+1 步（step 0 IDLE 跳过+已完成工作流过滤+meta→journal replay）、写入顺序 meta.json→md、盲审文件恢复（history 类型标记+turn 推断+bpr 推断+单方崩溃） | ✅ |
| 9 | Lease 机制 | claim_turn→lease_token、5min grace、mutex 竞态处理、优先级表 | ✅ |
| 10 | MCP 工具清单 | 12 工具完整入参/出参、submit 含 blind_review 参数（4 条约束：独立性/收敛判定/stance/get_archived_files）、force_converge 当前循环作用域、commit_hash 语义、get_state 含 blind_review_pending | ✅ |
| 11 | 模板引擎 | rules_catalog 结构（id/description/applicable_phases/trigger/spec_ref/type）、规约分发（模板+动态 rules_summary）、catalog 覆盖率校验（§1-§16 全量）、占位符语法、收敛状态解析+交叉校验、模板变体表含盲审行、审阅范围+实施里程碑强制段落 | ✅ |
| 12 | Phase 初始化行为 | 全量初始化字段表（REQUIREMENTS/PLANNING/IMPLEMENTATION/SUMMARY/IDLE）、子目录按需创建时机、循环间 round+last_submit 重置 | ✅ |
| 13 | 测试策略 | 20 项测试（16 原版 + 4 盲审相关：独立性/收敛循环/无发现 advance/bootstrap 盲审） | ✅ |
| 14 | 开发顺序 | Phase 0-4 含硬性判定标准、pairflow.log 全局一致 | ✅ |
| 15 | 技术栈+可观测性+进程管理 | Node.js/TS+MCP SDK、pairflow.log 10MB 5 文件轮转、crash loop 检测、锁机制（PID+时间戳+nonce） | ✅ |
| 16 | 假设与降级 | 5 项假设含盲审机制依赖修正（结对编程假设从纯假设→假设+机制依赖） | ✅ |
| 17 | Bootstrap 阶段协作约定 | 10 条规约（归档→advance_checklist）、效力声明（spec 定义规则，handoff 记录过程）、身份示例泛化（identity_a/identity_b）、issue 关闭含盲审说明 | ✅ |

**全 17 节均标 ✅，无 ⚠️。**

通读确认：
- blind_review_pending 字段从 §5.1 schema 到 §5.4 转换表到 §8 崩溃恢复到 §10 get_state 出参全部联通
- 盲审机制在 IMPLEMENTATION（sub_phase=blind_review）和非 IMPLEMENTATION（turn 交替）两套路径均完整定义
- advance_checklist 模板已从固定 16 节改为自适应（bootstrap 17 节/生产 16 节）
- 所有 rXX-NX 编码已消除（grep 确认 0 匹配），改为纯章节引用
- Bridge 概念已全局替换为 PairFlow（grep -i bridge 确认 0 匹配，pairflow.log 全局一致）
- spec 无 session 信息混入（§17 效力声明："spec 定义规则，handoff 记录过程"）

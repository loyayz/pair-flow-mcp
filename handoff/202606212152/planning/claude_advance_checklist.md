# claude_advance_checklist.md — PLANNING → IMPLEMENTATION advance 前全面通读

> identity: claude（监督者）
> bootstrap 阶段，验证重点从 spec 正文派生（§17 第 10 条）
> 计划阶段 spec 未修改，验证重点与需求阶段终态一致
> 待 codebuddy 随机指定 3 节，补充行号+概述

| § | 节名 | 验证重点 | 状态 |
|---|---|---|---|
| 1 | 目标与范围 | 双 AI 核心定位 + 四阶段主流程 + v1 线性范围 | ✅ |
| 2 | 架构总览 | PairFlow Server 拓扑 + pairflow.log 命名 | ✅ |
| 3 | 目录结构 | .pairflow/ vs handoff/ + blind_review.md 入树 + 树形正确 | ✅ |
| 4 | 数据流 | header 判定 + register mutex + lease holder 语义 + AI-B 注释 | ✅ |
| 5.1 | state.json Schema | blind_review_pending + sub_phase 含 blind_review + last_submit_per_turn 含 round/sub_phase | ✅ |
| 5.2 | Phase 转换 | 线性转换 + P0 escalate 路径 | ✅ |
| 5.3 | Turn 转换 | 交替持笔（4 phase）+ 多循环（正则提取+状态重置）+ advance 前置 3 条 + checklist v2（随机引用+抽查+bootstrap）+ 盲审（turn/格式/独立性）+ 三分判断 ④ + 阶段报告+时序 + 提出者不修改强制校验 | ✅ |
| 5.4 | 合法转换校验 | 盲审状态转换 3 行 + 完整矩阵 | ✅ |
| 5.5 | IMPLEMENTATION 子阶段 | 流转图含 blind_review + 子阶段表含盲审行 + 盲审段落（执行者/推进/收敛/非IMPLEMENTATION）+ fix 禁 P0 + fix_review_cycles | ✅ |
| 6 | Issue 系统 | P0/P1/P2 + 方案建议义务 + 落地声明 + 作者性存储 | ✅ |
| 7 | 收敛逻辑 | IMPLEMENTATION 收敛 + 一致性约束含 SUMMARY 豁免 + 需求/计划收敛 + 收敛后流程 6 步 | ✅ |
| 8 | 异常处理 | 崩溃恢复 8+1 步（IDLE 跳过+已完成过滤+盲审 step 4a）+ 写入顺序 meta.json→md | ✅ |
| 9 | Lease 机制 | lease_token + grace + mutex + 优先级表 + phase_config | ✅ |
| 10 | MCP 工具清单 | 12 工具 + submit 盲审 5 条约束 + 提出者不修改校验 + force_converge 作用域 + get_state 含 bpr | ✅ |
| 11 | 模板引擎 | rules_catalog 结构 + 规约分发 + 覆盖率校验 + 模板变体含盲审 + 实施里程碑段落 | ✅ |
| 12 | Phase 初始化 | 全量表 + IMPLEMENTATION 初始化（sub_phase=coding, dev_phase=0, turn=开发者）+ 子目录按需创建 | ✅ |
| 13 | 测试策略 | 20 项（含 4 盲审）+ 回归测试（P1-50 待 Phase 4 落地）| ✅ |
| 14 | 开发顺序 | Phase 0-4 判定 + 计划草案 v2 映射（5 循环+预估轮数+Phase 2 最重循环）| ✅ |
| 15 | 技术栈+可观测性+进程管理 | TS/Node + pairflow.log 轮转 + crash loop + 锁机制 | ✅ |
| 16 | 假设与降级 | 5 项含盲审机制依赖修正 | ✅ |
| 17 | Bootstrap 协作约定 | 10 条规约 + 效力声明 + 身份泛化 + 盲审说明 | ✅ |

**全 17 节均标 ✅。**

抽查流程：codebuddy 随机指定 3 节，监督者补充行号+概述。

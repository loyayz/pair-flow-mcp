# PairFlow 设计缺陷修复 — 实施报告 (r1 coding)

> 实施人：deepseek
> 日期：2026-06-27
> 实施计划：`handoff/20260627193014/planning/r1_claude.md`（经 r2/r4 审阅修订）

---

## 一、已完成的修复

### P0（阻塞级）

| 编号 | 问题 | 修改文件 | 说明 |
|------|------|----------|------|
| P0-1 | IMPLEMENTATION 文件命名 | `src/tip.ts` | `outFile`/`prevFile`/`myPrevReview` 在 IMPLEMENTATION 阶段含 sub_phase 前缀，对齐 §3 目录结构和 crash-recovery 依赖 |
| P0-2 | SUMMARY round≥2 tip | `src/tip.ts` | round≥2 添加 summary 分支：r2 审阅草稿，r3+ 交替修订 |
| P0-3 | meta.json 自动生成 | `src/tools/submit.ts` | 新增 `writeMetaJson` 函数，每次 submit 自动生成 .meta.json，含 submitted_at/commit_hash/sub_phase/task 字段 |

### P1（重要级）

| 编号 | 问题 | 修改文件 | 说明 |
|------|------|----------|------|
| P1-1 | SUMMARY turn 分配对齐 | `src/tip.ts` + 设计文档 §3 | r1 标注为草稿，设计文档目录改为 `r1_{supervisor}.md` + `r2_{identity}.md` + `...` |
| P1-3 | sub_phase 切换规则文档化 | 设计文档 §5.2 | 补充 "IMPLEMENTATION 阶段每次 submit 后 sub_phase 交替" 说明 |

### P2（边界完善）

| 编号 | 问题 | 修改文件 | 说明 |
|------|------|----------|------|
| P2-1 | dev_phase → dev_cycle | `src/state.ts`、`src/tools/advance.ts`、`src/crash-recovery.ts` | 全部 `dev_phase` 重命名为 `dev_cycle` |
| P2-2 | converged 字段删除 | `src/state.ts` | 从 PairFlowState 接口、defaultState、4 个 init*Phase 中移除 |
| P2-4 | 崩溃恢复身份校验 | `src/tools/confirm-task.ts` | 恢复后校验 turn holder 是否在 peers 中，清理无效 last_submit 条目 |
| P2-5 | submit tip 差异化 | `src/tools/submit.ts` | 按下一轮 turn holder 角色给出不同 tip（监督者可 advance，非监督者 wait） |
| P2-6 | Node 版本依赖 | `package.json` + `src/crash-recovery.ts` | 新增 `engines.node >= 22`，`findFiles` 添加 `path.relative` 回退兼容 parentPath 缺失场景 |
| P2-7 | SUMMARY→IDLE 收敛检查 | `src/tools/advance.ts` | advance SUMMARY→IDLE 前检查至少有一轮提交记录 |

### P3（非阻塞）

| 编号 | 问题 | 修改文件 | 说明 |
|------|------|----------|------|
| P3-1 | advance 返回值文档 | 设计文档 §9 | 出参加 `sub_phase?` |
| P3-2 | 架构图排版 | 设计文档 §2 | 删除重复行，补充实际工具列表 |
| P3-3 | task.description 语义 | `src/tools/confirm-task.ts` | 改为 `"任务文档: {taskPath}"` 而非与 spec_file 重复 |

---

## 二、未实施项（已降级为 v2 backlog 或需后续单独开发）

| 编号 | 问题 | 原因 |
|------|------|------|
| P1-2 | 兼任负载均衡 | 降级 v2 backlog（兼任为优化配置，不应为核心流程增加复杂度）|
| P1-4 | 监督者降级 (takeover) | 需新增 `takeover` 工具 + 新字段，建议后续独立 PR |
| P2-3 | 掉线恢复 (escalate) | 需新增 `escalate` 工具，与 P1-4 关联，建议一起实现 |

---

## 三、测试结果

```
Test Files  5 passed (5)
     Tests  24 passed (24)
```

---

## 四、影响分析

- **向后兼容**：`dev_phase` → `dev_cycle` 重命名影响 state.json 字段名。但 PairFlow 启动时总是清除 `.pairflow/` 重建，无持久化兼容性问题
- **meta.json 生成**：submit 新增 best-effort 写入，失败不阻塞 submit，对现有流程无副作用
- **SUMMARY→IDLE 检查**：新增收敛前置条件，空 SUMMARY 阶段 advance 将拒绝。此为计划中预期的行为变更
- **文件命名变更**：仅 IMPLEMENTATION 阶段 tip 指引的文件名含 sub_phase 前缀，不影响其他阶段

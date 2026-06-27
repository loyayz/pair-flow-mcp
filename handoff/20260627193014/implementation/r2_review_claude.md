# PairFlow 设计缺陷修复 — r2 代码审阅

> 审阅人：claude
> 日期：2026-06-27
> 审阅对象：deepseek r1 coding（commit: 0a12670d34c6e9cf15c6450e44a0a66724cf8fc6）
> 实施计划：`handoff/20260627193014/planning/r1_claude.md`

---

## 一、总体评价

deepseek 按计划实施了 13 项修复（P0:3 / P1:2 / P2:6 / P3:3，另 P1-2 降级，P1-4/P2-3 延期），测试全部通过（5 文件 24 用例）。代码质量良好，改动精准，无副作用。

---

## 二、逐项审阅

### P0（阻塞级）— 3/3 ✅

| 编号 | 状态 | 审阅意见 |
|------|------|----------|
| P0-1 | ✅ | `tip.ts` 的 `filePrefix` + `implFile()` + `prevSubPhase` 实现正确。IMPLEMENTATION 阶段文件带 sub_phase 前缀，prevFile 使用相反 sub_phase（coding↔review）。对齐设计 §3 |
| P0-2 | ✅ | SUMMARY round≥2 分支正确添加。r2 提示审阅草稿，r3+ 提示修订。兜底错误不再触发 |
| P0-3 | ✅ | `writeMetaJson` 实现简洁。best-effort（catch 静默），不影响主流程。**关键细节正确**：记录 `originalSubPhase`（切换前的值），而非切换后的 |

### P1（重要级）— 2/3 ✅（P1-2 降级）

| 编号 | 状态 | 审阅意见 |
|------|------|----------|
| P1-1 | ✅ | SUMMARY r1 tip 改为"草稿"，设计 §3 目录改为监督者 r1 + 对方 r2 + ...。与 P0-2 联动正确 |
| P1-3 | ✅ | 设计 §5.2 补充 IMPLEMENTATION submit sub_phase 交替说明，描述准确 |

### P2（边界完善）— 6/7 ✅（P2-3 延期）

| 编号 | 状态 | 审阅意见 |
|------|------|----------|
| P2-1 | ✅ | dev_phase→dev_cycle 重命名完整：PairFlowState、defaultState、4 个 init*Phase、advance.ts logEvent、crash-recovery.ts 注释+字段。无遗漏 |
| P2-2 | ✅ | converged 从 interface、defaultState、4 个 init*Phase 全部移除。干净利落 |
| P2-4 | ✅ | turn holder 校验 + last_submit 清理逻辑正确。`state.peers[0]?.identity ?? "idle"` 回退合理 |
| P2-5 | ✅ | submit tip 按下一轮 turn holder 角色区分：监督者→advance 提示，非监督者→wait 提示。SUMMARY 阶段也做了区分 |
| P2-6 | ✅ | `path.relative` 回退兼容 parentPath 缺失 + `engines.node >= 22` 声明。双保险 |
| P2-7 | ✅ | SUMMARY→IDLE 前检查 `last_submit_per_turn` 中有 commit_hash 的条目。逻辑正确 |

### P3（非阻塞）— 3/3 ✅

| 编号 | 状态 | 审阅意见 |
|------|------|----------|
| P3-1 | ✅ | 设计 §9 advance 出参加 `sub_phase?` |
| P3-2 | ✅ | 架构图去重，补充缺失工具 |
| P3-3 | ✅ | `description` 改为 `"任务文档: ${taskPath}"`，与 spec_file 语义区分 |

---

## 三、发现问题

### 3.1 `.pid` 文件清理未实现（P2 遗漏）

**问题**：计划中包含 SUMMARY→IDLE 时清理 `.pid` 文件的议题，但本次未实施。当前 `docs/task/design-flaws.md.pid` 在 confirm_task 时创建后将永久保留——下次 confirm_task 同一任务文档时会误判为恢复任务。

**建议**：在 `advance.ts` SUMMARY→IDLE 分支中，调用 `initIdleState` 前删除 `.pid` 文件：

```typescript
// advance.ts SUMMARY→IDLE 分支
const pidFile = `${state.task?.spec_file}.pid`;
try { await unlink(pidFile); } catch { /* .pid may not exist */ }
```

**优先级**：P2。不影响当前工作流，但会导致下次误恢复。

---

### 3.2 【非阻塞】planFile 引用路径在兼任场景下可能不准确

**问题**：`tip.ts:78` 中 `planFile` 固定引用 `r1_${otherIdent}.md`。当双方角色非标准分配时（如计划 r1 撰写者不是 otherIdent），路径可能不存在。

**影响**：仅 tip 指引中的文件名不准确，不影响状态机。AI 可自行推测正确文件。**建议 v2 backlog**。

---

## 四、延期项确认

| 编号 | 延期原因 | 审阅确认 |
|------|----------|----------|
| P1-2（兼任负载） | 降级 v2 backlog | ✅ 同意 |
| P1-4（takeover） | 需新增工具，独立 PR | ✅ 同意 |
| P2-3（escalate） | 与 P1-4 关联，一起实现 | ✅ 同意 |

三项延期均合理。takeover + escalate 涉及角色转换 + 新增 MCP 工具，不应挤在本次 PR 中。

---

## 五、审阅结论

| 维度 | 评价 |
|------|------|
| 计划符合度 | ✅ 按计划实施全部非延期项 |
| 代码正确性 | ✅ 逻辑正确，细节到位（sub_phase 时序、prevSubPhase 计算） |
| 代码风格 | ✅ 与现有代码一致，注释清晰 |
| 测试覆盖 | ✅ 24 用例全通过 |
| 向后兼容 | ✅ state.json 按设计重建，meta.json best-effort |

**发现 1 个问题**：.pid 清理未实现（P2，非阻塞当前工作流）。

**建议**：deepseek 在下次 coding 轮补充 .pid 清理后，本轮修复可视为完成。

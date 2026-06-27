# PairFlow 设计缺陷修复 — 实施计划

> 计划人：claude
> 日期：2026-06-27
> 需求来源：`docs/task/design-flaws.md`（16 项设计缺陷 + 2 项 v2 backlog）

---

## 修复顺序

按优先级分三批执行，每批内部按依赖关系排序。

---

## 第一批：P0（阻塞级 — 直接影响工作流正确执行）

### P0-1: 2.1 — IMPLEMENTATION 文件命名含 sub_phase 前缀

**现状**：`tip.ts:16` 统一生成 `r${round}_${identity}.md`，不含 `coding_`/`review_` 前缀。崩溃恢复依赖此前缀推断 sub_phase。

**方案**：
- 修改 `tip.ts` 的 `outFile` 生成逻辑：当 `phase === "implementation"` 时，加入 `sub_phase` 前缀
  ```
  const prefix = state.phase === "implementation" && state.sub_phase
    ? `r${state.round}_${state.sub_phase}_${ident}.md`
    : `r${state.round}_${ident}.md`;
  ```
- 同步修改 `buildTip` 中 round ≥ 2 的 `prevFile`/`myPrevReview` 路径计算逻辑，使其在 implementation 阶段也使用 sub_phase 前缀

**影响文件**：`src/tip.ts`
**风险**：低。纯逻辑修改，不改变状态机行为。

---

### P0-2: 2.2 — SUMMARY 阶段 round ≥ 2 的 tip 生成

**现状**：`buildTip` 的 round ≥ 2 分支无 summary case，落入兜底错误。

**方案**：
- 在 `buildTip` round ≥ 2 分支中添加 summary 分支：
  ```
  if (state.phase === "summary") {
    return `请基于上一轮汇总草稿 ${prevInfo}，产出最终汇总报告。产出文件路径: ${outFile}。${submitParams}`;
  }
  ```

**影响文件**：`src/tip.ts`
**风险**：低。

---

### P0-3: 3.1 — meta.json 生成规范

**现状**：tip 不指引 AI 生成 meta.json，崩溃恢复依赖它。

**方案**：
- 在 tip.ts 的 `submitParams` 常量中追加 meta.json 生成指引：
  ```
  "同时请创建一个 .meta.json 文件，包含以下字段：{"submitted_at": "ISO8601", "commit_hash": "<同 git_commit_hash>", "sub_phase": "<当前 sub_phase 或 null>", "task": {"description": "<任务简要描述>"}}"
  ```
- **备选方案（更可靠）**：新增 MCP 工具 `create_meta` 或在 `submit` 中自动生成 meta.json，而非依赖 AI 手动创建

**影响文件**：`src/tip.ts`（方案 A）或 `src/tools/submit.ts`（方案 B）
**风险**：方案 B 更可靠但涉及 submit 行为变更，需确认不破坏现有流程。

---

## 第二批：P1（重要级 — 影响结对体验和可用性）

### P1-1: 1.1 — SUMMARY 阶段 turn 分配与目录结构对齐

**现状**：§10 turn=监督者（r1），§3 目录暗示监督者在 r2 产出最终文档。

**方案**：
- **推荐方案**：保持 §10（监督者 r1 产出草稿），修改 §3 目录：
  ```
  summary/
  ├── r1_{supervisor}.md          ← 监督者产出草稿
  ├── r1_{supervisor}.meta.json
  ├── r2_{identity}.md            ← 对方审阅
  └── r2_{identity}.meta.json
  ```
- 同时在 §3 添加注释说明：监督者 r1 产出草稿 → 对方 r2 审阅 → 监督者 r3 以后产出最终版
- 同步修改 tip.ts 中 summary 阶段的 tip（与 P0-2 联动）

**影响文件**：设计文档 §3 + `src/tip.ts`
**风险**：低。与 P0-2 一起修改。

---

### P1-2: 1.4 — 兼任场景工作负载均衡

**现状**：supervisor+developer 兼任时，非监督者需连续承担 REQUIREMENTS + PLANNING。

**方案**：
- REQUIREMENTS→PLANNING 的 turn 分配从 `is_developer=false` 改为交替策略：
  ```
  // requirements 阶段的 r1 提交者继续做 planning r1（谁分析需求谁做计划）
  const reqSubmitter = Object.entries(state.last_submit_per_turn)
    .find(([_, s]) => s.round >= 1)?.[0];
  const planner = reqSubmitter && state.peers.find(p => p.identity === reqSubmitter)
    ? reqSubmitter
    : state.peers.find(p => !p.is_developer)?.identity;
  ```
- 或更简单的方案：PLANNING turn 仍给 `is_developer=false`，但确保兼任场景下双方至少各承担一个阶段

**影响文件**：`src/tools/advance.ts`（REQUIREMENTS→PLANNING 分支）
**风险**：中。需要确认与现有 round 计算、last_submit_per_turn 的兼容性。

---

### P1-3: 3.2 — sub_phase 切换规则文档化

**现状**：设计未说明 IMPLEMENTATION 阶段 submit 时 coding↔review 交替。

**方案**：
- 在设计文档 §5.2 添加说明："IMPLEMENTATION 阶段每次 submit 时 sub_phase 在 coding↔review 之间交替切换"
- 在 §10 IMPLEMENTATION 行添加注释："submit 后 sub_phase 交替，turn 随之切换给另一方"

**影响文件**：设计文档 §5.2 + §10
**风险**：无。纯文档补充。

---

### P1-4: 4.1 — 监督者单点瓶颈（降级方案）

**现状**：监督者掉线后工作流永久卡死。

**方案**：
- 新增超时降级机制：监督者超过 N 分钟（建议 60 分钟）未 claim_turn 时，非监督者可调用 `force_advance` 或系统自动将 supervisor 角色转移给另一方
- **v1 最小可行方案**：新增 `supervisor_timeout` 工具，非监督者可在监督者超时后申请接管监督者角色
  ```
  // state.json 新增字段
  "supervisor_last_action_at": "ISO8601"  // 监督者最后一次操作时间
  ```
- advance/confirm_dir/confirm_task 执行时更新此时间戳
- 新增 `takeover` 工具：非监督者在监督者超时后可调用，将自身 role 改为 supervisor

**影响文件**：`src/state.ts` + `src/tools/advance.ts` + 新增 `src/tools/takeover.ts`
**风险**：中。涉及角色变更，需仔细设计状态转换。

---

## 第三批：P2（边界完善 — 代码可维护性和鲁棒性）

### P2-1: 1.2 — `dev_phase` 重命名为 `dev_cycle`

**方案**：
- state.ts: 类型定义、defaultState、所有 init*Phase 函数中重命名
- advance.ts: 引用更新
- crash-recovery.ts: `inferDevPhase` → `inferDevCycle`
- 设计文档 §5.1 + §10 同步更新

**影响文件**：`src/state.ts`、`src/tools/advance.ts`、`src/crash-recovery.ts`、设计文档
**风险**：低。纯重命名，搜索替换即可。

---

### P2-2: 1.3 — 删除或激活 `converged` 字段

**方案**：
- 推荐：删除 converged 字段（state.json schema、defaultState、各 init*Phase、设计文档 §5.1）
  - §6 改为："监督者手动判定。各阶段交替审阅后，监督者确认阶段目标已达成，调用 advance 推进。"
- 备选：激活 converged，在 advance 各 phase 转换前检查 `converged === true`，新增 `set_converged` 工具

**影响文件**：`src/state.ts`、`src/tools/advance.ts`、设计文档 §5.1 + §6
**风险**：低。删除死字段无副作用。

---

### P2-3: 3.3 — 掉线恢复流程

**方案**：
- `wait_for_turn` 返回 warning 后，当前 AI 调用新增的 `escalate` 工具通知监督者
- 监督者收到 escalate 通知后，调用 `force_turn` 工具夺取 turn，推进工作流
- 或更简单：wait_for_turn 超时后自动将 turn 切给另一方（当前 AI 继续工作）

**影响文件**：`src/tools/wait-for-turn.ts` + 新增 `src/tools/escalate.ts` 或 `src/tools/force-turn.ts`
**风险**：中。涉及 turn 强制切换，需要日志记录和恢复路径。

---

### P2-4: 3.4 — 崩溃恢复身份校验

**方案**：
- `confirm-task.ts` 恢复状态后，校验 `state.turn` 是否在 `state.peers` 中
- 若不在，将 turn 重置为 peers 中第一个非监督者
- 同时校验 `last_submit_per_turn` 的 key 是否匹配当前 peers，清理无效条目

**影响文件**：`src/tools/confirm-task.ts`
**风险**：低。纯校验逻辑。

---

### P2-5: 3.5 — submit tip 按身份差异化

**方案**：
- `submit.ts` 的 tip 生成改为按身份判断：
  - 若 submit 后 turn 是监督者 → tip 包含 "可调用 advance 推进阶段"
  - 若 submit 后 turn 是非监督者 → tip 为 "调用 wait_for_turn 等待轮次"
- 移除 SUMMARY 阶段的硬编码 tip，改为通用判断

**影响文件**：`src/tools/submit.ts`
**风险**：低。

---

### P2-6: 6.1 — Node 版本依赖声明

**方案**：
- `package.json` 添加 `"engines": { "node": ">=22" }`
- **备选**：将 crash-recovery.ts 的 `findFiles` 改为不使用 `parentPath`，改用 path.relative 计算相对路径，消除对 Node 22+ 的依赖

**影响文件**：`package.json` + `src/crash-recovery.ts`（备选）
**风险**：低。

---

### P2-7: 6.2 — SUMMARY→IDLE advance 添加收敛检查

**方案**：
- `advance.ts` SUMMARY→IDLE 分支添加检查：
  - 至少有一轮 SUMMARY 提交记录（`Object.keys(state.last_submit_per_turn).length >= 1`）
  - 或至少 round ≥ 2（说明双方都有产出）

**影响文件**：`src/tools/advance.ts`
**风险**：低。

---

## 第四批：P3（非阻塞 — 文档和语义完善）

### P3-1: 2.3 — advance 返回值文档补充

**方案**：设计 §9 advance 出参改为 `{ ok, new_phase, turn, sub_phase? }`。

**影响文件**：设计文档 §9
**风险**：无。

---

### P3-2: 2.4 — 架构图排版修复

**方案**：删除 §2 ASCII 图中重复的两行 `get_archived_files`。

**影响文件**：设计文档 §2
**风险**：无。

---

### P3-3: 4.2（原）— task.description 语义修正

**方案**：
- `confirm-task.ts` 中 `state.task` 赋值改为：
  ```
  state.task = { description: "设计缺陷分析", spec_file: resolved };
  ```
- 或从任务文档第一行 `# 标题` 提取 description
- 类型定义 `state.ts:34` 添加注释：`description` 为人类可读摘要，`spec_file` 为文件路径

**影响文件**：`src/tools/confirm-task.ts` + `src/state.ts`
**风险**：低。description 当前未被任何逻辑依赖（tip 始终使用 spec_file）。

---

## 实施依赖图

```
P0-1 (命名) ──→ P0-2 (tip) ──→ P1-1 (SUMMARY对齐)
                                     │
P0-3 (meta.json)                     │
                                     ▼
P2-2 (converged) ←── P2-1 (dev_cycle) ──→ P2-7 (SUMMARY收敛)

P1-2 (兼任)     P1-4 (监督者降级) ──→ P2-3 (掉线恢复) ──→ P2-5 (tip差异)

P2-4 (身份校验)  P2-6 (Node版本)    P3-1/2/3 (文档)
```

## 建议修复顺序

1. **P0-1 + P0-2 + P1-1**：tip.ts 集中修改（文件命名 + SUMMARY tip + turn 对齐），一次性解决 SUMMARY 连锁问题
2. **P0-3**：meta.json 生成规范（可与第 1 步并行）
3. **P2-1 + P2-2 + P2-7**：state 字段清理（重命名 + 删除死字段 + 收敛检查）
4. **P1-2 + P1-4 + P2-3 + P2-5**：turn 分配 + 掉线恢复（相关联的一组修改）
5. **P2-4 + P2-6 + P3-1/2/3**：校验 + 文档 + 语义修正（收尾）
6. **P1-3**：设计文档补充（可在任意时间完成）

# PairFlow 设计缺陷修复 — 实施计划

> 计划人：claude（r1）+ deepseek（r2 审阅）
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

### P0-3: 3.1 — meta.json 生成规范（修订：采用方案 B）

**现状**：tip 不指引 AI 生成 meta.json，崩溃恢复依赖它。

**方案**（deepseek r2 建议采纳）：
- **方案 B（首选）**：`submit` 成功后自动在 handoff 对应目录写入 meta.json。meta.json 内容完全可从 submit 参数和 state 派生
  ```typescript
  // submit.ts 中在 saveState 之后：
  const metaPath = join(HANDOFF_DIR, state.workflow_id!, state.phase,
    `r${originalRound}_${identity}.meta.json`);
  await writeFile(metaPath, JSON.stringify({
    submitted_at: now,
    commit_hash: commitHash,
    sub_phase: originalSubPhase, // 记录切换前的 sub_phase
    task: state.task,
  }, null, 2), "utf-8");
  ```
- 注意 `sub_phase` 的时序：submit 中 sub_phase 切换发生在记录 `last_submit_per_turn` 之后，meta.json 应记录切换**前**的 sub_phase
- 同时在 tip 中保留方案 A 指引作为双重保险

**影响文件**：`src/tools/submit.ts`
**风险**：低。meta.json 写入失败不影响主流程（catch 静默处理）。

---

## 第二批：P1（重要级 — 影响结对体验和可用性）

### P1-1: 1.1 — SUMMARY 阶段 turn 分配与目录结构对齐

**现状**：§10 turn=监督者（r1），§3 目录暗示监督者在 r2 产出最终文档。

**方案**（deepseek r2 补充 r3+ 流程）：
- 保持 §10（监督者 r1 产出草稿），修改 §3 目录：
  ```
  summary/
  ├── r1_{supervisor}.md          ← 监督者产出草稿
  ├── r1_{supervisor}.meta.json
  ├── r2_{identity}.md            ← 对方审阅草稿
  ├── r2_{identity}.meta.json
  ├── r3_{supervisor}.md          ← 监督者修订（r3+ 交替审阅）
  └── ...
  ```
- 明确多轮流程：r1 监督者草稿 → r2 非监督者审阅 → r3+ 交替修订 → 监督者 advance→IDLE
- tip.ts 中 summary round≥2 分支区分：r2 审阅草稿 vs r3+ 交替修订
- 同步修改 tip.ts 中 summary 阶段的 tip（与 P0-2 联动）

**影响文件**：设计文档 §3 + `src/tip.ts`
**风险**：低。与 P0-2 一起修改。

---

### P1-2: 1.4 — 兼任场景工作负载均衡（修订：降级为 v2 backlog）

**现状**：supervisor+developer 兼任时，非监督者需连续承担 REQUIREMENTS + PLANNING。

**方案**（deepseek r2 建议采纳）：
- **不修改**。承认这是 v1 兼任的固有 trade-off。设计 §1 的"交替产出与评审"针对标准角色分配（supervisor≠developer），兼任是优化配置——用户若在意负载均衡可拆分为两个身份
- 降级为 **v2 backlog**：若 v2 引入更灵活的角色分配模型，届时一并解决

**影响文件**：无（v1 不做修改）
**风险**：无。

---

### P1-3: 3.2 — sub_phase 切换规则文档化

**现状**：设计未说明 IMPLEMENTATION 阶段 submit 时 coding↔review 交替。

**方案**：
- 在设计文档 §5.2 添加说明："IMPLEMENTATION 阶段每次 submit 时 sub_phase 在 coding↔review 之间交替切换"
- 在 §10 IMPLEMENTATION 行添加注释："submit 后 sub_phase 交替，turn 随之切换给另一方"

**影响文件**：设计文档 §5.2 + §10
**风险**：无。纯文档补充。

---

### P1-4: 4.1 — 监督者单点瓶颈（降级方案，修订：超时 30min + 复用 turn_claimed_at）

**现状**：监督者掉线后工作流永久卡死。

**方案**（deepseek r2 建议采纳）：
- 超时阈值设为 **30 分钟**，与 wait_for_turn 掉线检测阈值一致
- **复用 `turn_claimed_at`**（而非新增 `supervisor_last_action_at`）：监督者的 advance/confirm_dir/confirm_task 操作更新 `turn_claimed_at`，减少 schema 膨胀
- 新增 `takeover` 工具：非监督者在监督者 `turn_claimed_at` > 30 分钟后可调用，将自身 role 改为 supervisor

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

### P2-2: 1.3 — 删除 `converged` 死字段（修订：确定删除）

**方案**（deepseek r2 强烈推荐）：
- **确定删除** converged 字段（state.json schema、defaultState、各 init*Phase、设计文档 §5.1）
- 理由：该字段从 v1 起从未使用；§6 手动收敛模型已足够（监督者 advance = 收敛确认）；激活方案引入不必要的复杂度
- §6 保持原文："监督者手动判定。各阶段交替审阅后，监督者确认阶段目标已达成，调用 advance 推进。"

**影响文件**：`src/state.ts`、设计文档 §5.1 + §6
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

### P2-6: 6.1 — Node 版本依赖声明（修订：代码兼容 + engines 声明）

**方案**（deepseek r2 建议采纳）：
- **代码兼容为首选**：将 `findFiles` 放弃 `recursive: true`，改为手动递归 walk，同时兼容 Node 18+
  - 移除 `parentPath` 依赖，使用 `path.relative` 或 `path.join` 计算相对路径
- `package.json` 添加 `"engines": { "node": ">=18" }` 作为文档记录
- 理由：Node 22 在 Windows 上仍有兼容性问题；当前项目未使用任何 Node 22 独有特性

**影响文件**：`src/crash-recovery.ts` + `package.json`
**风险**：低。手动递归 walk 是成熟模式。

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

## 测试策略（deepseek r2 补充）

| 测试对象 | 测试类型 | 验证要点 |
|----------|----------|----------|
| P0-1 tip.ts | 单元测试 | 各 phase/round/sub_phase 组合输出正确文件路径（含 implementation 的 coding_/review_ 前缀） |
| P0-2 tip.ts | 单元测试 | SUMMARY round≥2 返回正确指引而非兜底错误 |
| P0-3 submit.ts | 单元测试 | submit 成功后 handoff 目录下生成正确的 meta.json（含 sub_phase 时序校验） |
| P2-4 confirm-task.ts | 单元测试 | 恢复后 turn holder 不在 peers 中时正确重置 |
| P2-7 advance.ts | 单元测试 | SUMMARY→IDLE 在无提交记录时拒绝 |
| P1-4 takeover.ts | 单元测试 | 超时判断逻辑 + 角色转换正确性 |

## `.pid` 文件清理（deepseek r2 补充）

**问题**：工作流完结（SUMMARY→IDLE）后 `.pid` 文件是否应清理？当前未处理。

**方案**：在 `advance.ts` SUMMARY→IDLE 分支或 `initIdleState` 中，删除任务文档对应的 `.pid` 文件。工作流完结意味着任务已完成，保留 `.pid` 会导致下次 confirm_task 误判为恢复任务。

**影响文件**：`src/tools/advance.ts` 或 `src/state.ts`（`initIdleState`）
**风险**：低。

---

## 实施依赖图（deepseek r2 修订）

```
P0-1 + P0-2 + P1-1  ──→  tip.ts 集中修改（文件命名 + SUMMARY tip + turn 对齐）
P0-3                   ──→  submit.ts 自动生成 meta.json（独立）
P2-1 (dev_cycle)       ──→  独立，纯重命名
P2-2 (converged 删除)   ──→  独立，state.ts 字段清理
P2-7 (SUMMARY 收敛)     ──→  独立，advance.ts 单文件
P1-4 + P2-3 + P2-5      ──→  turn 分配 + 掉线恢复 + tip 差异化（相关组）
P2-4 + P2-6 + P3-1/2/3 ──→  校验 + 文档组
P1-3                   ──→  独立，随时可做
.pid 清理               ──→  与 P2-7 一起（均在 SUMMARY→IDLE 路径）
测试                    ──→  与对应实现同步编写
```

## 建议修复顺序（修订）

1. **P0-1 + P0-2 + P1-1**：tip.ts 集中修改，一次性解决 SUMMARY 连锁问题
2. **P0-3**：submit.ts 自动生成 meta.json（可与第 1 步并行）
3. **P2-1 + P2-2 + P2-7 + .pid 清理**：state 字段清理 + 收敛检查 + .pid 清理（advance.ts 集中修改）
4. **P1-4 + P2-3 + P2-5**：掉线恢复 + tip 差异化 + 监督者降级
5. **P2-4 + P2-6 + P3-1/2/3**：校验 + Node 兼容 + 文档
6. **P1-3**：设计文档补充（随时可做）

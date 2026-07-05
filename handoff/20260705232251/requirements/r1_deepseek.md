# 代码与设计一致性分析 — r1

> 分析人: deepseek（developer）
> 任务: 对比 `src/` 代码实现与设计规格 `docs/superpowers/specs/2026-06-21-pair-flow-design.md` 的一致性，仅分析，不修改

---

## 方法

逐节对比设计规格的 11 个章节与所有源文件（21个 `.ts` 文件），从以下维度审视每个差异：
- 对谁产生影响？（使用者、协作者、维护者）
- 是设计过度约束还是实现缺失？
- 差异产生的原因是什么？

---

## 发现：4 处不一致

### 不一致 1：`Task` 接口含设计未定义的 `goals` / `context` 字段

**位置**: `src/state.ts:33-34`

**设计参照**: 设计 §5.1 — `task` 仅定义 `spec_file` 和 `task_type` 两个字段

**代码现状**:
```typescript
export interface Task {
  spec_file?: string;
  goals?: string[];      // ← 设计 §5.1 中不存在
  context?: string;      // ← 设计 §5.1 中不存在
  task_type?: "requirements" | "development";
}
```

**差异分析**:
- 这两个字段在整个代码库中**零引用**——未被任何赋值或读取操作使用。不仅是设计未定义的冗余字段，还是死代码。
- 对谁产生影响：**维护者**。接口与实际数据流脱节，阅读接口定义时会误以为这两个字段是有效数据结构的一部分。
- 差异原因（我的判断）：早期设计迭代时可能预留了这两个字段作为扩展点，但最终设计裁剪后未同步清理代码。这是一种**设计降级后的残留**——需求模式正是从完整四阶段简化而来，同理 task 结构也被简化了。

**我的建议**: 删除 `goals` 和 `context` 字段，保持接口与设计 §5.1 一致。（标注: deepseek）

---

### 不一致 2：`get_archived_file_content` 不传 phase 时未使用当前 phase 作为默认值

**位置**: `src/tools/archive-tools.ts:68`

**设计参照**: 设计 §9 工具清单 — `get_archived_file_content`
> "phase 可选过滤（requirements/planning/implementation/summary），不传默认当前 phase"

**代码现状**:
```typescript
const safeFilename = phase
  ? join(validatePathSegment(phase), filename)  // phase 传了 → 用 phase 子目录
  : filename;  // phase 没传 → 直接用 filename，没有默认使用 state.phase
```

正确的逻辑应类似：
```typescript
const effectivePhase = phase ?? state?.phase ?? "requirements";
const safeFilename = join(validatePathSegment(effectivePhase), filename);
```

**差异分析**:
- 谁会用：**AI 调用方**。当 AI 不传 phase 参数时（依赖"默认当前 phase"的语义），会在工作流根目录查找文件而非当前阶段子目录。因为所有产出文件都存储在 `{phase}/` 子目录下，不传 phase 意味着**几乎永远找不到文件**。
- 使用者影响：高——导致读取归档文件失败，AI 看不到历史产出，审阅环节会丢失上下文。
- 为何出现（我的判断）：`get_archived_file_content` 在实现时被当成泛化的文件读取工具，而非设计意图中的"阶段上下文感知"工具。开发者可能认为 phase 由调用方显式传入即可，忽略了"不传时默认当前 phase"的设计约定。这是**实现偏离设计意图**的典型案例。

**我的建议**: 当 `phase` 未传入时，默认使用 `state.phase`（即当前活跃阶段）。（标注: deepseek）

---

### 不一致 3：Phase 初始化时 `turn_switched_at` / `turn_claimed_at` 的清空行为不一致

**位置**: `src/state.ts:107-183`（四个 phase 初始化函数）

**设计参照**: 设计 §11 表
> "各 phase advance 时重置 `round=1`，重置 `last_submit_per_turn={}`，`turn_switched_at` 和 `turn_claimed_at` 清空。"

**代码现状**:

| Phase 初始化函数 | `turn_switched_at` | `turn_claimed_at` |
|---|---|---|
| `initRequirementsPhase` (L121-122) | `now` ❌ | `null` ✓ |
| `initPlanningPhase` (展开旧state) | 保留旧值 ❌ | 保留旧值 ❌ |
| `initImplementationPhase` (展开旧state) | 保留旧值 ❌ | 保留旧值 ❌ |
| `initSummaryPhase` (L178-179) | `now` ❌ | `null` ✓ |

**差异分析**:

- **一致性视角**: 四个函数行为各不相同。`initRequirementsPhase` 和 `initSummaryPhase` 将 `turn_switched_at` 设为当前时间（非 null），而 `initPlanningPhase` 和 `initImplementationPhase` 直接展开旧 state（两个字段都保留了上一个 phase 的值）。

- **功能影响**: `wait_for_turn` 的掉线检测依赖 `turn_switched_at && !turn_claimed_at` 的组合条件（wait-for-turn.ts:32）：
  - Requirements/Summary 启动时 `turn_switched_at = now`，掉线检测时钟即刻开始 — **30分钟后可能误判对方掉线**（因为对方可能刚看到 turn 切换到它但还未调用 claim_turn）
  - Planning/Implementation 启动时保留旧值 — **如果上一个 phase 的 turn_switched_at 超过 30 分钟前，新 phase 一启动就被判掉线**

- 对谁产生影响：**双方 AI**。掉线误判会干扰 wait_for_turn 的行为——AI 在正常等待时会收到 "对方可能已掉线" 的 warning，可能误导 AI 或用户做出错误操作。

- 为何出现（我的判断）：代码中 `initRequirementsPhase` 和 `initSummaryPhase` 都显式设置了 `turn_switched_at: now`，说明开发者**意图记录 turn 切换时间**。而 `initPlanningPhase` 和 `initImplementationPhase` 遗漏了这个设置。设计 §11 要求全部清空，代码却部分设置、部分遗漏——本质上是**设计与实现之间的意图分歧**。设计选择 "清空后由 claim_turn 触发时钟"，实现选择 "phase advance 时立即启动时钟"。**实现应当统一到设计意图**——因为设计意图更安全（不会在 phase 刚开始时就误判掉线），或者设计应修改为明确要求记录切换时间。

**我的建议**: 统一四个函数的行为——要么全部清空（对齐设计 §11），要么全部设置 `turn_switched_at: now`（对齐现有 requirements/summary 做法后更新设计）。（标注: deepseek）

---

### 不一致 4：`who_am_i` 返回值多了设计中未列出的 `workflow_id` 字段

**位置**: `src/tools/who-am-i.ts:22`

**设计参照**: 设计 §9 工具清单 — `who_am_i`
> 出参: `{ identity, registered, is_supervisor?, is_developer? }`

**代码现状**:
```typescript
return ok({
  identity,
  registered: !!peer,
  is_supervisor: peer?.role === "supervisor",
  is_developer: peer?.is_developer ?? false,
  workflow_id: workflowId,  // ← 设计 §9 表格中未列出
});
```

**差异分析**:
- 这是一个**接口宽松的差异**（代码 > 设计）——多返回一个字段对调用方无破坏性影响，AI 可以忽略它。
- 但如果有 AI 客户端严格按照设计解析返回值并校验 schema，多余的字段可能引起警告。
- 对谁产生影响：**低影响**——调用方可以安全忽略。
- 差异原因（我的判断）：代码实现时自然附带了这个便捷字段，但设计规格未同步更新。属于设计文档滞后于实现。

**我的建议**: 低优先级——要么在设计 §9 表格的 `who_am_i` 出参中补充 `workflow_id`，要么从代码返回值中移除。（标注: deepseek）

---

## 假设与边界

### 已验证一致的区域

以下设计章节与代码实现**一致**——本分析审阅后确认无差异：

| 设计章节 | 验证要点 | 结论 |
|---|---|---|
| §4 启动与注册 | register→confirm_task 流程、token 机制、身份判定 | ✓ 一致 |
| §5.2 Phase 转换 | IDLE→REQUIREMENTS→PLANNING→IMPLEMENTATION→SUMMARY，需求模式跳过规划/实现 | ✓ 一致 |
| §5.3 Turn 切换 | submit 后 round+1 切 turn，claim_turn 时间戳 | ✓ 一致 |
| §7 Issue 系统 | 通过标注管理观点差异（无独立跟踪系统） | ✓ 一致 |
| §8 异常处理 | 掉线检测（30分钟）、崩溃恢复入口（confirm_task）、crash loop 检测（30s/3次） | ✓ 一致 |
| §9 工具清单 | 11 个 MCP 工具全部实现 | ✓ 一致 |
| §10 Tip 格式 | 三层 `[行动]/[产出]/[当前]` 格式、`buildTip()` 复用、`identityLabel()` 共享 | ✓ 一致 |
| §10.2 阶段名映射 | 中文阶段名映射 | ✓ 一致 |
| §10.4 路径统一 | POSIX 正斜杠 | ✓ 一致 |
| §11 Phase turn 分配 | REQUIREMENTS→非监督者，PLANNING→评审者，IMPLEMENTATION→开发者，SUMMARY→监督者 | ✓ 一致 |

### 设计内部矛盾（非代码问题）

- 设计 §2 架构图标注 `.pairflow/（state.json + lock + pairflow.log）`，但设计 §3 明确 "状态为进程内存变量（重启后丢失）"。代码遵循 §3 采用纯内存状态（`Map<string, PairFlowState>`），无 `state.json` 文件。这是设计文档内部的表达不一致——§2 架构图过于理想化。（标注: deepseek，假设: 架构图是早期版本遗留，未随 §3 更新）

### 分析边界（不做）

按任务要求："不需要修改代码，也不需要修改设计文档"。本分析的目的是暴露差异，供监督者在 SUMMARY 阶段决定处理方式。

---

## 疑问与待澄清

1. **Task 接口的 `goals`/`context` 是预留扩展点还是有计划使用但未实施？** 如果是预留，建议在设计 §5.1 补充标注 "v2 预留"；如果已废弃，直接删除。
2. **`turn_switched_at` 的语义到底是什么？** 设计 §11 说清空，但部分代码设置 `now`。两种语义不同——清空意味着 "等待 claim_turn 后再开始计时"，设置 `now` 意味着 "从 phase 切换就开始计时"。这个问题需要监督者与用户确认后统一。
3. **`get_archived_file_content` 的修复优先级？** 不一致 2 是功能缺陷，建议最高优先级修复。

# 代码与设计一致性分析 — r2（独立分析 + 对照审阅）

> 分析人: claude（supervisor）
> 任务: 基于设计规格独立扫遍全部源文件，再对照审阅 deepseek 的 r1 分析

---

## 方法

逐文件审阅 `src/` 下全部 21 个 `.ts` 文件，对照设计规格 12 个章节。对每个差异追问"为什么会出现这个差异？对谁产生影响？"。

---

## 第一部分：我的独立发现

### 发现 A：`get_archived_file_content` 不传 phase 时丢失阶段上下文（功能缺陷）

**位置**: `src/tools/archive-tools.ts:68`

**设计参照**: 设计 §9 — `get_archived_file_content` 的 phase 参数"不传默认当前 phase"

**代码现状**:
```typescript
const safeFilename = phase
  ? join(validatePathSegment(phase), filename)
  : filename;  // ← 直接用 filename，没有默认使用 state.phase
```

**独立判断**: 这是功能缺陷。所有产出文件存储在 `handoff/{wfId}/{phase}/` 子目录下。不传 phase 时查找根目录而非当前阶段子目录 → 几乎永远找不到文件。调用方（AI）依赖"默认当前 phase"语义时静默失败。影响：高。

**原因推断**: 实现时将此工具当成泛化文件读取器，忽略了设计中的"阶段上下文感知"语义。

---

### 发现 B：Phase 初始化函数对 `turn_switched_at` / `turn_claimed_at` 处理不一致

**位置**: `src/state.ts:107-183`

**设计参照**: 设计 §11 — "各 phase advance 时重置...`turn_switched_at` 和 `turn_claimed_at` 清空"

**代码现状**（四个 init 函数对比）:

| 函数 | `turn_switched_at` | `turn_claimed_at` |
|---|---|---|
| `initRequirementsPhase` (L121-122) | `now` ❌ | `null` ✓ |
| `initPlanningPhase` (L135-143) | 保留旧值 ❌ | 保留旧值 ❌ |
| `initImplementationPhase` (L153-162) | 保留旧值 ❌ | 保留旧值 ❌ |
| `initSummaryPhase` (L178-179) | `now` ❌ | `null` ✓ |

**独立判断**: 四个函数三种行为：
1. Requirements + Summary：显式设为 `now`——意图是"phase 切换即启动掉线时钟"
2. Planning + Implementation：通过 `...state` 展开保留旧值——意图不明，像遗漏而非设计选择
3. 设计 §11：要求全部清空（设为 `null`）——这是第三种意图

影响链路：`wait_for_turn` 的掉线检测（L32-36）依赖 `turn_switched_at && !turn_claimed_at` 判断。如果 Requirements/Summary 初始化时设 `now`，时钟从 phase 切换时开始——若对方 30 分钟内未 claim（在做第一轮分析），会被误判掉线。Planning/Implementation 保留旧值同样有误判风险（旧值可能已超 30 分钟）。

**核心问题**: 不是"设计 vs 代码"的对立，而是**同一个设计意图在代码中被三种不同方式实现**——这是缺乏统一的 phase 初始化模板所致。

---

### 发现 C：`Task` 接口含设计未定义的 `goals` / `context` 死代码

**位置**: `src/state.ts:33-34`

**设计参照**: 设计 §5.1 — `task` 仅定义 `spec_file` 和 `task_type`

**代码现状**:
```typescript
export interface Task {
  spec_file?: string;
  goals?: string[];      // ← 设计 §5.1 不存在
  context?: string;      // ← 设计 §5.1 不存在
  task_type?: "requirements" | "development";
}
```

**独立判断**: 这两个字段在整个代码库中零引用——不是预留扩展点（因为没有 consumer），也不是活跃功能（因为没有 writer）。是设计裁剪后代码未同步清理的死代码。影响：低（仅误导维护者阅读接口定义时）。

---

### 发现 D：`who_am_i` 多返回了 `workflow_id`

**位置**: `src/tools/who-am-i.ts:22`

**设计参照**: 设计 §9 — 出参 `{ identity, registered, is_supervisor?, is_developer? }`

**代码现状**:
```typescript
return ok({
  identity,
  registered: !!peer,
  is_supervisor: peer?.role === "supervisor",
  is_developer: peer?.is_developer ?? false,
  workflow_id: workflowId,  // ← 设计未列出
});
```

**独立判断**: 接口宽松型差异（代码 > 设计）。多返回字段无破坏性，但如果有客户端按设计严格校验 schema 可能产生警告。属于实现时顺手附加了便捷字段，设计文档滞后。影响：极低。

---

### 发现 E：`lock.ts` 文件锁机制已实现但未接入（deepseek 未发现）

**位置**: `src/lock.ts`（全文件 113 行）

**设计参照**: 设计 §2 架构图标注 `.pairflow/（运行时: state.json + lock + pairflow.log）`

**代码现状**: `lock.ts` 实现了完整的文件锁机制：
- `acquireLock()` — PID 检查 + 心跳检测（15s 间隔/30s 超时）+ 崩溃循环检测（30s/3次）
- `releaseLock()` — 清理锁文件 + 停止心跳
- 但 `acquireLock` 和 `releaseLock` **在整个代码库中零引用**

**独立判断**: 设计承诺了进程级互斥锁（`.pairflow/lock`），代码实现了一套完整的文件锁，但从未在 `index.ts` 启动流程中调用。实际的进程互斥靠 `async-mutex` 的 `getMutex(workflowId)`（`src/state.ts:72-79`）实现——这是 per-workflow 的内存锁，与设计描述的 per-process 文件锁不同。

**影响分析**:
- 当前：无直接影响（`async-mutex` 提供了基本互斥）
- 风险：没有文件锁意味着**两个进程可以同时启动在同一端口**（端口冲突 EADDRINUSE 是唯一防线），设计意图的"防止多实例"未生效
- 这也意味着 `.pairflow/` 目录的运行时文件体系中缺少了设计承诺的 lock 组件

**为什么 deepseek 漏掉了**: r1 分析聚焦于"代码多了什么/少了什么"的字段级对比，未检查代码内部的引用关系（import chain）。`lock.ts` 本身存在且实现完整，只有追踪调用链才能发现它未被接入。

---

### 发现 F：idle 阶段 wait_for_turn 引导死锁（deepseek 未发现）

**位置**: `src/tools/confirm-task.ts:191-198` + `src/tools/wait-for-turn.ts:29`

**设计参照**: 设计 §4 数据流图 — confirm_task 完成后监督者调 advance

**代码现状**: confirm_task 对所有场景的 tip 都引导"调用 wait_for_turn"：
```typescript
// confirm-task.ts — 双方就位后
actionLine = `已加入工作流...双方已就位...调用 wait_for_turn...`;
```

但 idle 阶段 `turn = "idle"`（`defaultState()` 设置），`wait_for_turn` 的判断逻辑是：
```typescript
if (state.turn === identity) {  // identity 永远不会是 "idle"
  return ok(...);  // 永远不会执行
}
```

**独立判断**: 双方 confirm_task 后，都收到"调用 wait_for_turn"指令，然后都进入长轮询等待一个永远不会匹配的 turn。600 秒后超时返回无帮助的错误信息。**这在本次会话中已经复现**——必须靠用户手动告知监督者"直接 advance"才能突破。

**设计 vs 代码**: 设计 §4 数据流图中监督者调 advance 是正确行为，但 confirm_task 的 tip 没有区分场景——监督者在双方就位后应被告知"调用 advance 开始工作流"，而非"调用 wait_for_turn"。

**影响**: 中。每次新工作流启动都会被卡住，依赖用户或 AI 自行发现需要 advance。

---

## 第二部分：对照审阅 deepseek r1

### 对照 1：Task 接口 `goals`/`context`（deepseek 不一致 1）

| | deepseek | claude |
|---|---|---|
| 判定 | 不一致 | **一致** |
| 严重性 | 低（死代码） | 低（死代码） |

**对比**: 独立判断一致。deepseek 准确识别了零引用事实，我验证确认——grep 整个 src 目录 `goals` 和 `context` 仅出现在接口定义处。差异原因分析（"设计降级后的残留"）合理。

**补充**: deepseek 未提及的是，`goals` 和 `context` 在 `Task` 接口上都是 optional（`?:`），这意味着即使有人想用它们，TypeScript 也不会强制要求。这进一步降低了风险——但同时也说明它们从一开始就是"占位符"性质。

**结论**: 确认为一致。同意 deepseek 建议（删除或标注 v2 预留）。

---

### 对照 2：`get_archived_file_content` phase 默认值（deepseek 不一致 2）

| | deepseek | claude |
|---|---|---|
| 判定 | 不一致 | **一致** |
| 严重性 | 高（功能缺陷） | 高（功能缺陷） |

**对比**: 独立判断完全一致。代码逻辑一目了然——`phase ? join(phase, filename) : filename` 丢失了默认阶段语义。

**补充**: deepseek 的分析已经很完整。我只补充一点——这个 bug 的隐蔽性在于：如果调用方总是显式传 phase（而这恰恰是 AI 调用时的常见模式——tip 中通常包含明确的阶段上下文），bug 就不会触发。这解释了为什么它一直未被发现。

**结论**: 确认为一致。同意 deepseek 建议（最高优先级修复）。

---

### 对照 3：Phase 初始化 `turn_switched_at` / `turn_claimed_at`（deepseek 不一致 3）

| | deepseek | claude |
|---|---|---|
| 判定 | 不一致 | **一致** |
| 严重性 | 中 | 中 |

**对比**: 独立判断一致——四个 init 函数行为不同，设计 §11 要求清空。但**分析角度有差异**：

deepseek 侧重"运行时刻的掉线误判风险"分析，将差异分为两类（Requirements/Summary 设 now vs Planning/Implementation 保留旧值），并指出两种行为分别的误判场景。

我的分析侧重"根本原因"——这不是设计 vs 代码的二元对立，而是**缺乏统一的 phase 初始化模式**。四个 init 函数各自手写 `...state` spread + 字段覆盖，没有共享的"重置 phase 级别字段"的辅助函数。这导致了三种不同行为。

**补充角度**: 建议的修复方案不应只是"统一清空"或"统一设 now"，而应提取一个 `resetPhaseState(state)` 公用函数，统一处理 `round=1`、`last_submit_per_turn={}`、`turn_switched_at=null`、`turn_claimed_at=null` 这些"phase 级别重置"操作。这样设计 §11 的约束由代码结构保证，而非靠四个函数各自记住。

**结论**: 确认为一致。建议采用结构性修复（提取公用函数）而非逐个修补。

---

### 对照 4：`who_am_i` 多余 `workflow_id`（deepseek 不一致 4）

| | deepseek | claude |
|---|---|---|
| 判定 | 不一致 | **一致** |
| 严重性 | 低 | 极低 |

**对比**: 独立判断完全一致。都认为是接口宽松型差异（代码 > 设计），影响极低。

**补充**: 这个差异其实反映了一个更广泛的模式——代码返回的字段往往比设计文档列出的更丰富（`confirm_task` 返回 `task_path`、`recovered`，`register` 返回 `phase`）。这不是 bug，而是设计文档写的是"最小契约"，代码提供了"附加便利"。但从一致性审计的角度，要么设计应同步补全，要么代码应尊重设计的最小契约。

**结论**: 确认为一致。优先级最低，可随设计文档下一次修订时补全。

---

## 第三部分：汇总

### 发现矩阵

| # | 不一致 | 位置 | 严重性 | r1 已发现？ | 判定 |
|---|---|---|---|---|---|
| A/C | `Task` 接口 `goals`/`context` 死代码 | `state.ts:33-34` | 低 | ✅ 是 | 一致 |
| B/D | `get_archived_file_content` phase 默认值缺失 | `archive-tools.ts:68` | **高** | ✅ 是 | 一致 |
| C/B | Phase 初始化 `turn_switched_at`/`turn_claimed_at` 不一致 | `state.ts:107-183` | 中 | ✅ 是 | 一致（分析角度互补） |
| D/D | `who_am_i` 多余 `workflow_id` | `who-am-i.ts:22` | 极低 | ✅ 是 | 一致 |
| E | `lock.ts` 文件锁实现完整但未接入 | `lock.ts`（全文件） | 中 | ❌ 否 | **新增** |
| F | idle 阶段 confirm_task 引导死锁 | `confirm-task.ts:191-198` | 中 | ❌ 否 | **新增** |

### 已验证一致的区域

与 deepseek 相同的结论——以下设计章节与代码实现一致（不再重复展开）：
- §4 启动与注册流程 ✓
- §5.2 Phase 转换（含需求模式跳过逻辑）✓
- §5.3 Turn 切换 ✓
- §7 Issue 系统 ✓
- §8 异常处理（掉线检测/崩溃恢复/crash loop）✓
- §9 工具清单（11 个工具全部实现）✓
- §10 Tip 格式规范 ✓
- §11 Phase turn 分配 ✓

### 设计内部矛盾（非代码问题）

同意 deepseek 的标注：设计 §2 架构图中的 `.pairflow/state.json` 与 §3 "状态为进程内存变量"矛盾。补充——`lock.ts` 未被接入的事实进一步说明 `.pairflow/` 运行时目录体系在代码中的实现是不完整的（`pairflow.log` 正常写入，`lock` 实现了但未接入，`state.json` 不存在）。

### 各发现建议处理优先级

1. **P0 — 立即修复**: 不一致 B（`get_archived_file_content` phase 默认值）——功能缺陷，影响 AI 读取归档文件
2. **P1 — 尽快修复**: 不一致 F（idle 阶段引导死锁）——每次新工作流都受阻
3. **P2 — 计划修复**: 不一致 C（Phase 初始化不一致）——建议提取公用函数做结构性修复；不一致 E（lock.ts 未接入）——要么接入要么从设计中移除
4. **P3 — 技术债**: 不一致 A（Task 死代码）、不一致 D（who_am_i 多余字段）

所有观点注明提出人: claude

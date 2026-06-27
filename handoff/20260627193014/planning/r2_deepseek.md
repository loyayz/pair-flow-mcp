# PairFlow 设计缺陷修复 — r2 审阅

> 审阅人：deepseek
> 日期：2026-06-27
> 审阅对象：claude r1 实施计划（commit: 2bcdf796f65cef83c86677819106435fe9a4ee20）

---

## 一、总体评价

claude 的计划覆盖了全部 16 项设计缺陷 + 2 项 v2 backlog，按优先级分四批，每批有明确的方案、影响文件和风险评估。实施依赖图基本正确，修复顺序合理。**总体同意计划的框架和方向**，以下为逐条审阅意见。

---

## 二、同意的方案（无需修改）

以下方案完全同意，无需调整：

| 编号 | 简述 | 确认 |
|------|------|------|
| P0-1 | IMPLEMENTATION 文件命名加 sub_phase 前缀 | ✅ |
| P0-2 | SUMMARY round ≥ 2 tip 补充 | ✅ |
| P1-3 | sub_phase 切换规则文档化 | ✅ |
| P2-1 | dev_phase → dev_cycle 重命名 | ✅ |
| P2-4 | 崩溃恢复身份校验 | ✅ |
| P2-7 | SUMMARY→IDLE 收敛检查 | ✅ |
| P3-1 | advance 返回值文档补充 | ✅ |
| P3-2 | 架构图排版修复 | ✅ |
| P3-3 | task.description 语义修正 | ✅ |

---

## 三、有建议的方案（同意但有优化建议）

### 3.1 P0-3 — meta.json 生成规范：建议采用方案 B

**claude 方案**：A) tip 指引 AI 手动创建，B) submit 自动生成。

**deepseek 建议**：**推荐方案 B（submit 自动生成）**。理由：

1. P0-3 本身就是因为"AI 可能不做"才成为缺陷——方案 A 依赖 AI 遵从指引，本质上没有解决可靠性问题
2. 方案 B 的 submit 行为变更风险可控：只需在 submit 成功后，在 handoff 对应目录写入一个 meta.json 文件，不影响状态机
3. meta.json 的内容完全可从 submit 参数和 state 中派生，不需要 AI 参与
4. 若担心破坏现有流程，可先实现方案 B，同时在 tip 中保留方案 A 的指引作为双重保险

**具体实现建议**：
```typescript
// submit.ts 中在 saveState 之后：
const metaPath = join(HANDOFF_DIR, state.workflow_id!, state.phase, 
  `r${originalRound}_${identity}.meta.json`);
await writeFile(metaPath, JSON.stringify({
  submitted_at: now,
  commit_hash: commitHash,
  sub_phase: state.sub_phase, // 注意：此时 sub_phase 已切换，需记录切换前的值
  task: state.task,
}, null, 2), "utf-8");
```

注意 `sub_phase` 的时序问题：submit 中 sub_phase 切换发生在记录 `last_submit_per_turn` 之后，meta.json 应记录切换**前**的 sub_phase。

**结论**：同意方案 B，建议作为首选实施路径。

---

### 3.2 P1-1 — SUMMARY turn 分配：建议明确多轮流程

**claude 方案**：保持 §10（监督者 r1），修改 §3 目录结构为 `r1_{supervisor}.md` + `r2_{identity}.md`。

**deepseek 建议**：同意方向，但需要明确 r3 之后的场景。当前目录仅到 r2，但 submit 后 round 会持续累加。建议：

- **r1**：监督者产出草稿
- **r2**：非监督者审阅草稿
- **r3+**：交替审阅修订（与 requirements/planning 一样）
- **收敛条件**：监督者调用 advance → IDLE

对应 tip.ts 中 summary 的 round≥2 分支应区分：
- r2：审阅草稿
- r3+：交替审阅修订

**结论**：同意方案，补充 r3+ 流程说明。

---

### 3.3 P1-2 — 兼任负载均衡：建议简化方案

**claude 方案**：REQUIREMENTS→PLANNING 的 turn 改为"需求分析者继续做计划"。

**deepseek 建议**：方案逻辑合理（谁分析需求谁做计划，保持连贯性），但实现复杂度偏高。建议评估更简单的替代方案：

**替代 A**：不做修改，承认这是 v1 兼任的固有 trade-off。设计 §1 的"交替产出与评审"是针对标准角色分配（supervisor≠developer）的场景。兼任本身是优化配置，用户若在意负载均衡可拆分为两个身份。

**替代 B（若坚持修改）**：仅修改 PLANNING 的 tip，在兼任场景下提示监督者可通过 advance 跳过 PLANNING 阶段（因为需求分析者已在 r1 覆盖了部分计划内容）。

**结论**：偏向替代 A（不修改），或在实施时将 claude 方案降级为"可选优化"。

---

### 3.4 P1-4 — 监督者降级：超时阈值建议微调

**claude 方案**：60 分钟超时 + `takeover` 工具。

**deepseek 建议**：方向完全同意。两点微调：

1. **超时阈值**：60 分钟偏长。考虑 AI 工作流的实际节奏（单个任务通常 5-30 分钟），建议 **30 分钟**。与 wait_for_turn 的掉线检测阈值（30 分钟）保持一致。
2. **状态字段**：建议用已有的 `turn_claimed_at` 而非新增 `supervisor_last_action_at`。监督者的 advance/confirm_dir/confirm_task 操作可更新 `turn_claimed_at`，减少 schema 膨胀。

**结论**：同意方案，建议超时 30 分钟 + 复用 `turn_claimed_at`。

---

### 3.5 P2-2 — converged 字段：推荐删除

**claude 方案**：推荐删除，备选激活。

**deepseek 建议**：**强烈推荐删除**。理由：
- 该字段从 v1 起就是死代码，从未使用
- §6 的手动收敛模型已经足够（监督者 advance = 收敛确认）
- 激活方案需要新增 `set_converged` 工具 + advance 检查 + 状态转换，引入了不必要的复杂度
- 如果未来确实需要程序化收敛判定（如自动检测双方均提交后标记 converged），再加回来不迟

**结论**：删除，不留备选。

---

### 3.6 P2-6 — Node 版本依赖：推荐代码兼容方案

**claude 方案**：A) `engines: >=22`，B) 用 `path.relative` 替代 `parentPath`。

**deepseek 建议**：**推荐方案 B（代码兼容）**。理由：
- Node 22 在 Windows 上仍有兼容性问题（某些原生模块未适配）
- `parentPath` 改为 `path.relative` 的改动量极小（约 5 行），无需提升最低版本要求
- 当前项目未使用任何 Node 22 独有特性，仅为这一个 API 提升版本要求不划算

具体改动：
```typescript
// 替换前：
const pp = (e as { parentPath?: string }).parentPath;
const relDir = pp.startsWith(absDir) ? pp.slice(absDir.length) : pp;

// 替换后：
import { relative } from "node:path";
const pp = (e as { parentPath?: string }).parentPath ?? (e as { path?: string }).path ?? "";
const absPP = pp ? resolve(dir, pp) : resolve(dir); // parentPath 是绝对路径本身
// ...或者直接用 path.relative
```

实际上更好的做法是放弃 `recursive: true`，改为手动递归——这样同时兼容 Node 18+。

**结论**：推荐方案 B（代码兼容），同时保留方案 A 的 `engines` 声明作为文档记录。

---

## 四、缺失项

### 4.1 缺少测试策略

计划未提及测试。建议至少包含：
- **P0-1, P0-2**：tip.ts 单元测试 — 验证各 phase/round/sub_phase 组合输出正确的文件路径和指引
- **P2-7**：advance 单元测试 — 验证 SUMMARY→IDLE 在无提交记录时拒绝
- **P2-4**：confirm-task 单元测试 — 验证恢复后身份校验

### 4.2 缺少 `.pid` 文件清理

工作流完结（SUMMARY→IDLE）后 `.pid` 文件是否应清理？当前设计中未提及。建议在 `initIdleState` 或 `advance` SUMMARY→IDLE 分支中处理。

---

## 五、实施依赖图修订

claude 的依赖图基本正确，但 P2-7（SUMMARY→IDLE 收敛检查）不依赖 P2-1（dev_cycle 重命名），应独立执行。修订如下：

```
P0-1 + P0-2 + P1-1  ──→  tip.ts 集中修改
P0-3                   ──→  submit.ts 自动生成 meta.json
P2-1 (dev_cycle)       ──→  独立，纯重命名
P2-2 (converged 删除)   ──→  独立，不影响其他
P2-7 (SUMMARY 收敛)     ──→  独立，advance.ts 单文件
P1-2 + P1-4 + P2-3 + P2-5  ──→  turn 分配 + 掉线恢复组
P2-4 + P2-6 + P3-1/2/3   ──→  校验 + 文档组
P1-3                   ──→  独立，随时可做
```

---

## 六、审阅结论

| 类别 | 数量 | 处置 |
|------|------|------|
| 完全同意 | 9 | P0-1, P0-2, P1-3, P2-1, P2-4, P2-7, P3-1, P3-2, P3-3 |
| 同意方向，有优化建议 | 6 | P0-3 (方案B), P1-1 (r3+), P1-2 (简化), P1-4 (30min), P2-2 (删除), P2-6 (兼容) |
| 缺失需补充 | 2 | 测试策略 + .pid 清理 |

**建议**：claude 根据上述建议修订计划文档后，即可收敛进入开发阶段。

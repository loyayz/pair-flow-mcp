# Tip 模板化 — 实施计划审阅

> 审阅人：claude（developer）
> 审阅对象：`r1_codex.md`（commit `6c836dd`）

## 总体评价

计划质量很高。6 个 Task 按 TDD 节奏编排，每个 Task 都有 RED → GREEN → COMMIT 闭环，模板键矩阵覆盖了需求分析中确认的所有 tip 入口。文件结构清晰、全局约束明确。

以下按 Task 逐一审阅。

---

## Task 1: 严格模板加载与渲染边界 ✅

**同意**。

- `TEMPLATE_SPECS` 显式注册（不依赖目录扫描）对齐了需求分析的"启动校验"和"严格失败"
- `renderTip()` 内调 `formatTip()` 的设计正确：模板按三段格式写，渲染器解析三段、分别插值、再组装
- `lstatSync` + `isFile()` 检查解决了 D1（叶子普通文件校验），同时拒绝目录和链接
- `resetTipTemplatesForTests()` 提供测试隔离，考虑周到

**补充建议**：
- `TEMPLATE_SPECS` 中 `allowed` 变量的含义建议在代码注释中明确：`allowed = required ∪ optional`，渲染时必需变量缺失报错，可选变量缺失替换为空字符串（但若出现在模板文本中也应报错——因为模板引用了它）

---

## Task 2: 默认模板目录与键契约门禁 ✅

**同意**。

- "从当前 TypeScript 逐字迁移默认文案到模板"是正确的一步——保证行为不回归
- 关键约束"模板文件不得使用 `{{action}}`、`{{product}}`、`{{current}}` 或 `{{advance_prefix}}` 整句逃生变量"——这是需求分析中 codex 坚持的核心设计，我已在 r3 中同意

**补充建议**：
- Step 4 (README) 中建议增加一个"如何新增模板场景"的 checklist，帮助上游维护者在新增 phase/tool 时知道要改哪些地方

---

## Task 3: 迁移响应/注册/确认/等待类 tip ⚠️

**基本同意，有几点关注**：

1. **文件范围较大**：涉及 5 个源文件 + 3 个测试文件。Step 3 中 `confirm-task.ts` 的示例展示了清晰的模板键选择逻辑（`isFirst ? recovered ? "confirm.recovered" : "confirm.created" : "confirm.joined"`），这个模式可行。

2. **关注**：`wait-for-turn.ts` 的 warn/timeout tip 中 `elapsed_minutes` 变量。计划中使用 `Math.round(elapsed)` 的整数分钟数，**建议**统一为 `Math.round(elapsed)` 并在类型注释中标明单位。

3. **关注**：`get-state.ts` 有 4 个独立模板键（unbound/inactive/recovery-pending/roster-pending），每个只需 `identity` 和 `workflow_id`——这些足够了。但当前 `getStateTool` 在 recovery-pending 和 roster-pending 两种状态下的 tip 文案不同，模板中要对应体现。✅ 计划已覆盖。

---

## Task 4: 迁移 buildTip() ✅

**同意**。这是最复杂的迁移——`getAction()` 的 20+ 个分支。

- `selectTip()` 返回 `{ key, variables }` 的设计干净
- 表驱动测试覆盖所有 phase/round/sub_phase 分支，防止迁移遗漏
- 关于 `advancePrefix`：计划明确不构造完整句，直接选择 `.advance` 键——**同意**。`advance_target` 作为变量传入（如"进入实施计划阶段"），模板中写为 `作为监督者，若确认目标已达成可直接调用 advance（{{advance_target}}）。否则：`

**补充**：
- 建议在 `selectTip()` 函数的注释中对每个分支标注对应需求分析中的哪个矩阵行，便于代码审阅时核对

---

## Task 5: 迁移 advance 与 submit 成功 tip ✅

**同意**。

- `ownProduct()` 不再返回完整句——self/other 直接选不同模板键，设计正确
- `buildSubmissionSuccessTip()` 的三分支（advance-ready / both-submitted / wait）在矩阵中对应 `submit.advance-ready` / `submit.both-submitted` / `submit.wait`

**补充**：
- `advance.ts` 中 `markTurnAssigned()` 函数完全不涉及 tip 文案，保持不变 ✅

---

## Task 6: 文档、硬编码扫描与源码/构建产物验收 ✅

**同意**。

- 硬编码扫描测试是防止回归的关键防线。白名单机制（允许 `tip-format.ts` 和 `tip-template.ts` 中的 `formatTip` 调用）合理
- Step 4 的构建产物验证（`node dist/index.js` 模式下模板定位）解决了需求分析 Q5

**补充建议**：
- Step 1 硬编码扫描中，建议同时扫描 `const tip =` 和 `tip:` 赋值中出现的中文提示文案字符串，作为辅助检测（非唯一依据，但可以发现遗漏）

---

## 整体架构审视

### ✅ 优点

| 方面 | 评价 |
|------|------|
| TDD 节奏 | 每个 Task 都是 RED → GREEN → COMMIT，可独立验证 |
| 模板键矩阵 | 完整覆盖了需求分析确认的所有入口 |
| 严格失败 | 启动即校验，不留运行时静默退化路径 |
| 破坏性隔离 | `--help` 不依赖模板，其他操作在模板初始化后 |
| 测试门禁 | 表驱动测试 + 硬编码扫描 + 构建产物验证三层防线 |

### ⚠️ 潜在风险

| 风险 | 影响 | 建议 |
|------|------|------|
| Task 3-5 的测试文件修改可能引入意外回归 | 中 | 每个 Task commit 前跑全量测试（`npx vitest run`），不只跑相关测试文件 |
| `tsc --noEmit` 在 Task 4 后可能因类型变化报错 | 低 | `selectTip()` 的返回类型需与 `renderTip()` 参数类型对齐 |
| 构建产物（`dist/`）中的模板路径解析 | 中 | Task 6 Step 4 已有验证，但建议也在 CI 中跑一次 |

---

## 判断

计划完整、可执行。所有需求分析共识点（12 项）均在计划中得到体现，2 个待定分歧（D1/D2）已按监督者裁定方式落实。6 个 Task 按依赖顺序排列，每个都有明确的文件、接口、步骤和验收标准。

**同意按此计划进入 Implementation 阶段。**

---

> 审阅人：claude（developer）

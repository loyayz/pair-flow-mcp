# 需求分析：Tip 模板化

> 分析人：claude（developer）
> 任务：将所有接口的 tip 从代码硬编码改为从模板文件获取

---

## 1. 目标与范围

### 核心问题

当前 PairFlow 所有 MCP 工具返回的 `tip` 字段均为 TypeScript 源码中的字符串字面量（`tip.ts`、`register.ts`、`confirm-task.ts`、`advance.ts`、`submit.ts`、`wait-for-turn.ts`、`get-state.ts`）。fork 本仓库的用户若要定制提示文案（例如改为其他语言、调整措辞风格、匹配组织内部流程术语），必须直接修改源码，存在以下痛点：

- **修改门槛高**：需要理解 TypeScript 代码和 tip 生成逻辑才能安全改文案
- **升级冲突**：fork 后 upstream 有更新时，文案修改与代码变更混合在同一文件中，merge 困难
- **不可热切换**：修改文案需要重启服务，且无法在不同工作流/项目间使用不同模板

### 目标判断

将 tip 文案从 TypeScript 源码中分离到独立的模板文件中，使：
1. 用户无需阅读 TypeScript 代码即可修改提示文案
2. 模板文件独立于源码，upstream 升级时减少冲突
3. 模板格式简单、可预测，降低学习成本

### 边界（做/不做）

**做**：
- 设计模板文件格式（变量插值语法、文件组织结构）
- 实现模板加载引擎（读取、缓存、变量替换）
- 将所有现有硬编码 tip 迁移到模板文件
- 提供合理的默认模板（内置在 PairFlow 包中）
- 模板缺失/损坏时回退到内置默认值
- 模板路径可配置（默认指向内置模板目录，可覆盖为自定义目录）

**不做**：
- 模板热加载（修改模板需重启服务生效）
- 同一服务实例内按工作流切换模板
- 模板中的条件分支逻辑（如 `{{#if is_supervisor}}...{{/if}}`）—— v1 只做简单变量替换，分支逻辑仍保留在 `getAction()` 等 TypeScript 函数中
- 修改 tip 的结构化格式（`[行动]/[产出]/[当前]` 三段式仍由 `formatTip()` 组装）
- 模板国际化/多语言框架——v1 只支持单套模板

---

## 2. 干系人与场景

### 干系人画像

| 干系人 | 画像 | 关注点 |
|--------|------|--------|
| **Fork 维护者** | 为自己的团队/组织定制了 PairFlow，需要调整提示文案以匹配内部流程术语和工作风格 | 修改简单、不影响升级、改动范围可控 |
| **AI 参与者** | Claude/Codex 等 AI 客户端，通过 `wait_for_turn` 和 `get_state` 获取行动指引 | 提示清晰、上下文完整、格式一致 |
| **PairFlow 上游开发者** | 维护 PairFlow 核心功能，需要在不破坏 fork 定制的前提下迭代模板结构 | 新增模板场景时提供迁移指引 |

### 主场景

1. **Fork 后首次定制**：Fork 维护者将内置模板目录复制到自定义路径，修改文案（如将"需求分析"改为"Requirements Analysis"，调整语气风格），启动时指定模板路径
2. **上游升级**：PairFlow 新增一个工具或阶段，上游发布新版本时附带新增的模板文件；Fork 维护者将新增模板合并到自己的模板目录
3. **默认行为不变**：未指定模板路径时，使用内置默认模板，行为与当前硬编码完全一致
4. **模板损坏容错**：某个模板文件被误删或格式错误，加载时回退到内置默认值并记录警告

---

## 3. 功能需求

### 功能清单（按优先级排序）

**P0 — 核心功能**：

1. **模板文件格式定义**
   - 使用简单变量插值语法：`{{variable_name}}`
   - 每个模板文件对应一个 tip 场景（如 `requirements-r1.md`、`planning-r1.md`）
   - 模板内容为纯文本，包含 `{{变量}}` 占位符

2. **模板目录结构**
   ```
   templates/
   ├── requirements/
   │   ├── r1.md          # 第一轮需求分析
   │   ├── r2.md          # 第二轮（审阅对方）
   │   └── rn.md          # 第三轮及以后
   ├── planning/
   │   ├── r1.md
   │   └── rn.md
   ├── implementation/
   │   ├── r1-coding.md
   │   ├── rn-coding.md
   │   ├── r2-review.md
   │   └── rn-review.md
   ├── summary/
   │   ├── r1.md
   │   ├── r2.md
   │   └── rn.md
   ├── register.md        # register 成功后的 tip
   ├── confirm-task.md    # confirm_task 成功后的 tip
   ├── advance.md         # advance 各阶段的 tip
   ├── submit.md          # submit 成功后的 tip
   ├── wait-timeout.md    # wait_for_turn 超时
   ├── wait-warning.md    # roster/turn 超 30 分钟警告
   ├── idle.md            # idle 阶段的 tip
   └── completed.md       # 工作流结束
   ```

3. **模板变量体系**
   - 所有模板共享一套变量：`{{identity}}`、`{{other_identity}}`、`{{task_path}}`、`{{workflow_id}}`、`{{phase}}`、`{{phase_label}}`、`{{round}}`、`{{sub_phase}}`、`{{turn}}`、`{{file_path}}`、`{{prev_file}}`、`{{prev_commit}}`、`{{plan_doc}}`、`{{archive_root}}`、`{{responsibility_label}}`、`{{other_responsibility_label}}`、`{{advance_target}}`
   - `{{action}}` 和 `{{product}}` 和 `{{current}}` 三个变量由 TypeScript 端的 `getAction()` / `outFile()` / `identityLabel()` 逻辑生成后注入模板（即模板层面只做最终文本拼接，不做分拆逻辑判断）

4. **模板加载器** (`src/template-engine.ts`)
   - `loadTemplate(name: string, variables: Record<string, string>): string` — 核心加载+渲染函数
   - 启动时扫描并缓存所有模板文件
   - 模板缺失时回退到内置硬编码默认值
   - 内置默认值本身也以代码常量形式保留（作为 ultimate fallback）

5. **CLI 参数支持**
   - `--templates <path>` 指定自定义模板目录
   - 未指定时使用 PairFlow 包内置模板（`templates/` 目录随包发布）

**P1 — 增强功能**：

6. **模板验证**
   - 启动时校验模板中引用的变量是否在变量表中存在，警告未知变量
   - 模板文件编码统一为 UTF-8

7. **内置模板生成**
   - 将现有所有硬编码 tip 文案照原样写入内置模板文件
   - 保证模板化后的行为与当前 100% 一致

**P2 — 未来考虑（v2）**：
- 模板热加载
- 条件分支语法（`{{#if}}...{{/if}}`）
- 多语言模板支持

---

## 4. 非功能约束

### 性能
- 模板在服务启动时一次性加载到内存缓存（Map），后续请求直接从内存读取
- 单次模板渲染（变量替换）耗时应 < 1ms
- 模板文件总大小预计 < 50KB，内存占用可忽略

### 安全
- 模板文件只做纯文本变量替换，不执行任何代码
- `{{variable}}` 中的变量名仅允许 `[a-zA-Z0-9_]+`
- 变量值中的特殊字符（如反斜杠、引号）不影响模板渲染（纯字符串替换）
- 模板目录必须为非链接路径，防止符号链接攻击（复用现有 `findSymbolicLinkInPath` 逻辑）

### 兼容性
- 未指定 `--templates` 时行为与当前完全一致
- 模板文件格式向前兼容：新增变量不破坏旧模板（未识别的 `{{var}}` 保留原文或替换为空字符串）
- 新增模板场景时，若旧模板目录缺少对应文件，自动回退到内置默认值

### 可维护性
- 内置模板文件放在 `templates/` 目录，与 `src/` 平级
- 每个阶段的模板文件独立，修改一处不影响其他
- 变量表集中在 `template-engine.ts` 中定义和文档化

---

## 5. 假设与风险

### 假设

| # | 假设 | 风险等级 | 说明 |
|---|------|---------|------|
| H1 | v1 只需要简单变量替换，不需要模板中的条件分支 | 低 | `getAction()` 中的复杂分支逻辑保留在 TypeScript 端，模板只做最终拼接。若 fork 维护者需要更细粒度控制，v2 可考虑引入条件语法 |
| H2 | 模板文件使用 `{{variable}}` 双花括号语法 | 低 | 与 Mustache/Handlebars 子集兼容但不实现完整引擎。选择该语法是因为简单且广泛认知 |
| H3 | fork 维护者愿意手动合并上游新增的模板文件 | 中 | 当 PairFlow 新增 phase 或 tool 产生新的 tip 场景时，fork 维护者需要将新模板文件复制到自己的模板目录。**假设**：新场景频率低（主要 phase 已稳定），合并工作量可接受 |
| H4 | 模板加载失败时回退到内置默认值是合理的容错策略 | 低 | 内置默认值就是当前硬编码文案的直接迁移，语义不变 |
| H5 | 启动时一次性加载所有模板适合当前模板数量（~20 个文件） | 低 | 20 个模板文件，每个 < 2KB，总大小 < 50KB，启动加载开销可忽略 |

### 风险

| # | 风险 | 影响 | 缓解措施 |
|---|------|------|---------|
| R1 | `getAction()` 的逻辑与模板文件中的文案存在隐式耦合 | 中 | 变量名与 TypeScript 端生成的动作描述在语义上对齐。在 `template-engine.ts` 中为每个变量写文档注释 |
| R2 | 模板文件的目录结构和命名约定可能在后续迭代中变化 | 低 | 版本化模板目录，`templates/v1/`；也可通过约定而非强制——路径就是 API |
| R3 | 自定义模板中使用了未知变量名（拼写错误），渲染后出现 `{{typo}}` 原文 | 低 | 启动时校验并 warn 未知变量；渲染时对未提供值的变量替换为空字符串（可配置） |

---

## 6. 歧义与待澄清

| # | 问题 | 临时替代方案 | 提出人 |
|---|------|-------------|--------|
| Q1 | 模板路径 `--templates` 是相对路径（相对于 work_dir）还是绝对路径？ | 暂时要求必须是绝对路径，与现有 `task_path`、`work_dir` 的路径校验逻辑一致 | claude |
| Q2 | 是否需要 `--templates` 参数，还是作为 `confirm_task` 的一个字段（按工作流选择模板）？ | v1 作为服务器启动参数，所有工作流共用同一套模板。若需要按工作流切换应在 v2 中评估 | claude |
| Q3 | `submit` 成功后的 tip 包含 "等待监督者 advance" / "等待对方完成" / "turn 到你时自动返回" 三种分支——这些分支逻辑在模板中如何处理？ | 在 TypeScript 端（`buildSubmissionSuccessTip()`）通过 `getAction()` 生成对应的 action 文本，模板只做最终拼接。即分支逻辑不进入模板层 | claude |
| Q4 | 内置模板文件的加载路径——PairFlow 作为 npm 包被 `npx tsx` 运行时，如何可靠定位内置模板？ | 使用 `import.meta.url` 或 `__dirname` 相对于 `template-engine.ts` 的位置推算 `templates/` 目录路径 | claude |
| Q5 | 模板渲染时变量值为空（如 `prev_file` 在第一轮时为 null），是替换为空字符串还是保留 `{{prev_file}}` 原文？ | 替换为空字符串 ""，避免 AI 看到 `{{prev_file}}` 这样的模板语法残留 | claude |

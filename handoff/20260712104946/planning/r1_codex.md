# Tip 模板化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` and execute this plan task-by-task. PairFlow 已负责双方交替实现/评审，不额外创建 worktree 或并行 subagent。

**Goal:** 将 PairFlow 所有可定制 tip 句子迁移到仓库内固定纯文本模板，使 fork 维护者无需修改 TypeScript 即可改写提示，同时保持状态机与默认行动语义不变。（codex）

**Architecture:** 在仓库根创建 `templates/tips/`，每个稳定场景键对应一个 UTF-8 `.md` 模板。模板使用固定 `[行动]`、可选 `[产出]`、可选 `[当前]` 段和 `{{name}}` 纯文本占位符；`src/tip-template.ts` 负责模板键契约、叶子普通文件校验、启动缓存、严格插值并复用 `formatTip()` 组装段落。各工具只保留状态判断、模板键选择和结构化变量计算。（claude、codex）

**Tech Stack:** Node.js 20.19+、TypeScript 7、Vitest 4、Node `fs/path/url` 标准库；不增加模板引擎依赖。（codex）

## Global Constraints

- `docs/design.md` 是唯一权威规格；不得改变 phase、turn、职责、submit、advance、恢复或路径边界。（项目约束）
- v1 不增加 `--templates`、热加载、多语言、条件/循环/表达式或代码执行。（claude、codex）
- 默认模板是唯一 tip 文案来源；不得保留 TypeScript 文案 fallback。（claude、codex）
- 模板加载失败、叶子不是普通文件、未知模板键、未知占位符、必需占位符缺失或渲染变量缺失必须明确失败。（claude、codex）
- 请求路径只使用已缓存模板；模板修改后重启生效。（claude、codex）
- 路径变量继续在调用方转换为 POSIX 正斜杠；变量内容只替换一次，不二次解析。（claude、codex）
- 运行期 `.pid` 与 `.meta.json` 不提交；每个计划任务只提交列出的源码、模板、测试或文档。（项目约束）

---

## 文件结构与职责

- Create `src/tip-template.ts`：模板键类型、键到文件/变量契约、固定根定位、加载/解析/校验/缓存、`renderTip()`。
- Modify `src/index.ts`：`--help` 早退后、监听端口前调用 `initializeTipTemplates()`，失败时打印可定位错误并退出 1。
- Keep `src/tip-format.ts`：继续保证 `[行动] → [产出] → [当前]` 顺序与空段省略。
- Modify `src/response.ts`、`src/tip.ts`、`src/tools/{register,confirm-task,advance,get-state,wait-for-turn,submit}.ts`：删除可定制句子，改为模板键 + 结构化变量。
- Create `templates/tips/**/*.md`：默认文案唯一权威来源。
- Create `templates/tips/README.md`：语法、变量、固定路径、严格失败、重启生效说明。
- Create `src/__tests__/tip-template.test.ts`：加载、段落解析、变量契约、缓存和路径定位单元测试。
- Modify existing tip/tool tests：保持既有关键响应断言并新增完整场景键覆盖门禁。
- Modify `README.md`：链接模板说明并给 fork 维护者最短编辑流程。

## 模板文件格式

每个模板文件使用以下格式；`[行动]` 必须存在且非空，另两段可省略，段标记只能按此顺序出现：

```markdown
[行动]
读取任务文档 {{task_path}} 并进行深度需求分析。

[产出]
完成后 git commit，调用 submit，file_path = {{file_path}}

[当前]
你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到你了。
```

渲染器分别插值三个段体，再调用：

```ts
formatTip({ action, product, current })
```

## 模板键矩阵

planning 阶段采用以下完整矩阵；`required` 占位符必须出现在默认模板中并在渲染时提供，`allowed` 等于 required 加表中注明的可选项。实现时 `TEMPLATE_SPECS` 必须逐项列出，不允许目录扫描自动创造未知键。（codex，claude 同意先列矩阵）

| 文件/键组 | 场景键 | required 变量 |
|---|---|---|
| `response/rejected.md` | `response.rejected` | `message` |
| `register/success.md` | `register.success` | `token`, `identity` |
| `confirm/existing.md` | `confirm.existing` | `identity`, `responsibility`, `workflow_id`, `phase`, `round`, `turn`, `turn_relation` |
| `confirm/created.md` | `confirm.created` | `identity`, `responsibility`, `workflow_id` |
| `confirm/recovered.md` | `confirm.recovered` | `identity`, `responsibility`, `workflow_id` |
| `confirm/joined.md` | `confirm.joined` | `identity`, `responsibility`, `workflow_id`, `phase_status`, `participant_labels` |
| `get-state/*.md` | `get-state.unbound`, `get-state.inactive`, `get-state.recovery-pending`, `get-state.roster-pending` | 各键只声明其文本使用的 `identity`, `workflow_id` |
| `wait/*.md` | `wait.roster-warning`, `wait.turn-warning`, `wait.timeout-ready`, `wait.timeout-roster`, `wait.completed` | 对应键所需的 `identity`, `workflow_id`, `elapsed_minutes`, `round`, `turn` |
| `advance/requirements-other.md` | `advance.requirements.other` | `identity`, `turn`, `file_path` |
| `advance/planning-self.md`, `planning-other.md` | `advance.planning.self`, `advance.planning.other` | `identity`, `turn`, `file_path` |
| `advance/implementation-self.md`, `implementation-other.md` | `advance.implementation.self`, `advance.implementation.other` | `identity`, `turn`, `file_path` |
| `advance/summary-self.md` | `advance.summary.self` | `identity`, `file_path` |
| `advance/completed.md` | `advance.completed` | `identity`, `archive_root` |
| `state/idle-supervisor.md`, `idle-other.md`, `wait-other.md`, `unknown.md` | `state.idle.supervisor`, `state.idle.other`, `state.wait.other`, `state.unknown` | 对应键所需的 `identity_label`, `turn`, `round`, `phase_label`, `phase`, `sub_phase` |
| `requirements/r1.md`, `r2.md`, `rn.md`, `rn-advance.md` | `requirements.r1`, `requirements.r2`, `requirements.rn`, `requirements.rn.advance` | `task_path`, `prev_file`, `prev_commit`, `identity_label`, `round`, `phase_label`, `file_path`; advance 键另需 `advance_target` |
| `planning/r1.md`, `rn.md`, `rn-advance.md` | `planning.r1`, `planning.rn`, `planning.rn.advance` | `task_path` 或 `plan_file`, `prev_file`, `prev_commit`, `identity_label`, `round`, `phase_label`, `file_path`; advance 键另需 `advance_target` |
| `implementation/coding-r1.md`, `coding-rn.md` | `implementation.coding.r1`, `implementation.coding.rn` | `plan_file` 或 `prev_file`, `prev_commit`, `identity_label`, `round`, `phase_label`, `file_path` |
| `implementation/review-r2.md`, `review-rn.md`, `review-rn-advance.md` | `implementation.review.r2`, `implementation.review.rn`, `implementation.review.rn.advance` | `plan_file`, `prev_file`, `prev_commit`, `previous_review`（rn）, `identity_label`, `round`, `phase_label`, `file_path`; advance 键另需 `advance_target` |
| `summary/r1.md`, `r2.md`, `rn.md`, `rn-advance.md` | `summary.r1`, `summary.r2`, `summary.rn`, `summary.rn.advance` | `task_path`/`archive_root`/`prev_file`/`prev_commit`（按场景）, `identity_label`, `round`, `phase_label`, `file_path`; advance 键另需 `advance_target` |
| `submit/*.md` | `submit.advance-ready`, `submit.both-submitted`, `submit.wait` | `identity_label`, `turn_label`, `round`, `phase_label`, `file_path`;前两键另需 `supervisor`, `turn` |

说明：`phase_status`、`participant_labels`、`identity_label`、`turn_label` 是结构化显示值，不得包含完整行动句；它们由现有角色/阶段辅助函数生成。若实现者发现现有分支无法唯一映射到表中键，先补充一个明确键及其测试，不能把整句重新塞回变量。（codex）

---

### Task 1: 用 TDD 建立严格模板加载与渲染边界

**Files:**
- Create: `src/tip-template.ts`
- Create: `src/__tests__/tip-template.test.ts`
- Modify: `src/index.ts`
- Test: `src/__tests__/tip-template.test.ts`

**Interfaces:**
- Produces: `TemplateKey`, `initializeTipTemplates(root?: string): void`, `renderTip(key: TemplateKey, variables: Record<string, string | number>): string`, `resetTipTemplatesForTests(): void`。
- Consumes: `formatTip()` from `src/tip-format.ts`。

- [ ] **Step 1: 写失败测试，固定解析、校验和单次插值语义**

在临时目录写最小模板集合并断言：三段顺序正确；缺 `[行动]`、乱序段标记、叶子为目录/链接、未知占位符、required 占位符未出现在模板、渲染缺变量都抛出包含 key/path/variable 的错误；变量值 `{{nested}}` 保持原样，不被二次替换；第二次渲染不重新读文件。

```ts
expect(() => initializeTipTemplates(root)).toThrow(/requirements\.r1.*task_path/);
expect(renderTip("response.rejected", { message: "bad {{nested}}" }))
  .toBe("[行动] 请求被拒绝：bad {{nested}}");
```

- [ ] **Step 2: 运行单测确认 RED**

Run: `npx vitest run src/__tests__/tip-template.test.ts`

Expected: FAIL，原因是 `../tip-template.js` 尚不存在。

- [ ] **Step 3: 实现最小严格引擎**

使用明确规格表和固定根；禁止执行模板内容：

```ts
export const DEFAULT_TIP_TEMPLATE_ROOT = fileURLToPath(
  new URL("../templates/tips/", import.meta.url),
);

export function initializeTipTemplates(root = DEFAULT_TIP_TEMPLATE_ROOT): void {
  const loaded = new Map<TemplateKey, ParsedTemplate>();
  for (const [key, spec] of Object.entries(TEMPLATE_SPECS) as [TemplateKey, TemplateSpec][]) {
    const file = resolve(root, spec.file);
    const stat = lstatSync(file);
    if (!stat.isFile()) throw new Error(`tip template ${key} must be a regular file: ${file}`);
    loaded.set(key, parseAndValidate(key, file, readFileSync(file, "utf8"), spec));
  }
  registry = loaded;
}

export function renderTip(key: TemplateKey, values: Record<string, string | number>): string {
  if (!registry) initializeTipTemplates();
  const template = registry!.get(key);
  if (!template) throw new Error(`unknown tip template key: ${key}`);
  return formatTip(renderSections(template, values));
}
```

用 `/{{([A-Za-z][A-Za-z0-9_]*)}}/g` 提取占位符；启动校验 `allowed` 与 `required`，渲染时只对当前模板出现的占位符做一次 `replace`。

- [ ] **Step 4: 在 `index.ts` 的 help 早退后初始化模板**

```ts
try {
  initializeTipTemplates();
} catch (error) {
  console.error(`[pair-flow] failed to load tip templates: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
```

确保 `--help` 不依赖模板，但任何监听前模板已完成校验。

- [ ] **Step 5: 运行单测确认 GREEN 并提交**

Run: `npx vitest run src/__tests__/tip-template.test.ts src/__tests__/tip-format.test.ts`

Expected: PASS。

Commit: `git commit -m "feat: add strict tip template engine"`

---

### Task 2: 建立完整默认模板目录和键契约门禁

**Files:**
- Create: `templates/tips/**/*.md`（按上方矩阵）
- Create: `templates/tips/README.md`
- Modify: `src/tip-template.ts`
- Modify: `src/__tests__/tip-template.test.ts`

**Interfaces:**
- Produces: 上方矩阵中全部 `TemplateKey` 和对应默认文件。
- Consumes: Task 1 的加载/校验 API。

- [ ] **Step 1: 写失败测试固定矩阵完整性**

测试遍历 `TEMPLATE_SPECS`，断言每个 key 的文件存在、可加载、默认模板只引用该 key 允许变量、required 全部出现；再断言 `templates/tips/README.md` 不是模板键的一部分。

- [ ] **Step 2: 运行单测确认 RED**

Run: `npx vitest run src/__tests__/tip-template.test.ts`

Expected: FAIL，列出首个缺失默认模板文件。

- [ ] **Step 3: 从当前 TypeScript 逐字迁移默认文案到模板**

对 `src/response.ts`、`src/tip.ts` 和六个工具中的每个 `formatTip()` 分支建立对应文件。完整行动句必须写在模板内；代码可计算的变量只允许是 identity、角色标签、phase、round、turn、路径、commit、分钟数和布尔分支已选择后的键。模板文件不得使用 `{{action}}`、`{{product}}`、`{{current}}` 或 `{{advance_prefix}}` 这类整句逃生变量。

- [ ] **Step 4: 写模板维护说明**

README 明确：固定目录、段格式、允许变量以 `TEMPLATE_SPECS` 为准、修改后重启、严格失败示例、不得在模板中放 token/密钥。给出编辑 `requirements/r1.md` 的完整示例。

- [ ] **Step 5: 运行模板测试并提交**

Run: `npx vitest run src/__tests__/tip-template.test.ts`

Expected: PASS，矩阵中无缺文件或变量契约错误。

Commit: `git commit -m "feat: add default tip templates"`

---

### Task 3: 迁移响应、注册、确认与等待类 tip

**Files:**
- Modify: `src/response.ts`
- Modify: `src/tools/register.ts`
- Modify: `src/tools/confirm-task.ts`
- Modify: `src/tools/get-state.ts`
- Modify: `src/tools/wait-for-turn.ts`
- Modify: `src/__tests__/response.test.ts`
- Modify: `src/__tests__/tools.test.ts`
- Modify: `src/__tests__/wait-for-turn.test.ts`

**Interfaces:**
- Consumes: `renderTip()` 和对应键。
- Produces: 以上入口不再直接构造 tip 句子。

- [ ] **Step 1: 先为每个迁移分支增加精确断言**

保留现有行为断言，并至少覆盖 confirm 的 existing/created/recovered/joined、get-state 的四种状态、wait 的 roster warning/turn warning/two timeout/completed，以及 error wrapper。测试既断言动态变量，也断言三段顺序。

- [ ] **Step 2: 运行相关测试确认新增门禁会失败**

Run: `npx vitest run src/__tests__/response.test.ts src/__tests__/tools.test.ts src/__tests__/wait-for-turn.test.ts`

Expected: FAIL，直到调用点改用模板键。

- [ ] **Step 3: 最小迁移调用点**

示例：

```ts
tip: renderTip("response.rejected", { message })
```

```ts
return ok(data, renderTip(isFirst
  ? (recovered ? "confirm.recovered" : "confirm.created")
  : "confirm.joined", {
    identity,
    responsibility: myResponsibilityLabel,
    workflow_id: wfId,
    phase_status: phaseText,
    participant_labels: names,
  }));
```

不把现有完整句子赋给变量；对分支选择新增明确 key。

- [ ] **Step 4: 运行相关测试并提交**

Run: `npx vitest run src/__tests__/response.test.ts src/__tests__/tools.test.ts src/__tests__/wait-for-turn.test.ts`

Expected: PASS。

Commit: `git commit -m "refactor: render lifecycle tips from templates"`

---

### Task 4: 迁移状态行动指引 `buildTip()`

**Files:**
- Modify: `src/tip.ts`
- Modify: `src/__tests__/tip.test.ts`（若现有测试在其他文件，则在那里增加同等断言）
- Modify: `src/__tests__/tools.test.ts`

**Interfaces:**
- Keeps: `identityLabel()`, `phaseLabel()`, `outFile()`/planning path calculations。
- Replaces: `getAction()` 的句子返回值改为 `{ key, variables }`。

- [ ] **Step 1: 写表驱动失败测试覆盖全部 phase/round/sub_phase 分支**

用状态 fixture 覆盖 idle 两角色、非本人 turn、requirements r1/r2/rn/rn-advance、planning r1/rn/rn-advance、coding r1/rn、review r2/rn/rn-advance、summary r1/r2/rn/rn-advance、未知组合。每例断言选择的默认文案含正确路径、commit、round 和身份。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run src/__tests__/tip.test.ts src/__tests__/tools.test.ts`

Expected: FAIL，直到所有行动句由模板渲染。

- [ ] **Step 3: 将分支重构为键选择 + 结构化变量**

```ts
type TipSelection = { key: TemplateKey; variables: Record<string, string | number> };

export function buildTip(state: PairFlowState, identity: string): string {
  const selection: TipSelection = selectTip(state, identity);
  return renderTip(selection.key, selection.variables);
}
```

`selectTip()` 必须为矩阵列出的每个 state key 写显式分支并由表驱动测试逐一命中；不要构造 `advancePrefix` 完整句，直接选择对应 `.advance` 键。

- [ ] **Step 4: 运行测试并提交**

Run: `npx vitest run src/__tests__/tip.test.ts src/__tests__/tools.test.ts src/__tests__/wait-for-turn.test.ts`

Expected: PASS。

Commit: `git commit -m "refactor: template workflow action guidance"`

---

### Task 5: 迁移 advance 与 submit 成功 tip

**Files:**
- Modify: `src/tools/advance.ts`
- Modify: `src/tools/submit.ts`
- Modify: `src/__tests__/advance.test.ts`
- Modify: `src/__tests__/tools.test.ts`
- Modify: `src/__tests__/submit-round-order.test.ts`

**Interfaces:**
- Consumes: `advance.*`、`submit.*` 模板键。
- Keeps: phase 初始化、turn 分配、产出路径、commit/meta 原子写入逻辑完全不变。

- [ ] **Step 1: 写失败测试覆盖 self/other 与三种 submit 后状态**

advance 覆盖 requirements-other、planning-self/other、implementation-self/other、summary-self、completed；submit 覆盖可 advance、双方已提交但 turn 未回 supervisor、普通等待。断言自然语言身份与产出路径仍正确。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run src/__tests__/advance.test.ts src/__tests__/tools.test.ts src/__tests__/submit-round-order.test.ts`

Expected: FAIL，直到调用点使用对应模板键。

- [ ] **Step 3: 迁移并删除句子辅助函数**

`ownProduct()` 不再返回完整句；self/other 直接选择不同模板键并传 `file_path`。`buildSubmissionSuccessTip()` 只做三种 key 的选择和变量构造。

- [ ] **Step 4: 运行测试并提交**

Run: `npx vitest run src/__tests__/advance.test.ts src/__tests__/tools.test.ts src/__tests__/submit-round-order.test.ts`

Expected: PASS。

Commit: `git commit -m "refactor: template advance and submit tips"`

---

### Task 6: 文档、硬编码扫描与源码/构建产物验收

**Files:**
- Modify: `README.md`
- Modify: `src/__tests__/tip-template.test.ts`

**Interfaces:**
- Produces: fork 编辑说明、硬编码回归门禁、源码和 `dist` 两种定位验证。

- [ ] **Step 1: 增加硬编码扫描测试**

扫描生产代码，允许 `tip-format.ts` 中协议标签和结构代码，禁止迁移文件再次出现面向 AI 的完整 tip 句子或直接 `formatTip({` 调用。白名单必须按文件+用途显式列出，不使用宽泛中文字符禁令，因为 error 字段与工具 description 不属于本需求。

- [ ] **Step 2: 更新根 README**

新增“定制 Tip 模板”小节，链接 `templates/tips/README.md`，写明编辑、运行 `npx vitest run`、重启服务三步；明确 v1 无 CLI 覆盖目录。

- [ ] **Step 3: 运行全量测试与构建**

Run: `npx vitest run`

Expected: 所有测试 PASS。

Run: `npx tsc --noEmit`

Expected: exit 0，无类型错误。

Run: `npx tsc && node dist/index.js --help`

Expected: build exit 0；help exit 0 且不加载模板。

- [ ] **Step 4: 验证 dist 运行能定位根模板**

在空闲端口启动 `node dist/index.js --port 35691`，确认日志出现监听地址；调用 `curl --noproxy "*" http://127.0.0.1:35691/health` 得到 `{"ok":true,...}`，随后发送 SIGTERM 并确认 exit 0。再临时隐藏一个模板文件运行同一命令，必须在监听前以 exit 1 失败且错误包含模板 key 与绝对文件路径；恢复文件后重跑全量测试。

- [ ] **Step 5: 自审并提交**

逐项对照任务文档验收标准；搜索 `{{action}}|{{product}}|{{current}}|{{advance_prefix}}` 应无模板命中；搜索生产文件直接 `formatTip({` 只允许 `src/tip-template.ts`。确认 `git status --short` 仅含计划内文件，且 `.pid`/`.meta.json` 未暂存。

Commit: `git commit -m "docs: document tip template customization"`

## 计划自审

1. **规格覆盖**：所有 tip 入口、固定模板根、严格失败、按键变量契约、缓存、默认兼容、文档、源码与 dist 定位均有对应任务。（codex）
2. **无占位步骤**：每项给出文件、接口、失败测试、实现边界、命令与预期结果；没有把状态逻辑或模板清单留作实现时猜测。（codex）
3. **类型一致**：所有任务统一使用 `TemplateKey`、`initializeTipTemplates()`、`renderTip()`、`resetTipTemplatesForTests()`；工具只消费同一 API。（codex）
4. **分歧处理**：叶子 `lstat().isFile()` 同时实现普通文件校验并拒绝链接；不做全链路外部路径扫描。API 由本计划给出精确签名。（claude、codex）

## 完成定义

全量测试、`tsc --noEmit`、构建后启动与缺模板失败验证全部通过；生产代码不再包含可定制 tip 句子；默认模板完整可编辑；运行期 sidecar 未进入 Git。完成后由 PairFlow 进入 developer coding → supervisor review 循环。

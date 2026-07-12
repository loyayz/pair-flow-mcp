# Tip 模板化 — 第 4 轮代码评审

> 评审人：codex（supervisor/reviewer）
> 审阅提交：`4d2e6d8`（修复提交 `91cd283`）
> 上一轮评审：`r2_review_codex.md`

## 结论

**两条 P1 tip 语义回归已修复，但仍需一轮小修。** 全量测试、类型检查和构建通过；直接渲染证明 supervisor advance 只出现一次“否则”，600 秒超时能显示真实 turn。当前阻塞项是修复提交意外跟踪运行期 sidecar，以及严格模板格式只实现了乱序校验、未实现上一轮明确要求的重复/未知段标记拒绝。

## 上一轮 finding 验证

### [P1] advance 重复“否则” — 已解决

- `src/tip.ts` 现在只传 `进入实施计划阶段` 等结构化目标值。
- 四个 `.advance` 模板持有完整行动句。
- 实际渲染为：`作为监督者，若确认目标已达成可直接调用 advance（进入实施计划阶段）。否则：基于任务文档...`，只出现一次“否则”。

### [P1] wait timeout 错报“轮到你” — 已解决

- `turn` 已加入 `wait.timeout-ready` 的 allowed/required，并由 `timeoutState.turn` 传入。
- 实际渲染 `identity=alice, turn=bob` 时输出“轮到 bob”。

### [P2] 段标记顺序 — 部分解决

- 已拒绝非 `[行动]` 开头及 `[产出]` 位于 `[当前]` 之后的模板。
- 仍未拒绝重复段和未知段，见新 finding 2。

## 新 Findings

### [P1] 修复提交把 9 个 PairFlow 运行期 `.meta.json` 纳入 Git

**位置：** commit `91cd283`

**问题：** 该提交除代码修复外，还跟踪了 requirements/planning/implementation 下 9 个由 `submit` 自动生成的 `.meta.json`。`docs/design.md` 明确这些是本地恢复 sidecar，不要求 AI commit；实施计划 Global Constraints 更明确要求 `.pid` / `.meta.json` 不提交。它们包含当前 workflow、绝对 task_path、提交 hash 和时间戳，是运行环境状态，不属于 tip 模板功能源码。当前 `git status` 也显示后续 sidecar 仍持续生成，说明若不建立 ignore 门禁会反复污染提交。

**修复要求：**

1. 使用 `git rm --cached` 仅从索引移除 commit `91cd283` 加入的 9 个 `.meta.json`，不要删除工作区文件；
2. 在 `.gitignore` 增加精确规则 `handoff/**/*.meta.json` 和 `*.md.pid`，防止 PairFlow 运行期产物再次被 `git add -A` 纳入；
3. 新提交中确认 `git ls-files 'handoff/**/*.meta.json'` 无输出，`git status --short` 不再列出 sidecar；
4. 不改写或 squash 既有提交，只用正常后续提交纠正索引状态。

### [P2] 严格段格式仍接受重复和未知标记

**位置：** `src/tip-template.ts:parseAndValidate()`；`src/__tests__/tip-template.test.ts`

**问题：** 上一轮要求“拒绝重复、未知或乱序段标记”。当前实现只比较第一次 `indexOf`：

- 两个 `[行动]`、两个 `[产出]` 或两个 `[当前]` 不会因重复本身报错；
- 单独一行 `[未知]` 会被当作段内容接受；
- 新增测试只覆盖了两种乱序，没有覆盖重复/未知。

这与 README 的“每个模板包含三种定义段”及严格失败承诺不一致，也会使 fork 维护者写错标记时启动成功但产生意外 tip。

**修复要求：** 在解析前扫描所有形如 `^\[[^\]\r\n]+\]$` 的独立标记行：只允许 `[行动]`、`[产出]`、`[当前]`；每个允许标记最多出现一次；`[行动]` 恰好一次且位于开头，另外两段仍保持既定顺序。新增测试分别断言重复 `[行动]`、重复 `[产出]`、重复 `[当前]`、未知 `[其他]` 初始化失败，错误包含 template key、文件路径与具体标记。

## 验证证据

- `node node_modules/vitest/vitest.mjs run`：22 files / 218 tests passed。
- `node node_modules/typescript/bin/tsc --noEmit`：exit 0。
- `node node_modules/typescript/bin/tsc`：exit 0。
- 修复后的两个关键模板已通过真实默认 registry 直接渲染验证。

## 下一轮验收

修复后运行：

```bash
npx vitest run
npx tsc --noEmit
git ls-files "handoff/**/*.meta.json"
git status --short
```

预期：测试与类型检查通过；`git ls-files` 无 sidecar；status 只显示 PairFlow 当前未提交产物或为空，且这些 sidecar 被 ignore 后不再出现。

# Tip 模板化 — 第 2 轮代码评审

> 评审人：codex（supervisor/reviewer）
> 审阅提交：`f4af003`（coding 汇总；实现提交范围 `f41da45..dc20838`）
> 实施计划：`handoff/20260712104946/planning/r1_codex.md`

## 结论

**需要修复后再审。** 模板引擎总体架构符合计划，代码变更范围集中，模板唯一权威、固定根定位、叶子普通文件校验、启动缓存和文档均已实现。全量测试、类型检查、构建及 `dist` 启动通过，但评审发现两处会向 AI 返回错误/重复行动指引的确定回归，以及一处模板格式契约与实现相反的问题。

## 验证证据

- `node node_modules/vitest/vitest.mjs run`：22 files / 217 tests passed。
- `node node_modules/typescript/bin/tsc --noEmit`：exit 0。
- `node node_modules/typescript/bin/tsc`：exit 0。
- `node dist/index.js --port 35691`：成功输出 MCP 与 health 监听地址；评审超时终止该前台验证进程。
- 运行期 `.pid` / `.meta.json` 均未进入实现提交。

## Findings

### [P1] advance 模板重复输出“否则”

**位置：** `src/tip.ts` 的 `advanceTarget` 构造；`templates/tips/{requirements,planning,implementation,summary}/*-advance.md`

**问题：** TypeScript 将 `advance_target` 构造成完整前缀，已经以 `。否则：` 结尾；四个 `.advance` 模板又写了 `{{advance_target}}。否则：...`。所有监督者可 advance 的 tip 都会出现：

```text
作为监督者，若确认目标已达成可直接调用 advance（进入实施计划阶段）。否则：。否则：基于任务文档...
```

这不仅是标点问题，也违反“模板持有完整可编辑句子、代码只提供结构化动态值”的核心边界：`advance_target` 目前仍是一整句逃生变量。

**修复要求：** `src/tip.ts` 只传结构化目标值（例如 `进入实施计划阶段`）；四个模板持有完整的“作为监督者……否则……”句子。把 `advance_target` 更名为更准确的 `advance_phase` 或 `advance_destination`，同步更新四个 spec、模板和调用点。新增表驱动测试，至少覆盖 requirements/planning/implementation/summary 四个 `.advance` 键，断言只出现一次 `否则`，且 TypeScript 不生成完整行动句。

### [P1] 600 秒等待超时把别人的 turn 说成“轮到你”

**位置：** `src/tools/wait-for-turn.ts`；`src/tip-template.ts` 的 `wait.timeout-ready` 变量契约；`templates/tips/wait/timeout-ready.md`

**问题：** 原实现的超时 current 是 `轮到 ${state.turn}`。迁移后模板固定为“轮到你”，且调用点/spec 不再传 `turn`。`wait_for_turn` 只有在 `turn !== identity` 时才会继续等待到 600 秒，因此 roster 完整的超时路径恰恰通常表示轮到对方；当前文案会错误告诉调用者持有 turn，可能诱发越权 submit/advance。

可复现渲染：

```text
[当前] 你是 codex。单次等待已超时(600s)，当前是第 2 轮，轮到你。
```

**修复要求：** 将 `turn` 加回 `wait.timeout-ready` 的 allowed/required、模板和 `renderTip()` 调用，恢复 `轮到 {{turn}}`。扩展现有 fake-timer 600 秒测试，状态设为 `turn: "bob"`、调用者 `alice`，精确断言 tip 包含“轮到 bob”且不包含“轮到你”。

### [P2] README 声明段标记必须有序，解析器却刻意接受乱序

**位置：** `templates/tips/README.md`；`src/tip-template.ts:parseAndValidate()`；`src/__tests__/tip-template.test.ts` 的 `formatTip integration` 测试

**问题：** README 和实施计划都规定模板段只能按 `[行动] → [产出] → [当前]` 出现；解析器用三个独立正则抓取任意位置，测试还专门将 `[当前] → [产出] → [行动]` 视为合法。这使文档化格式不是实际契约，也削弱“模板损坏启动失败”的严格校验。

**修复要求：** 以计划和 README 为准，在加载时拒绝重复、未知或乱序段标记；把当前“乱序后仍重排”测试改为断言初始化失败且错误包含模板 key/path 和 section order 原因。正常顺序仍由 `formatTip()` 保证输出。

## 测试覆盖缺口

上述两个 P1 在 217 个测试全部通过时仍能稳定复现，说明默认模板的语义 parity 门禁不足。修复时不要只改模板文本；必须增加直接覆盖真实默认模板 + 实际调用变量的回归测试。尤其需要：

1. 四个 supervisor advance 场景的默认完整 tip；
2. roster ready 的 600 秒超时真实 turn；
3. 段标记顺序的失败测试。

修复后运行：

```bash
npx vitest run
npx tsc --noEmit
npx tsc
node dist/index.js --port 35691
```

并在 coding 产出中附上测试数、构建结果和针对三条 finding 的修改说明。

## 正向确认

- `TEMPLATE_SPECS` 显式列出 45 个键，默认文件齐全。（codex）
- `lstatSync().isFile()` 正确拒绝目录与 symlink 叶子，符合需求阶段裁定。（codex）
- `import.meta.url` 的 `../templates/tips/` 在 `src` 和 `dist` 两种位置均能指向仓库根模板，实际 dist 启动已验证。（codex）
- 工具状态机、turn 切换、submit/advance 权限和归档逻辑未被无关重构。（codex）
- 文档清楚说明固定模板路径、重启生效和无 fallback。（codex）

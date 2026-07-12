# Tip 模板化 — 阶段总结草稿

> 汇总人：codex（supervisor）
> 工作流：`20260712104946`
> 任务文档：`docs/task/tip-template.md`

## 1. 交付结果

PairFlow 的可定制 tip 句子已从 TypeScript 源码迁移到仓库固定目录 `templates/tips/`。fork 维护者可以直接编辑 45 个按场景组织的 UTF-8 `.md` 模板，重启服务后生效，无需修改状态机或工具源码。（claude 实现，codex 验证）

新增 `src/tip-template.ts` 作为严格模板边界：

- 使用显式 `TemplateKey → 文件 → allowed/required 变量` 注册表；
- 模板使用 `[行动]`、可选 `[产出]`、可选 `[当前]` 段和 `{{variable}}` 单次纯文本插值；
- 启动时校验并缓存全部模板，正常请求不重复读取磁盘；
- 缺文件、非普通文件、未知/重复/乱序段标记、未知占位符、必需占位符或渲染变量缺失均明确失败；
- 继续复用 `formatTip()` 保证三段顺序；不执行模板内容或变量内容。（claude、codex）

`response.ts`、`tip.ts` 及 `register`、`confirm_task`、`advance`、`get_state`、`wait_for_turn`、`submit` 的 tip 入口均已改为模板键选择和结构化变量传入。phase、turn、职责、路径、submit/advance、恢复和归档规则未改变。（claude 实现，codex 评审）

## 2. 关键决策

1. **模板是唯一文案权威**：不保留 TypeScript 硬编码 fallback；模板加载错误在监听端口前失败。（claude、codex）
2. **v1 固定模板根**：不增加 `--templates`、按 workflow 模板集、overlay、热加载或多语言框架。（claude、codex）
3. **逻辑与文案分离**：TypeScript 决定状态分支、模板键及 identity/role/phase/round/turn/path/commit 等动态值；模板持有完整可编辑句子，不使用 `{{action}}`、`{{product}}`、`{{current}}` 等整句逃生变量。（claude、codex）
4. **信任边界**：固定仓库根属于受信启动资源，但每个模板叶子必须是可读普通文件；不复用 task/handoff 的外部路径全链路扫描。（codex 裁定，claude 确认）
5. **源码与 dist 共用资源定位**：基于 `import.meta.url` 的 `../templates/tips/` 同时适用于 `src/tip-template.ts` 与 `dist/tip-template.js`。（claude 实现，codex 实测）
6. **运行期 sidecar 不入库**：`.gitignore` 新增 `handoff/**/*.meta.json` 与 `*.md.pid`；已误跟踪的 sidecar 全部从索引移除并保留本地运行文件。（codex 发现，claude 修复）

## 3. 实施与评审记录

### 实施

- `f41da45`：严格模板引擎与单元测试。
- `a106239`：45 个默认模板。
- `a39ee36`：所有 tip 调用点迁移。
- `dc20838`：模板定制文档。
- `f4af003`：第 1 轮 coding 汇总产物。

### 第 1 轮评审与修复

codex 在 `d98796c` 的评审中发现：

1. supervisor advance tip 重复“否则”，且 `advance_target` 仍是整句变量；
2. 600 秒 wait timeout 将真实的对方 turn 错报为“轮到你”；
3. README 规定段标记有序，解析器却接受乱序。

claude 在 `91cd283` 修复：结构化 advance 目标、真实 timeout turn、段顺序校验及回归测试。

### 第 2 轮评审与修复

codex 在 `eb30614` 的评审中发现：

1. 修复提交误跟踪 8 个运行期 `.meta.json`；
2. 严格段格式尚未拒绝重复/未知标记。

claude 在 `be7663c` 修复：清理 Git sidecar、增加 ignore 规则、扫描并拒绝重复/未知段标记，新增四个测试。`e964da2` 为本轮 coding 汇总产物。

## 4. 最终验证证据

由 codex 在最新 HEAD 独立执行：

- 全量测试：22 files / **222 tests passed**；
- `tsc --noEmit`：exit 0；
- `tsc` 完整构建：exit 0；
- `node dist/index.js --port 35691`：成功加载模板并输出 MCP/health 监听地址；
- `git ls-files 'handoff/**/*.meta.json'`：0 个已跟踪 sidecar；
- `git status --short`：验证时为空；
- 真实默认 registry 渲染验证：advance tip 只出现一次“否则”，wait timeout 正确显示 `turn=bob`。（codex）

## 5. 文档与使用方式

- 根 `README.md` 新增“定制 Tip 模板”入口；
- `templates/tips/README.md` 说明段格式、变量契约、严格失败、修改后重启及定制示例；
- fork 维护者的基本流程：编辑对应 `.md` → `npx vitest run` → 重启 PairFlow。（claude）

## 6. 明确排除与遗留问题

本次无阻塞遗留问题。以下能力经双方确认不属于 v1：

- 外部 `--templates` 路径或每 workflow 模板集；
- 热加载、overlay/fallback、多语言；
- 模板条件、循环、表达式或可执行代码；
- 状态机及 MCP 行为变更。

这些能力如有真实使用场景，应通过新任务重新定义路径信任、模板版本兼容和失败策略，不应在当前实现上预留未使用抽象。（claude、codex）

## 7. 后续建议

1. 新增任何 tip 分支时，同一提交必须增加 `TemplateKey`、变量契约、默认模板和对应状态测试。（codex）
2. 发布/打包流程若未来不再保留仓库根目录结构，应增加模板资源打包测试，继续保证 `dist` 定位。（codex）
3. fork 定制模板时优先保留 required 动态变量；严格启动校验会阻止误删关键上下文。（claude、codex）

## 8. Supervisor 判断

任务文档的 P0 范围和验收标准均已满足：默认模板完整可编辑，TypeScript 不再保存可定制 tip 句子，错误可定位，全量验证通过，sidecar 未进入 Git。建议由 claude 审阅本草稿；若无遗漏，形成最终报告并结束工作流。（codex）

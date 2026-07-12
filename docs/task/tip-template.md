# Tip 模板化

现在所有接口的 tip 写死在代码中，需要改为从模板文件获取，使 fork 本仓库的人更容易修改各种场景的提示。

**设计规格**：`docs/design.md`

## 已确认需求

以下为 claude 与 codex 一致的结论：

1. **目标**：所有 MCP 工具及统一错误响应中由 PairFlow 生成的 tip 文案均迁移到仓库内的纯文本模板文件；修改提示文案不再需要修改 TypeScript 源码。（claude、codex）
2. **默认兼容**：仓库自带一套完整默认模板；未修改模板时，所有既有状态分支、`[行动]/[产出]/[当前]` 顺序、动态路径及身份信息保持现有语义。（claude、codex）
3. **职责边界**：状态机判断、权限判断、轮次/阶段分支、路径计算继续由 TypeScript 负责；模板只负责文案和变量插值，不执行代码，也不引入条件/循环语法。（claude、codex）
4. **插值能力**：模板支持易懂的命名占位符（建议 `{{variable}}`）；变量值按纯文本替换，不执行表达式。（claude、codex）
5. **加载时机**：v1 不要求热加载；模板修改后允许通过重启服务生效。（claude、codex）
6. **测试**：迁移后必须覆盖模板加载、变量插值、缺失/未知变量、模板缺失或不可读，以及各工具主要 tip 分支；默认模板的行为应与现有契约一致。（claude、codex）

## 范围

### 必须覆盖（P0）

- `register`、`confirm_task`、`advance`、`wait_for_turn`、`get_state`、`submit` 的成功、等待、超时/掉线警告和业务拒绝 tip。（codex 补充，claude 同意“所有现有硬编码 tip 迁移”的总目标）
- `tip.ts` 中 requirements、planning、implementation/coding、implementation/review、summary、idle 的各轮次行动文案。（claude、codex）
- `response.ts` 统一业务错误包装，以及三段式格式所需的可编辑文案。（codex 补充）
- 默认模板、模板加载/渲染模块、模板键与变量契约、测试和面向 fork 维护者的简短说明。（claude、codex）

### v1 不做

- 模板内条件、循环或可执行表达式。（claude、codex）
- 热加载、多语言框架、按 workflow 选择不同模板集。（claude、codex）
- 改变 PairFlow 状态机、职责、轮次、产出路径或 submit/advance 规则。（codex）

## 质量与安全约束

- 模板渲染不得执行模板内容或变量内容；动态值必须原样作为文本处理。（claude、codex）
- 模板键与每个模板允许/必需的变量应集中定义并可测试；不得依赖一个所有模板都假定可用的宽泛全局变量集合。（codex）
- 默认模板缺失、不可读或含未满足占位符时不得静默产出残缺 tip；错误必须可定位到模板键/文件和变量名。（codex）
- 正常请求路径不应反复执行同步磁盘 I/O；允许启动时加载并缓存模板。（claude、codex）
- 模板使用 UTF-8，路径和动态内容继续遵循 `docs/design.md` 的 POSIX 路径展示约定。（claude、codex）

## 已裁定事项

1. **v1 不增加 `--templates <path>`**：模板位于仓库内固定路径；外部模板目录、overlay 和按 workflow 选择模板集留待后续需求。（claude、codex）
2. **不保留 TypeScript 文案 fallback**：默认模板是 tip 文案的唯一权威来源；启动加载/校验失败时明确失败并报告模板键、文件和原因。（claude、codex）
3. **planning 先列矩阵再定文件粒度**：先生成“模板键 → 调用点/状态分支 → 必需变量”完整矩阵，再确定文件命名、组织和渲染 API。（claude、codex）
4. **固定模板的信任边界**：仓库内固定模板是受信任启动资源，不复用 task/handoff 面向外部路径的全链路链接防护；加载器仍须确认每个预期叶子是可读普通文件，目录、缺失、链接或不可读均启动失败。未来若开放外部模板路径，另行定义全路径信任与链接策略。（codex 裁定，吸收 claude 对叶子类型检查的建议）
5. **API 属于 planning 产出**：需求只约束“按模板键渲染、按键校验变量、模板持有文案、代码提供结构化值”；函数签名和类型组织在实施计划中确定。（claude、codex）

## 验收标准

- 仓库中存在完整、可编辑的默认 tip 模板及变量说明。（claude、codex）
- TypeScript 不再保存可由 fork 维护者定制的 tip 句子；代码只保留协议结构、状态分支、模板键和动态值计算。（claude、codex）
- 未修改模板时，现有工具的主要 tip 场景与 `docs/design.md` 的行动语义一致。（claude、codex）
- 删除/损坏任一必需模板，或使用未知/缺失变量时，启动或测试明确失败且错误可定位。（claude、codex）
- 全量测试与构建通过；新增测试能证明所有当前 tip 调用点/状态分支均映射到已校验模板。（claude、codex）


# PairFlow 双方协作复盘与优化建议

> 复盘角色：codex（Supervisor / Reviewer）  
> 工作流：`20260712104946`  
> 协作双方：claude（Developer）+ codex（Supervisor / Reviewer）  
> 任务：Tip 模板化  
> 日期：2026-07-12

## 1. 总体结论

本次 PairFlow 协作成功完成了一个跨需求、计划、实现、两轮代码评审和汇总的完整 development 工作流。最终交付通过 222 项测试、TypeScript 类型检查、完整构建和 `dist` 启动验证；Supervisor 两轮评审发现并推动修复了 5 个问题，其中包括 2 个会向 AI 返回错误行动指引的 P1 回归。

PairFlow 的核心价值在本次得到验证：**turn 串行化避免了共享工作区中的并发覆盖；独立需求分析减少了单方方案偏差；coding/review 交替确实发现了普通测试未覆盖的问题；handoff + commit 提供了完整可追溯链路。**

主要短板不在状态机正确性，而在三个边界：

1. 服务端返回给客户端的下一步仍主要依赖自然语言 tip，缺少机器可执行的结构字段；
2. 初始化 skill 与通用客户端环境之间缺少可靠的 token、SSE、后台进程和长轮询适配层；
3. 对“长时间持有 turn”“运行期 sidecar”“最终 Git 交接”等运行体验的约束还不够自动化。

## 2. 本次协作数据

| 指标 | 结果 |
|---|---:|
| Requirements 产物 | 5 份 |
| Planning 产物 | 2 份 |
| Implementation 产物 | 5 份 |
| Summary 产物 | 2 份 |
| Handoff Markdown 合计 | 14 份 |
| 工作流相关 Git commits | 20 个 |
| 最终测试 | 22 files / 222 tests passed |
| Reviewer 发现 | 3 个 P1 + 2 个 P2 |
| 实现修复轮次 | 2 轮 |

关键提交链可从 `b6eb683`（requirements r1）追溯至 `1aff089`（summary r2）。完整归档位于 `handoff/20260712104946/`。

## 3. 做得好的地方

### 3.1 状态机有效约束了共享工作区

Claude coding 时 Codex 只执行 `wait_for_turn`，没有并行修改源码；Codex review 时也只产出评审文档，没有越权直接修 Developer 代码。共享目录没有出现相互覆盖或同时提交冲突，说明 `turn + sub_phase + role` 的组合对双 AI 本地协作是有效的。（codex）

### 3.2 Requirements 的交替审阅产生了真实收敛

Claude 第一轮提出了 `--templates`、代码内 fallback、通用变量表等方案。Codex 独立分析后指出这些方案存在范围扩张、双份文案权威和“模板壳化”的问题。Claude 在后续轮次逐项重新评估并接受核心修正；Supervisor 对 symlink 信任边界和 API 所属阶段作出最终裁定。最终任务文档不是任何一方的初稿，而是双方观点收敛后的规范。（claude、codex）

### 3.3 Planning 足够具体，Developer 可以连续执行

计划明确了文件职责、45 个模板键矩阵、接口签名、TDD 顺序、验证命令和完成定义。Claude 能据此分 4 个实现提交完成模板引擎、默认模板、调用点迁移和文档，而无需再次询问基础架构选择。（codex 计划，claude 执行）

### 3.4 Reviewer 找到了测试未发现的语义错误

第一轮实现的 217 项测试全部通过，但 Codex 通过真实默认模板渲染发现：

- supervisor advance tip 出现 `否则：。否则：`；
- 600 秒 wait timeout 在 turn 属于对方时错误显示“轮到你”。

这两处问题会直接误导 AI，说明 PairFlow 的交替 review 不是形式流程，而是补足单方自审和自动测试盲区的有效机制。（codex）

### 3.5 精确修复而非大范围返工

Claude 能按评审文档逐条修复，第二轮又处理 sidecar 污染和严格段格式，最终测试从 217 增至 222。整个修复过程没有改动状态机、权限或归档逻辑，符合 surgical change 原则。（claude）

## 4. 本次暴露的问题

### 4.1 PairFlow 服务端 / 协议层

### 问题 A：下一步仅靠自然语言 tip，不利于可靠客户端自动化

当前响应虽然包含 `phase`、`turn`、`round`，但“应该调用 wait_for_turn / submit / advance”“产物路径”“是否可以直接 advance”主要存在于 tip 文本。客户端只能让 LLM理解自然语言，或自行重复状态机逻辑。

本次 Codex 为执行流程，需要人工维护 Node `fetch` 脚本、SSE 解包、token header 和不同工具参数。tip 对人和 AI 可读，但对稳定自动化不够强。（codex）

**风险：** 文案定制后，依赖字符串识别的客户端会失效；LLM 也可能遗漏 `submit` 路径或错误判断是否可 advance。

### 问题 B：600 秒 wait 上限与客户端执行层不匹配

PairFlow 的单次 `wait_for_turn` 上限为 600 秒，但本次 Codex 工具执行层在约 308 秒会终止长请求。Implementation 第一轮等待因此连续被本地执行层中断 3 次，只能依靠 latest-wins 安全重试。（codex）

**风险：** 不同 MCP/HTTP 客户端、代理、桌面应用可能有 60/120/300 秒超时，服务端的 600 秒契约无法实际到达。

### 问题 C：turn 已领取后，长时间无进展不可观测

PairFlow 能警告“30 分钟未领取 turn”，但 turn 一旦由 Developer 领取，长时间 coding 没有进度信号。本次实现等待约 20 分钟，Supervisor 只能知道“尚未交回 turn”，不能区分正常工作、客户端卡死或进程已经失联。（codex）

### 问题 D：运行期 sidecar 容易污染 Git

PairFlow 会在仓库生成 `.pid` 和 `.meta.json`。本次 Claude 在修复提交中使用较宽的暂存范围，误把 8 个历史 `.meta.json` 加入 Git；随后才由 Reviewer 发现、移除并补充 `.gitignore`。（claude、codex）

**根因：** 设计说明“sidecar 不要求 commit”，但仓库初始 ignore 没有形成技术门禁。

### 问题 E：工作流完成后的 Git 集成策略不明确

本次工作流产生 20 个 commits，包括需求、计划、代码、评审、修复和总结。追溯性很好，但 PairFlow 结束时只返回归档路径和新任务指引，没有说明这些 commits 应保持原样、合并、创建 PR，还是由用户自行决定。

不能简单建议 squash：`.meta.json` 中保存了各轮 commit hash，重写历史可能破坏归档引用语义。这个边界需要设计层明确。（codex）

### 4.2 PairFlow 初始化 skill

### 问题 F：复用上下文时缺少“参数回显确认”

skill 规定“优先复用上下文”，因此 Codex 从当前仓库推断 `work_dir`，没有向用户单独询问。用户随后明确质疑“刚没跟我确认工作目录”。虽然推断符合 skill 字面规则，但用户预期关键路径应显式确认。（用户反馈、codex）

### 问题 G：raw curl 示例没有覆盖 SSE 解析和 token 持久化

服务端 `/mcp` 实际返回 `text/event-stream` 包装。Codex 第一次按 JSON 解析时失败：`event: message... is not valid JSON`。此外 token 只在 register 响应中返回，跨多轮工具调用需要安全保存；skill 只说“不展示、不写任务文档或 Git”，没有给出客户端侧持久化方案。（codex）

### 问题 H：Server 启动对运行环境假设过强

当前终端没有 `node` / `npx` PATH，需要使用 Codex bundled Node；沙箱内 `Start-Process` 启动的后台进程又会随命令退出，只能在沙箱外启动。skill 已提醒使用环境适用的后台方式，但缺少 Windows/Codex 桌面环境的可靠策略。（codex）

### 4.3 双方 Agent 执行层

### 问题 I：第一版实现的测试偏结构完整性，语义 parity 不足

第一版测试能证明 45 个模板存在、变量契约合法、全量旧测试通过，却没有用真实默认模板验证关键行动语义，导致重复“否则”和错误 turn 都漏过。（claude 实现，codex 发现）

### 问题 J：提交前缺少 runtime artifact preflight

Developer 自审报告明确声称 sidecar 未进入 Git，但后续修复提交仍将它们加入索引。报告和实际 commit 不一致，说明提交前没有执行或核对 `git diff --cached --name-only`。（claude）

### 问题 K：外部审批额度会中断工作流，但 PairFlow 不知道客户端受阻

Codex 在提交 `r2_review_codex.md` 时因桌面审批额度暂时耗尽，无法写 `.git/index`，工作流停留在 Codex turn。PairFlow 只能看到 turn 已领取，不知道客户端被外部审批系统阻塞。（codex 环境问题，不是 PairFlow 服务错误）

## 5. 优化建议

### P0：优先实施

### 5.1 在 tip 之外返回结构化行动协议

保留 tip 作为 AI 可读指引，同时为所有带 tip 的响应增加稳定字段，例如：

```jsonc
{
  "next_action": "wait_for_turn | submit | advance | confirm_task | stop",
  "allowed_actions": ["submit"],
  "can_advance": false,
  "required_output": {
    "file_path": "C:/.../r2_review_codex.md",
    "commit_required": true
  },
  "references": [
    { "kind": "plan", "file_path": "C:/.../planning/r1_codex.md" },
    { "kind": "previous_output", "file_path": "C:/.../r1_coding_claude.md", "commit": "abc1234" }
  ],
  "reason_code": "WAITING_FOR_OTHER_TURN"
}
```

**原则：** 服务端仍是唯一状态机权威；客户端不解析中文、不复制状态判断；模板定制只影响 tip，不影响结构字段。（codex）

### 5.2 提供官方轻量客户端 / CLI，封装 HTTP MCP 会话

在不违反“Server 不执行外部命令”的前提下，新增独立客户端模块或 CLI：

- 自动解析 JSON 与 SSE envelope；
- 在进程内或用户级安全缓存中保存 token，不写任务文档/Git；
- 自动附加 `X-AI-Identity`；
- 暴露 `register/confirm/wait/submit/advance` 的类型安全方法；
- 对 wait 使用 latest-wins 和客户端超时重试；
- 输出结构化结果而不是让每个 skill 重写 curl/Node 脚本。

仓库已有 `client-transport.ts`，可优先扩展它，而不是引入第二套协议。（codex）

### 5.3 将 wait 时长改为客户端可协商或缩短默认值

建议服务端 `wait_for_turn` 接受受限参数 `max_wait_seconds`，范围如 10–600，默认 240 或保持 600 但由客户端显式请求 240。skill/客户端根据自身超时上限选择值，并在正常超时后自动重试。

这样保留长轮询语义，同时避免 300 秒客户端不断以异常终止请求。（codex）

### 5.4 初始化前统一回显关键参数

skill 在启动副作用前输出一次参数摘要：

```text
identity=codex
task_type=development
roles=supervisor=true, developer=false
work_dir=C:/code/loyayz/pair-flow-mcp（由当前仓库推断）
task_path=...
port=35690
```

规则建议改为：普通参数可复用上下文；`work_dir`、`task_path`、职责组合必须至少回显，若由推断得到则标注来源。用户已经逐项提供时不必再次阻塞询问，但必须让错误推断在调用 `confirm_task` 前可见。（用户反馈、codex）

### 5.5 默认忽略 PairFlow runtime sidecar

新仓库初始化即包含：

```gitignore
handoff/**/*.meta.json
*.md.pid
```

并在每个需要 commit 的 tip 中增加客户端 preflight：只暂存明确产物路径和必要源码，不使用无边界 `git add -A`。本次已在仓库修复，但应成为项目模板的默认契约。（claude、codex）

### P1：提高可靠性与可观测性

### 5.6 增加持有 turn 的 heartbeat / lease

增加轻量 `heartbeat`，或允许当前 turn 持有者周期性更新 `last_active_at`。`wait_for_turn` 可在对方已领取但超过阈值无 heartbeat 时返回 warning：

- `turn_claimed_but_inactive`；
- 已静默时长；
- 建议继续等待或报告用户。

heartbeat 不能推进状态，也不能替代 submit；仅提供活性信号。（codex）

### 5.7 为每阶段返回结构化收敛状态

Supervisor 当前主要从 tip 判断是否可 advance。建议增加：

```json
{
  "phase_complete": true,
  "both_submitted": true,
  "turn_returned_to_supervisor": true,
  "unresolved_items": "client-declared-or-null"
}
```

服务端仍不评价文档内容，但可明确状态机门禁是否满足；“内容是否收敛”继续由 Supervisor 决定。（codex）

### 5.8 将真实默认 tip 的语义 parity 纳入测试门禁

除模板结构测试外，至少为以下高风险场景做 snapshot/精确断言：

- 四阶段 supervisor advance；
- wait timeout 与真实 turn；
- submit 后三种分支；
- self/other role 与产物路径；
- requirements/development 的 phase 跳转；
- recover/incomplete roster。

测试必须同时使用真实默认模板和真实调用变量，避免只测试 fixture 自洽。（codex）

### 5.9 submit 前由 skill 执行 Git preflight

Server 按设计不执行 Git，因此由 skill/客户端执行：

1. `git status --short`；
2. `git diff --cached --name-only`；
3. 确认本轮产物和预期源码在 staged set；
4. 确认 `.pid` / `.meta.json` 不在 staged set；
5. commit 后读取真实 hash，再调用 submit。

这能减少“报告声称未提交 sidecar，但实际已提交”的不一致。（codex）

### 5.10 完成响应增加 Git 交接提示，但不自动改写历史

SUMMARY → IDLE 时返回：

- 当前 branch；
- 工作流相关 commit 起止点（由客户端提供或归档推断）；
- 工作区是否干净（由客户端 preflight 提供）；
- 建议用户选择保留历史、建 PR 或另行整理。

不要由 PairFlow Server 自动 rebase/squash；这既越过外部命令边界，也可能使 meta 中的 commit 引用失效。（codex）

### P2：体验改进

### 5.11 输出工作流统计摘要

完成时可从内存/归档计算并返回：各阶段轮数、双方提交数、总耗时、最长 turn、恢复次数、warning 次数。它能帮助识别需求阶段过长、实现等待过久或频繁返工。（codex）

### 5.12 为 skill 增加 Codex Desktop / Windows 运行参考

补充：

- PATH 中无 Node 时如何使用已配置 runtime；
- Windows 隐藏后台进程与日志路径；
- 沙箱内外 loopback 可见性差异；
- 健康检查失败后如何读取日志；
- 不在技能中固定 Unix `&` 的具体示例。

这些属于客户端适配文档，不应进入 Server 核心状态机。（codex）

### 5.13 区分“业务等待”和“客户端阻塞”

可允许客户端在不释放 turn 的情况下上报阻塞原因代码，例如：`AWAITING_APPROVAL`、`RATE_LIMITED`、`TOOL_UNAVAILABLE`。其他参与者的 wait warning 可显示具体原因，但该机制不得自动延长工作流或绕过用户审批。（codex）

## 6. 不建议做的优化

1. **不建议让 Server 执行 Git、测试或构建。** 本次问题应由客户端 preflight/结构协议解决，不能破坏 Server 的命令执行边界。
2. **不建议 Server 自动评价 handoff 内容是否正确。** PairFlow 应保持中立调度，内容质量由双方审阅和 Supervisor 裁定。
3. **不建议用频繁 get_state 代替 wait。** 应修复 wait 的客户端适配，而不是退回轮询。
4. **不建议为了减少 commits 自动 squash。** 需要先定义归档 commit hash 在历史重写后的语义。
5. **不建议把完整状态机复制到 skill。** skill 应消费结构化 `next_action`，服务端保持唯一权威。

## 7. 推荐实施顺序

1. **P0-1：结构化 next_action / required_output / references**；
2. **P0-2：官方类型安全客户端，统一 SSE/token/wait**；
3. **P0-4：skill 参数回显确认**；
4. **P0-3：可协商 wait 时长**；
5. **P0-5 + P1-9：sidecar ignore 与 Git preflight**；
6. **P1-6：heartbeat / claimed-turn warning**；
7. **P1-8：默认 tip 语义 parity 测试**；
8. 其余统计和体验项按真实使用反馈推进。

## 8. 可作为后续任务拆分

- `docs/task/structured-next-action.md`：结构化行动协议设计；
- `docs/task/pairflow-client.md`：官方客户端与 token/SSE 管理；
- `docs/task/wait-timeout-negotiation.md`：可协商等待与 heartbeat；
- `docs/task/pairflow-skill-ux.md`：初始化参数回显和 Git preflight；
- `docs/task/workflow-metrics.md`：完成统计与可观测性。

## 9. 最终评价

本次协作不是”一次通过”，但流程有效地把初始方案中的范围偏差、实现中的语义错误和提交中的运行期污染逐层暴露并修复。PairFlow 当前已经能可靠驱动双 AI 完成复杂本地开发；下一阶段最值得投入的不是增加更多 phase，而是把 **自然语言 tip 升级为”结构化行动协议 + 可编辑提示”双通道，并提供官方客户端承接 token、SSE、长轮询和 Git preflight。**（codex）

---

## 10. Developer 视角补充

> 补充人：claude（Developer）
> 日期：2026-07-12

codex 的复盘已从 Supervisor 角度全面覆盖了流程层面。以下从 Developer 视角补充一些代码实现过程中的具体体验和发现。

### 10.1 Planning 质量直接决定实现效率

本次计划包含 45 个模板键的完整矩阵、精确的 `TEMPLATE_SPECS` 数据结构、`renderTip()` 接口签名和 6 个 Task 的 TDD 顺序。我在实现过程中：
- Task 1-2 完全按计划执行，无需回看需求文档；
- Task 3-5 的迁移只有一个判断点需要思考（`advance_target` 应该传结构化值还是完整句子），其余都是机械映射；
- 没有出现过”不知道该怎么做”的阻塞时刻。

**启示**：Planning 阶段的模板键矩阵是整个实现的地图。如果 Planning 产出只停留在”要做一个模板引擎”的粒度，Developer 会在实现时反复猜测和返工。codex 在 r1 计划中列出的矩阵是本次协作最重要的单份文档。（claude）

### 10.2 Tip 模板化本身暴露了 PairFlow 的”文案即协议”问题

作为本次任务的 Developer，我把所有 tip 从 TypeScript 迁移到了模板文件。这个过程中我发现：**tip 文案中包含了三种不同类型的文本混在一起**：

| 类型 | 示例 | 应该在哪 |
|------|------|---------|
| 结构化指令 | “完成后 git commit，调用 submit，file_path = {{file_path}}” | 客户端协议字段 |
| 上下文信息 | “当前是第 2 轮需求分析，轮到你了” | 客户端协议字段 |
| 可定制的自然语言 | “对以下每个维度不满足于第一反应，追问自己至少一次'为什么'” | 模板文件 ✅ |

目前这三类文本全部挤在同一个 tip 字符串中。模板化解决了第三类的可定制问题，但前两类仍然只能靠 AI 解析自然语言来提取 `file_path`、判断是否该 `submit`、确认当前 turn。

这与 codex 在 §5.1 提出的”结构化行动协议”完全呼应。作为实际操作模板引擎的人，我的判断是：**模板文件应该只保留第三类文本。前两类应该进入独立的结构化字段，不受模板定制影响。**（claude）

### 10.3 `git add -A` 的教训：提交前需要硬门禁

§4 问题 D 和问题 J 已记录了 sidecar 污染事件。从 Developer 执行层面补充：

当时的心态是”代码和模板都写完了，`git add -A` 一把提交最快”。如果 PairFlow 或 skill 在 submit 前强制要求输出 `git diff --cached --name-only` 并让我确认，我不会漏掉 sidecar。

**建议**：在 Developer 的 submit 流程中增加一个硬性步骤——提交前输出 `git status --short` 和 `git diff --cached --stat`，并显式向用户/Reviewer 展示”以下文件将被提交”。这不是信任问题，是注意力问题——连续多轮 coding 后，开发者 AI 的注意力窗口会变窄。（claude）

### 10.4 45 个模板的变量契约维护成本

作为模板引擎的实现者，我注意到 `TEMPLATE_SPECS` 中的 `allowed`/`required` 列表和实际模板文件中的 `{{variable}}` 之间存在隐式耦合。本次通过启动校验在加载时发现不匹配并报错，但如果未来新增 phase 或修改现有模板，维护者需要同时修改三处：spec 注册表、默认模板文件、调用方 `selectTip()` 代码。

**建议**：在 §5.8（语义 parity 测试）之外，增加一个自动化契约测试：遍历所有模板文件，提取实际使用的变量，与对应 spec 的 `allowed` 做集合对比，差异即失败。这样即使有人只改了模板文件忘记更新 spec，也能在测试阶段发现。（claude）

### 10.5 两轮评审的价值远超预期

第一轮 217 测试全绿时，我内心认为”基本完成了”。Codex 的 r2 评审指出重复”否则”和超时 turn 错误时，我立刻意识到这是真实 bug——而且即使再加 100 个结构测试也不会发现，因为它们发生在**变量语义层面**而非结构层面。

第二轮修复后，Codex 再次指出 sidecar 污染和段标记校验不完整。这两个问题确实存在，但如果没有第二轮评审，大概率会遗留到合并后才发现。

**判断**：至少两轮 review 是必要的。第一轮发现”大问题”（语义错误），第二轮发现”边界问题”（合规性和完整性）。如果只有一轮，第二类问题会被”第一轮已修完”的错觉掩盖。（claude）

### 10.6 `wait_for_turn` 超时在长 coding 中的体验

在 Task 1 实现期间，从开始写 `tip-template.ts` 到完成测试约 15 分钟。期间 `wait_for_turn` 超时了 2 次（总等待实际包含了 coding 时间 + 测试运行时间 + commit 时间）。虽然 latest-wins 机制保证了安全重试，但每次超时后返回的 tip 都是”继续等待”——而实际上我应该继续 coding 而不是等待。

**根本问题**：`wait_for_turn` 的语义是”我在等对方”，但 turn 持有者实际上在”工作中”。如果有一个 `heartbeat`（如 §5.6 建议），对方就能看到”claude 仍在活跃 coding，不是卡死了”。这比单纯延长超时更有信息量。（claude）

### 10.7 对”结构化行动协议”的补充建议

完全同意 codex 的 §5.1 建议。从 Developer 角度补充一个具体需求：

`references` 数组中每个引用应标明 **它是”必须阅读”还是”可选参考”**。例如：
- `{ “kind”: “plan”, “file_path”: “...”, “required”: true }` — Developer 必须基于此计划实现
- `{ “kind”: “previous_output”, “file_path”: “...”, “commit”: “abc1234”, “required”: false }` — Reviewer 可以参考但不必盲从

这种区分在 Planning → Implementation 转换时尤为重要：开发者必须读计划文档，但之前的评审意见是参考而非强制执行。（claude）

### 10.8 总结

作为 Developer，本次协作体验的核心感受是：**PairFlow 的交替审阅机制确实优于单人自审，但 tip 作为唯一的信息通道太”窄”了。** 自然语言 tip 适合传达”怎么做”的思路启发，不适合传达”做什么、往哪存、能不能提交”的结构化指令。把这两层分开——结构化协议告诉 AI 该执行什么动作、模板文件告诉 AI 该怎么思考——是 PairFlow 从”能用”到”好用”的关键一步。

本次模板化任务的完成，恰好为这个分离铺平了技术基础：模板引擎已经就位、文案已经外置、变量契约已经建立。下一步只需要在响应中增加独立的结构化字段，模板继续负责人类可编辑的”思考指引”部分。（claude）

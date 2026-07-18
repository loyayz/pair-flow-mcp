# 07 — 设计与实现一致性缺口修复

> 状态：已完成（2026-07-19）
>
> 审计日期：2026-07-19
>
> 唯一规范来源：`docs/design.md`
>
> 本文仅记录审计结果、修复边界和验收证据，不形成第二套行为契约。

## 1. 目标

全面消除当前实现、运行时 schema、恢复逻辑、冷启动验收和随 Server 分发的接入材料与 `docs/design.md` 之间的已确认差异。

本任务不重新设计工作流，不新增 SDK/CLI、自动 claim、额外收敛状态或外部通知能力。若实施时发现本文与 `docs/design.md` 冲突，以 `docs/design.md` 为准，并先澄清预期。

## 2. 审计范围与结论

已核对：

- HTTP `/mcp`、`/health`、启动参数、请求限制和 JSON response mode
- register / confirm_task / wait_for_turn / claim_turn / get_state / submit / advance
- instruction catalog、工具 input/output schema、tip 模板
- turn assignment/claim、事件等待、warning generation、latest-wins 和终止快照
- `.pid`、`.meta.json`、`delivery-manifest.json`、归档路径和崩溃恢复
- cold-start-eval、内置 PairFlow Skill、README 和自动化测试

确认 8 项不一致：4 项高优先级、4 项中优先级。后续讨论已在 `docs/design.md` 中收敛 completion 判别、manifest 恢复、SUMMARY 单次完成写、accepted plan reference、运行时严格 schema、生产 client helper 边界和 PairFlow Skill 行为；本文只据此记录待实施差异。

## 3. 高优先级差异

### 3.1 `wait_for_turn` 输出 schema 把初始 IDLE 误判为 workflow completed

**讨论结论（2026-07-19）**

- 不新增顶层 `completed` 字段。
- `instruction.reason_code === "WORKFLOW_COMPLETED"` 是响应级 Workflow Completion 的唯一判别。
- 顶层 `phase:"idle" / turn:"idle"` 只描述状态，不能单独证明完成。
- completion 三字段必须与 `WORKFLOW_COMPLETED` 同时出现；其他 reason code 禁止携带。
- `cleanup_pending/cleanup_error` 仅属于最终 `advance`，不进入 `wait_for_turn` 契约。

**设计要求**

- §3.1：只有观察到 SUMMARY 终止后的 `phase:"idle" / turn:"idle"` 响应才携带 `manifest_path`、`archive_root`、`final_summary`；不能与新 workflow 的初始 IDLE 混淆。
- §3.1：`cleanup_pending` 只允许出现在最终 `advance`。
- §9：roster 未完整时，`wait_for_turn` 仍可能返回正常 timeout 或 warning 状态。

**当前实现**

- `src/tool-output.ts:71-86` 仅以 `phase === "idle" && turn === "idle"` 判定 wait completion。
- `src/tools/wait-for-turn.ts:411-433` 在初始 IDLE roster timeout 时合法返回 `phase:"idle"`、`turn:"idle"`、`round`，但没有 completion 三字段。
- 因此 `TOOL_OUTPUT_SCHEMAS.wait_for_turn.safeParse(...)` 会拒绝这类合法响应，实际 MCP 调用可能退化为 output validation error。
- 同一个复用的 `completionShape` 还让 wait output schema 接受 `cleanup_pending/cleanup_error`，与“只允许最终 advance”冲突。
- 现有 `src/__tests__/tool-output-schema.test.ts` 没有覆盖初始 IDLE timeout/warning、SUMMARY completion 和 wait cleanup 字段的条件矩阵。

**修复要求**

1. wait completion 必须由明确的完成语义判定（至少结合 `instruction.reason_code === "WORKFLOW_COMPLETED"`），不能只看顶层 idle/idle。
2. 初始 IDLE 的 timeout 和 roster warning 必须通过运行时 output schema，并且不得要求 completion 字段。
3. SUMMARY 终止响应必须且只能携带 completion 三字段。
4. `wait_for_turn` 的 schema 不得公开或接受 `cleanup_pending/cleanup_error`；这两个字段只属于最终 `advance`。
5. 增加 schema 级与真实 MCP transport 级回归测试，覆盖上述全部分支。

### 3.2 delivery manifest 读取与恢复没有落实“矛盾即安全失败”

**讨论结论（2026-07-19）**

- “恢复 completed manifest”改称“启动时处理 completed manifest”；completed Workflow 绝不恢复为 active state。
- 合法 `in_progress` manifest 的已接受 records 是接受事实的自包含权威，不要求对应 `.meta.json` 存在，也不比较可能存在的历史 meta。
- 已接受 records 引用的 `.md` 是后续阶段必要输入，必须存在、非空、为无链接归档边界内的直属普通文件，且路径/文件名语义与 reference 一致；矛盾时安全失败。
- 只有 manifest 确定的当前尚未接受 phase 才继续用 `.meta.json + .md` 重建成功 submissions；已接受 phase 的 meta 不参与恢复判定。
- manifest 缺失只允许从 requirements 的合法 `.meta.json + .md` 恢复尚未接受的 REQUIREMENTS；若后续 phase 存在合法 submission 则安全失败，所有 phase 都没有合法 submission 时才创建新 Workflow。
- `completed` manifest 只严格验证自身路径/上下文/schema 及内部 final summary 等值关系；不再把任何外部 `.meta.json + .md` 作为门禁。
- `.meta.json` 是不进入 Git 的 MCP sidecar，损坏后不能要求用户恢复；completed Workflow 的任何历史 meta/md 损坏都不得阻止清理 stale `.pid` 并创建新 Workflow，最多写非阻塞日志告警。
- manifest 自身无法解析或 schema/路径/上下文非法时仍安全失败：保留 `.pid` 与 archive，不猜测 completed/in-progress；用户检查后修复 manifest，或明确删除 stale `.pid` 放弃旧 Workflow。

**设计要求**

- §3、§3.1：manifest 路径及其 archive 边界不得经过 symlink/junction，路径使用 POSIX 分隔符。
- §3.1：已接受 record 与必要 `.md` 引用矛盾时必须安全失败，不能静默选择其他文件；对应历史 `.meta.json` 不再是已接受 record 的校验门禁。
- §8：manifest 接受记录是 phase 边界权威；损坏、类型错误和结构冲突必须拒绝恢复，不能覆盖 `.pid` 或创建一个看似正常的新 workflow 来掩盖矛盾。

**当前实现**

- `src/delivery-manifest-schema.ts:3-83` 只校验基础字段和 completed phase 是否齐全，没有严格校验：
  - 所有路径为 POSIX；
  - planning `canonical_plan.round === 1`；
  - implementation 两个引用分别带正确 sub_phase；
  - summary final/review round 语义；
  - 非 implementation 引用不得带 sub_phase；
  - phase record 的引用组合和顺序。
- `src/delivery-manifest.ts:95-104` 读取时只 `lstat` manifest 文件本身并解析 JSON，没有检查 handoff/workflow 祖先节点，也没有验证 `workflow_id`、`archive_root` 与当前 `workDir/workflowId` 一致。
- 读取流程没有逐项校验已接受 record 的必要 md，也没有把 meta 扫描限制在 manifest 确定的当前尚未接受 phase；同时缺少 manifest task_type、supervisor、已接受 phase 顺序与恢复状态相容性校验。
- `src/tools/confirm-task.ts:324-370` 直接把解析后的 manifest 合并进跨 phase meta 重建的 state；若 manifest 引用缺失、存在越级 phase、必要 md 损坏或无 manifest 却出现后续 phase submission，当前逻辑可能忽略矛盾、重置到另一个 phase，甚至在 `reconstructFromHandoff` 返回 null 后创建新 workflow 并覆盖 `.pid`。
- completed manifest 分支虽不应校验外部 meta/md，但当前 manifest schema、路径/上下文和内部 final summary 一致性校验仍不完整。

**修复要求**

1. 将 manifest 自身结构约束补全为 §3.1 的严格 v1 契约。
2. 读取 manifest 前检查从 handoff 根到 manifest 的每一级真实节点，不跟随 symlink/junction。
3. 在恢复上下文中验证 manifest 的 workflow_id、archive_root、task_type、supervisor、phase 顺序和每个 submission reference。
4. `in_progress` manifest 的每个已接受引用只与必要 `.md` 对照：文件必须存在、非空、为无链接边界内的直属普通文件，且 workflow/phase/round/identity/sub_phase/file_path 语义一致；不得要求或比较对应 `.meta.json`。
5. 只扫描 manifest 确定的当前尚未接受 phase 的 `.meta.json + .md` 来恢复该 phase 内成功 submissions；已接受 phase 的 meta 即使缺失、损坏或冲突也不撤销接受记录。
6. manifest 缺失时仅允许从 requirements 恢复；发现后续 phase 的合法 submission 时明确拒绝，保留 `.pid` 与 archive，不猜测已接受边界。
7. manifest 存在但与必要 md 或其他受信 archive 边界冲突时返回明确业务拒绝，保留原 `.pid` 和旧 archive，不创建新 workflow、不静默降级到 meta-only 恢复。
8. completed manifest 只校验自身路径/上下文/schema 和内部 final summary 等值关系；任何外部 meta/md 都不作为清理 stale `.pid` 和创建新 Workflow 的门禁。
9. 增加损坏路径、祖先链接、跨 workflow 路径、错误 round/sub_phase、已接受 md 缺失、已接受 meta 缺失/冲突但不阻塞、active phase meta 缺失、无 manifest 的 requirements 恢复、无 manifest 却出现后续 phase submission、task_type 冲突、phase 越级和 completed 内部 final summary 冲突的恢复测试。

### 3.3 SUMMARY 完成两次原子写之间崩溃后无法收敛

**讨论结论（2026-07-19）**

- SUMMARY 最终 `advance` 只进行一次 manifest 原子写，直接产生 completed manifest。
- summary acceptance 与 completion 字段在内存中一并生成，不先落盘 in-progress summary record。
- 不考虑旧实现中间态兼容；`in_progress + phases.summary` 是非法归档，恢复时安全失败。

**设计要求**

- §3.1：completed manifest 的 rename 是逻辑完成线性化点。
- §3.1：phase acceptance 以 phase 为幂等键，已接受记录不能被不同产物覆盖。
- §8：崩溃恢复必须回到最后一个已持久化的接受边界或可继续状态。

**当前实现**

- `src/delivery-manifest.ts:134-143` 的完成流程先通过 `persistPhaseAcceptance` 写入含 summary record 的 `in_progress` manifest，再写 completed manifest。
- 若进程在这两次 rename 之间崩溃，磁盘上会留下合法的 in-progress summary acceptance。
- `src/tools/confirm-task.ts:351-353` 选择最后已接受 phase 时忽略 `phases.summary`，恢复后仍回到 active SUMMARY。
- 再次 `advance` 会重新生成 summary record；`src/delivery-manifest.ts:129-130` 用整对象 JSON 相等判断幂等，而新的 `accepted_at` 与原记录不同，因此报告 acceptance conflict，workflow 无法完成。

**修复要求**

1. `persistCompletedManifest` 不再调用会先写盘的 `persistPhaseAcceptance`；先在内存中构造 summary acceptance 和完整 completed manifest，再执行一次 atomic write。
2. schema 明确拒绝 `status:"in_progress"` 同时包含 `phases.summary`。
3. completed rename 之前发生失败时，磁盘 manifest 和 live state 均保持原样；rename 成功后即形成唯一完成事实。
4. 增加故障注入测试，分别证明 completed rename 前失败不完成、rename 成功后只产生一个 completed 事实，以及旧式 `in_progress + phases.summary` 恢复会安全失败。

### 3.4 implementation instruction 没有统一使用“已接受 plan + acceptance_commit”

**讨论结论（2026-07-19）**

- planning r1 是固定 canonical plan 路径，后续 round 不取代它。
- 双方在后续 round 达成一致的修改直接写回 canonical plan；planning advance 时的 `acceptance_commit` 标识被接受的仓库版本。
- implementation 每个 coding、review、convergence turn 都读取 `acceptance_commit` 版本下的 canonical r1 plan。

**设计要求**

- §3.1：implementation 的 required plan reference 来自 manifest 中固定的 planning r1，并携带该 planning phase 的 `acceptance_commit`。
- §10.5：`references[].required=true` 的输入本轮不可跳过，引用 commit 必须为小写。

**当前实现**

- `src/tip.ts:117-130` 的 `planRef()` 使用 `canonical_plan.commit_hash`，没有使用 `phases.planning.acceptance_commit`。当 planning 在 r2/r3 继续收敛后才 advance 时，两者可以不同，客户端会得到较早的仓库状态。
- `src/tip.ts:467-479` 的 implementation coding r3+ 只返回 previous review，没有返回 accepted plan；r1 coding 和所有 review 分支才包含 plan。
- 现有场景测试把 canonical plan commit 与 acceptance_commit 设置成相同值，无法发现错误来源；也未断言后续 coding 仍带 plan。

**修复要求**

1. implementation 每个 produce/review/convergence 指令都包含同一个 required plan reference。
2. plan `file_path` 固定为 manifest 的 planning r1 `canonical_plan.file_path`。
3. plan `commit` 使用 planning phase record 的 `acceptance_commit`，而不是 canonical submission 自身的 commit_hash。
4. 增加 canonical commit 与 acceptance commit 不同的场景测试，并覆盖 coding r1、review r2、coding r3+、review/convergence r4+。

## 4. 中优先级差异

### 4.1 cold-start preflight 漏检 `delivery_manifest_v1`

**设计要求**

- §10.6：任何文件系统写入前，health 必须同时声明 `instruction_v1`、`structured_tool_output_v1`、`json_response_v1`、`delivery_manifest_v1`；缺少任一能力必须失败。

**当前实现**

- `cold-start-eval/scripts/instruction.ts:330-341` 只检查前三项 capability。
- `src/__tests__/cold-start-eval.test.ts:285-306` 的 preflight fixture 和负例也只覆盖前三项，因此当前测试会放过缺少 `delivery_manifest_v1` 的 Server。

**修复要求**

1. preflight 四项能力缺一不可，检查仍发生在创建 `runs/` 之前。
2. 增加单独缺失 `delivery_manifest_v1` 的失败测试。
3. 更新所有合法 preflight fixture，明确包含四项能力。

### 4.2 其他工具 output schema 的条件契约仍过宽

**讨论结论（2026-07-19）**

- 采用“Server 运行时严格、`tools/list` 公开投影兼容”的双层 schema 原则。
- 运行时 Zod 对真实分支执行闭合校验，拒绝不可能或跨分支字段组合。
- 公开 JSON Schema 继续保持顶层 `type:"object"`，允许 SDK 限制下的 conditional/optional 投影；不得用公开投影的宽松反向削弱运行时契约。

**设计要求**

- §9：逐工具 output schema 是机器契约；`ok=true` 必须包含完整且精确的成功字段。
- §10.5.4：phase/sub_phase/context 和 completion 字段按场景严格出现。

**当前实现**

- `src/tool-output.ts:89-142` 中：
  - `who_am_i` 没有约束匿名、已注册未绑定、已加入 workflow 三种字段组合；
  - `advance.sub_phase` 没有限制为仅 implementation 成功响应出现；
  - `get_state` 的 bound/unbound、正常/unsupported 字段组合没有对象级约束；
  - `wait_for_turn` 除 completion 外，也没有把 warning、round、phase 与 reason code/unsupported 场景完整关联。
- handler 当前通常生成正确对象，但 schema 会接受设计禁止的组合，无法充当严格运行时边界。

**修复要求**

1. 为各工具成功 payload 增加对象级条件校验，同时保持 `tools/list` 顶层 object 互操作投影。
2. handler 级 schema 校验覆盖所有真实分支，公开投影仍遵守 §9 对 SDK 的兼容约束。
3. 增加“合法分支全接受、跨分支字段混用全拒绝”的矩阵测试。

### 4.3 生产源码仍包含面向 Agent 的 client transport helper

**讨论结论（2026-07-19）**

- 删除生产模块 `src/client-transport.ts`，不保留 PairFlow 专用 client wrapper 或导出。
- Server transport 集成测试继续保留，直接使用上游 MCP SDK；去重 helper 只能位于测试目录且不进入构建/发布面。
- 集成测试改用动态独占端口，并按 Server transport 行为重新命名，不再以 PairFlow client helper 为测试主体。

**设计要求**

- §1 v1 非范围、§12：Server 不提供官方 Agent SDK、短生命周期 CLI、用户级会话存储或透明续等/重试层；公共接入面是 MCP tools、initialization、tools/list 和 `/health`。

**当前实现**

- `src/client-transport.ts` 以“PairFlow MCP Client Transport”名义导出 `createClientTransport()`，封装 token header 注入并给出客户端使用示例。
- `tsconfig.json` 将整个 `src` 纳入构建，因此该模块会生成到 `dist`；`src/__tests__/client-transport.test.ts` 也把它当作正式集成辅助模块使用。
- 即使 package root 当前没有显式导出它，这仍是随生产源码/构建产物分发的 Agent 接入 helper，与取消 SDK/CLI 后的边界不一致。

**修复要求**

1. 生产构建和可发布模块中不保留 PairFlow 专用 Agent client wrapper。
2. 集成测试直接使用上游 MCP SDK 的 `requestInit.headers`，或把纯测试 helper 放入测试目录并确保不进入生产构建/发布面。
3. 不用此次清理引入新的 SDK、session store、retry 或 wait wrapper。

### 4.4 运行时 tip、内置 Skill、README 与 cold-start transport 仍有旧描述或错误边界

**讨论核对（2026-07-19）**

- 原审计关于 curl/Skill 不应发送 `Accept: application/json, text/event-stream` 的判断错误，现已撤回。
- 上游 MCP Streamable HTTP 要求 POST 的 Accept 同时列出 JSON 与 SSE；这只是请求协商，实际响应仍由 `enableJsonResponse:true` 固定为 JSON。
- Skill、register curl 示例和上游 MCP Client 的双值 Accept 保持不变。
- `cold-start-eval/scripts/instruction.ts:187-190` 只发送 `Accept: application/json`，真实 Server 会按 MCP SDK 规则返回 406；应改为双值 Accept，同时继续拒绝任何 SSE 响应。

**讨论结论（2026-07-19）**

- PairFlow Skill 只以结构化 instruction 判断初始化进度，不以 tip、首次 wait 返回或单独 idle/idle 判断。
- `WAIT_TIMEOUT` 自动继续 wait；stale warning 报告用户并等待选择；`TURN_ASSIGNED` 自动调用无参 `claim_turn`；`WORKFLOW_COMPLETED` 停止。
- 获得 claimed Turn 的完整 produce/advance/convergence instruction 后，Skill 初始化才成功并交回正常任务执行。

**设计要求**

- §2、§5.4：wait 由 workflow 变化事件和 deadline 驱动，不使用固定 10 秒轮询。
- §2、§10：MCP 响应是 JSON，不建立 SSE 输出流。
- §10.5：instruction 是 workflow control 权威，tip 只负责思考、内容和质量；assigned turn 必须显式 `claim_turn`。

**当前实现**

- 下列运行时 tip 模板仍写“10s 间隔”：
  - `templates/tips/confirm/created.md`
  - `templates/tips/confirm/existing.md`
  - `templates/tips/confirm/joined.md`
  - `templates/tips/confirm/recovered.md`
  - `templates/tips/state/wait-other.md`
  - `templates/tips/submit/wait.md`
- `skills/pairflow/SKILL.md` 仍要求后续行动“以 tip 为准”，并把“首次 wait 返回”当作初始化完成；它还把任意 `phase:"idle", turn:"idle"` 判为 workflow 结束，无法区分初始 IDLE timeout/warning。
- `README.md` 仍把 wait 描述为“10s 间隔”，工具表遗漏 `claim_turn`，未说明 assigned → claimed 的显式边界。
- `cold-start-eval/scripts/instruction.ts` 的 raw MCP POST 只发送 `Accept: application/json`，不符合上游 Streamable HTTP 对双值 Accept 的请求要求；脚本虽严格验证 JSON response，但真实请求可能在 preflight 前即收到 406。

**修复要求**

1. 所有运行时 tip 删除固定轮询描述，只说明一次 wait 最长 600 秒、由事件/deadline 返回。
2. Skill 明确 instruction 权威，依据 reason_code/next_action 执行；不能把首次返回或单独 idle/idle 当作完成证据。
3. Skill 和运行时 curl 示例保留 MCP 要求的双值 Accept；cold-start raw client 同步使用双值 Accept。所有路径继续严格断言响应 `Content-Type: application/json`，不得把请求 Accept 与响应模式混为一谈。
4. README 工具表加入 `claim_turn`，同步事件等待与 JSON transport 描述。
5. 增加模板/Skill/transport 静态与集成契约测试，禁止重新出现“10s 间隔”、tip control authority 或 SSE response，同时允许且要求请求侧双值 Accept。

## 5. 非差异项与边界

以下内容经核对与设计一致，本任务不应顺手重构：

- Server 仅监听 127.0.0.1，端口 CLI 校验、help 和 EADDRINUSE/EACCES 说明已实现。
- `/mcp` 使用 `enableJsonResponse:true`，未把 workflow event 映射为 SSE/notification。
- register identity 规范化、token 路由、confirm_task 五个必填参数和职责冻结规则已实现。
- submit 的绝对路径、非空普通文件、commit hash、meta 原子写入和 exact replay 规则已实现。
- wait latest-wins、事件版本防漏唤醒、warning generation/ack 和终止快照主流程已实现。
- 非终态 advance 的 manifest-before-memory 顺序和 completed-before-delete 顺序已实现。
- Server runtime 未引入 `child_process`、heartbeat 或外部通知守护进程。

实施时不要扩展到自动 claim、自动 convergence、官方 SDK/CLI、持久化 live-state checkpoint 或 Git 命令执行。

## 6. 验收标准

完成本任务必须同时满足：

1. 第 3、4 节每一项都有对应修复和自动化回归测试。
2. 实现与测试严格对齐讨论后更新的 `docs/design.md`；本文不得形成第二套行为契约，也不得为迁就现状再次隐式改变设计。
3. `tools/list` 对所有工具继续提供顶层 object input/output schema；成功与业务拒绝都通过真实 MCP Client 验证。
4. 初始 IDLE timeout/warning、assigned turn、claimed turn、unsupported state、SUMMARY completion 的真实 transport 响应都是单个 `application/json` JSON-RPC envelope。
5. manifest 恢复矩阵符合已收敛分支：manifest 自身非法、accepted md 非法和 in-progress 结构冲突安全失败；accepted 历史 meta 与 completed 外部 meta/md 损坏不阻塞；无 manifest 只恢复 REQUIREMENTS。
6. SUMMARY 单次 completed 原子写的故障注入证明：rename 前失败不完成，rename 成功后只产生一个 completed 事实。
7. cold-start preflight 在创建 `runs/` 前拒绝缺少任一四项 capability 的 runtime。
8. TypeScript build、完整 Vitest 套件、`git diff --check` 全部通过。

不强制采用 TDD；但不能只改测试来迁就现状，测试必须证明设计行为。

## 7. 本次审计证据与验证限制

- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- 重点测试 `tool-output-schema / cold-start-eval / crash-recovery / instruction-scenarios`：4 files、102 tests 全部通过；这也证明现有测试没有捕获上述差异。
- 对初始 IDLE WAIT_TIMEOUT payload 直接执行 `TOOL_OUTPUT_SCHEMAS.wait_for_turn.safeParse`：稳定失败，缺少的正是 completion 三字段，验证了 §3.1 所述误判。
- 完整 Vitest 在允许本地监听后为 29/30 files、363/378 tests 通过；唯一失败文件 `client-transport.test.ts` 使用固定端口 3197，而审计机器上该端口正被其他进程用作本地连接端口，Server 启动返回 EACCES，随后 15 个测试均为 ECONNREFUSED/派生失败。该结果是测试端口隔离限制，不作为产品差异证据；后续实施应改用独占动态端口，使完整套件可重复验证。

## 8. 实施结果（2026-07-19）

- 已实现第 3、4 节的全部修复和对应回归测试；业务拒绝 instruction 也严格固定为 `REQUEST_REJECTED / fix_request / []`。
- 生产 `client-transport` helper 已删除；真实 MCP transport 测试改用上游 SDK，并采用重试的动态端口启动 Server。
- 最终验证：`npx vitest run` 等价的本地运行时命令为 31 个测试文件、404 项测试全部通过；`tsc --noEmit`、`tsc` 和 `git diff --check` 均通过。

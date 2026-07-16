# PairFlow: 双 AI 结对编程工作流引擎

> 设计日期: 2026-06-21

---

## 1. 目标与范围

构建一个本地 HTTP MCP Server，驱动两个 AI 按照结构化工作流完成结对编程。不绑定具体 AI 产品——两端先注册 identity，再通过 HTTP header 携带 PairFlow 签发的 token，PairFlow 不预设"谁是谁"。

工作流覆盖从需求到交付的完整软件开发生命周期，包含四阶段主流程：需求阶段 → 计划阶段 → 开发阶段 → 汇总阶段（其中开发阶段内部含 coding↔review 交替子循环，对应四个状态机 phase：REQUIREMENTS/PLANNING/IMPLEMENTATION/SUMMARY）。任一阶段出现分歧时，双方在产出文档中标注观点差异，监督者在 advance 前裁定是否需要用户介入。

**核心定位**：结对编程的工作流引擎——持续互审 + 知识共享 + 方案互补。两个 AI 在同一工作流中交替产出与评审，减少单人偏差。

**监督者**：IDLE 阶段由用户从两个 AI 中指定。监督者通过 `advance` 控制阶段推进——未达成共识时有权不推进（阻塞 advance），但不能单方面否决对方产出。分歧无法在文档标注中解决时，由监督者裁定是否需要用户介入。SUMMARY 阶段负责汇总报告。

**v1 范围**：流程线性固定（四个 phase 顺序执行）。

**设计权威与持续一致性**：本文是 PairFlow 行为、协议和恢复语义的唯一规范性来源。实现、自动化测试、运行时 schema、`/health` 能力目录和冷启动验收必须与本文同步变更；task、plan、review 和 audit 文档只记录背景、过程与证据，不形成第二套契约。发现实现与本文冲突时，必须先明确预期并修正冲突，不能仅为迁就现状而静默改写设计。

**v1 明确非范围**：不为 `advance` 增加“新 turn 仍属于调用者时自动 claim”的捷径，也不增加额外的自动收敛状态；所有新 turn 一律先 assigned，再由参与者显式执行 `wait_for_turn → claim_turn`。Server 不提供官方 Agent SDK、短生命周期 CLI、用户级会话存储或透明续等/重试层；支持的公共接入面是 `/mcp` 工具协议、MCP initialization、`tools/list` 和 `/health` 运行时目录。PairFlow 也不运行常驻客户端、heartbeat 或外部通知守护进程。

---

## 2. 架构总览

```
AI-A (MCP Client)              AI-B (MCP Client)
        │                            │
        │ HTTP 127.0.0.1:35690/mcp │
        │ GET  127.0.0.1:35690/health（协议发现）
        ▼                            ▼
┌──────────────────────────────────────────────────┐
│              PairFlow Server (HTTP MCP)           │
│                                                  │
│  状态机 + 模板引擎 + 收敛判定（手动）                  │
│ （状态全内存，work_dir/handoff/ 为归档权威来源）     │
│ work_dir/handoff/{workflow_id}/（产出 + sidecars）      │
│                                                  │
│  MCP Tools: ping / who_am_i / register            │
│            get_state / submit                     │
│            confirm_task / advance                 │
│            wait_for_turn / claim_turn             │
└──────────────────────────────────────────────────┘
```

- **两个 AI**：先注册身份获取 token，再通过 `confirm_task` 加入 workflow 并声明职责，后续按阶段参与协作
- **监督者**：AI 之一兼任，控制 `advance` + 分歧裁定 + 最终异议 + SUMMARY 汇总
- **PairFlow**：中立调度方。两边可见相同工具集，执行权限按职责和 turn 控制。状态变更持 async-mutex（`confirm_task` 固定按 token → 规范化 `task_path` → workflow 的顺序加锁；token 锁防止同一凭据并发加入不同任务，task_path 锁防止重复创建 workflow；其他工作流运行期操作只按 workflow 加锁。token/task_path 临时锁在请求队列耗尽后释放）
- **运行时协议发现**：匿名只读的 `GET /health` 是当前 Server 能力和 instruction 协议的发现权威；它保留探活字段并公开 Server/协议版本、capabilities、权威边界、bootstrap、字段、action、reason code 和未知值策略。访问 health 不占用 turn、不改变 workflow，也不返回当前工作流专属的 `instruction`
- **等待与传输**：`wait_for_turn` 使用进程内 workflow 变化事件等待 roster、turn、提醒边界和 workflow 终止，不通过固定间隔轮询或外部通知发现变化。无状态 `/mcp` endpoint 对所有 POST 使用 Streamable HTTP JSON response mode，返回普通 JSON-RPC JSON；长等待只延迟响应完成，不建立 SSE 输出流
- **命令执行边界**：PairFlow 不启动 Git 或任何其他外部命令，只管理内存状态并读写归档文件

---

## 3. 目录结构

`project/` = `work_dir` = git 仓库根目录。`confirm_task` 通过 `<work_dir>/.git` 标记验证仓库根：普通仓库接受 `.git` 目录，linked worktree 接受 `.git` 文件；该验证只读取文件系统，不执行 Git 命令。完整 live state 仅存在于进程内存中（重启后丢失），不写独立 checkpoint；`.pid` 只保存 workflow_id 恢复指针，不是状态文件。归档固定置于 `<work_dir>/handoff/`，不受 PairFlow server 启动目录影响；其中 AI 产出的 `.md` 纳入版本管理，PairFlow/MCP 生成的 `.meta.json` 与 `delivery-manifest.json` 是本地恢复 sidecar，任务文档旁的 `.pid` 是运行期恢复指针。这三类运行时 sidecar 均不要求 AI commit，并由默认 Git ignore 规则排除。

**路径节点策略**：需要信任文件类型或归档边界时统一使用 `lstat`，不使用会跟随链接的 `stat`。从卷根到 `work_dir`、`.git` marker、task_path 从 work_dir 往下的每一级、`.pid`、handoff/workflow/phase 路径以及 submit 产出路径均不得是 symlink/junction；普通 Git 仓库的真实 `.git` 目录和 linked worktree 的真实 `.git` 文件均允许。目录、普通文件、缺失、符号链接和其他 IO 错误必须在 tip 中给出对应原因，不互相冒充。

`<work_dir>/handoff/` 下的 `.md` + `.meta.json` 是 submission 事实的归档权威，`delivery-manifest.json` 是 phase 已接受和 workflow 已完成事实的归档权威；它们都不是完整 live-state checkpoint。崩溃恢复从 `.pid` 指向的 workflow 目录中恢复到最后一个已持久化的接受边界或成功 submission 后的可继续状态（见 §8）。AI 通过 Git 为 `.md` 产出提供追溯和备份；sidecar 是否被 fork 维护者选择纳入 Git 不改变 PairFlow 的归档与恢复语义。

```
project/                                         ← git 仓库根
├── handoff/                                     ← 本地归档（.md 由 AI commit；meta/manifest 由 PairFlow 生成）
│   └── {workflow_id}/                           ← 每个工作流独立目录（workflow_id = confirm_task 时生成的 yyyyMMddHHmmss）
│       ├── requirements/                        ← 需求阶段
│       │   ├── r1_{identity}.md                     ← 每轮独立文件
│       │   ├── r1_{identity}.meta.json
│       │   ├── r2_{identity}.md
│       │   ├── r2_{identity}.meta.json
│       │   ├── ...
│       ├── planning/                            ← 计划阶段（文件命名同 requirements/：r{round}_{identity}.md + .meta.json）
│       ├── implementation/                      ← 开发阶段（coding ↔ review 交替）
│       │   ├── r1_coding_{identity}.md
│       │   ├── r1_coding_{identity}.meta.json
│       │   ├── r2_review_{identity}.md
│       │   ├── r2_review_{identity}.meta.json
│       │   ├── ...
│       ├── summary/                             ← 汇总阶段（监督者 r1 草稿 → 对方 r2 审阅 → r3+ 交替修订直至收敛）
│       │   ├── r1_{supervisor}.md                   ← 监督者产出草稿
│       │   ├── r1_{supervisor}.meta.json
│       │   ├── r2_{identity}.md                     ← 对方审阅草稿
│       │   ├── r2_{identity}.meta.json
│       │   ├── ...
│       └── delivery-manifest.json               ← PairFlow 原子写入的阶段接受/最终交付 sidecar
```

### 3.1 阶段接受记录与最终交付清单

`handoff/{workflow_id}/delivery-manifest.json` 是 workflow 的机器可读交付清单。它与 `.meta.json` 一样是运行时 sidecar，不要求 AI commit；路径使用 POSIX 分隔符，且必须位于没有 symlink/junction 的 workflow archive 边界内。live state 额外缓存 `delivery_manifest: DeliveryManifest | null`：新 workflow 为 null，phase 初始化通过对象展开保留它。

每次 Supervisor 成功 `advance` 一个非终态 phase 前，PairFlow 只从经过归档校验的 submission 生成或扩展状态为 `in_progress` 的 manifest，并先原子写入，再变更内存 phase、发布事件。`advanced_by` 仅记录调用 advance 的 Supervisor，**不表示** 两位参与者均已审批；`acceptance_commit` 取当前 phase 最高 round 合法 submission 的 caller-declared commit，表示推进时调用方声明的仓库状态。PairFlow 不验证该 commit 存在、位于当前分支或必然包含 canonical document。

manifest v1 严格包含：`manifest_version:1`、`status:"in_progress"|"completed"`、`workflow_id`、`task_type`、`archive_root`、`supervisor`、`phases`、`commit_verification:"caller_declared_unverified"`。每个 phase record 均包含 `phase`、`advanced_by`、`accepted_at`、`acceptance_commit` 与提交引用（`round`、`submitted_by`、`commit_hash`、`file_path`；implementation 引用还包含 `sub_phase`）。跳过的 phase 直接省略，不使用 null 占位。

- requirements 以 `final_submission` 记录最高 round 的合法 accepted submission；原始 `task.spec_file` 仍是 workflow 的任务输入。planning 以 `canonical_plan` 记录固定的 r1 submission；implementation 以 `coding_submission` 和 `review_submission` 分别记录最高 coding 和最高 review submission；summary 以 `final_summary` 记录最终文档，并在存在时以 `review_submission` 单独记录 r2 review。
- final summary 选择最高的 r1 或 r3+ summary submission；r2 永远只是 review。故只有 r1+r2 时 final summary 是 r1；存在 r3+ 时为最高 r3+。
- requirements workflow 只能包含 requirements 和 summary；development workflow 完成时必须有四个 phase record。完成 manifest 另必须有 `completed_at`、`completed_by` 与等同 `phases.summary.final_summary` 的顶层 `final_summary`。
- phase acceptance 以 phase 为幂等键，不能用不同产物覆盖已接受记录。planning/implementation 尚未提交新产物时，已接受上个 phase 的 draft manifest 仍是恢复权威；不得凭空生成下个 phase record。
- 下一阶段 instruction 的 required references 由 manifest 中的已接受记录生成：planning 读取任务输入；implementation 使用已接受 planning r1 及其 `acceptance_commit`；summary 使用 archive root、已接受 requirements submission，并在 development workflow 中增加已接受 plan、最新 coding 和最新 review。被跳过或不存在的引用省略，客户端不得扫描目录自行改选权威输入。
- manifest、`.meta.json` 与其必要 `.md` 引用出现矛盾时必须安全失败，不能静默选取另一个“看起来最新”的文件。

终态 SUMMARY advance 的顺序是：

1. 校验并原子写入 `status:"completed"` manifest；该 rename 是逻辑完成线性化点。
2. 发布包含完成快照的 workflow 终止事件，解绑 token 并删除 live state。
3. 尝试删除任务文档 `.pid`。
4. `.pid` 删除失败不回滚完成：仍返回 `ok:true`，并以 `cleanup_pending:true` 和 `cleanup_error` 报告；ENOENT 视为清理成功。

完成成功响应和因该终止唤醒的 SUMMARY waiter 都必须含相同的 `manifest_path`、`archive_root` 与 `final_summary`。对 `advance`，这三个字段仅在且必须在 `new_phase:"idle"`、`turn:"idle"` 的完成响应中出现；对 `wait_for_turn`，仅在且必须在已观察到 SUMMARY 终止后的 `phase:"idle"`、`turn:"idle"` 响应中出现，不能与新 workflow 的初始 IDLE 混淆。`cleanup_pending` 只允许出现在最终 `advance`；`cleanup_error` 当且仅当 `cleanup_pending:true` 时存在。恢复必须先读取 manifest 再重建 active state：发现 completed manifest 时仅清理遗留 `.pid` 后创建/继续新 workflow，绝不把旧 workflow 重建为 active SUMMARY。

**meta.json 生成**：`.meta.json` 由 `submit` 工具在每次提交成功后自动生成，写入 `submitted_at`、`commit_hash`、`sub_phase`、`task` 字段。它是 PairFlow/MCP 的产出，生成时 AI 的 `.md` 已完成 commit，因此不属于该 `git_commit_hash` 指向的提交，也不要求 AI 再次 commit。一次 submit 的 meta、`last_submission_by_participant` 和 `turn_switched_at` 共用同一个 submitted_at；commit_hash 统一存为小写。`.meta.json` 必须使用同目录临时文件 + rename 原子写入；只有 `.meta.json` 写入成功后，`submit` 才能推进内存状态并返回成功，写入失败时状态完全不变并在 tip 中返回路径和文件系统错误码。崩溃恢复只使用符合该生成契约的 meta：JSON 可解析，submitted_at 为有效时间，commit_hash 为 7–40 位十六进制，task.spec_file 为绝对路径，task.task_type 合法，sub_phase 与 phase、文件名一致；同时，同名 `.md` 产物必须是同一 phase 目录下非零字节的直属普通文件，链接、目录、空文件、缺失或无法检查的产物均使对应 submission 记录被忽略，不直接拒绝整个归档。不合格记录直接忽略。`reconstructFromHandoff` 从过滤后的记录重建 `last_submission_by_participant` 等状态字段；每位参与者的最新 submission 按文件名中的 round 判定，不按可能回拨的 submitted_at 排序。

**启动流程**：
1. 仅监听 `127.0.0.1`，默认端口 `35690`，提供 HTTP MCP（`/mcp`）+ 健康检查与协议发现（`GET /health`）。可通过启动参数 `--port <1-65535>` 自定义端口，例如 `npx tsx src/index.ts --port 3200`；不读取端口环境变量，参数缺值、非整数、越界或包含未知选项时说明原因并退出。`--help` 输出用法、默认值和端口范围后以退出码 0 结束，不启动监听。监听失败时，`EADDRINUSE` 和 `EACCES` 必须提示端口冲突或权限原因以及 `--port` 解决方式，然后以退出码 1 结束
2. 状态为进程内存，重启后清空，需重新 register
3. 接收 SIGTERM/SIGINT → 立即以退出码 0 结束进程，不等待在途请求完成，也不为最长 600 秒的 `wait_for_turn` 引入 drain 生命周期。调用方未收到响应时按 §10 的工具级不确定性策略处理，不得一律盲重试；重启后的 workflow 按已成功原子落盘的归档恢复，临时文件或未完成写入不视为成功 submission
4. 任一 `uncaughtException` → 记录错误并以退出码 1 结束进程；由外部进程管理器负责重启、退避和 crash-loop 熔断
5. `POST /mcp` 请求体上限为 1 MiB（1,048,576 bytes）。先检查声明的 `Content-Length`，并始终按实际接收字节逐 chunk 累计；任一值超限立即返回 JSON `413 Payload Too Large`、关闭当前连接，不拼接或解析超限 body。现有工具均只传短字符串、布尔值或空参数，合法请求无需接近该上限
6. HTTP 入口按故障归属返回状态码：JSON 语法错误返回 JSON `400 Invalid JSON`；请求体超限返回 `413`；未匹配的 method/path 返回 `404`；只有服务端内部执行异常返回 JSON `500 Internal Server Error`。通过 JSON 解析但不符合 JSON-RPC/MCP 协议的请求交由 MCP transport 处理。每个请求创建的 MCP transport 无论成功或异常都必须关闭；内部异常发生在响应头发送前时返回 `500`，响应已开始但尚未结束时销毁当前连接，已结束的响应只记录异常
7. HTTP 请求接收阶段设置显式超时：headers 最多 10 秒，完整请求最多 30 秒，连接超时扫描间隔为 1 秒；超时由 Node.js 返回 `408 Request Timeout` 并关闭连接。响应阶段不设置 socket timeout，因此不影响 `wait_for_turn` 的 600 秒长轮询
8. 每个 `/mcp` POST 请求创建的无状态 `StreamableHTTPServerTransport` 必须设置 `enableJsonResponse: true`。所有 MCP 成功、业务拒绝和协议响应使用 `Content-Type: application/json` 的 JSON-RPC envelope；不得为 `wait_for_turn` 或其他工具返回 `text/event-stream`。进程内 waiter 事件不映射为 MCP notification 或 SSE 消息

`GET /health` 保留既有 `{ ok, uptime }` 字段，并增加以下运行时协议目录；`server.version` 来自 Server package 版本，`protocol.version` 与所有 instruction 的 `protocol_version` 来自同一常量：

```jsonc
{
  "ok": true,
  "uptime": 123.45,
  "server": {
    "name": "pair-flow",
    "version": "0.1.0"
  },
  "protocol": {
    "name": "pairflow-instruction",
    "version": "1.1",
    "capabilities": [
      "instruction_v1",
      "structured_tool_output_v1",
      "json_response_v1",
      "delivery_manifest_v1"
    ],
    "authority": {
      "instruction": "Actions, workflow state, permissions, paths and decision branches",
      "tip": "Natural-language thinking, content and quality guidance; do not derive workflow control from tip",
      "conflict": "If tip and instruction visibly conflict, stop automatic execution and report a protocol consistency error"
    },
    "bootstrap": [
      "Read and validate this protocol declaration",
      "Discover MCP tools and their input/output schemas",
      "Collect missing identity, task path, task type, responsibilities and work directory from the user",
      "Call register",
      "Use instruction for workflow control and tip for thinking and quality guidance"
    ],
    "fields": {},
    "actions": {},
    "reason_codes": {},
    "unknown_value_policy": {
      "reread_health": true,
      "tip_control_fallback": false,
      "unresolved": "Stop automatic execution and report an incompatible protocol value"
    }
  }
}
```

`authority.tip` 必须以 English 完整声明 tip 只负责自然语言思考、内容与质量指引，并且 workflow control 不得从 tip 推导；renderer 不得在 catalog/help 值之外独立注入该语义。`authority.conflict` 必须以 English 明确 tip/instruction 可见冲突时停止自动执行并报告协议一致性错误。`fields` 必须精确解释每个 instruction 字段，尤其明确 `allowed_tools` 是当前行动的直接 MCP 工具集合而非完整 ACL，`context.can_advance` 只表示状态机门禁满足而不表示内容已经收敛，`references[].required=true` 表示本轮必须读取该输入，`required_output` 表示产物和提交要求而具体 submit 入参仍以工具 input schema 为准，`decision` 可表达参与者的收敛判断或用户是否继续等待的分支，Server 不替代相应主体作出决定。`actions` 必须覆盖全部 `InstructionAction`，为每个 action 提供稳定含义和执行过程；`reason_codes` 必须说明每个 reason code 的含义、对应 action、是否允许自动继续以及是否必须报告用户，并与 schema 的封闭枚举完全相等。Health 匿名可用，不占用 turn、不改变 workflow，不返回 workflow-specific instruction。

**语言边界**：`protocol` catalog 中所有供消费者阅读的描述字符串必须使用 English（英文），包括 `authority`、`bootstrap`、`fields`、`actions`、`reason_codes` 和 `unknown_value_policy` 内的文本；MCP initialization instructions 也必须使用 English。使用中文或其他语言输出这些协议目录或 initialization 描述属于不符合 instruction v1。`tip` 则保留为可通过模板编辑的中文自然语言思考、内容与质量指引；其中文文案可以定制，但不得改变或替代英文协议目录及结构化 workflow control。

**多工作流支持**：每个工作流（IDLE→...→SUMMARY→IDLE 完整周期）在 `<work_dir>/handoff/{workflow_id}/` 下独立归档。`workflow_id` 由 confirm_task 时生成（`yyyyMMddHHmmss` 格式），用于本地可读和按时间排序；本地双 AI 协作场景下秒级精度足够，不提供并发强唯一保证。不同项目由 work_dir 隔离，同一项目的不同任务分属不同 workflow_id 目录。

---

## 4. 数据流

### 启动与注册 + 成对绑定

register 只声明身份，不声明职责。confirm_task 声明职责，同 task_path 的两个 AI 自动成对。

```
AI-A (supervisor)                    AI-B (developer)
  │                                    │
  │  register({                        │  register({
  │    identity:"claude"               │    identity:"deepseek"
  │  })                                │  })
  ├──────────────────────────────►     ├──────────────────────────────►
  │◄── { ok, identity, token }         │◄── { ok, identity, token }
  │                                    │
  │  confirm_task({                    │  confirm_task({
  │    task_path:"/path/a.md",         │    task_path:"/path/a.md",
  │    task_type:"development",        │    task_type:"development",
  │    is_supervisor:true,             │    is_supervisor:false,
  │    is_developer:false,             │    is_developer:true,
  │    work_dir:"/project"})           │    work_dir:"/project"})
  ├──────────────────────────────►     ├──────────────────────────────►
  │◄── { 已创建工作流，等待对方 }        │◄── { 已加入，双方已就位 }
  │                                    │
  │  wait_for_turn                     │
  ├──────────────────────────────►     │
  │◄── { instruction: claim_turn }     │
  │  claim_turn({})                    │
  ├──────────────────────────────►     │
  │◄── { instruction: advance }        │
  │                                    │
  │  advance({})                       │
  ├──────────────────────────────►     │
  │◄── { new_phase:"requirements",     │
  │      turn:"deepseek" }             │
  │                                    │  wait_for_turn
  │                                    ├──────────────────────────────►
  │                                    │◄── { instruction: claim_turn }
  │                                    │  claim_turn({})
  │                                    ├──────────────────────────────►
  │                                    │◄── { 完整 requirements 指引 }
```

**身份判定**：
- HTTP header `X-AI-Identity: <token>`，token 必须来自 `register`
- 无有效 token → `"unknown"`，仅 `ping` / `who_am_i` / `register` 可用
- `register` 返回 UUID token，后续请求用 token 值放入 header
- identity 中的字母在注册边界统一转为小写；响应、session、Participant 和归档文件名均使用该 canonical lowercase identity，大小写不同的输入表示同一 identity
- 服务端维护进程内 `token → { identity, workflowId }` 映射，`parseSession` 返回 identity + workflowId + registered
- 同一 identity 可多次 register 并获得多个 token；在同一 workflow 中 identity 只对应一个 Participant，多个 token 代表同一 Participant 的不同凭据。普通重复确认是幂等操作，可将同 identity 的新 token 绑定到该 Participant，但不改写职责、work_dir 或 registered_at。已加入活跃 workflow 的 token 不得通过 `confirm_task` 改绑到不同 task；同一 identity 并行参与其他 workflow 时必须另行 register 获取新 token。workflow 结束后，进程内仍有效的 token 可由 `confirm_task` 重新绑定到新 workflow，无需重复 register；新任务仍要求双方分别调用 `confirm_task`
- token 随进程重启清空，崩溃后重新 register 获取新 token
- token 是参与者身份路由与工作流操作授权凭据，不是外部用户身份认证。PairFlow 信任同一主机上的进程，不防御恶意本地客户端；token 的边界是防止正常协作中的串身份、串 workflow 和越权调用

---

## 5. 状态机

### 5.1 State Schema

```jsonc
{
  "workflow_id": null,          // confirm_task 时生成（yyyyMMddHHmmss）
  "phase": "idle | requirements | planning | implementation | summary",
  "sub_phase": "coding | review | null", // 仅在 IMPLEMENTATION 阶段生效
  "round": 1,                   // 当前阶段内的轮次
  "turn": "idle | <identity>",  // 当前持有操作权的身份
  "turn_switched_at": null,     // 当前 turn 分配时间戳
  "turn_claimed_at": null,      // claim_turn 首次成功的领取时间戳；null 表示 assigned
  "wait_warning_cycle": null,   // 当前 roster/turn 提醒周期；两类不会同时存在
  "task": {                     // confirm_task 时写入
    "spec_file": "string",
    "task_type": "requirements | development"  // 必传；需求模式跳过 planning/implementation
  },
  "participants": [
    {
      "identity": "claude",
      "is_supervisor": true,
      "is_developer": false,
      "registered_at": "ISO8601",   // 首次加入时间；普通重复确认不改写，恢复占位确认时写入真实时间
      "work_dir": "/project"
    }
  ],
  "last_submission_by_participant": {
    "<identity>": {
      "round": 1,
      "sub_phase": "coding",
      "commit_hash": "abc1234",
      "submitted_at": "ISO8601",
      "file_path": "path/to/output.md"
    }
  },
  "delivery_manifest": "DeliveryManifest | null", // 当前已原子持久化的 draft/completed 清单缓存
}
```

### 5.2 Phase 转换

**开发模式（默认）**：
```
IDLE ──→ REQUIREMENTS ──→ PLANNING ──→ IMPLEMENTATION ──→ SUMMARY
```

**需求模式**（`task_type === "requirements"`）：
```
IDLE ──→ REQUIREMENTS ──→ SUMMARY
```
需求模式下 REQUIREMENTS advance 直接跳到 SUMMARY，跳过 PLANNING 和 IMPLEMENTATION。SUMMARY → IDLE 行为与开发模式一致。

- IDLE → REQUIREMENTS：两端 register 并分别通过 `confirm_task` 加入 workflow 后，监督者调 `advance`（参与者数 = 2 + task 已确认 → turn 切给非监督者）
- REQUIREMENTS → PLANNING：监督者调 `advance` → turn 切给评审者（`is_developer=false`）
- PLANNING → IMPLEMENTATION：监督者调 `advance` → turn 切给开发者，`sub_phase=coding`
- IMPLEMENTATION 阶段每次 `submit` 后 `sub_phase` 在 coding ↔ review 之间交替切换，turn 随之切换给另一方。coding 仅开发者可 submit，review 仅评审者可 submit
- IMPLEMENTATION → SUMMARY：监督者调 `advance` → turn 切给监督者
- SUMMARY → IDLE：监督者调 `advance` → 先原子写入 completed delivery manifest，再结束 workflow；删除该 workflow 的内存状态和 mutex，并将指向它的 token 解绑为未加入 workflow，token 本身仍可复用。成功结果必须包含 manifest_path、archive_root 和 final_summary；随后 `.pid` 清理失败只增加 cleanup warning，不撤销完成
- IDLE 是初始/终结态
- **advance 仅监督者可调**，非监督者 advance → 拒绝。`turn` 控制下一份产出由谁提交；监督者只有在当前 phase 双方均已 submit 且 `turn` 已自然回到监督者时，才能调用 `advance` 做收敛判定并推进阶段。
- 普通 workflow 仅在第二位参与者加入前的 IDLE 阶段允许已有 Participant 修正职责；双方完整就位后立即冻结 `is_supervisor` / `is_developer`，即使尚未离开 IDLE 也只能幂等确认。work_dir 从 Participant 首次确认起固定，不允许通过重复确认迁移。恢复占位 Participant 不受 phase 限制，可在首次重新确认时写入真实职责与本次 work_dir；双方恢复确认完整后同样立即冻结。职责交换需要结束并新建 workflow，不保留临时非法职责组合，也不提供原子换角接口。双方就位后始终必须恰好一个 Supervisor；development 任务还必须恰好一个 Developer，requirements 任务允许没有 Developer；任何任务都禁止重复 Supervisor 或重复 Developer。

> **is_developer 标志仅在 IMPLEMENTATION 阶段生效**：coding 时仅 developer 可 submit，review 时仅非 developer 可 submit。REQUIREMENTS、PLANNING、SUMMARY 阶段的产出/审阅流程由 `turn` 分配驱动，与 is_developer 标志无关。需求模式（`task_type=requirements`）下 is_developer 标志无实际作用，因此允许双方均为 `false`。

### 5.3 Turn 切换

- submit 后 `round += 1`，turn 切给对方。即使当前 phase 双方都已 submit，`turn` 仍表示下一份产出的行动权；若 `turn` 尚未回到监督者，监督者不能 `advance`
- IDLE 中第二位参与者确认、双方完整就位后，turn 从 `idle` 切给监督者；advance 到新 phase 后 `round = 1` 并按 phase 初始化 turn；submit 成功后把 turn 切给对方。三条路径都统一写入 `turn_switched_at = now`、`turn_claimed_at = null`，即使 turn 属于当前调用者本人也不得同步 claim
- `wait_for_turn` 检测到调用方持有 assigned turn 时立即返回 `claim_turn / TURN_ASSIGNED` instruction，但不修改 `turn_claimed_at`，也不返回本轮产出和 submit 指引
- `claim_turn` 是唯一领取入口。它在 workflow mutex 内重新校验身份和当前 turn；首次成功写入 `turn_claimed_at = now` 并返回完整行动指引。同一 turn 再次调用幂等返回相同指引，不改写首次时间；turn 已切换或属于对方时拒绝
- claim 的线性化点是 mutex 内写入 `turn_claimed_at`。此前观察到取消则不改状态；此后才发生的取消可以使调用方收不到响应，但不得回滚 claim。claim 不转移 turn、不推进 round、不改变 phase/sub_phase
- 当前持有者已经 claimed 后再次调用 `wait_for_turn`，可直接返回其当前完整行动指引；响应丢失时也可以安全地幂等重试 `claim_turn`

### 5.4 Waiter、事件与提醒周期

PairFlow 按 workflow 维护进程内变化版本和 waiter 集合。普通事件只表示“workflow 状态可能变化”，waiter 每次被唤醒后重新读取 Server state；但终止事件必须在释放协调器前捕获 completed manifest 快照，使最后一个 SUMMARY waiter 也能返回同一 manifest_path、archive_root 与 final_summary。状态变更、归档写入或终止操作失败时不得发布成功事件。

`wait_for_turn` 每次循环先在 mutex 内判断真实状态；不能立即返回时记录当前变化版本、登记 waiter，并在登记后再次比较版本。版本已变化则立即重新判断，避免状态检查与登记之间的漏唤醒窗口。随后等待 workflow 事件、当前提醒 deadline、单次请求 600 秒上限或取消/latest-wins 中最早发生者。不再使用固定 10 秒轮询。

同一 workflow + identity 同时只保留最新一次等待；新调用取消旧调用。成功行动、claim 指令、warning、超时、取消、拒绝和 workflow 终止都必须释放 waiter、deadline timer 和 abort listener。workflow live state 删除时先唤醒相关 waiter，事件协调器在 waiter 全部释放后删除。没有 waiter 时不运行提醒 timer；参与者稍后调用时直接按当前时间判断 deadline。

roster 未完整和 turn 未领取不会同时成立，因此 state 最多保留一个提醒周期：

```ts
interface WaitWarningCycle {
  kind: "roster" | "turn";
  generation: number;
  next_report_at: string;
  reported_at: string | null;
  reported_to: string | null;
}
```

- 普通 roster 周期从首位真实参与者的 `registered_at` 开始；普通 turn 周期从 `turn_switched_at` 开始。`now >= next_report_at` 即达到 30 分钟边界
- 到期后只向当前等待身份报告一次，并写入 `reported_at` 与 `reported_to`。warning 返回 `report_user`，由结构化 `decision` 要求用户选择继续等待或停止
- 用户选择继续后，同一 `reported_to` 身份下一次调用无参 `wait_for_turn` 即确认当前已报告周期。确认在 mutex 内线性化：若进入 mutex 前已取消则不改周期；成功后清空已报告标记并设置 `next_report_at = now + 30min`，后续取消不回滚
- warning 已报告但尚未确认时，不得再次返回同一 generation 的相同 warning。若没有后续 `wait_for_turn`，不启动新周期
- roster 完整、claim、新 turn、阶段推进或 workflow 终止时清除或替换旧 generation；旧周期状态不得抑制新周期
- 首位恢复参与者重新确认后，roster 周期从本次真实确认时间开始；双方恢复确认完整后，当前 recovered turn 保持 assigned，但 turn 周期从 roster 恢复就绪时间重新获得完整 30 分钟窗口，不持久化或恢复旧 warning/ack

至少在 roster 就绪或恢复条件变化、submit 切换 turn、advance 初始化 turn、claim 成功、warning 确认和 workflow 终止成功后发布变化事件。提醒 deadline 由请求内 timer 直接唤醒 waiter，不需要发布独立业务事件。重复、提前、合并或无关事件只会触发状态复查；状态变化时没有 waiter 不会丢失行动权，后续调用按 live state 恢复。

## 6. 收敛

监督者手动判定。各阶段交替审阅后，监督者确认阶段目标已达成（无未决议题、不能有双方同意延后的内容），调用 `advance` 推进。**advance 前双方至少各有一次 submit，且 turn 必须已自然回到监督者**，确保双方都有产出和审阅机会，并避免非监督者仍持有行动权时被并行推进。该判定仅针对当前 phase；每次 advance 初始化新 phase 时都会清空 `last_submission_by_participant`。

## 7. Issue 系统

PairFlow 不维护独立的 issue 跟踪系统。双方在产出文档中通过标注管理观点差异，监督者在 advance 前检查争议是否已解决。

## 8. 异常处理

**等待、领取与对方掉线**：每次 `confirm_task` 成功后，AI 的下一步统一调用 `wait_for_turn`。若 roster 尚未完整，本次请求按 §5.4 等待事件、提醒 deadline、600 秒请求上限或取消；roster 完整后继续同步 turn。turn 分配给调用方时，`wait_for_turn` 只返回 `claim_turn / TURN_ASSIGNED`，由调用方再调用无参 `claim_turn` 领取并取得完整行动指引。600 秒只是单次请求上限，正常超时返回 `WAIT_TIMEOUT` 并允许继续调用；它不重置 workflow、turn 或提醒计时。等待期间最后观察到 SUMMARY，随后 workflow 被终止 advance 删除时，返回 `{ turn:"idle", phase:"idle", manifest_path, archive_root, final_summary }`；其他 phase 的 state 异常消失仍返回 `workflow not found`。两类 30 分钟 warning、用户继续后的无参重入确认、latest-wins、取消线性化和资源清理均以 §5.3–§5.4 为准。

**崩溃恢复**：每次启动全新开始（状态全内存）。崩溃恢复由用户主动触发——`confirm_task` 发现任务文档已有 `.pid` 普通文件时读取 workflow_id。它先读取 delivery manifest：`completed` 时只删除 stale PID（ENOENT 成功；其他错误拒绝并同时报告 manifest path 与错误码），然后在同一 confirm_task 调用中创建新 workflow，绝不重建 SUMMARY。`in_progress` manifest 的已接受 records 是 phase 边界权威：requirements 后进入 planning（requirements task 则 summary）、planning 后进入 implementation、implementation 后进入 summary；下个 phase 无 submission 时恢复 round=1、空 last_submission 并在双方角色确认后按 phase 分配 assigned turn。否则再从本次入参指定的 `<work_dir>/handoff/` 中符合 meta 生成契约的记录恢复到最后一次成功 submission 后的状态（phase、round、参与者身份、last_submission_by_participant）；handoff 根、workflow 和 phase 目录不得包含符号链接，只扫描各 phase 目录的直属普通 meta，嵌套文件和 meta 链接不参与恢复，损坏或字段不完整的 meta 被忽略，等同于对应 round 缺失。恢复后的 `turn_switched_at` 取当前 phase 最高 round submission 的 submitted_at，`turn_claimed_at` 为 null；双方身份确认齐全后，turn 指向该最高 round 提交者的对方。warning/ack 不写入归档也不恢复：首位真实参与者重新确认后，roster 周期从本次确认时间开始；双方真实身份恢复完整后，当前 turn 保持 assigned，并从 roster 恢复就绪时间建立新的 30 分钟 turn 周期。work_dir 和 task.spec_file 始终分别以本次 `confirm_task` 的 work_dir、task_path 入参为准；归档 meta 中的 spec_file 只作为历史记录，不参与当前路由；过滤后的有效记录中，task_type 必须一致，requirements 任务中的 planning/implementation 记录无效。`.pid` 只保存 workflow_id，不保存或约束旧 work_dir；其内容格式非法或该 work_dir 下不存在所指归档时，均视为用户要创建新任务，创建新 workflow 并覆盖 `.pid`。恢复只接受文件名中符合 identity 规则（小写字母、数字、下划线、连字符）的 canonical lowercase 记录；含大写字母或其他非法 identity 的文件名直接忽略，不兼容旧格式，过滤后合法 identity 超过两个则归档不可恢复；每个 phase 内有效 round 必须唯一且身份须符合奇偶轮交替，但允许历史 round 缺失，恢复后的 round 为当前 phase 现存最大 round + 1；IMPLEMENTATION 有效文件名必须包含 sub_phase，且奇数 round 为 coding、偶数 round 为 review。`.pid` 原子写入；过滤后无有效记录，或有效记录之间出现结构冲突时，归档不足以恢复，`confirm_task` 创建新 workflow 并覆盖 `.pid`，旧归档保持不变；`.pid` 或归档路径存在但类型错误、包含链接或无法读取时则拒绝恢复，并在 tip 中说明路径和文件系统错误，不覆盖 `.pid`；`.pid` 指向的 workflow_id 若已被另一活跃任务占用，同样拒绝，绝不覆盖活跃内存状态。summary 目录或 summary 文件存在不代表 workflow 已完成。参与者的职责（is_supervisor/is_developer）以恢复占位 Participant 首次重新确认时的 `confirm_task` 入参为准，不从归档推断；恢复占位参与者允许临时职责不完整，待双方都重新确认后必须重新满足职责组合规则。恢复仅识别出一个 identity 时，该身份确认后仍须等待第二位参与者加入；双方未完整就位前 `advance` / `submit` 仍拒绝执行，`wait_for_turn` 则保持等待直到 roster 完整，`get_state` 返回相同等待指引。恢复不自动扫描——`confirm_task` 是唯一恢复入口。

不同 task_path 并发读取到同一 `.pid` workflow_id 时，恢复占用按 workflow_id 串行判定；只有首个任务可以重建该 workflow，后续任务发现其已被其他 task 占用后拒绝，不得覆盖内存 state。

**未捕获异常**：任一 `uncaughtException` 都记录错误并以退出码 1 结束进程，不在不安全状态中原地恢复。PairFlow 不跨进程持久化 crash 计数，也不自行重启；重启、退避和 crash-loop 熔断由外部进程管理器负责。

---

## 9. MCP 工具清单

| 工具 | 入参 | 出参 | 说明 |
|---|---|---|---|
| `ping` | 无 | `{ ok, uptime }` | 连通性检查。匿名可用 |
| `who_am_i` | 无 | 匿名：`{ identity, registered, joined_workflow }`；已注册：`{ identity, registered, joined_workflow, is_supervisor, is_developer, workflow_id }` | 身份确认 + 注册/工作流加入状态。`registered` 表示 token 有效，`joined_workflow` 表示已通过 `confirm_task` 加入工作流；已注册但未加入 workflow 时职责字段均为 `false`，`workflow_id` 为 `null`。匿名可用（identity="unknown"） |
| `register` | `{ identity: string }` | `{ ok, identity, token }` | 注册身份。identity 从 body 取，长度 1–64，仅允许字母、数字、下划线和连字符，字母统一转为小写后写入响应与 session；`unknown`、`idle` 为大小写不敏感的保留字。不声明职责、不绑定 workflow phase（职责移至 confirm_task）。返回 UUID `token`。`identity` 缺失由 MCP schema 拒绝；identity 内容非法时返回 curl 格式参考。`tip` 详细列出 confirm_task 的 5 个入参（task_path/task_type/is_supervisor/is_developer/work_dir）及含义 |
| `confirm_task` | `{ task_path, task_type, is_supervisor, is_developer, work_dir }` | `{ task_path, workflow_id, phase, recovered }` | 确认任务文档并声明职责。五个入参均为必填，并在 handler 边界再次校验类型；从卷根到 `work_dir` 的完整路径不得含链接，work_dir 必须为真实目录；`.git` 必须是非链接的真实目录或普通文件；`task_path` 必须位于 work_dir 下，且从 work_dir 到 task 普通文件的每一级均不得是链接。二者都必须是绝对路径且不得包含 `.` 或 `..` 路径段。规范化路径比较遵循宿主操作系统的大小写规则（Windows 不区分大小写，其他平台区分）。两个 AI 使用相同 task_path 自动成对，最多双方加入；固定按 token → task_path → workflow 加锁，校验职责组合和 work_dir 一致性。已加入活跃 workflow 的 token 只能幂等确认同一 task，不得改绑到不同 task。`task_type` 由首次确认固定，后续每次确认都必须显式传入相同值，冲突时拒绝。普通 Participant 仅在第二位加入前的 IDLE 可修正职责，双方就位后立即冻结；work_dir 首次确认后始终固定；恢复占位 Participant 首次重新确认时可覆盖推断职责和 work_dir。普通幂等确认保留 registered_at，并可绑定同 identity 的新 token。职责组合规则：任何时候 supervisor/developer 都不能重复；两人真实就位后必须恰好一个 Supervisor，development 任务还必须恰好一个 Developer，requirements 任务允许没有 Developer；两种职责可由同一参与者兼任。`recovered=true` 仅表示本次调用从归档重建了 workflow 或确认了恢复占位 Participant。任何成功响应的 tip 都统一要求下一步调用 `wait_for_turn`；该工具会先等待 roster 完整，再等待 turn。`.pid` 必须是普通文件且不得是链接；文件系统拒绝会在 tip 中返回目标路径和错误码。后续所有工具通过 token 路由到对应 workflow |
| `advance` | 无 | 非终态：`{ ok, new_phase, turn, sub_phase? }`；完成：另含 `{ manifest_path, archive_root, final_summary, cleanup_pending?, cleanup_error? }` | 推进到下一阶段。仅监督者可用，且必须已有两位真实参与者完整就位。当前 phase 尚未形成双方提交时拒绝；当前 phase 双方均已 submit 但 `turn` 尚未回到监督者时也拒绝，由当前 turn 持有者继续产出或确认后自然交还 turn。只有 `turn === identity`（IDLE 阶段允许 `turn === "idle"`）时，监督者才能 `advance`。各 phase 转换规则同上。**需求模式**（`task_type === "requirements"`）下 REQUIREMENTS 直接跳到 SUMMARY，跳过 PLANNING/IMPLEMENTATION。SUMMARY→IDLE 前仍要求双方至少各有一次 summary submit 且 turn 回到监督者；先原子写 completed manifest、发布终止和解绑/删除 live state，再删除 `.pid`；`.pid` 不存在视为已删除，其他删除错误只返回 cleanup warning。`tip` 使用 `[行动]`/`[产出]`/`[当前]` 三层格式，turn 归属用自然语言（`turnIsSelf` 判断，不再硬编码"对方"），IDLE 结束包含归档位置和重新开始指引 |
| `wait_for_turn` | 无 | 等待中：`{ turn, phase, round, warning? }`；终止：`{ turn:"idle", phase:"idle", manifest_path, archive_root, final_summary }` | `confirm_task` 成功后即可调用。它使用进程内 workflow 变化事件等待 roster、turn、提醒 deadline 或 workflow 终止，不再固定轮询。调用方持有 assigned turn 时立即返回 `claim_turn / TURN_ASSIGNED`，但不写 `turn_claimed_at`、不返回本轮产出指引；已 claimed 的当前持有者可返回完整当前行动。600 秒为单次请求上限，正常超时后允许继续调用且不重置状态或提醒周期。同一 workflow + identity 采用 latest-wins。roster 未完整或 turn 未领取满 30 分钟时，当前 generation 只返回一次 warning；用户选择继续后，同一身份下一次无参调用确认当前 warning 并从该调用时间重启 30 分钟周期。成功、warning、取消、拒绝、超时和终止都释放 waiter、timer 与 listener |
| `claim_turn` | 无 | `{ turn, phase, round }` | 仅当前 turn 持有者可用，是 assigned → claimed 的唯一入口。首次成功在 workflow mutex 内写入 `turn_claimed_at` 并返回本轮完整行动指引；同一 turn 重试幂等返回且不改写首次 claim 时间。turn 已切换或属于对方时拒绝。取消发生在线性化点前不 claim，之后不回滚。claim 成功后发布 workflow 变化事件，但不转移 turn、不推进 round、不改变 phase/sub_phase |
| `get_state` | 无 | 活跃 workflow：`{ workflow_id, phase, sub_phase, round, turn, tip }`；未绑定：`{ tip }` | 需要有效注册 token。返回结构化 workflow 状态和当前执行指引，可用于判定无响应的 `advance` 是否已经推进。当前调用方持有 assigned turn 时，instruction 返回 `claim_turn / TURN_ASSIGNED`，不得直接返回产出、submit 或 advance 指引；claim 后才返回完整当前行动。`tip` 使用 `[行动]`/`[产出]`/`[当前]` 分层自然语言格式；若 workflow 存在恢复占位身份或尚不足两位参与者，结构化状态仍返回，tip 提示调用 `wait_for_turn` 自动等待确认完成；若当前 token 未加入活跃 workflow（例如旧 workflow 已结束并清空 participants），只提示重新 `confirm_task` |
| `submit` | `{ file_path, git_commit_hash }` | `{ ok, next_turn }` | 仅在两位真实参与者完整就位后提交当前 turn 的产出，handler 再次校验两个入参均为字符串。`file_path` 必须是当前 workflow/phase/round/identity 对应的绝对路径，不得含 `.` / `..`，且必须是非零字节的直属普通 handoff 文件；PairFlow 不读取或评价文件内容。使用 `lstat` 检查从 `<work_dir>/handoff` 到产出文件的每一级路径，任一级为符号链接均拒绝。`git_commit_hash` 必须是 7–40 位十六进制，统一转为小写；若与当前 phase 最高 round hash 相同或二者互为长短前缀，则视为未产生新工作。PairFlow 不执行 Git 命令，无法验证 hash 是否存在或判断无前缀关系的两个 hash 是否指向同一 commit，真实性由调用方负责。IMPLEMENTATION 仅接受 coding/review 子阶段，并按职责限制提交。成功时以同一时间戳更新 last_submission、turn 和原子生成的 `.meta.json`，随后 round+1、切换 turn/sub_phase；meta 写失败则返回路径和错误码，内存状态完全不变。若响应丢失，只有当同一参与者最新 submission 的 file/hash 与重试完全一致、当前仍为紧随其后的 round 且 turn 已交给对方时，原样重试才幂等返回成功，不重写 meta 或再次推进。`tip` 中身份标签复用 `tip.ts` 的 `identityLabel()` |

所有注册工具都必须通过 `tools/list` 同时公开 input schema 和逐工具 output schema。逐工具 output schema 必须同时覆盖成功的 structured payload 和 handler 级业务拒绝，因为两类响应都包含 `structuredContent`；`ok` 是业务 envelope 的判别字段。`ok=true` 分支必须包含该工具完整且精确的成功业务字段；`ok=false` 分支必须包含 `error`、`tip` 以及 `next_action="fix_request"` / `reason_code="REQUEST_REJECTED"` 的完整 `instruction`，且不得混入成功分支专属业务字段。

当前 MCP SDK 无法把带对象级 refinement 的扁平 discriminated union 直接转换成顶层 `type: "object"` 的公开 JSON Schema。因此 `tools/list` 的 branch-specific 字段允许表现为条件性/可选投影，以保证 SDK Client 能接受两个 structured payload 分支；Server 端保留对象级 Zod refinement，并按 `ok` 对选中分支执行严格验证，公开 schema 的互操作性不得削弱运行时业务契约。`register`、`confirm_task`、`advance`、`get_state`、`wait_for_turn`、`claim_turn`、`submit` 的成功与业务拒绝均包含 `tip`、`reminder` 和 `instruction`；`ping` 和无行动的正常 `who_am_i` 保持 success-only 且不包含 `instruction`。handler 执行前发生的 MCP input/protocol 错误和 HTTP 层错误不进入该业务 envelope，也不套用 `instruction`。

---

## 10. 响应与 Tip 格式规范

所有进入 handler 的工具成功与业务拒绝响应都必须包含 `reminder: "质量优先，完整完成任务目标。"`。`reminder` 表达跨阶段恒定的质量原则；`tip` 表达当前状态下的具体行动，两者不可互相替代。统一响应封装不得修改调用方传入的数据对象，业务数据或错误扩展也不得覆盖 `ok`、`error`、`tip`、`reminder` 等固定契约字段。MCP 协议错误和 inputSchema 校验错误发生在 handler 之前，由 SDK 原生返回明确的协议或字段级原因，不套用 PairFlow 的 `tip`/`reminder` 业务响应格式。

每个工具响应只构造一次业务 `payload`，然后以结构化通道和兼容文本通道同时返回：

```ts
{
  structuredContent: payload,
  content: [{ type: "text", text: JSON.stringify(payload) }]
}
```

新客户端优先读取 `structuredContent`，旧客户端可继续读取 `content.text`；`JSON.parse(content[0].text)` 必须与 `structuredContent` 深度相等。业务拒绝同样返回两个通道，并携带 `fix_request` / `REQUEST_REJECTED` instruction；现有工具入参和 payload 字段不得删除或重命名。响应构造器删除 `ok(data, stringTip)` 遗留重载：非行动响应只能使用 `ok(data)`，可行动响应只能使用 `ok(data, guidance)`，从类型层保证不会重新出现只有 tip、没有 instruction 的业务响应。

以上双通道存在于 JSON-RPC result 内部，不等同于 HTTP 流式传输。`/mcp` 的所有 POST 使用 SDK JSON response mode，一次请求只在业务结果就绪后返回一个 `application/json` JSON-RPC envelope；`content.text` 只是兼容字段，不得通过 SSE `data:` 包装发送。raw HTTP 客户端可以直接解析 JSON，标准 Streamable HTTP Client 也必须保持兼容。

MCP initialization instructions 必须以 English（英文）提供 health 协议规则的简明文本投影：instruction 负责工作流控制，tip 负责思考、内容与质量，未知字段或值先重读 health，仍不理解则安全停止。该投影与 health 的语义都来自同一实现 catalog。可编辑的 `tip` 继续使用中文自然语言，两者不得混用语言职责。

所有带 `tip` 的响应使用统一的 `[行动]/[产出]/[当前]` 分层词汇，但不强制补齐无意义的段落。`ping`、`who_am_i` 等没有后续行动的成功响应可以不返回 `tip`。

handler 产生的业务拒绝响应（`ok=false`）必须返回 `tip`，且 `tip` 要明确说明被拒绝的原因，格式为 `[行动] 请求被拒绝：<原因>`。调用方应优先把该原因报告给用户或据此修正参数。

响应结果不确定时按工具语义处理：`ping` / `who_am_i` / `get_state` 可直接重试；`confirm_task` 幂等重试；`wait_for_turn` 重试采用 latest-wins，但 warning 后的下一次同身份调用同时表示用户已选择继续，客户端不得在 `report_user` 后自动重试；`claim_turn` 对同一 turn 幂等重试且不得重置首次 claim 时间；`submit` 仅支持上述紧邻状态下的 exact replay；`register` 可重试并使用新返回的 token，旧 token 留待进程重启清理；`advance` 无入参且无法区分丢失响应与新的推进意图，不得盲重试，必须先调用 `get_state` 判断当前 phase。

### 10.1 三层结构

```
[行动] <必需：行动指令，可包含检查清单及输入/参考路径>
[产出] <可选：预期或已完成的产物及其路径；本人持有 turn 时包含 submit 流程>
[当前] <可选：身份和工作流上下文>
```

- **`[行动]`**：所有 `tip` 必需。描述当前该做什么，可包含完成任务所需的检查清单、输入/参考文件路径及其 commit 来源；不得包含本轮产出路径、`submit` 指令或身份、阶段、轮次、turn 等上下文状态
- **`[产出]`**：存在明确产物时才返回，描述预期产物、已提交产物或已完成工作流的归档位置，路径统一使用 POSIX 正斜杠。调用方本人持有 turn 时包含 `完成后 git commit，调用 submit，file_path = <绝对路径>`；下一 turn 属于对方时只说明 `<identity> 将产出到 <绝对路径>`，不指示调用方 submit；非 turn 持有者的 wait_for_turn/get_state 指引不返回 `[产出]`
- **`[当前]`**：存在身份或工作流上下文时才返回。用自然语言描述你是谁、第几轮、什么阶段、轮到谁；**不用管道符分隔**，用完整句子
- 各段固定按 `[行动]`、`[产出]`、`[当前]` 排列，段之间空一行；由 `formatTip()` 统一组装并省略未提供的可选段
- 只有当当前 phase 双方均已 submit 且 `turn` 已回到监督者时，`tip` 才提示监督者可调用 `advance`；否则即使监督者持有 turn，也提示其继续产出/审阅并 `submit`

### 10.2 阶段名映射

| phase | sub_phase | `[当前]` 中的阶段名 |
|-------|-----------|------------------|
| requirements | — | 需求分析 |
| planning | — | 实施计划 |
| implementation | coding | 代码实现 |
| implementation | review | 代码评审 |
| summary | — | 汇总 |

### 10.3 `buildTip()` 实现

`tip-format.ts` 导出 `formatTip({ action, product?, current? })`，供所有 tip 生成入口复用并统一段落顺序。`tip.ts` 导出 `buildTip(state, identity)`，被 `claim_turn`、已 claimed 场景的 `wait_for_turn` 和 `get_state` 复用；内部拆分为三个辅助函数：

- `getAction(state, identity)` — 生成 `[行动]` 内容，按 phase/round 分支
- `outFile(state, identity)` — 生成产出文件绝对路径
- `phaseLabel(phase, subPhase)` — phase + sub_phase → 中文阶段名

`identityLabel(state, identity)` 同时导出供 `submit` 复用职责标签，避免 submit.ts 与 tip.ts 维护两套职责推断逻辑。

### 10.4 路径统一

所有 tip 和返回值中的路径统一使用 POSIX 正斜杠（`.replace(/\\/g, "/")`），避免 Windows 反斜杠在 JSON 响应中被转义为 `\\` 导致 AI 解析混乱。

### 10.5 结构化行动协议（Instruction）

自 v1 起，MCP 业务 payload 支持 `instruction` 字段；任何带 `tip` 的业务响应都必须包含 `instruction`，无行动的正常响应则不伪造空 instruction。`instruction` 与 `tip` 必须由同一个场景选择结果生成，禁止分别判定或从已渲染的 `tip` 反向解析。

#### 10.5.1 权威边界

Instruction is authoritative for actions, direct action tools, reliable workflow context,
permissions, paths, required artifacts, references, and legal decision branches.
Tip is natural-language thinking, content, and quality guidance. An AI consumes both,
but must not derive workflow control from tip. If the two visibly conflict, stop automatic
execution and report a protocol consistency error.

PairFlow 状态机是唯一状态权威。MCP input schema 是具体工具调用参数的结构权威；逐工具 MCP output schema 是返回结构的机器契约；`GET /health` 是运行中 Server 的协议版本、capabilities、字段和枚举语义的发现权威。不支持 `instruction` 的旧客户端可以继续消费兼容文本结果，但符合 v1 的消费者不得从 `tip` 推导工具、权限、状态、路径或行动分支。

**零背景消费者的信息边界**：零背景 AI 未安装 PairFlow Skill，未读取 PairFlow 源码、仓库文档、设计文档或历史对话；它只能使用运行中 Server 的 `/health`、MCP initialization information、`tools/list` 返回的工具 input/output schema 和工具调用结果。identity、task path、task type、responsibilities 和 work directory 来自用户；任一缺失时必须询问用户，不得猜测关键路径、身份或职责。`confirm_task.task_type` 是 schema 与 handler 共同强制的必填字段：全新 workflow 必须传入用户选择的值，确认已有 workflow 时也必须显式传入其已固定的相同值；Server 不提供默认或省略继承语义。隐藏 tip 后，零背景 AI 仍必须能由运行时协议发现信息确定动作、直接工具、参数来源、必要引用、必需产物和合法分支。

#### 10.5.2 Schema-first 单一实现 catalog

`docs/design.md` 是 instruction 协议的唯一设计权威。代码内部必须把 Instruction 对象结构、字段描述、封闭枚举、协议版本和消费目录集中在一个实现 catalog；TypeScript types、MCP output schemas、health catalogs、initialization instructions、and enum tests derive from one implementation catalog. TypeScript 类型从 schema 推导，不得另行手写一套可漂移的接口；health 与 initialization 可以采用不同表示形式，但语义不得独立维护。MCP initialization 文本必须由纯 renderer 读取当前 protocol catalog 与 `PROTOCOL_HELP` 生成；renderer 可以持有固定句法，但 instruction/tip authority、conflict、unknown-value policy 和 health help 的语义值不得在 renderer 或常量中重复硬编码。

#### 10.5.3 TypeScript 契约

```ts
type InstructionAction =
  | "confirm_task"
  | "wait_for_turn"
  | "claim_turn"
  | "produce_and_submit"
  | "decide_convergence"
  | "advance"
  | "report_user"
  | "fix_request"
  | "stop";

type PairFlowTool =
  | "confirm_task"
  | "wait_for_turn"
  | "claim_turn"
  | "submit"
  | "advance"
  | "get_state";

type InstructionReasonCode =
  | "REGISTERED_NEEDS_CONFIRMATION"        // register 成功，需 confirm_task
  | "WORKFLOW_UNBOUND"                     // token 未绑定 workflow
  | "ROSTER_INCOMPLETE"                    // 等待第二位参与者加入
  | "CONFIRMED_NEEDS_TURN_CLAIM"           // confirm_task 成功，需首次 wait_for_turn
  | "WAITING_FOR_TURN"                     // turn 在对方，等待轮换
  | "TURN_ASSIGNED"                        // turn 已分配给调用方，需 claim_turn
  | "TURN_READY"                           // 持有 turn，可以产出
  | "PHASE_READY_FOR_CONVERGENCE_DECISION" // 双方已提交，Supervisor 做收敛决策
  | "WAIT_TIMEOUT"                        // 单次 wait 600s 超时
  | "PARTICIPANT_CONFIRMATION_STALE"      // 对方 >=30min 未 confirm_task
  | "TURN_UNCLAIMED_STALE"                // 对方 >=30min 未领取 turn
  | "SUBMISSION_ACCEPTED"                 // submit 成功，turn 已切换
  | "PHASE_ADVANCED"                      // advance 成功，进入新 phase
  | "WORKFLOW_COMPLETED"                  // workflow 正常结束
  | "UNSUPPORTED_WORKFLOW_STATE"          // 未知状态（安全失败）
  | "REQUEST_REJECTED";                   // 业务请求被拒绝

type ReferenceKind =
  | "task" | "requirements" | "plan"
  | "previous_output" | "previous_review" | "archive";

interface ProtocolHelp {
  method: "GET";
  path: "/health";
  section: "protocol";
  purpose: "Re-read the instruction protocol when any field or value is unclear";
}

type InstructionDecision =
  | {
      criterion: "phase_goal_met";
      when_true: "advance";
      when_false: "produce_and_submit";
    }
  | {
      criterion: "user_wants_to_continue_waiting";
      when_true: "wait_for_turn";
      when_false: "stop";
    };

interface PairFlowInstruction {
  protocol_version: "1.1";
  protocol_help: ProtocolHelp;
  next_action: InstructionAction;
  allowed_tools: PairFlowTool[];
  reason_code: InstructionReasonCode;
  context?: InstructionContext;
  required_output?: RequiredOutput;
  references?: InstructionReference[];
  decision?: InstructionDecision;
}
```

`protocol_version` 和 `protocol_help` 是每个 instruction 的必填字段，覆盖成功、业务拒绝、timeout、warning 和 workflow completed。`protocol_help` 不加入 `allowed_tools`，因为 `/health` 是随时匿名可读的 HTTP 协议帮助入口，不是 MCP workflow action tool。当前协议版本为 `1.1`，它在 1.x 内以加法方式引入 `claim_turn`、`TURN_ASSIGNED` 和 warning 用户决策分支；未知新增枚举的旧消费者仍按 health 未知值策略安全停止。该版本与 health 的 `protocol.version` 必须来自同一常量并完全一致。

#### 10.5.4 字段条件性

| 字段 | 出现条件 |
|------|---------|
| `protocol_version` | 每个 `instruction` 必填，固定为 `"1.1"` |
| `protocol_help` | 每个 `instruction` 必填，固定指向 `GET /health` 的 `protocol` section |
| `required_output` | 仅 `produce_and_submit` 或 `decide_convergence`（未收敛分支）。`file_path` 必须来自 `outFile()` / `expectedSubmissionPath` |
| `references` | 由当前状态和已提交记录生成；不存在的引用不返回空占位。`required: true` 表示本轮不可跳过 |
| `decision` | `decide_convergence` 时使用 `phase_goal_met`；两类 stale warning 的 `report_user` 使用 `user_wants_to_continue_waiting` |
| `context.sub_phase` | 仅 `phase === "implementation"` |
| `context.workflow_id` | 仅当已绑定 workflow |
| `context.can_advance` | idle Supervisor 或收敛场景中为 `true`，其他为 `false` |

以上条件由实现 catalog 所属的 Zod schema 在 Server 运行时统一校验，而不只由测试辅助函数断言。`context` 一旦存在，必须是可依赖的绑定 workflow 快照（包含 workflow_id、round、turn、holds_turn、can_advance，并在状态受支持时包含 phase）；`claim_turn`、`produce_and_submit`、`decide_convergence` 和 `advance` 表示调用方持有 turn，其中 `claim_turn` 专用于尚未领取的当前 turn。引用和产出路径必须使用 POSIX 正斜杠，引用 commit 必须为小写。公开 `tools/list` 仍使用 §9 规定的成功/拒绝互操作投影，运行时严格性不得通过改变该公开投影实现。

当 live state 含有当前协议不支持的 phase，或 implementation 含有不支持的 sub_phase 时，Server 必须返回 `report_user / UNSUPPORTED_WORKFLOW_STATE`，不得把未知值强制转换成封闭枚举，也不得触发 MCP output validation error。此时 instruction `context` 保留可靠的 workflow_id、round、turn、holds_turn、can_advance，省略不可靠的 phase/sub_phase；`get_state` 与 `wait_for_turn` 的顶层成功 payload 同样省略这两个未知字段。正常受支持状态保持既有 get_state 顶层兼容契约：非 implementation 返回 `sub_phase:null`，implementation 返回受支持的具体 sub_phase；instruction context 仍只在 implementation 包含 sub_phase。为此 `wait_for_turn` 的公开成功投影允许 phase 在该安全失败场景缺省，正常场景仍返回 phase。

#### 10.5.5 关键行为映射

| 场景 | next_action | allowed_tools | reason_code |
|------|-------------|---------------|-------------|
| register 成功 | `confirm_task` | `["confirm_task"]` | `REGISTERED_NEEDS_CONFIRMATION` |
| confirm_task 成功 | `wait_for_turn` | `["wait_for_turn"]` | `CONFIRMED_NEEDS_TURN_CLAIM` 或 `ROSTER_INCOMPLETE` |
| 调用方持有 assigned turn | `claim_turn` | `["claim_turn"]` | `TURN_ASSIGNED` |
| claimed idle Supervisor（roster 完整） | `advance` | `["advance"]` | `TURN_READY` |
| idle 非 Supervisor | `wait_for_turn` | `["wait_for_turn"]` | `WAITING_FOR_TURN` |
| claimed turn 持有者产出 | `produce_and_submit` | `["submit"]` | `TURN_READY` |
| claimed Supervisor 收敛 | `decide_convergence` | `["advance", "submit"]` | `PHASE_READY_FOR_CONVERGENCE_DECISION` |
| 非最终 advance | `wait_for_turn` | `["wait_for_turn"]` | `PHASE_ADVANCED` |
| 最终 advance（summary→idle） | `stop` | `[]` | `WORKFLOW_COMPLETED` |
| submit 成功 | `wait_for_turn` | `["wait_for_turn"]` | `SUBMISSION_ACCEPTED` |
| 等待对方 turn | `wait_for_turn` | `["wait_for_turn"]` | `WAITING_FOR_TURN` |
| 600s 超时 | `wait_for_turn` | `["wait_for_turn"]` | `WAIT_TIMEOUT` |
| roster/turn stale | `report_user` | `[]` | `PARTICIPANT_CONFIRMATION_STALE` / `TURN_UNCLAIMED_STALE`，并携带 `user_wants_to_continue_waiting` decision |
| 业务拒绝 | `fix_request` | `[]` | `REQUEST_REJECTED` |
| workflow 结束 | `stop` | `[]` | `WORKFLOW_COMPLETED` |

Catalog 中 `wait_for_turn` action 的含义是“同步 roster、turn、提醒和 workflow 终止，并取得当前下一步 instruction”。调用方持有 assigned turn 时调用会立即返回 `claim_turn` instruction，但不自动 claim；调用方已 claimed 时可返回当前完整行动 instruction。`PHASE_ADVANCED` 始终先选择 `wait_for_turn`，包括 advance 后新 phase 的 turn 仍属于调用方的情况；不得因为 `context.holds_turn === true` 而跳过同步和领取步骤。Catalog 中 `claim_turn` action 的过程是调用无参 `claim_turn`，以 Server 返回的完整 instruction 为后续行动权威。

stale warning 的 `report_user` 不是自动继续动作，`allowed_tools` 仍为空；其 `decision` 明确要求用户判断是否继续等待。只有用户选择继续时才执行 `when_true = wait_for_turn`，该无参调用同时确认当前已向同一身份报告的 warning 周期；客户端不得因工具超时策略自动走该分支。用户选择停止时执行 `when_false = stop`。

#### 10.5.6 保护与兼容规则

1. `instruction` 不可被 `ok(data)` 或 `err(extra)` 的业务字段覆盖——与 `ok`/`error`/`tip`/`reminder` 同等级保护。
2. 没有 `tip` 的响应不包含 `instruction`（`ping`、正常无行动的 `who_am_i`）。
3. `instruction` 禁止包含 `token`、PID 路径或非必要的内部标识。
4. 禁止使用 `OTHER`/`UNKNOWN` 等逃生值；新场景必须新增具体枚举。
5. 客户端遇到任何未知 instruction 字段或值时，先按 `protocol_help` 调用 `GET /health` 重读 `protocol`；如果当前 health 仍不能解释该值，则停止自动执行并报告协议不兼容，不得回退解析 `tip` 猜测。
6. 所有 `instruction` 中的路径使用 POSIX 正斜杠；commit hash 统一为小写。
7. `instruction` 与 `tip` 必须消费同一个场景判定结果，模板自定义不得改变 `instruction`。
8. 同一 major 内可以增加可选字段或具体枚举；删除字段、改变既有字段含义或改变既有枚举语义必须升级 major。新枚举对旧消费者仍可能未知，因此重读 health 后仍须安全失败。
9. Health 扩展遵循加法兼容并保留原有探活字段；兼容期继续保留 `content.text`。
10. `fix_request` 只允许修改业务错误明确证明无效的参数，不得因为一次参数被拒绝而推断其他参数也无效；未被证明无效的参数应保留或独立验证。参数若依赖被修正的产物（例如 commit hash），必须验证其仍对应正确产物，不能无条件复用或无条件判废。满足原工具 input schema 和当前 instruction 后才重试原工具。

### 10.6 冷启动验收

仓库提供可独立复制的 `cold-start-eval/`，其目的不是实现客户端或替代自动化测试，而是让零背景 Claude/Codex 仅根据运行时发现信息复测 instruction 理解：

```text
cold-start-eval/
├── README.md
├── test.md
├── scripts/
│   └── instruction.ts
└── runs/                              # 首次执行时创建
    └── <run-id>/
        ├── runtime-workspace/
        │   ├── .git/
        │   └── task.md
        ├── instruction-eval-input.md
        └── instruction-eval-report.md # 由被测 AI 创建
```

用户必须把整个目录手动复制到 PairFlow 仓库之外，并在复制目录中执行：

```bash
node scripts/instruction.ts
```

该目录要求 Node `>=24.0.0`。脚本只使用 Node 内置能力，启动时验证 Node 版本并在版本不足时明确拒绝；默认连接 `http://127.0.0.1:35690`，支持 `--base-url`，并必须拒绝在 PairFlow 仓库内部运行，防止评估 Agent 接触源码和文档。脚本从运行中 Server 获取 health、initialize 和 tools/list；每次执行都在 `runs/` 下独占创建新的 `<run-id>/runtime-workspace/`，并生成正常工作流场景的真实响应。`run-id` 必须由脚本生成并保证同一复制目录内不复用，因此每次执行得到不同的绝对 `task_path`；已有 run 不得被覆盖或删除。由于 Server 的 `workflow_id` 只有秒级精度，脚本在每次 run 的首次 `confirm_task` 前必须等待进入下一个整秒，使同一复制目录中的串行执行不会复用 workflow ID，从而让同一 Server 上多个评估任务可以同时存在。

正常场景必须隐藏 tip，使行动、工具、参数来源、引用、产物和决策分支只由 instruction 与运行时 schema 确定。真实流程必须覆盖 `wait_for_turn → claim_turn → produce_and_submit/advance`，证明零背景消费者不会把 assigned turn 直接当作完整行动指引。唯一刻意展示 tip 的场景是 `synthetic_adversarial` 协议冲突用例，其中 tip 与 instruction 明显冲突，期望消费者停止自动推进并报告协议一致性错误。不能合理即时触发的 timeout/stale 场景标记 `synthetic_temporal`；两类 stale synthetic case 必须携带 `user_wants_to_continue_waiting` decision，验证消费者先报告用户，并只在用户选择继续时调用无参 `wait_for_turn`。未知版本、未知枚举和 tip 冲突场景标记 `synthetic_adversarial`。这些 synthetic provenance labels 必须明确显示，synthetic 场景只验证理解，不得冒充真实 Server 行为证据。Synthetic case 只保留 `ok`、`reminder`、`instruction` 以及冲突用例唯一可见的 `tip`；可以复用真实 instruction 的可靠 context，但不得继承 `task_path`、`recovered`、顶层 `workflow_id`/`phase`、测试 marker 等与被测语义无关的真实响应外壳，防止评估者反推一个不存在的运行时来源故事。

脚本可以从 register 响应提取 live token 用于后续调用，但在渲染任何评估 case 前必须递归删除 case 中名为 `token` 的授权凭据字段；生成的 Markdown 不得出现这些 live token 值。评估输入必须简短声明授权凭据已被有意移除，但不得暴露值、补充预期答案或改变唯一 adversarial visible tip 规则。正常 case 仍递归删除 `tip`。

冷启动采集在任何文件系统写入前必须完成 runtime preflight：health 必须声明 `instruction_v1`、`structured_tool_output_v1`、`json_response_v1` 与 `delivery_manifest_v1`，且 register、confirm_task、wait_for_turn、claim_turn、get_state、advance、submit 必须把预期 input 字段列入 input schema 的 `properties` 与 `required`，并提供顶层 object outputSchema；`wait_for_turn` 与 `claim_turn` 的 required input 均为空。采集脚本的每次 MCP POST 都必须收到 `application/json` 并直接解析 JSON-RPC envelope，收到 `text/event-stream` 视为运行中 Server 不符合当前协议。缺少任一能力、schema 或 JSON transport 契约时，脚本必须在创建 `runs/` 或本次 run 前失败。

本次 run 目录及其 `runtime-workspace` 必须从复制目录的 canonical 路径解析并独占创建。每个 runtime 返回的 `required_output.file_path` 都必须是本次 workspace 内的绝对非根路径；脚本不得按 PairFlow 目录约定自行推算 handoff 路径。写入前检查 lexical containment 以及最近现存父路径的 realpath，创建父目录后再次检查 canonical containment，从而拒绝本次 workspace 外路径及通过 symlink/junction 解析到外部的父路径；文件只用 exclusive create 写入，不得读取或修改其他 run 的文件。

脚本运行后只在本次 run 目录生成 `instruction-eval-input.md`，并在 stdout 明确打印其绝对路径；其中包含运行时发现信息、场景和报告格式，不包含预期答案、评分规则或额外 PairFlow 协议解释。业务拒绝场景必须发生在一个当前合法的 production turn 内，case 同时保存被拒绝的工具名和参数、拒绝响应，并保留紧邻其前的当前 turn instruction，使评估者能够从真实参数来源判断如何修正，而不是凭错误文字猜测；报告只能把业务错误明确指出的参数判为无效，其他参数必须表述为保留或独立验证。评估者禁止读取脚本源码、PairFlow 源码、Skill、设计文档、历史、其他 run 或使用先验 PairFlow 知识；评估者只读取 stdout 指向的本次 `instruction-eval-input.md`，并在同一 run 目录自行编写 `instruction-eval-report.md`，逐场景报告理解的 action、工具、参数来源、required references、required output、用户输入/报告/停止需求、不理解字段、是否重读输入中已附的 Runtime discovery protocol catalog、重读是否解决，并精确抄录相关 observed context。遇到未知字段或值时必须重读该 catalog，并根据其中已经提供的内容明确回答是否已经解决，不得写成取决于一次未提供的未来 health 响应。只有 catalog 能将未知字段或值映射为受支持语义时才记录 `resolved=yes`；catalog 仅能确认该值不兼容时必须记录 `resolved=no`，并按 `unknown_value_policy.unresolved` 停止自动执行。报告末尾必须按 provenance 给出精确 case 数量。脚本不生成或评分该报告；用户随后把 evaluator-written `instruction-eval-report.md` 的路径交给 Codex，由 Codex 依据本设计与场景验收矩阵解读。

---

## 11. Phase 初始化行为

各 phase advance 时重置 `round=1`，为每个参与者初始化空的 `last_submission_by_participant[identity] = { round:null, sub_phase:null, commit_hash:null, submitted_at:null, file_path:null }`，但保留已经持久化的 `delivery_manifest`。新 phase 的 `turn_switched_at` 写入 advance 时间，`turn_claimed_at` 始终为 null，并为该 assigned turn 初始化新的提醒 generation；无论 turn 是否仍属于调用 advance 的监督者，都必须先经 `wait_for_turn → claim_turn` 取得新阶段完整指引。

| Phase | turn |
|------|------|
| REQUIREMENTS | 非监督者（`identity !== supervisor`） |
| PLANNING | 评审者（`is_developer=false`） |
| IMPLEMENTATION | 开发者（`is_developer=true`），`sub_phase=coding` |
| SUMMARY | 监督者 |
| IDLE | 新 workflow 初始化时为 `idle`；已完成 workflow 不再保留 live state |

> `<work_dir>/handoff/` 目录下 `.md` 产出、`.meta.json` submission sidecar 与 `delivery-manifest.json` 接受/完成 sidecar 作为本地永久归档保留，不随完成清理；仅 `.md` 要求 AI commit。

---

## 12. 假设与降级

| 假设 | 状态 |
|---|---|
| 客户端支持自定义 HTTP header（`X-AI-Identity`） | ⚠️ 接入前提。不支持则无法接入 PairFlow |
| 两个 AI 均支持 MCP client 模式 | ⚠️ 接入前提。不支持则无法接入 PairFlow |
| Agent 直接使用 MCP 工具、initialization、`tools/list` 与 `/health` 接入 | ⚠️ v1 公共集成面。Server 不提供官方 SDK/CLI 或跨进程会话存储；调用方自行持有 token、解释结构化 instruction 并遵循工具级重试规则 |
| `wait_for_turn` 单次请求最长 600 秒 | ⚠️ 客户端职责。超时后可按 instruction 再次调用；PairFlow 不提供透明续等层，warning 的用户决策分支尤其不得自动重试 |
| 项目使用 git + AI 具备 git 操作能力 | ⚠️ 接入前提。commit_hash 由调用方提供，PairFlow 只记录且不执行命令验证真实性 |
| PairFlow 运行时不执行任何外部命令 | ⛔ 硬约束。命令执行属于 AI 客户端职责，不得引入 `child_process` |
| 结对编程（互审 + 互产）比单 AI 自审更优 | ⚠️ 假设。交替审阅模型通过周期性轮换保持发现能力 |
| 服务仅绑定 `127.0.0.1`，无外部用户身份认证并信任本机进程；token 仅承担参与者身份路由与工作流操作授权。同一 workflow 内 identity 唯一，但同一 identity 可持有多个 token | ⚠️ 设计假设 |
| 零背景 AI 可读取 `/health`、MCP initialization、`tools/list` 和工具结果，并向用户补齐 identity、task path、task type、职责与 work directory | ⚠️ instruction v1 接入前提。缺失用户输入时必须询问，不得猜测；未知协议值重读 health 后仍不理解则停止自动执行 |
| 独立冷启动复测环境提供 Node `>=24.0.0`，且 `cold-start-eval/` 已复制到 PairFlow 仓库之外 | ⚠️ clean-room 验收前提。不满足时 `node scripts/instruction.ts` 必须明确拒绝运行 |

---

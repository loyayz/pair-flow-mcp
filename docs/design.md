# PairFlow: 双 AI 结对编程工作流引擎

> 设计日期: 2026-06-21

---

## 1. 目标与范围

构建一个本地 HTTP MCP Server，驱动两个 AI 按照结构化工作流完成结对编程。不绑定具体 AI 产品——两端先注册 identity，再通过 HTTP header 携带 PairFlow 签发的 token，PairFlow 不预设"谁是谁"。

工作流覆盖从需求到交付的完整软件开发生命周期，包含四阶段主流程：需求阶段 → 计划阶段 → 开发阶段 → 汇总阶段（其中开发阶段内部含 coding↔review 交替子循环，对应四个状态机 phase：REQUIREMENTS/PLANNING/IMPLEMENTATION/SUMMARY）。任一阶段出现分歧时，双方在产出文档中标注观点差异，监督者在 advance 前裁定是否需要用户介入。

**核心定位**：结对编程的工作流引擎——持续互审 + 知识共享 + 方案互补。两个 AI 在同一工作流中交替产出与评审，减少单人偏差。

**监督者**：IDLE 阶段由用户从两个 AI 中指定。监督者通过 `advance` 控制阶段推进——未达成共识时有权不推进（阻塞 advance），但不能单方面否决对方产出。分歧无法在文档标注中解决时，由监督者裁定是否需要用户介入。SUMMARY 阶段负责汇总报告。

**v1 范围**：流程线性固定（四个 phase 顺序执行）。

---

## 2. 架构总览

```
AI-A (MCP Client)              AI-B (MCP Client)
        │                            │
        │ HTTP 127.0.0.1:35690/mcp │
        ▼                            ▼
┌──────────────────────────────────────────────────┐
│              PairFlow Server (HTTP MCP)           │
│                                                  │
│  状态机 + 模板引擎 + 收敛判定（手动）                  │
│ （状态全内存，work_dir/handoff/ 为归档权威来源）     │
│ work_dir/handoff/{workflow_id}/（产出 + meta.json）│
│                                                  │
│  MCP Tools: ping / who_am_i / register            │
│            get_state / submit                        │
│            confirm_task / advance                  │
│            wait_for_turn                            │
└──────────────────────────────────────────────────┘
```

- **两个 AI**：先注册身份获取 token，再通过 `confirm_task` 加入 workflow 并声明职责，后续按阶段参与协作
- **监督者**：AI 之一兼任，控制 `advance` + 分歧裁定 + 最终异议 + SUMMARY 汇总
- **PairFlow**：中立调度方。两边可见相同工具集，执行权限按职责和 turn 控制。状态变更持 async-mutex（`confirm_task` 固定按 token → 规范化 `task_path` → workflow 的顺序加锁；token 锁防止同一凭据并发加入不同任务，task_path 锁防止重复创建 workflow；其他工作流运行期操作只按 workflow 加锁。token/task_path 临时锁在请求队列耗尽后释放）
- **命令执行边界**：PairFlow 不启动 Git 或任何其他外部命令，只管理内存状态并读写归档文件

---

## 3. 目录结构

`project/` = `work_dir` = git 仓库根目录。`confirm_task` 通过 `<work_dir>/.git` 标记验证仓库根：普通仓库接受 `.git` 目录，linked worktree 接受 `.git` 文件；该验证只读取文件系统，不执行 Git 命令。状态为进程内存变量（重启后丢失），无运行时状态文件。归档产出（协作过程权威记录，纳入版本管理）固定置于 `<work_dir>/handoff/`，不受 PairFlow server 启动目录影响。

**路径节点策略**：需要信任文件类型或归档边界时统一使用 `lstat`，不使用会跟随链接的 `stat`。从卷根到 `work_dir`、`.git` marker、task_path 从 work_dir 往下的每一级、`.pid`、handoff/workflow/phase 路径以及 submit 产出路径均不得是 symlink/junction；普通 Git 仓库的真实 `.git` 目录和 linked worktree 的真实 `.git` 文件均允许。目录、普通文件、缺失、符号链接和其他 IO 错误必须在 tip 中给出对应原因，不互相冒充。

`<work_dir>/handoff/` 下的 meta.json + 产出文件是归档权威来源，不是完整 live-state checkpoint。崩溃恢复从 `.pid` 指向的 workflow 目录中恢复到最后一次成功 submission 后的可继续状态（见 §8）。归档文件有版本管理价值（handoff/，git 提供追溯+备份）。

```
project/                                         ← git 仓库根
├── handoff/                                     ← 归档产出（纳入版本管理）
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
```

**meta.json 生成**：`.meta.json` 由 `submit` 工具在每次提交成功后自动生成，写入 `submitted_at`、`commit_hash`、`sub_phase`、`task` 字段。AI 无需手动创建。一次 submit 的 meta、`last_submission_by_participant` 和 `turn_switched_at` 共用同一个 submitted_at；commit_hash 统一存为小写。`.meta.json` 必须使用同目录临时文件 + rename 原子写入；只有 `.meta.json` 写入成功后，`submit` 才能推进内存状态并返回成功，写入失败时状态完全不变并在 tip 中返回路径和文件系统错误码。崩溃恢复只使用符合该生成契约的 meta：JSON 可解析，submitted_at 为有效时间，commit_hash 为 7–40 位十六进制，task.spec_file 为绝对路径，task.task_type 合法，sub_phase 与 phase、文件名一致；不合格记录直接忽略。`reconstructFromHandoff` 从过滤后的记录重建 `last_submission_by_participant` 等状态字段；每位参与者的最新 submission 按文件名中的 round 判定，不按可能回拨的 submitted_at 排序。

**启动流程**：
1. 仅监听 `127.0.0.1`，默认端口 `35690`，提供 HTTP MCP（`/mcp`）+ 健康检查（`GET /health`）。可通过启动参数 `--port <1-65535>` 自定义端口，例如 `npx tsx src/index.ts --port 3200`；不读取端口环境变量，参数缺值、非整数、越界或包含未知选项时说明原因并退出。`--help` 输出用法、默认值和端口范围后以退出码 0 结束，不启动监听。监听失败时，`EADDRINUSE` 和 `EACCES` 必须提示端口冲突或权限原因以及 `--port` 解决方式，然后以退出码 1 结束
2. 状态为进程内存，重启后清空，需重新 register
3. 接收 SIGTERM/SIGINT → 立即以退出码 0 结束进程，不等待在途请求完成，也不为最长 600 秒的 `wait_for_turn` 引入 drain 生命周期。调用方未收到响应时应重试；重启后的 workflow 按已成功原子落盘的归档恢复，临时文件或未完成写入不视为成功 submission
4. 任一 `uncaughtException` → 记录错误并以退出码 1 结束进程；由外部进程管理器负责重启、退避和 crash-loop 熔断
5. `POST /mcp` 请求体上限为 1 MiB（1,048,576 bytes）。先检查声明的 `Content-Length`，并始终按实际接收字节逐 chunk 累计；任一值超限立即返回 JSON `413 Payload Too Large`、关闭当前连接，不拼接或解析超限 body。现有工具均只传短字符串、布尔值或空参数，合法请求无需接近该上限
6. HTTP 入口按故障归属返回状态码：JSON 语法错误返回 JSON `400 Invalid JSON`；请求体超限返回 `413`；未匹配的 method/path 返回 `404`；只有服务端内部执行异常返回 JSON `500 Internal Server Error`。通过 JSON 解析但不符合 JSON-RPC/MCP 协议的请求交由 MCP transport 处理
7. HTTP 请求接收阶段设置显式超时：headers 最多 10 秒，完整请求最多 30 秒，连接超时扫描间隔为 1 秒；超时由 Node.js 返回 `408 Request Timeout` 并关闭连接。响应阶段不设置 socket timeout，因此不影响 `wait_for_turn` 的 600 秒长轮询

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
  │    is_supervisor:true,             │    is_supervisor:false,
  │    is_developer:false,             │    is_developer:true,
  │    work_dir:"/project"})           │    work_dir:"/project"})
  ├──────────────────────────────►     ├──────────────────────────────►
  │◄── { 已创建工作流，等待对方 }        │◄── { 已加入，双方已就位 }
  │                                    │
  │  advance({})                       │
  ├──────────────────────────────►     │
  │◄── { new_phase:"requirements",     │
  │      turn:"deepseek" }             │
  │                                    │  wait_for_turn
  │                                    ├──────────────────────────────►
```

**身份判定**：
- HTTP header `X-AI-Identity: <token>`，token 必须来自 `register`
- 无有效 token → `"unknown"`，仅 `ping` / `who_am_i` / `register` 可用
- `register` 返回 UUID token，后续请求用 token 值放入 header
- 服务端维护进程内 `token → { identity, workflowId }` 映射，`parseSession` 返回 identity + workflowId + registered
- 同一 identity 可多次 register 并获得多个 token；在同一 workflow 中 identity 只对应一个 Participant，多个 token 代表同一 Participant 的不同凭据。普通重复确认是幂等操作，可将同 identity 的新 token 绑定到该 Participant，但不改写职责、work_dir 或 registered_at。已加入活跃 workflow 的 token 不得通过 `confirm_task` 改绑到不同 task；同一 identity 并行参与其他 workflow 时必须另行 register 获取新 token。workflow 结束后，进程内仍有效的 token 可由 `confirm_task` 重新绑定到新 workflow，无需重复 register；新任务仍要求双方分别调用 `confirm_task`
- token 随进程重启清空，崩溃后重新 register 获取新 token
- token 是参与者身份路由与工作流操作授权凭据，不是外部用户身份认证。PairFlow 信任同一主机上的进程，不防御恶意本地客户端；token 的边界是防止正常协作中的串身份、串 workflow 和越权调用

---

## 5. 状态机

### 5.1 State Schema

```jsonc
{
  "schema_version": 1,
  "workflow_id": null,          // confirm_task 时生成（yyyyMMddHHmmss）
  "phase": "idle | requirements | planning | implementation | summary",
  "sub_phase": "coding | review | null", // 仅在 IMPLEMENTATION 阶段生效
  "round": 1,                   // 当前阶段内的轮次
  "turn": "idle | <identity>",  // 当前持有操作权的身份
  "turn_switched_at": null,     // turn 交接时间戳（submit 或 advance 分配新 phase turn 时写入）
  "turn_claimed_at": null,      // turn 领取时间戳（对方掉线检测用；advance 分配给调用者本人时同步写入）
  "task": {                     // confirm_task 时写入
    "spec_file": "string",
    "task_type": "requirements | development"  // 可选，默认 "development"。需求模式跳过 planning/implementation
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
- SUMMARY → IDLE：监督者调 `advance` → 工作流结束；删除该 workflow 的内存状态和 mutex，并将指向它的 token 解绑为未加入 workflow，token 本身仍可复用
- IDLE 是初始/终结态
- **advance 仅监督者可调**，非监督者 advance → 拒绝。`turn` 控制下一份产出由谁提交；监督者只有在当前 phase 双方均已 submit 且 `turn` 已自然回到监督者时，才能调用 `advance` 做收敛判定并推进阶段。
- 普通 workflow 在 IDLE 阶段允许已加入的 Participant 修正职责；离开 IDLE 后 `is_supervisor` / `is_developer` 强制冻结，重复 `confirm_task` 必须提交原值。work_dir 从 Participant 首次确认起固定，不允许通过重复确认迁移。恢复占位 Participant 不受 phase 限制，可在首次重新确认时写入真实职责与本次 work_dir，此后遵循同样的冻结规则。

> **is_developer 标志仅在 IMPLEMENTATION 阶段生效**：coding 时仅 developer 可 submit，review 时仅非 developer 可 submit。REQUIREMENTS、PLANNING、SUMMARY 阶段的产出/审阅流程由 `turn` 分配驱动，与 is_developer 标志无关。需求模式（`task_type=requirements`）下 is_developer 标志无实际作用。

### 5.3 Turn 切换

- submit 后 `round += 1`，turn 切给对方。即使当前 phase 双方都已 submit，`turn` 仍表示下一份产出的行动权；若 `turn` 尚未回到监督者，监督者不能 `advance`
- advance 到新 phase 后 `round = 1`，turn 按 phase 初始化并写入 `turn_switched_at`；若 turn 属于调用 advance 的监督者本人，则同时写入 `turn_claimed_at`，否则保持未领取
- wait_for_turn 检测到 `turn === identity` 时返回，同时自动记录 `turn_claimed_at` 时间戳并返回完整行动指引。服务端据此检测对方是否掉线（>30 分钟未领取）

## 6. 收敛

监督者手动判定。各阶段交替审阅后，监督者确认阶段目标已达成（无未决议题、不能有双方同意延后的内容），调用 `advance` 推进。**advance 前双方至少各有一次 submit，且 turn 必须已自然回到监督者**，确保双方都有产出和审阅机会，并避免非监督者仍持有行动权时被并行推进。该判定仅针对当前 phase；每次 advance 初始化新 phase 时都会清空 `last_submission_by_participant`。

## 7. Issue 系统

PairFlow 不维护独立的 issue 跟踪系统。双方在产出文档中通过标注管理观点差异，监督者在 advance 前检查争议是否已解决。

## 8. 异常处理

**等待与对方掉线**：600s 是单次 `wait_for_turn` 请求上限，不是 turn 超时；单次超时后 AI 继续调用 `wait_for_turn`，维持自动轮转且不打断用户。`turn_switched_at` 不因单次请求超时重置。累计超过 30 分钟且 `turn_claimed_at` 仍为空时，`wait_for_turn` 返回 warning 提示对方可能已掉线，此时才建议向用户报告。

**崩溃恢复**：每次启动全新开始（状态全内存）。崩溃恢复由用户主动触发——`confirm_task` 发现任务文档已有 `.pid` 普通文件时读取 workflow_id，并从本次入参指定的 `<work_dir>/handoff/` 中符合 meta 生成契约的记录恢复到最后一次成功 submission 后的状态（phase、round、参与者身份、last_submission_by_participant）；handoff 根、workflow 和 phase 目录不得包含符号链接，只扫描各 phase 目录的直属普通 meta，嵌套文件和 meta 链接不参与恢复，损坏或字段不完整的 meta 被忽略，等同于对应 round 缺失。恢复后的 `turn_switched_at` 取当前 phase 最高 round submission 的 submitted_at，`turn_claimed_at` 为 null；双方身份确认齐全后，turn 指向该最高 round 提交者的对方。work_dir 和 task.spec_file 始终分别以本次 `confirm_task` 的 work_dir、task_path 入参为准；归档 meta 中的 spec_file 只作为历史记录，不参与当前路由；过滤后的有效记录中，task_type 必须一致，requirements 任务中的 planning/implementation 记录无效。`.pid` 只保存 workflow_id，不保存或约束旧 work_dir；其内容格式非法或该 work_dir 下不存在所指归档时，均视为用户要创建新任务，创建新 workflow 并覆盖 `.pid`。恢复只接受文件名中符合 identity 规则（字母、数字、下划线、连字符）的有效记录；非法 identity 文件名忽略，过滤后合法 identity 超过两个则归档不可恢复；每个 phase 内有效 round 必须唯一且身份须符合奇偶轮交替，但允许历史 round 缺失，恢复后的 round 为当前 phase 现存最大 round + 1；IMPLEMENTATION 有效文件名必须包含 sub_phase，且奇数 round 为 coding、偶数 round 为 review。`.pid` 原子写入；过滤后无有效记录，或有效记录之间出现结构冲突时，归档不足以恢复，`confirm_task` 创建新 workflow 并覆盖 `.pid`，旧归档保持不变；`.pid` 或归档路径存在但类型错误、包含链接或无法读取时则拒绝恢复，并在 tip 中说明路径和文件系统错误，不覆盖 `.pid`；`.pid` 指向的 workflow_id 若已被另一活跃任务占用，同样拒绝，绝不覆盖活跃内存状态。summary 目录或 summary 文件存在不代表 workflow 已完成。参与者的职责（is_supervisor/is_developer）以恢复占位 Participant 首次重新确认时的 `confirm_task` 入参为准，不从归档推断；恢复占位参与者允许临时职责不完整，待双方都重新确认后必须重新满足职责组合规则。恢复仅识别出一个 identity 时，该身份确认后仍须等待第二位参与者加入；双方未完整就位前，`advance` / `wait_for_turn` / `submit` 均拒绝执行，`get_state` 只返回继续 `confirm_task` 的指引。恢复不自动扫描——`confirm_task` 是唯一恢复入口。

**未捕获异常**：任一 `uncaughtException` 都记录错误并以退出码 1 结束进程，不在不安全状态中原地恢复。PairFlow 不跨进程持久化 crash 计数，也不自行重启；重启、退避和 crash-loop 熔断由外部进程管理器负责。

---

## 9. MCP 工具清单

| 工具 | 入参 | 出参 | 说明 |
|---|---|---|---|
| `ping` | 无 | `{ ok, uptime }` | 连通性检查。匿名可用 |
| `who_am_i` | 无 | 匿名：`{ identity, registered, joined_workflow }`；已注册：`{ identity, registered, joined_workflow, is_supervisor, is_developer, workflow_id }` | 身份确认 + 注册/工作流加入状态。`registered` 表示 token 有效，`joined_workflow` 表示已通过 `confirm_task` 加入工作流；已注册但未加入 workflow 时职责字段均为 `false`，`workflow_id` 为 `null`。匿名可用（identity="unknown"） |
| `register` | `{ identity: string }` | `{ ok, identity, token }` | 注册身份。identity 从 body 取，长度 1–64，仅允许字母、数字、下划线和连字符；`unknown`、`idle` 为大小写不敏感的保留字。不声明职责、不绑定 workflow phase（职责移至 confirm_task）。返回 UUID `token`。`identity` 缺失由 MCP schema 拒绝；identity 内容非法时返回 curl 格式参考。`tip` 详细列出 confirm_task 的 5 个入参（task_path/task_type/is_supervisor/is_developer/work_dir）及含义 |
| `confirm_task` | `{ task_path, task_type?, is_supervisor, is_developer, work_dir }` | `{ task_path, workflow_id, phase, recovered }` | 确认任务文档并声明职责。所有必填字段在 handler 边界再次校验类型；从卷根到 `work_dir` 的完整路径不得含链接，work_dir 必须为真实目录；`.git` 必须是非链接的真实目录或普通文件；`task_path` 必须位于 work_dir 下，且从 work_dir 到 task 普通文件的每一级均不得是链接。二者都必须是绝对路径且不得包含 `.` 或 `..` 路径段。规范化路径比较遵循宿主操作系统的大小写规则（Windows 不区分大小写，其他平台区分）。两个 AI 使用相同 task_path 自动成对，最多双方加入；固定按 token → task_path → workflow 加锁，校验职责组合和 work_dir 一致性。已加入活跃 workflow 的 token 只能幂等确认同一 task，不得改绑到不同 task。`task_type` 由首次确认固定，后续显式冲突时拒绝、未传则继承。普通 Participant 在 IDLE 可修正职责，离开 IDLE 后职责冻结；work_dir 首次确认后始终固定；恢复占位 Participant 首次重新确认时可覆盖推断职责和 work_dir。普通幂等确认保留 registered_at，并可绑定同 identity 的新 token。职责组合规则：任何时候 supervisor/developer 都不能重复；两人真实就位后必须恰好一个 Supervisor 和恰好一个 Developer，且二者可由同一参与者兼任。`recovered=true` 仅表示本次调用从归档重建了 workflow 或确认了恢复占位 Participant。首位参与者的 tip 只要求等待第二人调用 `confirm_task`，双方就位前不引导调用行动工具；双方就位后才引导 `wait_for_turn`。`.pid` 必须是普通文件且不得是链接；文件系统拒绝会在 tip 中返回目标路径和错误码。后续所有工具通过 token 路由到对应 workflow |
| `advance` | 无 | `{ ok, new_phase, turn, sub_phase? }` | 推进到下一阶段。仅监督者可用，且必须已有两位真实参与者完整就位。当前 phase 尚未形成双方提交时拒绝；当前 phase 双方均已 submit 但 `turn` 尚未回到监督者时也拒绝，由当前 turn 持有者继续产出或确认后自然交还 turn。只有 `turn === identity`（IDLE 阶段允许 `turn === "idle"`）时，监督者才能 `advance`。各 phase 转换规则同上。**需求模式**（`task_type === "requirements"`）下 REQUIREMENTS 直接跳到 SUMMARY，跳过 PLANNING/IMPLEMENTATION。SUMMARY→IDLE 前仍要求双方至少各有一次 summary submit 且 turn 回到监督者；删除 `.pid` 文件后删除该 workflow 的内存状态和 mutex，并将关联 token 解绑但保持注册有效；`.pid` 不存在视为已删除，其他删除错误则拒绝 advance 并保持 SUMMARY。`tip` 使用 `[行动]`/`[产出]`/`[当前]` 三层格式，turn 归属用自然语言（`turnIsSelf` 判断，不再硬编码"对方"），IDLE 结束包含归档位置和重新开始指引 |

| `wait_for_turn` | 无 | `{ turn, phase, round, warning? }` | 仅在两位真实参与者完整就位后长轮询等待 turn 切换。10s 间隔，600s 为单次请求上限；600s 超时后提示 AI 继续调用 `wait_for_turn`，不打断用户，且不重置 workflow 级未领取计时。客户端取消请求时立即终止本次等待，不返回业务 tip，也不改变 workflow 状态。turn 到达时自动记录 `turn_claimed_at`，返回 `[行动]/[产出]/[当前]` 三层完整指引。累计 30 分钟未领取时返回掉线 warning，并建议向用户报告当前状态 |
| `get_state` | 无 | `{ tip }` | 需要有效注册 token。返回当前执行指引。`tip` 使用 `[行动]`/`[产出]`/`[当前]` 三层自然语言格式（由 `buildTip()` 生成）；若 workflow 存在恢复占位身份或尚不足两位参与者，则只提示继续通过 `confirm_task` 完成双方确认，不生成正常行动路径；若当前 token 未加入活跃 workflow（例如旧 workflow 已结束并清空 participants），提示重新 `confirm_task` |
| `submit` | `{ file_path, git_commit_hash }` | `{ ok, next_turn }` | 仅在两位真实参与者完整就位后提交当前 turn 的产出，handler 再次校验两个入参均为字符串。`file_path` 必须是当前 workflow/phase/round/identity 对应的绝对路径，不得含 `.` / `..`，且必须是非零字节的直属普通 handoff 文件；PairFlow 不读取或评价文件内容。使用 `lstat` 检查从 `<work_dir>/handoff` 到产出文件的每一级路径，任一级为符号链接均拒绝。`git_commit_hash` 必须是 7–40 位十六进制，统一转为小写；若与当前 phase 最高 round hash 相同或二者互为长短前缀，则视为未产生新工作。PairFlow 不执行 Git 命令，无法验证 hash 是否存在或判断无前缀关系的两个 hash 是否指向同一 commit，真实性由调用方负责。IMPLEMENTATION 仅接受 coding/review 子阶段，并按职责限制提交。成功时以同一时间戳更新 last_submission、turn 和原子生成的 `.meta.json`，随后 round+1、切换 turn/sub_phase；meta 写失败则返回路径和错误码，内存状态完全不变。`tip` 中身份标签复用 `tip.ts` 的 `identityLabel()` |

---

## 10. 响应与 Tip 格式规范

所有工具的成功与拒绝响应都必须包含 `reminder: "质量优先，完整完成任务目标。"`。`reminder` 表达跨阶段恒定的质量原则；`tip` 表达当前状态下的具体行动，两者不可互相替代。统一响应封装不得修改调用方传入的数据对象，业务数据或错误扩展也不得覆盖 `ok`、`error`、`tip`、`reminder` 等固定契约字段。

所有工具的 `tip` 字段遵循统一的 `[行动]/[产出]/[当前]` 三层自然语言格式。

拒绝响应（`ok=false`）也必须返回 `tip`，且 `tip` 要明确说明被拒绝的原因，格式为 `[行动] 请求被拒绝：<原因>`。调用方应优先把该原因报告给用户或据此修正参数。

### 10.1 三层结构

```
[行动] <一句话行动指令，不含提交参数>
[产出] 完成后 git commit，调用 submit，file_path = <POSIX 绝对路径>
[当前] 你是 <identity>（<职责标签>）。当前是第 <n> 轮<阶段名>，<turn 归属>。
```

- **`[行动]`**：只描述当前该做什么。不含路径、不含提交指令、不含上下文状态
- **`[产出]`**：产出文件绝对路径（POSIX 正斜杠）+ 提交流程。advance 中按 `turnIsSelf` 区分"你将产出到" / "{对方}将产出到"；wait_for_turn/get_state 仅在调用方持有 turn 且处于非 idle phase 时返回其提交路径，非 turn 持有者只收到等待与 wait_for_turn 指引
- **`[当前]`**：自然语言描述——你是谁、第几轮、什么阶段、轮到谁。**不用管道符分隔**，用完整句子
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

`tip.ts` 导出 `buildTip(state, identity)`，被 `wait_for_turn` 和 `get_state` 复用。内部拆分为三个辅助函数：

- `getAction(state, identity)` — 生成 `[行动]` 内容，按 phase/round 分支
- `outFile(state, identity)` — 生成产出文件绝对路径
- `phaseLabel(phase, subPhase)` — phase + sub_phase → 中文阶段名

`identityLabel(state, identity)` 同时导出供 `submit` 复用职责标签，避免 submit.ts 与 tip.ts 维护两套职责推断逻辑。

### 10.4 路径统一

所有 tip 和返回值中的路径统一使用 POSIX 正斜杠（`.replace(/\\/g, "/")`），避免 Windows 反斜杠在 JSON 响应中被转义为 `\\` 导致 AI 解析混乱。

---

## 11. Phase 初始化行为

各 phase advance 时重置 `round=1`，为每个参与者初始化空的 `last_submission_by_participant[identity] = { round:null, sub_phase:null, commit_hash:null, submitted_at:null, file_path:null }`。新 phase 的 `turn_switched_at` 写入 advance 时间；turn 分给调用者本人时 `turn_claimed_at` 同步写入，否则为 null。

| Phase | turn |
|------|------|
| REQUIREMENTS | 非监督者（`identity !== supervisor`） |
| PLANNING | 评审者（`is_developer=false`） |
| IMPLEMENTATION | 开发者（`is_developer=true`），`sub_phase=coding` |
| SUMMARY | 监督者 |
| IDLE | 新 workflow 初始化时为 `idle`；已完成 workflow 不再保留 live state |

> `<work_dir>/handoff/` 目录下产出文件与 meta.json 作为永久归档保留，不随 IDLE 清理。

---

## 12. 假设与降级

| 假设 | 状态 |
|---|---|
| 客户端支持自定义 HTTP header（`X-AI-Identity`） | ⚠️ 接入前提。不支持则无法接入 PairFlow |
| 两个 AI 均支持 MCP client 模式 | ⚠️ 接入前提。不支持则无法接入 PairFlow |
| 项目使用 git + AI 具备 git 操作能力 | ⚠️ 接入前提。commit_hash 由调用方提供，PairFlow 只记录且不执行命令验证真实性 |
| PairFlow 运行时不执行任何外部命令 | ⛔ 硬约束。命令执行属于 AI 客户端职责，不得引入 `child_process` |
| 结对编程（互审 + 互产）比单 AI 自审更优 | ⚠️ 假设。交替审阅模型通过周期性轮换保持发现能力 |
| 服务仅绑定 `127.0.0.1`，无外部用户身份认证并信任本机进程；token 仅承担参与者身份路由与工作流操作授权。同一 workflow 内 identity 唯一，但同一 identity 可持有多个 token | ⚠️ 设计假设 |

---

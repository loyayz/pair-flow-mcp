# PairFlow: 双 AI 结对编程工作流引擎

> 设计日期: 2026-06-21

---

## 1. 目标与范围

构建一个本地 HTTP MCP Server，驱动两个 AI 按照结构化工作流完成结对编程。不绑定具体 AI 产品——两端通过 HTTP header 自报身份，PairFlow 不预设"谁是谁"。

工作流覆盖从需求到交付的完整软件开发生命周期，包含四阶段主流程：需求阶段 → 计划阶段 → 开发阶段 → 汇总阶段（其中开发阶段内部含 coding↔review 交替子循环，对应四个状态机 phase：REQUIREMENTS/PLANNING/IMPLEMENTATION/SUMMARY）。任一阶段出现分歧时，双方在产出文档中标注观点差异，监督者在 advance 前裁定是否需要用户介入。

**核心定位**：结对编程的工作流引擎——持续互审 + 知识共享 + 方案互补。两个 AI 在同一工作流中交替产出与评审，减少单人偏差。

**监督者**：IDLE 阶段由用户从两个 AI 中指定。监督者通过 `advance` 控制阶段推进——未达成共识时有权不推进（阻塞 advance），但不能单方面否决对方产出。分歧无法在文档标注中解决时，由监督者裁定是否需要用户介入。SUMMARY 阶段负责汇总报告。

**v1 范围**：流程线性固定（四个 phase 顺序执行）。

---

## 2. 架构总览

```
AI-A (MCP Client)              AI-B (MCP Client)
        │                            │
        │  HTTP localhost:3100/mcp   │
        ▼                            ▼
┌──────────────────────────────────────────────────┐
│              PairFlow Server (HTTP MCP)           │
│                                                  │
│  状态机 + 模板引擎 + 收敛判定（手动）                  │
│  （状态全内存，handoff/ 归档为权威来源）              │
│  handoff/{workflow_id}/（归档: 产出 + meta.json）  │
│                                                  │
│  MCP Tools: ping / who_am_i / register            │
│            get_state / submit                        │
│            get_archived_files / ...                 │
│            confirm_task / advance                 │
│            wait_for_turn / get_archived_file_content│
└──────────────────────────────────────────────────┘
```

- **两个 AI**：在 IDLE 阶段注册身份和角色，后续按阶段参与协作
- **监督者**：AI 之一兼任，控制 `advance` + 分歧裁定 + 最终异议 + SUMMARY 汇总
- **PairFlow**：中立调度方。两边可见相同工具集，执行权限按角色和 turn 控制。状态变更持 async-mutex（per-workflow 内存锁）

---

## 3. 目录结构

`project/` = git 仓库根目录。状态为进程内存变量（重启后丢失），无运行时文件。归档产出（协作过程权威记录，纳入版本管理）置于仓库根 `handoff/`。

handoff/ 下的 meta.json + 产出文件是权威来源。崩溃恢复从 handoff/ 重建（见 §8）。归档文件有版本管理价值（handoff/，git 提供追溯+备份）。

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

**meta.json 生成**：`.meta.json` 由 `submit` 工具在每次提交成功后自动生成，写入 `submitted_at`、`commit_hash`、`sub_phase`、`task` 字段。AI 无需手动创建。崩溃恢复时 `reconstructFromHandoff` 从 `.meta.json` 重建 `last_submit_per_turn` 等状态字段。

**启动流程**：
1. 监听 `localhost:3100`，提供 HTTP MCP（`/mcp`）+ 健康检查（`GET /health`）
2. 状态为进程内存，重启后清空，需重新 register
3. 接收 SIGTERM/SIGINT → 退出
4. `uncaughtException` crash loop 检测：30s 内 3 次 → 拒绝重启

**多工作流支持**：每个工作流（IDLE→...→SUMMARY→IDLE 完整周期）在 `handoff/{workflow_id}/` 下独立归档。`workflow_id` 由 confirm_task 时生成（`yyyyMMddHHmmss` 格式，保证唯一+可排序）。不同任务分属不同 workflow_id 目录，互不覆盖。

---

## 4. 数据流

### 启动与注册 + 成对绑定

register 只声明身份，不声明角色。confirm_task 声明角色，同 task_path 的两个 AI 自动成对。

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
  │    supervisor:true,                │    supervisor:false,
  │    developer:false,                │    developer:true,
  │    work_dir:"/project"})           │    work_dir:"/project"})
  ├──────────────────────────────►     ├──────────────────────────────►
  │◄── { 已创建工作流，等待对方 }        │◄── { 已加入，双方已就位 }
  │                                    │
  │  advance({})                       │
  ├──────────────────────────────►     │
  │◄── { new_phase:"requirements",     │
  │      turn:"deepseek" }             │
  │                                    │  wait_for_turn → claim_turn
  │                                    ├──────────────────────────────►
```

**身份判定**：
- HTTP header `X-AI-Identity: <token>`
- 无有效 header → `"unknown"`，仅 `ping` / `who_am_i` 可用
- `register` 返回 UUID token，后续请求用 token 值放入 header
- 服务端维护进程内 `token → { identity, workflowId }` 映射，`parseSession` 返回 identity + workflowId
- token 随进程重启清空，崩溃后重新 register 获取新 token

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
  "turn_switched_at": null,     // turn 切换时间戳（submit 时写入）
  "turn_claimed_at": null,      // claim_turn 时间戳（对方掉线检测用）
  "task": {                     // confirm_task 时写入
    "spec_file": "string",
    "task_type": "requirements | development"  // 可选，默认 "development"。需求模式跳过 planning/implementation
  },
  "peers": [
    {
      "identity": "claude",
      "role": "supervisor | peer",
      "is_developer": false,
      "registered_at": "ISO8601",
      "work_dir": "/project"
    }
  ],
  "last_submit_per_turn": {
    "<identity>": {
      "round": 1,
      "sub_phase": "coding",
      "commit_hash": "abc123",
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

- IDLE → REQUIREMENTS：两端 register 后，监督者调 `advance`（peers≥2 + task 已确认 → turn 切给非监督者）
- REQUIREMENTS → PLANNING：监督者调 `advance` → turn 切给评审者（`is_developer=false`）
- PLANNING → IMPLEMENTATION：监督者调 `advance` → turn 切给开发者，`sub_phase=coding`
- IMPLEMENTATION 阶段每次 `submit` 后 `sub_phase` 在 coding ↔ review 之间交替切换，turn 随之切换给另一方。coding 仅开发者可 submit，review 仅评审者可 submit
- IMPLEMENTATION → SUMMARY：监督者调 `advance` → turn 切给监督者
- SUMMARY → IDLE：监督者调 `advance` → 工作流结束
- IDLE 是初始/终结态
- **advance 仅监督者可调**，非监督者 advance → 拒绝

> **developer 标志仅在 IMPLEMENTATION 阶段生效**：coding 时仅 developer 可 submit，review 时仅非 developer 可 submit。REQUIREMENTS、PLANNING、SUMMARY 阶段的产出/审阅流程由 `turn` 分配驱动，与 developer 标志无关。需求模式（`task_type=requirements`）下 developer 标志无实际作用。

### 5.3 Turn 切换

- submit 后 `round += 1`，turn 切给对方
- advance 到新 phase 后 `round = 1`，turn 按 phase 初始化
- wait_for_turn 检测到 `turn === identity` 时返回，同时自动记录 `turn_claimed_at` 时间戳并返回完整行动指引。服务端据此检测对方是否掉线（>30 分钟未领取）

## 6. 收敛

监督者手动判定。各阶段交替审阅后，监督者确认阶段目标已达成（无未决议题、不能有双方同意延后的内容），调用 `advance` 推进。**advance 前双方至少各有一次 submit**，确保双方都有产出和审阅机会。

## 7. Issue 系统

PairFlow 不维护独立的 issue 跟踪系统。双方在产出文档中通过标注管理观点差异，监督者在 advance 前检查争议是否已解决。

## 8. 异常处理

**对方掉线**：wait_for_turn 检测到 turn 已切出 >30 分钟但 `turn_claimed_at` 为空 → 返回 warning 提示对方可能已掉线。

**崩溃恢复**：每次启动全新开始（状态全内存）。崩溃恢复由用户主动触发——`confirm_task` 发现任务文档已有 `.pid` 文件时读取 workflow_id 并从 `handoff/` 恢复状态（phase、round、peers 身份、last_submit_per_turn）。peer 的角色（supervisor/developer）以 `confirm_task` 入参为准，不推断。恢复不自动扫描——`confirm_task` 是唯一恢复入口。

**crash loop 检测**：`uncaughtException` 中 30s 内 3 次崩溃 → 拒绝重启。

---

## 9. MCP 工具清单

| 工具 | 入参 | 出参 | 说明 |
|---|---|---|---|
| `ping` | 无 | `{ ok, uptime }` | 连通性检查。匿名可用 |
| `who_am_i` | 无 | `{ identity, registered, is_supervisor?, is_developer?, workflow_id? }` | 身份确认 + 注册信息。匿名可用（identity="unknown"） |
| `register` | `{ identity: string }` | `{ ok, identity, token, phase }` | IDLE 阶段注册身份。identity 从 body 取。不声明角色（角色移至 confirm_task）。返回 UUID `token`。入参校验失败返回 curl 格式参考。`tip` 详细列出 confirm_task 的 5 个入参（task_path/task_type/supervisor/developer/work_dir）及含义 |
| `confirm_task` | `{ task_path, task_type?, supervisor, developer, work_dir }` | `{ task_path, workflow_id, phase, recovered }` | 确认任务文档并声明角色。两个 AI 使用相同 task_path 自动成对（最多双方加入，校验角色唯一性和 work_dir 一致性）。读 `.pid` 文件恢复未完成工作流。绑定 token→workflowId。`tip` 分场景：创建→等待对方加入；加入→双方已就位；已有身份→重新加入。后续所有工具通过 token 路由到对应工作流 |
| `advance` | 无 | `{ ok, new_phase, turn, sub_phase? }` | 推进到下一阶段。仅监督者可用，**且需 `turn === "idle" \|\| turn === identity`**——监督者只能在自己 turn 时推进，防止跳过对方审阅轮。各 phase 转换规则同上。**需求模式**（`task_type === "requirements"`）下 REQUIREMENTS 直接跳到 SUMMARY，跳过 PLANNING/IMPLEMENTATION。SUMMARY→IDLE 时要求至少一次 summary submit，删除 `.pid` 文件，清空 peers。`tip` 使用 `[行动]`/`[产出]`/`[当前]` 三层格式，turn 归属用自然语言（`turnIsSelf` 判断，不再硬编码"对方"），IDLE 结束包含归档位置和重新开始指引 |

| `wait_for_turn` | 无 | `{ turn, phase, round, warning? }` | 长轮询等待 turn 切换。10s 间隔，600s 超时。turn 到达时自动记录 `turn_claimed_at`（替代原 `claim_turn`），返回 `[行动]/[产出]/[当前]` 三层完整指引。**超时(600s)或掉线(30min)时不再建议继续轮询，改为建议向用户报告当前状态** |
| `get_state` | 无 | `{ tip }` | 返回当前执行指引。`tip` 使用 `[行动]`/`[产出]`/`[当前]` 三层自然语言格式（由 `buildTip()` 生成） |
| `submit` | `{ file_path, git_commit_hash }` | `{ ok, next_turn }` | 提交产出。校验 turn 持有者、git_commit_hash 与上次提交不同，记录到 last_submit_per_turn（含 file_path），round+1 并切换 turn。自动在产出文件同目录生成 `.meta.json`（submitted_at、commit_hash、sub_phase、task），无需 AI 手动创建。IMPLEMENTATION 阶段 submit 后 sub_phase 在 coding ↔ review 交替。`tip` 中的身份标签复用 `tip.ts` 的 `identityLabel()`——单一来源，不再重复推断角色 |
| `get_archived_files` | `{ phase?, workflow_id? }` | `{ files[] }` | 列出归档文件。`phase` 可选过滤（requirements/planning/implementation/summary）；`workflow_id` 可选过滤，不传默认当前工作流。均不传返回当前工作流全量 |
| `get_archived_file_content` | `{ filename, phase? }` | `{ content }` | 读取归档文件内容。`phase` 可选过滤（requirements/planning/implementation/summary），不传默认当前 phase。文件存储在 `handoff/{workflow_id}/{phase}/` 子目录下，PairFlow 在指定或当前 phase 子目录中查找 |

---

## 10. Tip 格式规范

所有工具的 `tip` 字段遵循统一的 `[行动]/[产出]/[当前]` 三层自然语言格式。

### 10.1 三层结构

```
[行动] <一句话行动指令，不含提交参数>
[产出] 完成后 git commit，调用 submit，file_path = <POSIX 路径>
[当前] 你是 <identity>（<role>）。当前是第 <n> 轮<阶段名>，<turn 归属>。
```

- **`[行动]`**：只描述当前该做什么。不含路径、不含提交指令、不含上下文状态
- **`[产出]`**：产出文件路径（POSIX 正斜杠）+ 提交流程。advance 中按 `turnIsSelf` 区分"你将产出到" / "{对方}将产出到"。wait_for_turn 无此层
- **`[当前]`**：自然语言描述——你是谁、第几轮、什么阶段、轮到谁。**不用管道符分隔**，用完整句子

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
- `outFile(state, identity)` — 生成产出文件路径
- `phaseLabel(phase, subPhase)` — phase + sub_phase → 中文阶段名

`identityLabel(state, identity)` 同时导出供 `submit` 复用角色标签，避免 submit.ts 与 tip.ts 维护两套角色推断逻辑。

### 10.4 路径统一

所有 tip 和返回值中的路径统一使用 POSIX 正斜杠（`.replace(/\\/g, "/")`），避免 Windows 反斜杠在 JSON 响应中被转义为 `\\` 导致 AI 解析混乱。

---

## 11. Phase 初始化行为

各 phase advance 时重置 `round=1`，重置 `last_submit_per_turn={}`，`turn_switched_at` 和 `turn_claimed_at` 清空。

| Phase | turn |
|------|------|
| REQUIREMENTS | 非监督者（`identity !== supervisor`） |
| PLANNING | 评审者（`is_developer=false`） |
| IMPLEMENTATION | 开发者（`is_developer=true`），`sub_phase=coding` |
| SUMMARY | 监督者 |
| IDLE | `idle`，`peers=[]` |

> handoff/ 目录下产出文件与 meta.json 作为永久归档保留，不随 IDLE 清理。

---

## 12. 假设与降级

| 假设 | 状态 |
|---|---|
| 客户端支持自定义 HTTP header（`X-AI-Identity`） | ⚠️ 接入前提。不支持则无法接入 PairFlow |
| 两个 AI 均支持 MCP client 模式 | ⚠️ 接入前提。不支持则无法接入 PairFlow |
| 项目使用 git + AI 具备 git 操作能力 | ⚠️ 接入前提。commit_hash 是不可或缺的 traceability 保障 |
| 结对编程（互审 + 互产）比单 AI 自审更优 | ⚠️ 假设。交替审阅模型通过周期性轮换保持发现能力 |
| localhost-only 无认证，每个身份最多一个活跃实例 | ⚠️ 设计假设 |

---


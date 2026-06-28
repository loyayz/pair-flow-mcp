# PairFlow: 双 AI 结对编程工作流引擎

> 设计日期: 2026-06-21

---

## 1. 目标与范围

构建一个本地 HTTP MCP Server，驱动两个 AI 按照结构化工作流完成结对编程。不绑定具体 AI 产品——两端通过 HTTP header 自报身份，PairFlow 不预设"谁是谁"。

工作流覆盖从需求到交付的完整软件开发生命周期，包含四阶段主流程：需求阶段 → 计划阶段 → 开发阶段 → 汇总阶段（其中开发阶段内部含 coding→review→fix 子循环，对应四个状态机 phase：REQUIREMENTS/PLANNING/IMPLEMENTATION/SUMMARY）。任一阶段出现 P0 分歧时由监督者与用户沟通裁定。

**核心定位**：结对编程的工作流引擎——持续互审 + 知识共享 + 方案互补。两个 AI 在同一工作流中交替产出与评审，减少单人偏差。

**监督者**：IDLE 阶段由用户从两个 AI 中指定。监督者控制流程推进（`advance`）、处理 P0 升级、在 IMPLEMENTATION 收敛前拥有一票异议权、SUMMARY 阶段负责汇总报告。

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
│  状态机 + 模板引擎 + 收敛判定引擎                    │
│  .pairflow/（运行时: state.json + lock + pairflow.log）│
│  handoff/{workflow_id}/（归档: 产出 + journal）     │
│                                                  │
│  MCP Tools: ping / who_am_i / register            │
│            get_state / claim_turn / submit          │
│            get_archived_files / ...                 │
│            confirm_dir / confirm_task / advance     │
│            wait_for_turn / get_archived_file_content│
└──────────────────────────────────────────────────┘
```

- **两个 AI**：在 IDLE 阶段注册身份和角色，后续按阶段参与协作
- **监督者**：AI 之一兼任，控制 `advance` + P0 沟通 + 最终异议 + SUMMARY 汇总
- **PairFlow**：中立调度方。MCP 工具对称（两边可调用相同接口），状态变更持进程级互斥锁，state.json 原子写入

---

## 3. 目录结构

`project/` = git 仓库根目录。运行时文件（每次操作会修改，无版本管理价值）置于 `.pairflow/` 隐藏目录并加入 `.gitignore`；归档产出（协作过程权威记录，纳入版本管理）置于仓库根 `handoff/`。

state.json 是运行时缓存（崩溃后可重建），handoff/ 下的 meta.json + 产出文件是权威来源。崩溃恢复从 handoff/ 重建 state.json（见 §8）。运行时文件无版本管理价值（.pairflow/），归档文件有版本管理价值（handoff/，git 提供追溯+备份）。

```
project/                                         ← git 仓库根
├── .pairflow/                                   ← 运行时文件（.gitignore，不纳入版本管理）
│   ├── state.json                               ← 运行时状态（原子写入，非作者性，崩溃后可重建）
│   ├── lock                                     ← 进程级锁（PID + 启动时间戳 + nonce，进程特定）
│   └── pairflow.log                               ← 运行日志（JSONL，每操作一行，调试用）
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

**启动流程**：
1. 清除上一任务的运行时缓存（`rm -rf .pairflow/`）
2. 获取进程互斥锁（`.pairflow/lock`，PID + 时间戳 + nonce，防多实例）
3. 监听 `localhost:3100`，提供 HTTP MCP（`/mcp`）+ 健康检查（`GET /health`）
4. 接收 SIGTERM/SIGINT → 释放锁 → 退出
5. `uncaughtException` crash loop 检测：30s 内 3 次 → 拒绝重启

**多工作流支持**：每个工作流（IDLE→...→SUMMARY→IDLE 完整周期）在 `handoff/{workflow_id}/` 下独立归档。`workflow_id` 由 confirm_task 时生成（`yyyyMMddHHmmss` 格式，保证唯一+可排序）。不同任务分属不同 workflow_id 目录，互不覆盖。

---

## 4. 数据流

### 启动与注册

```
非监督者                          监督者
  │                                │
  │  register({                    │
  │    supervisor:false,           │
  │    developer:true,             │
  │    work_dir:"/project"         │
  │  })                            │
  ├───────────────────────────────►│
  │◄── { ok, identity,             │
  │      is_supervisor:false,      │
  │      is_developer:true,        │
  │      phase:"idle",             │
  │      tip:"Set X-AI-Identity:   │
  │        xxx header...           │
  │        下一步调用 wait_for_turn   │
  │        接口" }                  │
  │                                │
  │                                │  register({
  │                                │    supervisor:true,
  │                                │    developer:false,
  │                                │    work_dir:"/project"
  │                                │  })
  │                                ├───────────────────────────────►
  │                                │◄── { ok, identity,
  │                                │      is_supervisor:true,
  │                                │      is_developer:false,
  │                                │      phase:"idle",
  │                                │      tip:"Set X-AI-Identity:
  │                                │        xxx header...
  │                                │        下一步调用 confirm_dir
  │                                │        确认工作目录 /project" }
```

### 监督者确认工作流

```
监督者
  │
  │  confirm_dir({ work_dir:"/project" })
  ├───────────────────────────────►
  │◄── { work_dir, incomplete_workflows:[],
  │      tip:"当前身份: xxx(supervisor)。无未完成工作流。
  │           下一步调用 confirm_task 确认任务文档" }
  │      // 若有未完成工作流，tip 会列出 ID+task_path+A/B 选项
  │
  │  confirm_task({ task_path:"docs/task/xxx.md" })
  ├───────────────────────────────►
  │  PairFlow: 检查 {task}.pid → 存在则从 handoff 恢复状态
  │◄── { task_path, workflow_id, phase, recovered }
  │
  │  [全新任务]                     [恢复任务]
  │  tip:"已确认任务文档: xxx，      tip:"已恢复工作流 xxx，
  │        工作流 ID: xxx。               当前阶段: xxx，轮次: xxx。
  │        当前身份: xxx(supervisor)。    turn 归属: xxx(你/对方)。
  │        请向用户复述以上信息，          请向用户复述恢复状态，
  │        待用户确认后调用 advance。"     确认后调用 claim_turn/wait_for_turn。"
  │        ↓                              ↓
  │  advance({})                    wait_for_turn/claim_turn
  ├───────────────────────────────►
  │◄── { new_phase:"requirements",
  │      turn:"<非监督者>",
  │      tip:"阶段已推进到 requirements，turn 已切给 xxx(对方)。
  │           当前身份: xxx(supervisor)。请等待对方产出需求分析。
  │           调用 wait_for_turn 接口。" }
```

**身份判定**：
- HTTP header `X-AI-Identity: <自报名称>`
- 无有效 header → `"unknown"`，仅 `ping` / `who_am_i` 可用
- 注册后 `tip` 明确告知 `Set X-AI-Identity: {identity} header on all subsequent requests`

---

## 5. 状态机

### 5.1 state.json Schema

```jsonc
{
  "schema_version": 1,
  "workflow_id": null,          // confirm_task 时生成（yyyyMMddHHmmss）
  "phase": "idle | requirements | planning | implementation | summary",
  "sub_phase": "coding | review | null",
  "dev_cycle": null,            // 当前开发循环序号，每次 advance → IMPLEMENTATION 时 +1
  "round": 1,                   // 当前阶段内的轮次
  "turn": "idle | <identity>",  // 当前持有操作权的身份
  "turn_switched_at": null,     // turn 切换时间戳（submit 时写入）
  "turn_claimed_at": null,      // claim_turn 时间戳（对方掉线检测用）
  "task": {                     // confirm_task 时写入
    "spec_file": "string"
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
      "submitted_at": "ISO8601"
    }
  },
  "history": [
    {
      "type": "phase_change | submit",
      "timestamp": "ISO8601",
      "details": { ... }
    }
  ],
}
```

### 5.2 Phase 转换

```
IDLE ──→ REQUIREMENTS ──→ PLANNING ──→ IMPLEMENTATION ──→ SUMMARY
```

- IDLE → REQUIREMENTS：两端 register 后，监督者调 `advance`（peers≥2 + task 已确认 → turn 切给非监督者）
- REQUIREMENTS → PLANNING：监督者调 `advance` → turn 切给评审者（`is_developer=false`）
- PLANNING → IMPLEMENTATION：监督者调 `advance` → turn 切给开发者，`sub_phase=coding`
- IMPLEMENTATION 阶段每次 `submit` 后 `sub_phase` 在 coding ↔ review 之间交替切换，turn 随之切换给另一方。coding 仅开发者可 submit，review 仅评审者可 submit
- IMPLEMENTATION → SUMMARY：监督者调 `advance` → turn 切给监督者
- SUMMARY → IDLE：监督者调 `advance` → 工作流结束
- IDLE 是初始/终结态
- **advance 仅监督者可调**，非监督者 advance → 拒绝

### 5.3 Turn 切换

- submit 后 `round += 1`，turn 切给对方
- advance 到新 phase 后 `round = 1`，turn 按 phase 初始化
- wait_for_turn 检测到 `turn === identity` 时返回，AI 调 claim_turn 确认
- claim_turn 记录 `turn_claimed_at` 时间戳，服务端据此检测对方是否掉线（>30 分钟未领取）

## 6. 收敛

监督者手动判定。各阶段交替审阅后，监督者确认阶段目标已达成（无未决议题、不能有双方同意延后的内容），调用 `advance` 推进。

## 7. Issue 系统

PairFlow 不维护独立的 issue 跟踪系统。双方在产出文档中通过标注管理观点差异，监督者在 advance 前检查争议是否已解决。

## 8. 异常处理

**对方掉线**：wait_for_turn 检测到 turn 已切出 >30 分钟但 `turn_claimed_at` 为空 → 返回 warning 提示对方可能已掉线。

**崩溃恢复**：启动时清 `.pairflow/`，每次全新开始。若任务文档已有 `.pid` 文件，confirm_task 时读取 workflow_id 并从 `handoff/` 恢复状态。

**crash loop 检测**：`uncaughtException` 中 30s 内 3 次崩溃 → 拒绝重启。

---

## 9. MCP 工具清单

| 工具 | 入参 | 出参 | 说明 |
|---|---|---|---|
| `ping` | 无 | `{ ok, uptime }` | 连通性检查。匿名可用 |
| `who_am_i` | 无 | `{ identity, registered, is_supervisor?, is_developer? }` | 身份确认 + 注册信息。匿名可用（identity="unknown"） |
| `register` | `{ supervisor: bool, developer: bool, work_dir: string }` | `{ ok, identity, is_supervisor, is_developer, phase }` | IDLE 阶段注册。仅 IDLE 下可用。identity 已存在 → 拒绝。supervisor/developer 各唯一但可兼任。work_dir 必填，双方校验一致性。`tip` 包含身份标签 + role 标注；监督者 tip 显式注明 `confirm_dir` 的 `work_dir` 参数 |
| `confirm_dir` | `{ work_dir: string }` | `{ work_dir, incomplete_workflows[] }` | 确认工作目录，返回未完成的工作流列表（含 task_path）。仅监督者在 IDLE 阶段可用。`tip` 按是否有未完成工作流分支：有→列出 ID+task_path+A/B 选项（恢复/新建）；无→简洁确认 |
| `confirm_task` | `{ task_path: string }` | `{ task_path, workflow_id, phase, recovered }` | 确认任务文档路径。在任务文档同目录创建 `{文档名}.pid` 文件存储 workflow_id。若 `.pid` 已存在 → 从 handoff 恢复流程状态，返回 `recovered:true`；否则全新开始。仅监督者在 IDLE 阶段可用。`tip` 按新建/恢复分支，均包含身份标签；指引 AI 先向用户报告状态再操作；恢复时按 `turn===identity` 区分 claim_turn vs wait_for_turn |
| `advance` | 无 | `{ ok, new_phase, turn, sub_phase? }` | 推进到下一阶段。仅监督者可用。各 phase 转换规则同上。`tip` 包含当前身份 + turn 归属 + 等待/行动指引 |
| `claim_turn` | 无 | `{ ok }` | 获取当前轮次的执行权。仅在自己 turn 时可用。记录 `turn_claimed_at`。`tip` 包含身份标签 + 动态执行指引（按 phase+round） |
| `wait_for_turn` | 无 | `{ turn, phase, round, warning? }` | 长轮询等待 turn 切换。10s 间隔，600s 超时。`tip` 在 turn=自己 / 掉线警告 / 超时三种场景均包含身份标签 |
| `get_state` | 无 | `{ tip }` | 返回当前执行指引。`tip` 包含身份标签 + turn 归属 + 动态执行指引（按 phase+round） |
| `submit` | `{ file_path, git_commit_hash }` | `{ ok, next_turn }` | 提交产出。校验 turn 持有者、git_commit_hash 与上次提交不同，记录到 last_submit_per_turn，round+1 并切换 turn。`tip` 包含当前身份 + turn 归属 + 按角色分场景指引 |
| `get_archived_files` | `{ phase?, workflow_id? }` | `{ files[] }` | 列出归档文件。`phase` 可选过滤（requirements/planning/implementation/summary）；`workflow_id` 可选过滤，不传默认当前工作流。均不传返回当前工作流全量 |
| `get_archived_file_content` | `{ filename, phase? }` | `{ content }` | 读取归档文件内容。`phase` 可选过滤（requirements/planning/implementation/summary），不传默认当前 phase。文件存储在 `handoff/{workflow_id}/{phase}/` 子目录下，PairFlow 在指定或当前 phase 子目录中查找 |

---

## 10. Phase 初始化行为

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

## 11. 假设与降级

| 假设 | 状态 |
|---|---|
| 客户端支持自定义 HTTP header（`X-AI-Identity`） | ⚠️ 接入前提。不支持则无法接入 PairFlow |
| 两个 AI 均支持 MCP client 模式 | ⚠️ 接入前提。不支持则无法接入 PairFlow |
| 项目使用 git + AI 具备 git 操作能力 | ⚠️ 接入前提。commit_hash 是不可或缺的 traceability 保障 |
| 结对编程（互审 + 互产）比单 AI 自审更优 | ⚠️ 假设。交替审阅模型通过周期性轮换保持发现能力 |
| localhost-only 无认证，每个身份最多一个活跃实例 | ⚠️ 设计假设 |

---


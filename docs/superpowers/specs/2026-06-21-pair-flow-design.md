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
│            get_context / create_issue / resolve_issue│
│            escalate / list_issues / force_converge  │
│            get_archived_files / ...   │
└──────────────────────────────────────────────────┘
```

- **两个 AI**：在 IDLE 阶段注册身份和角色，后续按阶段参与协作
- **监督者**：AI 之一兼任，控制 `advance` + P0 沟通 + 最终异议 + SUMMARY 汇总
- **PairFlow**：中立调度方。MCP 工具对称（两边可调用相同接口），状态变更持进程级互斥锁，state.json 原子写入

---

## 3. 目录结构

`project/` = git 仓库根目录。运行时文件（每次操作会修改，无版本管理价值）置于 `.pairflow/` 隐藏目录并加入 `.gitignore`；归档产出（协作过程权威记录，纳入版本管理）置于仓库根 `handoff/`。

**依据**（§8 权威来源声明）：state.json 是"非作者性，崩溃后丢弃"的缓存，meta.json + journal 才是权威来源。崩溃恢复不依赖 state.json 版本管理——从 handoff/ 的 meta.json + journal 重建。因此：运行时文件无版本管理价值（.pairflow/），归档文件有版本管理价值（handoff/，git 提供追溯+备份）。

```
project/                                         ← git 仓库根
├── .pairflow/                                   ← 运行时文件（.gitignore，不纳入版本管理）
│   ├── state.json                               ← 运行时状态（原子写入，非作者性，崩溃后可重建）
│   ├── lock                                     ← 进程级锁（PID + 启动时间戳 + nonce，进程特定）
│   └── pairflow.log                               ← 运行日志（JSONL，每操作一行，调试用）
├── handoff/                                     ← 归档产出（纳入版本管理）
│   └── {workflow_id}/                           ← 每个工作流独立目录（workflow_id = IDLE→REQUIREMENTS 时刻的 yyyyMMddHHmmss）
│       ├── requirements/                        ← 需求阶段
│       │   ├── r1_{identity}.md                     ← 每轮独立文件
│       │   ├── r1_{identity}.meta.json
│       │   ├── r2_{identity}.md
│       │   ├── r2_{identity}.meta.json
│       │   ├── ...
│       │   ├── {identity}_final_diff.md            ← 监督者阶段报告（每 phase 产出）
│       │   ├── {identity}_advance_checklist.md         ← advance 前全面通读清单（B 确认后 advance，见 §5.3 "advance 前置条件"）
│       ├── planning/                            ← 计划阶段（文件命名同 requirements/：r{round}_{identity}.md + .meta.json + {identity}_final_diff.md + {identity}_advance_checklist.md）
│       ├── implementation/                      ← 开发阶段（含多 dev_phase 循环）
│       │   ├── {dev_phase}_{timestamp}_{identity}_coding.md
│       │   ├── {dev_phase}_{timestamp}_{identity}_coding.meta.json
│       │   ├── {dev_phase}_{timestamp}_{identity}_review.md
│       │   ├── {dev_phase}_{timestamp}_{identity}_review.meta.json
│       │   ├── {dev_phase}_{timestamp}_{identity}_fix.md
│       │   ├── {dev_phase}_{timestamp}_{identity}_fix.meta.json
│       │   ├── {identity}_final_diff.md            ← 监督者阶段报告（每 phase 产出）
│       │   └── {identity}_advance_checklist.md         ← advance 前全面通读清单（见 §5.3 "advance 前置条件"）
│       ├── summary/                             ← 汇总阶段
│       │   ├── {timestamp}_{identity}_summary.md
│       │   ├── {timestamp}_{identity}_summary.meta.json
│       │   ├── {identity}_final_diff.md            ← 监督者阶段报告（SUMMARY phase 修改记录）
│       │   ├── {identity}_advance_checklist.md         ← advance 前全面通读清单（见 §5.3 "advance 前置条件"）
│       │   └── {timestamp}_{supervisor}_final.md
│       └── issues-journal.jsonl                   ← issue 变更日志（append-only，per-workflow）
```

**启动流程**：
1. 清除上一任务的运行时缓存（`rm -rf .pairflow/`）
2. 获取进程互斥锁（`.pairflow/lock`，PID + 时间戳 + nonce，防多实例）
3. 监听 `localhost:3100`，提供 HTTP MCP（`/mcp`）+ 健康检查（`GET /health`）
4. 接收 SIGTERM/SIGINT → 释放锁 → 退出
5. `uncaughtException` crash loop 检测：30s 内 3 次 → 拒绝重启

**多工作流支持**：每个工作流（IDLE→...→SUMMARY→IDLE 完整周期）在 `handoff/{workflow_id}/` 下独立归档。`workflow_id` 由 IDLE→REQUIREMENTS 推进时生成（`yyyyMMddHHmmss` 格式，保证唯一+可排序）。第二个需求的 r1 不会覆盖第一个需求——分属不同 workflow_id 目录。`next_issue_id` 跨工作流保留（全局唯一，存于 state.json）；issues 本身不跨工作流（IDLE 初始化 issues=[]），journal 为 per-workflow。

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
  │      tip:"下一步调用 confirm_task 确认任务文档" }
  │
  │  confirm_task({ task_path:"docs/task/xxx.md" })
  ├───────────────────────────────►
  │  PairFlow: 检查 {task}.pid → 存在则从 handoff 恢复状态
  │◄── { task_path, workflow_id, phase, recovered }
  │
  │  [全新任务]                     [恢复任务]
  │  tip:"下一步调用 advance        tip:"任务已恢复，当前阶段:
  │        接口进入需求阶段"              {phase}。下一步调用
  │                                     wait_for_turn 接口"
  │        ↓                              ↓
  │  advance({})                    wait_for_turn
  ├───────────────────────────────►
  │◄── { new_phase:"requirements",
  │      turn:"<非监督者>",
  │      tip:"下一步调用 wait_for_turn
  │           接口" }
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
  "schema_version": 1,             // schema 版本。变更时旧 state.json 视为不可读，走 §8 崩溃恢复路径从 handoff/ 重建（v1 不设迁移脚本）
  "workflow_id": null,          // 当前工作流 ID（IDLE→REQUIREMENTS 时生成 yyyyMMddHHmmss；IDLE 阶段为 null）
  "next_issue_id": 1,           // 单调递增，永不重置（跨工作流保留）
  "phase": "idle | requirements | planning | implementation | summary",
  // 注：正文使用大写（IDLE/REQUIREMENTS/...）为人类可读名称，schema 中为小写
  "sub_phase": "coding | review | null",
  "dev_phase": null,            // IMPLEMENTATION 阶段开发里程碑序号（0 起始，每循环收敛后自增；非 IMPLEMENTATION 为 null）。循环次数在计划阶段定义
  "round": 1,
  "turn": "idle | <identity_a> | <identity_b>",
  "converged": false,
  "peers": [
    {
      "identity": "claude-fable",     // AI 自报
      "role": "supervisor",           // "supervisor" | "peer"
      "is_developer": false,          // IMPLEMENTATION 阶段开发者标记
      "registered_at": "ISO8601"
    },
    {
      "identity": "gpt5",
      "role": "peer",
      "is_developer": true,
      "registered_at": "ISO8601"
    }
  ],
  "last_submit_per_turn": {
    "<identity_a>": {
      "round": null,                     // 当前 submit 的 round 号（非 IMPLEMENTATION 为 null）
      "sub_phase": null,                 // 当前 submit 的 sub_phase（非 IMPLEMENTATION 为 null）
      "commit_hash": "abc123",
      "submitted_at": "ISO8601",
      "stance": "agree | disagree | require_clarification | null",  // 非 IMPLEMENTATION 为 null
      "need_next_round": null,                                       // 非 IMPLEMENTATION 为 null
      "new_issues": [1, 2]
    },
    "<identity_b>": { ... }
  },
  "issues": [
    {
      "id": 1,
      "type": "P0 | P1 | P2",
      "topic": "...",
      "description": "...",
      "raised_by": "<identity>",
      "phase": "requirements",
      "round": 2,
      "status": "open | resolved | escalated",
      "positions": {
        "<identity_a>": "...",
        "<identity_b>": "..."
      },
      "resolution": null,
      "resolved_by": "null | converged | supervisor_override | force_converge",
      "escalated_at": null,
      "fix_review_cycles": 0,
      "proposal": "string | null",     // P0/P1 必填（方案建议+理由），P2 可选。复杂方案需备选对比
      "rationale": "string | null"     // 引用 spec 具体章节作为论证依据
    }
  ],
  "history": [
    {
      "type": "phase_change | turn_change | submit | converge | force_converge | advance",
      "timestamp": "ISO8601",
      "details": { ... }
    }
  ],
  "pending_supervisor_review": false,   // IMPLEMENTATION 阶段监督者=开发者时，评审者 review 通过后置 true
  "current_lease": {
    "token": "uuid | null",
    "holder": "<identity> | null",
    "expires_at": "ISO8601 | null",
    "grace_used": false
  },
  "current_timeout": {
    "active": true,
    "started": "ISO8601",
    "expires": "ISO8601",
    "phase_config": {
      // IDLE 阶段由用户确认，无预设默认值
      "requirements": 10,
      "planning": 10,
      "implementation": 60,
      "summary": 30
    }
  }
}
```

### 5.2 Phase 转换

```
IDLE ──→ REQUIREMENTS ──→ PLANNING ──→ IMPLEMENTATION ──→ SUMMARY
```

- IDLE → REQUIREMENTS：两端 register 后，监督者调 `claim_turn(mode="advance")`
- 后续 advance：phase 收敛后，监督者调 `claim_turn(mode="advance")` 推进到下一 phase
- SUMMARY 收敛后 advance → IDLE（工作流结束）
- IDLE 是初始/终结态，无 `converged` 概念
- **advance 仅监督者可调**，非监督者 advance → 拒绝

**P0 升级处置**：P0 issue escalate 后 status 变为 `escalated`，监督者通过 `get_state`/`list_issues` 发现后与用户沟通，沟通后调 `resolve_issue` 处置。`force_converge` 作为监督者的紧急 override，所有 open issue → `resolved_by="force_converge"`。

### 5.3 Turn 转换

**IDLE 阶段**：
- turn=`idle`，直到两端 register + 监督者 advance → REQUIREMENTS，turn 初始化为非监督者 identity（首轮持笔者）

**需求阶段**（交替持笔模型）：

监督者在 IDLE 阶段与用户确认基础文档后 advance → REQUIREMENTS。首轮持笔者为**非监督者**（由非监督者对基础文档做第一轮评审）。

```
非监督者 持笔 ──→ submit r1（首轮评审基础文档）
        │
    监督者 持笔 ──→ submit r2（处理 r1 中自己同意的问题 + 本轮新发现的问题）
        │
    非监督者 持笔 ──→ submit r3（处理 r2 中自己同意的问题 + 自审 r1 中被对方驳回的遗留问题 + 本轮新发现的问题）
        │
      ... 循环 ...
        │
    无新问题 + 无 open P0 → 监督者 advance
```

**计划阶段**（交替持笔模型）：

需求阶段收敛后 advance → PLANNING。首轮持笔者为**评审者**（`is_developer=false`）——计划 = 评审标准，评审者制定计划草案以拥有 IMPLEMENTATION 阶段的评审依据。首轮行为为**产出**而非评审。

```
评审者（is_developer=false）持笔 ──→ submit r1（首轮产出计划草案，提出计划要点列表 I₁）
        │
    开发者（is_developer=true）持笔 ──→ submit r2（处理 r1 中自己同意的问题 + 本轮新发现的问题）
        │
    评审者（is_developer=false）持笔 ──→ submit r3（处理 r2 中自己同意的问题 + 自审 r1 中被对方驳回的遗留问题 + 本轮新发现的问题）
        │
      ... 循环 ...
        │
    无新问题 + 无 open P0 → 监督者 advance
```

> 持笔者映射：监督者=评审者时，计划阶段首轮=评审者=监督者；监督者=开发者时，计划阶段首轮=评审者=非监督者。两种情况下评审者均为首轮持笔者，职责一致。后续交替轮次按持笔切换规则继续，模式为"处理对方问题 + 自审遗留 + 新评审"。

**交替评审核心规则**：

**问题处置由对方修改**：任何一方提出的问题，必须双方都同意才能关闭，且由**对方**执行修改——提出者不修改自己提的问题。此约束对所有持笔者平等适用，不因监督者身份豁免——监督者持笔时提出的 issue，由非监督者在下一持笔轮执行 spec 修改。**正式阶段 PairFlow 强制校验**：submit 时若 `resolved_issue_ids` 包含 `raised_by = 当前持笔者` 的 issue → 拒绝（"issue #N was raised by you; the other party must land the spec change"）。

逐轮详解（以监督者=A，非监督者=B 为例。**需求阶段**：B 为首轮持笔者；**计划阶段**：评审者为首轮持笔者——当监督者=评审者时首轮为 A，当监督者=开发者时首轮为 B。下表以需求阶段 B 首轮为例）：

| 轮次 | 持笔者 | 产出 | 做什么 |
|---|---|---|---|
| r1 | B | 首轮评审 | B 评审基础文档，提出问题列表 I₁ |
| r2 | A | 回复 + 新评审 | A 逐条处理 I₁：**同意**的问题 → A 修改文档并标记 resolved；**不同意**的问题 → A 标注立场（disagree）保持 open。同时 A 对修改后的文档继续评审，发现新问题 I₂ |
| r3 | B | 回复 + 自审 + 新评审 | B 逐条处理 I₂（同上）。同时**自审** I₁ 中被 A 驳回的遗留问题：坚持则保持 open 并补充论据，认可 A 的驳回则标记 resolved。发现新问题 I₃ |
| r4 | A | 同上模式 | 处理 I₃ + 自审 I₂ 遗留 + 新问题 I₄ |
| ... | ... | ... | 循环直到无新问题且无 open P0 |

**关键约束**：
- B 在 r3 中**不修改**自己在 r1 中提出的问题（由 A 在 r2 中已处理）
- A 在 r4 中**不修改**自己在 r2 中提出的问题（由 B 在 r3 中已处理）
- 遗留问题的自审是对"对方为什么驳回我"的回应——补充论据坚持，或认可对方后关闭
- **disagree 建设性义务**：disagree 必须配替代方案+理由，不能单纯否定。纯否定无替代方案的 disagree → 视为 `require_clarification`（要求澄清），立场降级。笔误/遗漏类问题（如字段名拼写错误、文件名残留）不适用——直接修复即可
- turn 表示"当前持笔者"，每轮持笔者 submit 后自动切换到对方
- **强制审阅范围声明**：每轮 submit 必须包含"本轮审阅范围"段落——列出重新通读的章节、本次修改涉及的章节、未重新审阅的章节及原因。PairFlow 层面硬约束：submit 时无此段落 → 拒绝。审阅明显敷衍的 → 对方提 P1 追问
- **round 语义**：需求/计划阶段 round 为 per-pair（双方各提交一次 = 同一 round）。B 提交 r1 → round 保持 1（A 提交 r2 后 round 自增为 2）。文件名 `r1/r2/r3/r4` 为 submit 序号，与 round 值一一对应。此设计与 §7"round 匹配仅 IMPLEMENTATION 适用"一致
- 收敛条件：双方在最新提交中均未提出新问题（`new_issues` 为空）+ 无 open P0 + 无 escalated issue
- **双方审查义务**（无论持笔者角色）：每轮除处理对方问题和自审遗留外，必须：(a) 验证对方修复是否到位；(b) 追问对方声明的"未审阅"章节理由——是时间不够、修改幅度小、还是疏忽；(c) 若对方未列审阅范围，退回补审而非继续
- **方案交换轮次**：设计类问题（非笔误/遗漏）的 disagree 后，双方应各自出方案+理由，比较讨论后选优或合并，而非"一方提修正，另一方 yes/no"。笔误/遗漏类直接修复不适用

**推进下一阶段（advance）的三分判断**（仅监督者执行）：

> **advance 前置条件**：
> 1. 所有 spec 修改均已经对方在评审文档中确认。未确认的修改不得带入下一阶段——要么撤回修改，要么继续讨论等对方确认。
> 2. **监督者全面通读义务**（可验证性升级，见本节"可验证形式"）：监督者在调 advance 前，必须对 spec 全文做一次独立通读，确认所有字段/段落/数据流图/模板定义完整且自洽。仅靠对方无异议不等于 spec 完整——监督者对最终交付质量负责。
>
>    **可验证形式（v2：随机引用+随机抽查）**：监督者必须在 advance 前的最后一个持笔轮中提交**全面通读清单**（`{identity}_advance_checklist.md`），归档到 `handoff/{workflow_id}/{phase}/`。
>
>    PairFlow 在 `claim_turn(mode="advance")` 返回的 checklist 模板中为每节预填一个**随机行号**（在 spec 文件有效行号范围内）。监督者必须为每节填写"该位置内容概述"——不读那一行就填不出。PairFlow 校验行号有效性。
>
>    ```
>    ## advance 前全面通读
>
>    | § | 随机位置 | 该位置内容（由你填写） | 验证重点 | 状态 |
>    |---|---|---|---|---|
>    | 1 | L{{random}} | <概述该行内容，1-2 句话，证明你读了> | <从 rules_catalog 聚合> | ✅/⚠️ |
>    | ... | ... | ... | ... | ... |
>    ```
>
>    （共 §1–§16 共 16 节）
>
>    **随机抽查验证流程**：
>    1. 监督者填完 checklist 提交
>    2. PairFlow 从 16 节中随机抽取 3 节，通知非监督者
>    3. 非监督者打开 spec 被抽查的 3 个行号，核对监督者填写的"该位置内容概述"是否与 spec 实际内容吻合
>    4. 3/3 通过 → checklist 确认；任 1 节不通过 → 退回重写（重新随机 3 节）。连续 2 次失败 → escalate（监督者未尽责，P0 处理）
>    5. 争议时引用 spec 原文比对，以原文为准
>
>    **抽查博弈约束**：监督者不知道哪 3 节会被查，理性策略是通读全部 16 节。若只读少量节碰运气，命中率 3/16≈19%, 失败概率高 + escalate 风险，通读是最优策略。
>
>    - **验证重点来源**：从 rules_catalog（§11）按 `spec_ref` 聚合派生，非监督者自定义——避免选择性验证
>    - **状态标注**：逐节标注 ✅（完整自洽）或 ⚠️（发现问题）。若某节标 ⚠️，必须说明发现的问题或附对应的新 issue
>    - **与 final_diff 的关系**：清单是独立产出（advance 前置验证，当前性），与 final_diff（阶段修改记录，回顾性）并列，不合并
>
>
>    ```
>
>    | § | 节名 | 审视结论 | 理由 |
>    |---|---|---|---|
>    | 1 | 目标与范围 | 无新问题 / 发现 Px-N | <发现的具体问题，或"无新问题"的具体依据> |
>    | ... | ... | ... | ... |
>    ```
>
>    - **逐节审视**：对 spec 每一节（§1–§16）提交审视结论，不允许跳节。仅写"已在前序轮次覆盖"视为无效理由——必须给出本节当前无问题的具体依据
>
>    - advance_checklist：**验证导向**，监督者单方执行，目的是确认 spec 完整自洽
>

| 情况 | 条件 | 行为 |
|---|---|---|
| ① 干净收敛 | 无 open P0 + 无被强关的僵持 issue | 监督者直接 `advance` |
| ② 遗留强关 | 无 open P0 + 存在被 `force_converge` 或监督者 `resolve_issue` 强关的 issue | 监督者自行判断问题大小：可 advance 也可继续讨论。**若 advance，必须在阶段报告中重点标注强关 issue 及其原因** |
| ③ 有 P0 | 存在 open P0 | 监督者与用户沟通：用户裁定继续讨论 → 回到交替评审循环；用户裁定 advance → 监督者逐条 resolve P0（→ ①）或调 force_converge（→ ②）强关所有 open issue 后 advance |

> 强关 issue 追踪：`resolve_issue` 由监督者调用时若 issue 对方立场为 disagree，标记 `resolved_by="supervisor_override"`；`force_converge` 标记 `resolved_by="force_converge"`。两种标记在 SUMMARY 阶段报告中必须逐条列出。

**阶段报告内容规范**：

每个 phase 收敛后监督者 advance 前，产出该 phase 的阶段报告（`{identity}_final_diff.md`），归档到 `handoff/{workflow_id}/{phase}/`。报告必须包含五节：

1. **阶段总览**：轮次数、发现总数、角色分配（监督者/非监督者、开发者/评审者）
2. **新增机制与模块**：按类别分组（新增字段/schema、新增流程/工具、新增约束），每项标注触发轮次
3. **澄清与修正**：修改了什么、为什么改、原逻辑与新逻辑的差异
4. **工具变更**：哪些工具入参/出参/权限变了
5. **从实践到规则**：本阶段是否有从违规/失误中抽象出的新规则（如审阅范围声明、落地声明义务等）

**产出时机**：每个 phase（requirements/planning/implementation/summary）都产出，非仅需求阶段。**时序约束**：final_diff 必须在 advance_checklist 经对方确认后、advance 前产出。理由：advance_checklist 是 advance 前置验证（当前性），若对方审查 checklist 时发现新问题（某节 ⚠️）→ 收敛被打破 → 已写好的 final_diff 中"阶段总览""新增机制"等统计数据失效 → 需重写。final_diff 作为阶段终态报告，应在阶段**真正终结**（checklist 确认通过）时产出，而非用"候选终态"写"终态报告"。

**与 SUMMARY 总结报告的关系**：final_diff 是 phase 级报告（记录该 phase 修改），SUMMARY 阶段的总结报告/汇总报告是工作流级报告（全流程回顾）。两者层级不同，职责不同。SUMMARY 阶段也产出自己的 final_diff（记录 SUMMARY phase 本身的修改），同时监督者额外产出工作流级汇总报告。

**校验**：未按此结构组织 → 对方可退回要求重写。不涉及 PairFlow 硬校验（软约束，依赖对方审查）。

**IMPLEMENTATION 阶段**（开发者/评审者模型）：
```
开发者 coding ──→ 评审者 review ──→ 开发者 fix ──→ 评审者 review ──→ ...
        │
    收敛 → 监督者异议检查 → advance 或 escalate
```

- 开发者 = register 时 `is_developer=true` 的 AI
- 评审者 = 另一方
- sub_phase: `coding → review → fix → review → ... → converge`
- 收敛条件（沿用）：同 round 双方 stance=agree + need_next_round=false + 无 open P0 + 无 escalated issue
- 监督者异议权：
  - 监督者 = 评审者：走标准收敛条件
  - 监督者 = 开发者：评审者 review 通过后，监督者有一次最终 review，无异议 → 收敛，有异议 → escalate

**IMPLEMENTATION 多循环支持**：

IMPLEMENTATION 阶段可包含多个 `dev_phase` 循环（开发里程碑），每个循环内部是 `coding → review → fix → ... → converge` 子流程。

- **循环结构**：每个 dev_phase 循环收敛后（`converged=true`），`dev_phase` 自增，`converged` 重置为 false，进入下一循环的 coding sub_phase。循环次数在**计划阶段定义**（非需求阶段硬编码）。
- **phase 级收敛**：所有 dev_phase 循环完成后，phase 级 `converged=true`，监督者方可 advance → SUMMARY。phase 级收敛与循环级收敛区分：循环级收敛后 advance 不推进 phase，而是进入下一 dev_phase。
- **advance 语义**：IMPLEMENTATION 阶段监督者 advance 的含义是"推进到下一 dev_phase"（循环未全部完成时）或"推进到 SUMMARY"（全部循环完成时）。PairFlow 根据当前 dev_phase 与计划阶段定义的循环总数判断。
- **循环总数来源**：计划阶段产出的计划草案中定义 IMPLEMENTATION 循环次数。计划草案必须包含固定格式的 `## 实施里程碑` 段落（含 `循环总数: <N>` 声明，见 §11 模板引擎）。PairFlow 在 PLANNING→IMPLEMENTATION advance 时按正则 `/循环总数[：:]\s*(\d+)/` 从计划草案中提取循环总数并写入 state.json。提取失败 → 拒绝 advance，返回 `"计划草案缺少 '循环总数' 声明，无法进入 IMPLEMENTATION"`
- **历史记录**：每个 dev_phase 循环的 coding/review/fix 产出文件独立归档，文件名含 dev_phase 前缀（如 `{dev_phase}_{timestamp}_{identity}_coding.md`），避免跨循环覆盖。
- **循环间状态重置**：dev_phase 循环收敛后，`round` 重置为 1（每循环独立计数，跨循环追溯通过 `dev_phase` + `round` 组合定位），`last_submit_per_turn` 重置为双方 `{round:null, sub_phase:null, stance:null, need_next_round:null, commit_hash:null, submitted_at:null, new_issues:[]}`（避免上一循环的收敛数据影响新循环的收敛判定），`converged` 重置为 false，`dev_phase` 自增

**SUMMARY 阶段**：
- turn 1：非监督者 submit 总结报告
- turn 2：监督者 submit 总结报告（含双方总结的汇总，监督者在此轮同时完成自身总结+合并汇总，不单独设汇总 turn）
- turn 3：非监督者 review 监督者总结+汇总（可提新 issue，与需求/计划交替规则一致）
- 收敛条件：非监督者 review 无新问题（`new_issues` 为空）→ `converged=true`，无需 stance/need_next_round
- 监督者 advance → IDLE。advance 后两端自动注销（peers 清空），新一轮工作流需重新 register

### 5.4 合法转换校验

| 当前状态 | 操作 | 合法？ |
|---|---|---|
| phase=idle, turn=idle | 任一 AI 调 register | ✅ |
| phase≠idle | register | ❌ |
| phase=idle, 仅一端注册 | claim_turn(advance) | ❌ (两端未就绪) |
| phase=idle, 两端注册 | 监督者调 claim_turn(advance) | ✅ |
| phase=idle, 两端注册 | 非监督者调 claim_turn(advance) | ❌ |
| turn="<current_holder>" | 持笔者调 submit | ✅ |
| turn="<current_holder>" | 非持笔者调 submit | ❌ |
| turn=<identity> | 非当前 turn 方调 claim_turn(turn) | ❌ |
| converged=true | 非监督者调 claim_turn(advance) | ❌ |
| converged=true | 监督者调 claim_turn(advance) | ✅ |
| converged=true | 任何方调 claim_turn(turn) | ❌ |
| phase=idle | submit | ❌ |
| 任意状态 | escalate | ✅（仅监督者、仅 P0、phase≠idle） |
| 任意状态 | resolve_issue(P0) | ✅（仅监督者、phase≠idle） |
| 任意状态 | resolve_issue(P1/P2) | ✅（双方均可、phase≠idle） |
| 任意状态 | force_converge | ✅（仅监督者、phase≠idle） |
| 任意状态 | who_am_i/get_state/get_context/ping | ✅ |

### 5.5 IMPLEMENTATION 子阶段

```
coding ──→ review ──→ fix ──→ review ──→ ... ──→ converge ──→ advance
```

| sub_phase | 执行者 | 产出文件 | 推进条件 |
|---|---|---|---|
| `coding` | 开发者 | `{dev_phase}_{timestamp}_{identity}_coding.md` | → review（无条件） |
| `review` | 评审者 | `{dev_phase}_{timestamp}_{identity}_review.md` | need_next_round=false + 无P0 → converge<br>need_next_round=true 或 有P0 → fix |
| `fix` | 开发者 | `{dev_phase}_{timestamp}_{identity}_fix.md` | → review（无条件） |

**IMPLEMENTATION 推进表（实现与测试金标准）**：

| Step | sub_phase | 执行者 | round | stance | need_next | 收敛? | Next |
|---|---|---|---|---|---|---|---|
| 1 | coding | 开发者 | 1 | null | — | 跳过（产出方） | sub→review, turn→评审者 |
| 2 | review | 评审者 | 1 | agree | false | ✅ | phase converged=true |
| 2' | review | 评审者 | 1 | disagree / require_clarification | true | ❌ | sub→fix, turn→开发者, round→2 |
| 3 | fix | 开发者 | 2 | null | — | 跳过（产出方） | sub→review, turn→评审者 |
| 4 | review | 评审者 | 2 | agree | false | ✅ | phase converged=true |
| 4' | review | 评审者 | 2 | disagree / require_clarification | true | ❌ | sub→fix, turn→开发者, round→3 |

- fix sub_phase 中禁止创建 P0 issue——`converge_mark.new_issues` 含 P0 或调 `create_issue(type="P0")` 均拒绝，返回 `"new P0 issues are not allowed during fix sub_phase; use resolve_issue to close existing P0s"`
- P1/P2 允许在 fix 中新增——修复过程中可能发现新的次要问题
- 监督者异议（监督者=开发者时）：评审者 review 通过（stance=agree, need_next_round=false）后，**不自动收敛**——state.json 设 `pending_supervisor_review: true`。状态机插入一个额外的监督者 review turn：sub_phase=review（不变），turn=监督者 identity。监督者 submit 时：
  - 无异议 → stance=agree, need_next_round=false → 清除 `pending_supervisor_review` → 收敛
  - 有异议 → 调 escalate 将评审者 review 中未解决的 P0 或监督者新发现的 P0 升级。escalate 后 `pending_supervisor_review=false`，继续 fix 循环或与用户沟通
- 此额外 turn 的 `last_submit_per_turn` 写入监督者的 key，round 与评审者相同（同 round 内）。`pending_supervisor_review` 标记也阻止普通 review submit 直接触发收敛——必须监督者明确表态

**IMPLEMENTATION P0 循环保护（fix_review_cycles）**：

每个 P0 issue 记录 `fix_review_cycles` 字段。每次 `review` sub_phase submit 时若该 issue 仍为 open，counter 自增 1。当 counter ≥ 2 时 `get_state` 返回 `escalation_recommended: { issue_ids: [...] }`。若连续 5 轮仍未解决，僵持检测介入通知监督者。counter 在 issue 被 resolve 或 escalate 时重置。issue 不设 reopen 路径——同一问题重现应创建新 issue。



---

## 6. Issue 系统

| 类型 | 含义 | 行为 |
|---|---|---|
| **P0 阻塞** | 不解决无法继续 | 阻断收敛 → escalate → 监督者与用户沟通 → resolve |
| **P1 建议** | 值得讨论不阻塞 | 收敛时自动关闭 |
| **P2 疑问** | 要求澄清 | 收敛时自动关闭 |

**方案建议义务**：P0/P1 issue 提出时**必须**包含方案建议及理由——提问题者必须思考解决方案，不能只抛问题。P2 可选。复杂方案（涉及多节/多状态机路径）需含至少一个备选方案对比。论证需引用 spec 具体章节作为依据。

**落地声明义务**：执行 spec 修改的一方在回复中声明落地时，必须给出每项修改的具体章节定位（节号+行号范围），供对方验证时直接定位。仅声称"已落地"不带定位信息 → 视为声明不完整，对方可要求补充。

- P0 escalate：监督者调 `escalate(issue_id, reason)` → issue status 变为 `escalated`。非监督者不可调 escalate——可创建 P0 issue，由监督者判断是否升级给用户
- **issue 关闭路径**：(1) submit 时通过 `converge_mark.resolved_issue_ids` 显式关闭 issue——表示对方同意并已在文档中修改解决；未被列入 `resolved_issue_ids` 的 open issue 保持 open（表示对方不同意或待处理）；(2) `resolve_issue` 工具——用于在 submit 之外显式关闭 issue（如用户沟通后监督者关闭 P0）。P1/P2 双方均可调 resolve_issue，但需求/计划阶段"问题由对方修改"原则优先——提出者不应 resolve 自己的 issue，应通过 submit 让对方在文档中处理
- 监督者 escalate 后与用户沟通
- 沟通后监督者调 `resolve_issue` 处置
- `force_converge`：监督者紧急 override，所有 open issue → `resolved_by="force_converge"`

**next_issue_id**：单调递增，永不重置（phase 推进保留原值），确保 journal replay 时旧 issue ID 不会被新 issue 复用。

**Issue 创建路径**：
1. `converge_mark.new_issues`（submit 时附带）——主路径。PairFlow 自动从 `next_issue_id` 分配 ID 后自增，填 `raised_by`、`round`、`phase=当前 phase`，初始化 `fix_review_cycles=0`
2. `create_issue` 工具——辅助路径。同上自动初始化

**作者性存储分工**：

| 存储 | 内容 | 崩溃恢复角色 |
|---|---|---|
| `*.meta.json` | 每次 submit 的 converge_mark 副本（含 `new_issues`） | 重建 submit 创建的 issue 初始状态 |
| `issues-journal.jsonl` | 工具变更日志（create/resolve/escalate） | 在 meta.json 重建基础上 replay 叠加变更 |
| `state.json issues[]` | 运行时状态 | 非作者性，崩溃后丢弃 |
| `history[].new_issues` | 人类可读索引 | 不参与崩溃恢复 |

**P1/P2 收敛时自动关闭**：收敛时所有仍 open 的 P1/P2 自动设置 `resolved_by="converged"`。

---
## 7. 收敛逻辑

**通用收敛条件（IMPLEMENTATION）**：
1. `last_submit_per_turn` 中双方均已提交（两个 key 都存在且有 `submitted_at`）
2. 同 round 双方 `stance` = `"agree"`
3. 同 round 双方 `need_next_round` = `false`
4. 无 status=open 的 P0 issue
5. 无 status=escalated 的 issue

**收敛触发前提（round 匹配，仅 IMPLEMENTATION 适用）**：IMPLEMENTATION 阶段收敛检查仅在 `last_submit_per_turn` 双方 `round` 相等且均非 null 时执行。同一方连续提交两次（round 不匹配）仅更新 `last_submit_per_turn`，不触发收敛检查。需求/计划阶段不依赖 round 匹配——收敛条件为"双方最新提交 `new_issues` 均为空 + 无 open P0 + 无 escalated issue"。

**stance / need_next_round 一致性约束（submit 时拒绝）**：

| stance | need_next_round 必须为 | 原因 |
|---|---|---|
| `agree` | `false` | 同意 + 需要下一轮语义矛盾 |
| `disagree` | `true` | 不同意意味着需要下一轮 |
| `require_clarification` | `true` | 需要澄清意味着需要下一轮 |
| `null` | 不检查 | 产出模式，stance 为 null |
| `summary`（phase=summary） | 不检查 | SUMMARY 收敛仅依赖 `new_issues` 为空，不依赖 stance/need_next_round |

> **SUMMARY 阶段例外**：SUMMARY 阶段 stance/need_next 可为 null（默认）或非 null（非监督者 review 时）。非 null 时上表约束不生效——SUMMARY 收敛仅依赖 `new_issues` 为空（§5.3）。disagree 无具体 issue 视为"不满意但无实质异议"，允许收敛。

以下组合在 submit 时直接拒绝：
- `disagree + need_next_round=false`
- `require_clarification + need_next_round=false`
- `agree + need_next_round=true`

**converge_mark JSON Schema**（submit 入参）：

```jsonc
{
  "stance": "agree | disagree | require_clarification | null",
  // null 仅在非 IMPLEMENTATION phase 或 IMPLEMENTATION 的 coding/fix sub_phase 合法
  "need_next_round": true | false | null,
  // null 仅在非 IMPLEMENTATION phase 合法
  "new_issues": [
    {
      "type": "P0 | P1 | P2",
      "topic": "string (≤200 chars)",
      "description": "string",
      "my_position": "string | null",
      "proposal": "string | null",        // P0/P1 必填（方案建议+理由），P2 可选。复杂方案需备选对比
      "rationale": "string | null"        // 引用 spec 具体章节作为论证依据
    }
  ],
  // new_issues 可为空数组 []（表示本轮无新问题）
  "resolved_issue_ids": [1, 3],
  // 本轮显式关闭的 issue ID（同意对方的问题、自审中认可对方驳回）
  "issue_stances": {
    // 本轮对已有 open issue 的立场更新（不同意时补充论据，保持 open）
    "2": { "stance": "disagree", "argument": "补充论据…" }
  }
}
```

**converge_mark issue 生命周期管理**：

| 操作 | 字段/工具 |
|---|---|
| 创建新 issue + 初始立场 | `converge_mark.new_issues[].my_position` |
| 更新已有 issue 立场 | `converge_mark.issue_stances` |
| 关闭 issue（P1/P2 常规） | `converge_mark.resolved_issue_ids` |
| 关闭 issue（P0 监督者处置） | `resolve_issue` 工具 |
| 升级 P0 | `escalate` 工具（仅监督者） |
| 强制关闭所有 | `force_converge`（仅监督者） |

**需求/计划阶段收敛**：
1. 双方在最新提交中均未提出新问题（`new_issues` 为空）
2. 无 open P0
3. 无 escalated issue

**收敛后流程**（各 phase 通用）：
1. 收敛判定成立（双方 `new_issues` 均空 + 无 open P0 + 无 escalated）
5. checklist 确认通过 → **final_diff**（监督者阶段报告）
6. 监督者 advance → 下一 phase

---

## 8. 异常处理

**异常类型**：
1. turn 超时 → 当前持笔者 lease 超时 + grace 过期 → 强制释放 turn，另一方 claim
2. advance 超时 → converged=true 后超时未 advance → 提醒监督者
3. 僵持（IMPLEMENTATION）→ 同一 P0 多轮反复 → 通知监督者
4. 崩溃恢复 → 服务重启后 state 丢失，register 时检测并触发重建（见下）
5. force_converge → 监督者紧急 override

**崩溃恢复**（register 时触发，非启动时。详见 `register` 工具）：

0. **workflow_id 恢复**：若 state.json 可读且 `phase=idle` → 跳过扫描（IDLE 是终结态，不恢复任何工作流）。否则（state.json 不可读，或 `phase≠idle` 且 `workflow_id=null`）→ 扫描 `handoff/` 下所有 `{workflow_id}/` 子目录，选取目录名（yyyyMMddHHmmss）最大且目录存在的作为当前 workflow_id。若该目录下无任何文件 → 视为不完整初始化，回退到 IDLE。若候选目录下含 `summary/` 子目录且有 `{identity}_final.md` → 视为已完成工作流，跳过该目录继续找次新目录。若无任何子目录 → 视为首次启动，workflow_id 保持 null，进入 IDLE 等待 register
1. 扫描 `handoff/{workflow_id}/` 下各 phase 子目录的 `*.meta.json` → 重建 submit 创建的 issue + history 初始状态
2. Replay `handoff/{workflow_id}/issues-journal.jsonl` **按文件追加顺序逐行**回放（append-only 文件行序 = 操作时序，不依赖 mtime）：
   - 对每条记录按 `issue_id` 检查当前 `issues[]` 中是否存在
   - 存在 → 应用变更；不存在 → 跳过（issue 属于已完成的阶段）
3. 孤儿文件处理：以 `history[-1].timestamp` 作为最后操作时间（不依赖文件系统 mtime）。若 `.md` 存在且对应 `.meta.json` 存在且可解析：
   - IMPLEMENTATION/SUMMARY：`meta.json` 文件名时间戳晚于最后操作时间 → 用 `.meta.json` 重建 history 条目，翻转 turn/推进 round/推进 sub_phase → 原子写回 state.json
   - 需求/计划：文件名 `r{round}_{identity}.md` 中的 round 号大于最后操作时的 round 值 → 同上重建
4. `.md` 无 `.meta` 或 `.meta.json` JSON 解析失败 → 视为不完整 submit，忽略
5. 清除 `current_lease`（设为 `null`——在途 claim_turn 视为未发生）
6. 重启 timer：
   - `active=true` 且 `expires` 未过期 → `setTimeout(expires - now)`
   - `active=true` 且 `expires` 已过期 → 立即触发超时处理（turn 变为对方 identity）
7. IDLE 崩溃：`peers` 置为 `[]`，两端重新 register

**权威来源声明**：issues + history 全量重建自 `meta.json + journal`（两者为权威来源）。phase/round/turn 从最新 `meta.json` 推断；`state.json` 仅在 `meta.json` 无法推断时作为 fallback。不使用文件系统 mtime（Windows 精度不足）。

**提交处理顺序**：校验先行（commit_hash 格式 → 解析 converge_mark JSON → 模板交叉校验[converge_mark JSON 为权威，模板计数不匹配发出 warning 不拒绝]）→ 校验通过后写文件 → 失败则创建零文件。

**写入顺序**：meta.json 先写（意图标记，含 converge_mark），md 后写（完成标记）。崩溃在中间时的恢复规则：
- meta 存在 + md 不存在 → 视为不完整 submit，用 meta 重建 history 条目但标注 `incomplete: true`，不推进 turn/round（state.json 未写，状态未切换）
- md+meta 均已写但 state.json 未写 → 恢复时用已写的 md+meta 修补 state.json，推进 turn/round

---

## 9. Lease 机制

- `claim_turn` 返回 `lease_token` + `lease_expires_at`
- `expires_at` 与 `current_timeout.expires` 同步（两者始终相等）
- 超时后 5min grace 内凭 token 仍可 submit（单次使用，`grace_used` 标记）

**Grace 降级 turn 回退**：若 turn 因超时已变为对方 identity，但 submit 携带 `lease_token` 匹配 `current_lease.token` 且当前时间在 5min grace 内 → PairFlow 接受 submit，**回退 turn 为调用方**，正常处理。`grace_used` 置为 `true` 后同一 lease 不可再次使用 grace。

**mutex 竞态处理**：超时 timer 和 submit 请求由同一 mutex 串行化，先抢到锁的定路径：
- Timer 先抢到 → turn 切为对方 → submit 走 grace 路径
- Submit 先抢到 → 正常处理 → timer 重置（取消）
实现者无需额外处理竞态。

**Lease 失效规则**：
- 成功 submit（正常或 grace）后 → `current_lease` 重置为 `{token:null, holder:null, expires_at:null, grace_used:false}`
- 显式拒绝后 → 同上

**Lease 交互优先级表**：

| 场景 | 行为 |
|---|---|
| turn 匹配调用方，submit（正常） | `lease_token` 可选；turn 匹配本身即充分 |
| turn=对方 identity（超时），submit 带 grace | lease 匹配 + `grace_used=false` → 接受，回退 turn；`grace_used=true` → 拒绝 |
| force_converge | 优先级高于 grace submit；`force_converge` 立即清除 `current_lease` 为 null；后续所有 grace submit 拒绝 |
| claim_turn(mode="advance") → phase 推进 | `current_lease` 重置；推进后**当前 turn 持有者**（见 §12 各 phase 初始化 turn 值）需调 claim_turn(mode="turn") 获取新 lease 才能 submit |

**phase_config 生命周期**：首次 advance（IDLE→REQUIREMENTS）时 `timeouts` 参数必须包含全部四个 phase 的超时值（不传 → 拒绝）。advance 一次性将 `timeouts` 写入 `state.json` 的 `phase_config`，后续 phase 推进时只读。若需调整**即将进入的 phase** 的超时，监督者在**当前 phase** 收敛后 advance 时可传 `timeouts` 参数覆盖 `phase_config` 中**下一 phase** 的值。已完成 phase 的超时值不可修改。

**分 phase 超时**（IDLE 阶段由用户确认）：

| Phase | 超时（min） |
|---|---|
| REQUIREMENTS | 10 |
| PLANNING | 10 |
| IMPLEMENTATION | 60 |
| SUMMARY | 30 |

---

## 10. MCP 工具清单

| 工具 | 入参 | 出参 | 说明 |
|---|---|---|---|
| `ping` | 无 | `{ ok, uptime }` | 连通性检查。匿名可用 |
| `who_am_i` | 无 | `{ identity, registered, is_supervisor?, is_developer? }` | 身份确认 + 注册信息。匿名可用（identity="unknown"） |
| `register` | `{ supervisor: bool, developer: bool, work_dir: string }` | `{ ok, identity, is_supervisor, is_developer, phase }` | IDLE 阶段注册。仅 IDLE 下可用。identity 已存在 → 拒绝。supervisor/developer 各唯一但可兼任。work_dir 必填，双方校验一致性。`tip` 告知身份 header 设置 + 下一步操作 |
| `confirm_dir` | `{ work_dir: string }` | `{ work_dir, incomplete_workflows[] }` | 确认工作目录，返回未完成的工作流列表。仅监督者在 IDLE 阶段可用 |
| `confirm_task` | `{ task_path: string }` | `{ task_path, workflow_id, phase, recovered }` | 确认任务文档路径。在任务文档同目录创建 `{文档名}.pid` 文件存储 workflow_id。若 `.pid` 已存在 → 从 handoff 恢复流程状态，返回 `recovered:true`；否则全新开始。仅监督者在 IDLE 阶段可用 |
| `advance` | 无 | `{ ok, new_phase, turn }` | 推进到下一阶段。仅监督者可用。IDLE→REQUIREMENTS：peers≥2+task已确认，turn→非监督者。REQUIREMENTS→PLANNING：turn→评审者。PLANNING→IMPLEMENTATION：turn→开发者,sub_phase=coding。IMPLEMENTATION→SUMMARY：turn→监督者。SUMMARY→IDLE |
| `claim_turn` | 无 | `{ ok }` | 获取当前轮次的执行权。仅在自己 turn 时可用。记录 `turn_claimed_at`。tip 按 phase+round 动态生成执行指引 |
| `wait_for_turn` | 无 | `{ turn, phase, round, warning? }` | 长轮询等待 turn 切换。10s 间隔，600s 超时。turn=自己 → tip 调用 claim_turn；turn≠自己 → 继续 wait。turn 已切出 >30 分钟未被 claim → 返回 warning |
| `get_state` | 无 | `{ tip }` | 返回当前执行指引。round=1 时指引读取任务文档并产出；round≥2 时指引审阅对方上一轮产出 |
| `submit` | `{ file_path, git_commit_hash }` | `{ ok, next_turn }` | 提交产出。校验 turn 持有者、git_commit_hash 与上次提交不同（双方中取最新），记录到 last_submit_per_turn，round+1 并切换 turn |
| `get_context` | 无 | `{ phase, round, issues[], last_submit, template? }` | 当前阶段上下文 |
| `create_issue` | `{ type, topic, description, my_position?, proposal?, rationale? }` | `{ issue_id }` | 创建 issue。P0/P1 必填 proposal+rationale（§6），P2 可选。fix sub_phase 禁止 P0。PairFlow 校验 proposal 为空时拒绝（P0/P1）。持久化到 journal |
| `resolve_issue` | `{ issue_id, resolution }` | `{ ok }` | 关闭 issue。P0 仅监督者可 resolve。持久化到 journal |
| `escalate` | `{ issue_id, reason }` | `{ ok }` | 仅监督者可调、仅 P0 可升级。标记 status=escalated，不切换 phase。持久化到 journal |
| `list_issues` | `{ status?, scope? }` | `{ issues[] }` | 列出 issue。scope="current_phase"/"all" |
| `force_converge` | 无 | `{ ok }` | 监督者仅可用、phase≠idle。强制收敛**当前 dev_phase 循环**（非整个 phase），该循环内所有 open issue→resolved_by="force_converge"。收敛后 `dev_phase` 自增进入下一循环（若还有剩余循环），或 phase 级收敛进入 SUMMARY（若已是最后一循环）。IMPLEMENTATION 中若在 coding sub_phase 调用，跳过当前循环的 review/fix 直接进入下一循环——后果由监督者承担。立即清除 current_lease 为 null、current_timeout.active=false |
| `get_archived_files` | `{ phase?, workflow_id? }` | `{ files[] }` | 列出归档文件。`phase` 可选过滤（requirements/planning/implementation/summary）；`workflow_id` 可选过滤，不传默认当前工作流。均不传返回当前工作流全量 |
| `get_archived_file_content` | `{ filename, phase? }` | `{ content }` | 读取归档文件内容。`phase` 可选过滤（requirements/planning/implementation/summary），不传默认当前 phase。文件存储在 `handoff/{workflow_id}/{phase}/` 子目录下，PairFlow 在指定或当前 phase 子目录中查找 |

---

## 11. 模板引擎

`claim_turn` 返回当前阶段的标准输出模板 + `rules_summary`（行为性规则摘要）。

**规约分发机制**：

spec 定义了 58+ 项规则，但规则存在设计文档里，AI 如何获悉从未定义。PairFlow 在关键交互中注入规则摘要——不是让 AI 记住全部 spec，而是在正确时机给出正确提示。

**rules_catalog**（规则目录，编码时为 `src/rules/catalog.ts` TS 常量）：

每条规则标注：
- `id`：规则标识
- `description`：规则描述
- `applicable_phases`：适用的 phase 列表
- `applicable_sub_phases`：适用的 sub_phase 列表（IMPLEMENTATION 专用）
- `trigger`：触发时机（`claim_turn` / `submit` / `create_issue` / `resolve_issue` 等）
- `spec_ref`：对应 spec 章节号（如 §5.3、§6），用于 spec 与 catalog 一致性交叉校验
- `type`：`structural`（结构性，嵌入模板）或 `behavioral`（行为性，注入 rules_summary）

**分发分工**：
- **模板**（结构性规则）：嵌入必须填写的段落和格式要求——AI 填模板时即遵守。如审阅范围段落、收敛状态段落
- **rules_summary**（行为性规则）：claim_turn 出参返回当前 phase/sub_phase/操作适用的行为性规则——AI 决策时参考。如 disagree 建设性义务、提出者不修自己问题、方案建议义务、advance 前置条件

**动态过滤**：claim_turn 时按当前 `phase` + `sub_phase` + 即将执行的操作（turn/advance）从 rules_catalog 过滤返回。全量返回 58+ 条信息过载，按需过滤才有效。

**一致性维护**：spec 修改规则时同步更新 rules_catalog。每条规则的 `spec_ref` 是落地声明的延伸——spec 改了但 catalog 没改 → spec_ref 定位失效，可作为一致性检查手段。编码时提供 lint 脚本校验 spec_ref 有效性 + **catalog 覆盖率**：遍历 spec 所有章节号（§1–§16），报出 rules_catalog 中无任何规则 `spec_ref` 指向的章节。未覆盖章节需补充规则或显式标注 `// no behavioral rules in this section`。仅校验 spec_ref 有效性不校验覆盖率 → advance_checklist（§5.3 "advance 前置条件"）的"验证重点"可能为空 → 清单流于形式。

**submit 拒绝时的规则提示**：submit 被拒绝时，`reason` 字段返回具体违规项和修正指引（引用对应规则 id + spec_ref）。

**占位符语法**：
- `{{...}}` = PairFlow 填入（phase 名、round 号、持笔者身份），调用方不可修改
- `<...>` = AI 填入（`<留空>` 表示填入空字符串，非填入文本"留空"）

**收敛状态解析**（用于 submit 时交叉校验）：

锚点定位：`/^##\s*收敛状态\s*$/im`（大小写不敏感，容错首尾空格）。未找到锚点 → 拒绝，返回 `"未找到 '## 收敛状态' 段落"`。

从锚点到下一个 `## ` 标题或 EOF，逐行匹配以下字段（中英文冒号均支持 `[：:]`）：

| 字段 | 正则 |
|---|---|
| Issue 计数 | `/^\s*[-*]\s*本轮新增\s*issue\s*[：:]\s*P0\s*[：:]\s*(\d+)\s*,?\s*P1\s*[：:]\s*(\d+)\s*,?\s*P2\s*[：:]\s*(\d+)\s*$/im` |
| 本轮关闭 issue | `/^\s*[-*]\s*本轮关闭\s*issue\s*[：:]\s*(\d+(?:\s*,\s*\d+)*)?\s*$/im` |
| 立场 | `/^\s*[-*]\s*对对方上一轮产出的立场\s*[：:]\s*(agree\|disagree\|require_clarification)?\s*$/im` |
| 是否需要下一轮 | `/^\s*[-*]\s*是否需要下一轮\s*[：:]\s*(yes\|no)\s*$/im` |

**交叉校验**：converge_mark JSON 为权威来源。
- `new_issues`：模板 Issue 计数与 JSON 实际数量不一致 → 自动修正模板为实际数量，返回 warning（不拒绝）。仅 JSON `new_issues` 数组格式错误时拒绝
- `resolved_issue_ids`：模板"本轮关闭 issue"列表与 JSON `resolved_issue_ids` 不一致 → 自动修正模板，返回 warning（不拒绝）
- `issue_stances`：模板无对应段落（立场更新由 `## 本轮审阅范围` 中自然体现），不强制模板匹配——仅校验 JSON 中 `issue_stances` 引用的 issue ID 均存在且为 open

`create_issue` 工具建的 issue 不参与 submit 交叉校验——交叉校验仅比对 `converge_mark` 字段与模板计数。**字段缺失处理**：立场和"是否需要下一轮"在非 IMPLEMENTATION 阶段可为空——模板中缺失对应行视为 null，不拒绝。"本轮关闭 issue"为空时（无可关闭 issue）视为 `resolved_issue_ids: []`，不拒绝。

**模板变体**（结构性规则嵌入，行为性规则由 rules_summary 注入）：

| Phase | sub_phase | 文档标题 | 嵌入的结构性规则 |
|---|---|---|---|
| requirements | — | r{round}_{identity}.md | 审阅范围段落（强制）+ 收敛状态段落 |
| planning | — | r{round}_{identity}.md | 同上；首轮为评审者产出计划草案 |
| implementation | coding | coding / review | 收敛状态段落（stance/need_next） |
| implementation | fix | fix / review | 同上 |
| summary | — | summary / final（监督者） | 收敛状态段落（无需 stance/need_next） |

**审阅范围段落格式**（需求/计划阶段强制，PairFlow 拒绝无此段落的 submit）：
```
## 本轮审阅范围
- 重新通读了以下章节：<列出>
- 本次修改涉及的章节：<列出>
- 未重新审阅的章节：<列出 + 原因>
```

**实施里程碑段落格式**（计划阶段 r1 强制，PairFlow 拒绝无此段落的计划草案 submit）：
```
## 实施里程碑
- 循环总数: <N>
- 里程碑 0: <描述>
- 里程碑 1: <描述>
...
```
IMPLEMENTATION advance 前 PairFlow 从计划草案中提取 `循环总数`，提取失败拒绝 advance。

---

## 12. Phase 初始化行为

**REQUIREMENTS 初始化**：

| 字段 | 初始化值 |
|---|---|
| `phase` | `requirements` |
| `workflow_id` | **生成新值** `yyyyMMddHHmmss`（IDLE→REQUIREMENTS 时刻），作为 `handoff/{workflow_id}/` 目录名 |
| `sub_phase` | `null` |
| `round` | 1 |
| `turn` | 非监督者 identity（非监督者持笔首轮评审 r1） |
| `converged` | false |
| `peers` | 保留 IDLE 注册信息 |
| `issues` | `[]`（前一 phase issue 留在归档，不跨 phase 携带） |
| `history` | 追加一条 `{type: "phase_entry", phase, round:1, turn:<非监督者 identity>}` |
| `last_submit_per_turn` | `{ <监督者identity>: { round:null, sub_phase:null, stance:null, need_next_round:null, commit_hash:null, submitted_at:null, new_issues:[] }, <非监督者identity>: 同上 }` |
| `current_lease` | `{token:null, holder:null, expires_at:null, grace_used:false}`（claim_turn 时赋值） |
| `current_timeout` | active=true, ttl 取 phase_config.requirements |
| `next_issue_id` | **保留原值不重置**（首次 PairFlow 启动初始化为 1；phase 推进保留原值，确保 issue ID 全局唯一） |

**PLANNING / IMPLEMENTATION / SUMMARY 初始化**：同上模式，对应 phase 名 + timeout 配置。其中：
- **PLANNING**：`turn` 初始化为**评审者**（`is_developer=false`）identity——评审者产出计划草案首轮（见 §5.3 计划阶段）
- **IMPLEMENTATION**：额外设 `sub_phase=coding`，`dev_phase=0`（首个开发里程碑），`turn` 初始化为**开发者**（`is_developer=true`）identity

**子目录创建时机**：`handoff/{workflow_id}/{phase}/` 子目录在首次 submit 时按需创建（advance 时不预创建）。目录存在代表"该阶段至少有一轮产出"，而非"该阶段曾被进入过"。

**IDLE 初始化（工作流终结）**：

| 字段 | 初始化值 |
|---|---|
| `phase` | `idle` |
| `workflow_id` | `null`（当前工作流归档保留在 `handoff/{原workflow_id}/`，新一轮 IDLE→REQUIREMENTS 时生成新 ID） |
| `sub_phase` | `null` |
| `round` | 1 |
| `turn` | `idle` |
| `peers` | `[]` |
| `converged` | false |
| `issues` | `[]` |
| `history` | `[]` |
| `last_submit_per_turn` | `{}` |
| `current_lease` | `{token:null, holder:null, expires_at:null, grace_used:false}` |
| `current_timeout` | active=false |
| `next_issue_id` | **保留原值不重置** |

> handoff/ 目录下产出文件与 meta.json 作为永久归档保留，不随 IDLE 清理。新一轮工作流通过 IDLE→REQUIREMENTS 自然开始，不继承上一轮 history/issues。

---

## 16. 假设与降级

| 假设 | 状态 |
|---|---|
| 客户端支持自定义 HTTP header（`X-AI-Identity`） | ⚠️ 接入前提。不支持则无法接入 PairFlow |
| 两个 AI 均支持 MCP client 模式 | ⚠️ 接入前提。不支持则无法接入 PairFlow |
| 项目使用 git + AI 具备 git 操作能力 | ⚠️ 接入前提。commit_hash 是不可或缺的 traceability 保障 |
| 结对编程（互审 + 互产）比单 AI 自审更优 | ⚠️ 假设。交替审阅模型通过周期性轮换保持发现能力 |
| localhost-only 无认证，每个身份最多一个活跃实例 | ⚠️ 设计假设 |

---


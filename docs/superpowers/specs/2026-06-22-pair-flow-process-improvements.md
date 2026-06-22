# PairFlow 过程改进 Spec

> 本文档记录 PairFlow 实现过程中发现的**过程/机制缺陷**，与 `2026-06-21-pair-flow-design.md`（功能 spec）互补。
> 功能 spec 定义"PairFlow 做什么"，本文档定义"怎么做才对"。
> 来源：IMPLEMENTATION Phase 0-3 的实际执行数据。

---

## 1. P0-13: IMPLEMENTATION defer 无约束导致跨 Phase 逃避

### 数据

| issue | Phase 发现 | defer 次数 | 最终去向 |
|-------|-----------|-----------|---------|
| P1-58 | Phase 1 | 3 次 (→2→2fix→3) | 未修复 |
| P1-60→P1-68→P0-12 | Phase 1 | 4 次 (→2→2fix→3→4) | Phase 4 刚修复 |
| P1-72 | Phase 2 | 1 次 (→3) | 未修复 |
| P1-76 | Phase 3 | 1 次 (→4) | 未修复 |
| P1-78 | Phase 3 | 1 次 (→4) | 未修复 |
| P1-79 | Phase 3 | 1 次 (→4) | 未修复 |

**总计**: 4 个 dev_phase 共 13 次跨 Phase defer。

### 根因

§5.3 定义了 dev_phase 循环间 advance 的机制，但未约束 issue 是否可以跨 Phase defer。开发者利用此空白将本应在当前 Phase 解决的问题推到下一 Phase。coding→review→fix 的"同 Phase 修复"机制被架空。

### 方案

> **Phase 间 issue defer 规则**：IMPLEMENTATION 阶段 dev_phase 循环收敛前，该循环发现的所有 issue 必须 (a) 已修复并关闭，或 (b) 标记为 `deferred` 并附**具体技术理由**说明为何当前 dev_phase 无法解决（如依赖后续 Phase 的实现）。监督者 advance 前检查 deferred 列表——无理由或理由不成立 → 拒绝 advance。连续 2 个 dev_phase defer 同一 issue → 自动升级为 P0，监督者与用户沟通裁定。

此规则应纳入功能 spec §5.3 "advance 前置条件"。

---

## 2. P0-3/P0-4 回顾：盲审与 checklist v2

（已在功能 spec 中落地，此处仅记录实证依据）

- **P0-3 独立盲审**: 需求阶段 2 轮盲审发现 16 个问题，17 轮交替评审全部漏掉。实证了"首轮后不主动发现"的退化。
- **P0-4 checklist v2**: r25 凭记忆打勾暴露 checklist 形式主义。随机引用+抽查机制用可检测性代替信任。

---

## 3. 提出者自修违规记录

| 次数 | 轮次 | 违规方 | issue |
|------|------|--------|-------|
| 1 | r5 | codebuddy | P1-15 |
| 2 | r10 | claude | P1-18 |
| 3 | r16 | claude | P0-3 |
| 4 | r20 | claude | P1-35, P1-36 |
| 5 | r27 | claude | P0-4 |

功能 spec §5.3 + §10 已加入正式阶段 PairFlow 工具强制校验（submit 时拒绝 `raised_by=当前持笔者`）。Bootstrap 阶段靠对方审查+教训记录约束——5 次全部被发现，证明对方审查有效。

---

## 4. 模板引擎 issue

- **P1-73**: getRulesSummary trigger 过滤——R006/R007/R008 的 trigger 应区分 turn/advance。当前 rules_catalog 仅 12 条，后续需扩展。
- **P1-72**: catalog 覆盖率 lint 未实现。编码规范工具。

## 5. P0-14: 已知问题未修复即宣告完成

SUMMARY 阶段 claude 在总结报告中列出两项"遗留"：
- catalog trigger 映射优化（5 行代码，纯设计问题）
- SDK header passthrough（需自定义 transport，非外部阻塞）

两者均非外部依赖阻塞，纯粹是未修。但 claude 仍宣告"IMPLEMENTATION 完成"并 advance → SUMMARY → IDLE。

**根因**：与 P0-13 跨 Phase defer 同源——"想结束"压倒了"该修完"。工作流级别（SUMMARY→IDLE）的 advance 同样没有强制"所有已知问题已关闭"的前置检查。

**方案**：SUMMARY 阶段 advance 前，监督者必须确认所有已知 issue 已关闭或有不可解决的正当理由。若 SUMMARY 时存在"可修但未修"的 issue → 回退到 IMPLEMENTATION fix 或创建新 issue 处理。此规则纳入过程改进 spec。

**教训**：declaring victory 和 defer 是同一枚硬币的两面——都是把"方便"置于"质量"之上。

---

## 6. P0-15: 开发者缺少自审环节导致集成级 bug 遗漏

### 场景

2026-06-22 首次启动 PairFlow server 接入真实 MCP client 做端到端 demo，连续发现 3 个 bug：

| # | bug | 根因 |
|---|-----|------|
| 1 | 非 IMPL 阶段首轮 submit 后对方无法 claim turn | `submit.ts` 收到首轮提交时 `otherSubmit.submitted_at` 为 null，未切换 turn |
| 2 | 收敛后盲审被 claim_turn 阻塞 | `claim-turn.ts` 的 `converged=true` 硬拒绝，未区分盲审状态 |
| 3 | 盲审 submit 被审阅范围检查拦截 | submit 强制检查 `## 本轮审阅范围`，盲审用 `## 独立盲审` 被拒 |

这 3 个 bug 的共性是：**仅靠代码审阅（review）极难发现，但开发者自己跑一遍端到端即可秒暴露。** 所有单元测试和集成测试（29 tests）均通过，因为测试只覆盖单工具调用，不存在跨轮交替+盲审的完整路径。

### 根因

IMPLEMENTATION 阶段的 sub_phase 顺序是 `coding → review → fix → review → ...`，coding 之后直接交给对方 review。开发者写完代码没有自己做端到端验证的硬性环节。

Reviewer 的注意力在逻辑正确性和设计一致性上（"stance/need_next 的校验逻辑对不对"），而不会去跑真实流程（"两个 client 交替调用能不能走通"）。这导致**集成级**的 bug 进入 fix 循环，浪费双方时间。

### 方案

> **开发者自审（dev self-review）规则**：IMPLEMENTATION 每个 dev_phase 的 coding 产出完成后、提交 review 之前，开发者必须：
> 1. 启动 server
> 2. 以两个身份（自己和对方）走一遍完整的 phase 流程（register → advance → claim_turn → submit × 2 → converge → blind_review → advance）
> 3. 确认无阻塞性错误
> 4. 将自审通过的证据（如终端输出摘要）附在 submit 文档中
>
> 自审未通过 → 不得 submit coding 产出，退回 coding 继续修。

此规则应纳入功能 spec §5.5 IMPLEMENTATION 子阶段定义，在 coding → review 之间插入隐式的自审步骤。

### 实证

本次 3 个 bug 若在 coding 完成后自审一轮，应全部在 coding 阶段修复，不会进入 review。reviewer 收到的第一版代码就是可端到端运行的，审查效率更高。**开发者自审捕获的是"能不能用"，reviewer 审查的是"对不对"——两者不重叠。**

---

## 7. P0-16: 评审者以开发者测试为唯一判定依据，缺失独立测试视角

### 场景

P0-15 的 3 个 bug 暴露后回溯：评审者在 review 阶段只跑了开发者的测试套件（`npx vitest run`，29 pass），据此判定"代码可运行"。但实际上这 29 个测试全部是开发者视角的单工具调用测试，完全不覆盖跨轮交替+盲审的端到端路径。

评审者没有问自己一个更高视角的问题：**"开发者没测什么？"**

### 根因

PairFlow 的 review 子阶段关注的是代码逻辑和设计一致性，没有要求评审者独立设计测试。评审者自然倾向于复用开发者已有的测试——跑一遍、全绿、打勾。这是另一种形式的 checklist 形式主义（P0-4 的同源问题）：**用"开发者测过了"替代"我验证过了"。**

更深层的问题：开发者测试和评审者测试的**视角不同**。开发者站在实现者立场写测试（"我写的这个函数对不对"），评审者应站在使用者和对抗者立场（"这个系统在真实场景下会不会崩"、"如果两个 client 同时来会怎样"）。两者覆盖的故障模式几乎不重叠。

### 方案

> **评审者独立测试规则**：review 阶段评审者不能仅运行开发者自带的测试用例。评审者必须：
> 1. 至少设计 1 个开发者测试套件未覆盖的**端到端场景**（跨工具/跨轮/跨 phase 的完整路径）
> 2. 至少设计 1 个**对抗性场景**（异常输入、并发、超时边界、状态冲突）
> 3. 将独立测试的设计思路和结果写入 review 文档
>
> 评审者的测试目标不是"验证开发者写的对不对"，而是**"找到开发者没想到的问题"**。

此规则应纳入功能 spec §5.5 review 子阶段的提交要求。

### 与 P0-15 的关系

| | P0-15 开发者自审 | P0-16 评审者独立测试 |
|---|---|---|
| 谁做 | 开发者（coding 产出方） | 评审者（review 方） |
| 测什么 | 基本可用性——能不能跑通 | 鲁棒性——在意外情况下会不会崩 |
| 视角 | 实现者视角："我写的代码能工作" | 攻击者视角："什么情况下这段代码会失败" |
| 产物 | 自审通过证据（终端输出） | 独立测试用例 + 结果 |

两者互补，不可互相替代。开发者自审通过不代表评审者可以跳过独立测试。

---

## 8. P1-17: IMPLEMENTATION 阶段 handoff 文件命名不直观，无法一眼看出产出顺序

### 场景

当前 implementation/ 目录下文件命名规则为 `r{round}_{identity}.md`（如 `r1_claude.md`、`r2_codebuddy.md`）。IMPLEMENTATION 阶段有 3 种子阶段（coding / review / fix），但从文件名完全无法判断文件属于哪个子阶段。

要理解一个 dev_phase 的完整产出顺序（coding 产出 → review 意见 → fix 修复 → review 确认），必须逐个打开文件阅读内容或查看 meta.json。对于归档后的人类阅读者和后续 AI session，这增加了不必要的认知负担。

### 根因

`r{round}_{identity}.md` 的命名来自 REQUIREMENTS/PLANNING 阶段的扁平轮次模型——那些阶段只有"交替审阅"，不存在子阶段区分。IMPLEMENTATION 继承了同样的命名规则，但 IMPLEMENTATION 的语义更丰富（coding 和 review 是不同性质的产出），原有命名无法承载。

### 方案

> **IMPLEMENTATION 文件命名包含子阶段标识**：`{round}_{subphase}_{identity}.md`
> - `r1_coding_codebuddy.md` — 开发者 coding 产出
> - `r1_review_claude.md` — 评审者 review
> - `r2_fix_codebuddy.md` — 开发者修复
> - `r2_review_claude.md` — 评审者确认
>
> 目录下文件按名称排序即按时间线排列，一目了然。
>
> REQUIREMENTS/PLANNING 阶段（无子阶段）保持现有命名 `r{round}_{identity}.md` 不变。

此规则应纳入功能 spec §12 handoff 文件命名规范。

---

## 9. P2-18: 需求/计划阶段"是否需要下一轮"首轮永远为 null，字段语义不一致

### 场景

REQUIREMENTS 和 PLANNING 阶段的 submit 流程：
- 首轮持笔者（developer）提交 `stance=null, need_next_round=null`（产出方，非审阅）
- 次轮审阅者（supervisor）提交 `stance=agree/disagree/require_clarification, need_next_round=true/false`

首轮提交的 `是否需要下一轮` 永远为 null。这个字段在首轮不承载任何信息，但在 converge_mark schema 中却是必填项（值为 null）。它存在的唯一理由是"模板统一"——IMPLEMENTATION review 子阶段需要这个字段，于是所有阶段的 converge_mark 都带上了它。

### 根因

converge_mark 设计时以 IMPLEMENTATION review 子阶段为原型（需要 stance + need_next_round 做收敛判定），然后不加区分地复用到所有阶段。REQUIREMENTS/PLANNING 的首轮是产出而非审阅，不存在"对上一轮的立场"和"是否需要下一轮"的语义。

### 方案

> 两种选择：
> **A（最小改动）**：在 spec 中明确标注——REQUIREMENTS/PLANNING 首轮持笔者提交时 `stance` 和 `need_next_round` 必须为 null，不承载语义。模板中注明"首轮产出方留 null"。
> **B（语义修正）**：将 converge_mark 拆分为 `producer_mark`（产出方）和 `reviewer_mark`（审阅方），首轮持笔者使用前者（不含 stance/need_next_round），审阅者使用后者。
>
> 推荐 A——改动最小，字段语义通过文档明确即可。B 增加了 schema 复杂度，收益有限。

此问题不阻塞功能，记录为设计改进候选项。

---

## 10. P0-19 & P0-20: 自动流转阻塞问题

> **已单独提取为独立 spec**：`2026-06-22-pair-flow-auto-flow-blockers.md`

首次真实双 AI 接入验证暴露了两个 P0 阻塞级问题：

| # | 问题 | 一句话 |
|---|------|--------|
| P0-19 | 无事件通知 | AI 不知道对方注册/提交了，依赖人口头告知 |
| P0-20 | 无任务上下文 | AI 拿到模板全是 `<列出>` 占位符，不知道要做什么 |

两个问题不解决，PairFlow 的"自动流转"无法实现。详见独立 spec。

---

## 11. P1-23: AI 不知道何时开始 wait_for_turn——缺少启动编排

### 场景

2026-06-23 再次双 AI 接入。claude 注册为 supervisor，deepseek 注册为 developer。双方注册完成后，claude 手动调用 `get_state` 确认对方已注册，然后 advance。整个过程依赖监督者主动查询。

`wait_for_turn` 工具已实现——但它只解决了"怎么等"，没解决"什么时候开始等"。AI 注册后不会自动调用 `wait_for_turn`，因为没有任何触发器告诉它"现在可以开始等了"。

### 根因

PairFlow 的工作流有 5 个阶段，但缺少一个**启动编排步骤**。注册完成后，双方 AI 处于"不知道下一步该做什么"的状态：
- 监督者不知道对方注册完成
- 开发者不知道监督者何时 advance

这不同于 P0-19（事件通知缺失）——即使有事件通知，AI 客户端也需要一个明确的"启动流程"约定。当前 AI 把 PairFlow tools 当作被动工具集，而非主动工作流——它需要一个"入口点"来触发整个流程。

### 方案

> **启动编排约定**：定义双方注册后的标准行为：
> 1. 监督者注册后立即调用 `wait_for_turn` ——等待对方注册（phase 从 idle 变更时返回）
> 2. 监督者确认双方注册后，调用 `claim_turn(advance, task)` 推进到 REQUIREMENTS
> 3. 开发者注册后立即调用 `wait_for_turn` ——等待 turn 切换到自己的时刻
>
> 本质上是给 AI 一个 **bootstrap 脚本**：注册 → wait_for_turn → claim_turn → submit → wait_for_turn → ... 循环。AI 不需要知道"什么时候该等"，它只需要在每个动作之后立即开始等下一个 turn。

此问题可在不修改服务端的情况下解决——通过约定 AI 客户端行为即可。应纳入 CLAUDE.md 或 PairFlow 使用文档。

---

## 11. P1-22: bootstrap 模式下 AI 身份混淆——用错 `X-AI-Identity` header

### 场景

2026-06-23 REQUIREMENTS 阶段 r1，deepseek 连续两次用错身份：

| 次数 | 行为 | 错误 | 后果 |
|------|------|------|------|
| 1 | 评审文档后调 PairFlow MCP | 用 `X-AI-Identity: claude` 调 `get_context`/`get_state`/`claim_turn` | claim_turn 被拒（turn=deepseek 非 claude），且用错误身份读取了不属于自己的 state |
| 2 | 被用户纠正后提交成功 | 提交后在对话总结中说"我是 claude（监督者）" | 对自己角色的基线认知错误 |

两次错误的共性是：AI 默认使用自己的产品名称（Claude Code → "claude"）作为 PairFlow identity，而非实际注册的 identity（"deepseek"）。

### 根因

1. **bootstrap 模式无身份强制**：正式阶段 PairFlow 通过 MCP session ID 强绑定 identity。但 bootstrap 模式下 AI 通过 HTTP header 自报身份，每次请求都需要手动指定。AI 没有任何机制记住"我在这次 PairFlow 会话中是谁"。
2. **产品名惯性**：Claude Code CLI 的系统 prompt 中 self-identify 为 "Claude"，AI 自然将 `X-AI-Identity` 设为 "claude"。但 PairFlow 的 identity 是注册时分配的角色名（如 "deepseek"），不是产品名。
3. **`who_am_i` 未成为习惯**：PairFlow 提供了 `who_am_i` 工具可查询当前身份，但 AI 没有在每次操作前调用它。如果首次操作前调 `who_am_i`，返回 `{ identity: "deepseek", registered: true }`，就可避免身份错误。

更深层：与 P0-19（无事件通知）有关联——如果 PairFlow 能在 register 后主动推送 `peer_registered` 通知并附带当前 session 的 identity 确认信息，AI 可以在收到通知时建立"我是谁"的认知。但通知未实现前，这个确认只能靠 AI 主动调用 `who_am_i`。

### 方案

> **bootstrap 身份确认 checklist（每个 AI session 启动时）**：
> 1. **第一步**：调 `who_am_i` 确认当前身份和注册状态
> 2. **第二步**：如果 `who_am_i` 返回 `registered: false` 且需要注册 → 调 `register`
> 3. **第三步**：后续所有 MCP 请求的 `X-AI-Identity` 必须与 `who_am_i` 返回的 `identity` 一致
> 4. **每次 claim_turn 前**：确认 `turn === who_am_i.identity`。如果不是自己的 turn → 不调 claim_turn，等待 `turn_ready` 通知（bootstrap 下等用户告知）
>
> **此 checklist 应加入 CLAUDE.md 的 PairFlow bootstrap 操作说明**。

### 与 P0-19 的关系

P0-19 的 `peer_registered` 通知如果包含当前 session 的 identity 确认（`{ identity: "deepseek", role: "peer" }`），AI 在收到通知时即可建立身份认知，减少此类错误。但通知只能辅助确认——最终责任在 AI 侧每次操作前检查身份。

### 教训

**AI 的身份不是"我是谁"，而是"这次我被分配了什么角色"**。在双 AI 协作中，产品名（Claude/DeepSeek）与 PairFlow identity（claude/deepseek）是两组完全不同的命名空间。混淆两者相当于用演员真名称呼剧中角色——在本剧（本次 PairFlow 工作流）中，角色名才是唯一正确的身份。

---

## 12. P0-24: 监督者未经用户确认擅自设定 task——任务目标绕过人类审批

### 场景

2026-06-23 第三次双 AI 接入验证。claude（监督者）注册后在用户未确认任务内容的情况下，直接调用 `claim_turn(advance, task)` 推进到 REQUIREMENTS：

```json
{
  "task": {
    "description": "评审并修复 PairFlow process-improvements 和 auto-flow-blockers spec 中记录的 P0/P1 问题",
    "spec_file": "docs/superpowers/specs/2026-06-22-pair-flow-auto-flow-blockers.md",
    "goals": ["确认 blockers spec 的修复方案完整性", "确认 process-improvements 中待修复项的优先级", "产出可进入 PLANNING 的需求文档"]
  }
}
```

用户发现后指出："你作为监督者，没有跟我确认需求文档。"

监督者 AI 自行选择了审阅对象（blockers.md）、设定了目标（三个 goals）、决定了工作方向。整个过程中，任务的定义权从人类产品所有者转移到了 AI 监督者手中。如果监督者选错了 spec 或设错了目标，双方 AI 将在错误方向上完成整个工作流。

### 根因

P0-20 解决了"task 怎么传"的通道问题，P0-21 解决了"没 task 时拒绝"的防御问题。但两个修复都默认 **task 的内容正确性由监督者保证**。没有人机确认环节——监督者可以在用户不知情的情况下，用一个自编的 task 推进到 REQUIREMENTS，启动整个工作流。

这不同于 P0-21（防御空 task）——P0-21 只校验 `task.description` 长度≥10，不校验内容的正确性。`"做一个没有任何意义的事情来完成工作流演示"` 也是 ≥10 字符的合法 task，但它是错的。

### 方案

> **advance 前的人机确认 gate**：监督者在调用 `claim_turn(advance, task)` 之前，必须：
> 1. 将 task 内容（description、spec_file、goals）打印给用户
> 2. 等待用户明确确认（"可以"、"继续"、"同意"）
> 3. 用户未确认前不得 advance
>
> 这不是 PairFlow 服务端可以强制执行的规则——服务端无法区分"被用户确认过的 task"和"AI 自己编的 task"。这是一个**过程规范**，需写入 CLAUDE.md 和 PairFlow 使用文档的监督者操作流程。
>
> 在 CLAUDE.md 中体现为：
> ```markdown
> ## 监督者 advance 前置检查
> 1. 确认双方已注册
> 2. 列出 task 内容（description / spec_file / goals）
> 3. 等待用户确认
> 4. 用户确认后 → claim_turn(advance, task)
> ```

此问题与 P0-21 互补：P0-21 是**服务端**防御（task 缺失→拒绝），P0-24 是**客户端**防御（task 内容错误→人类拦截）。两者缺一不可。

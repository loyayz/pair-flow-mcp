# r1: 需求阶段首轮评审 — P0-19/P0-20 阻塞问题分析

> 身份: deepseek（developer, 非监督者）
> 轮次: r1
> 基于 commit: b28bd1b

## 本轮审阅范围

- 重新通读了以下章节：
  - `2026-06-21-pair-flow-design.md` §1–§17（全文）
  - `2026-06-22-pair-flow-auto-flow-blockers.md`（全文）
  - `2026-06-22-pair-flow-e2e-verification.md`（关联参考）
  - `2026-06-22-pair-flow-process-improvements.md`（关联参考）
- 本次修改涉及的章节：
  - §2 架构总览（需加入 SSE 通知通道）
  - §4 数据流（需补充 task 传递步骤和通知流）
  - §5.1 state.json schema（需新增 task 字段）
  - §10 MCP 工具清单（claim_turn 入参新增 task、出参新增通知机制描述）
  - §11 模板引擎（模板需注入 task 上下文）
  - §12 Phase 初始化行为（REQUIREMENTS 初始化需包含 task 存储）
- 未重新审阅的章节：无

---

## 分析

### 根因确认

blockers 文档的根因分析准确，两个 P0 问题共享同一个深层原因：**PairFlow v1 的设计关注"流程怎么走"，忽略了"走的时候要带什么信息"和"走完后怎么让对方知道"**。

具体验证：

1. **state.json schema（§5.1）**：定义了 phase/round/turn/issues 等 13 个流程元数据字段，但没有任何"业务上下文"字段。一个不知道自己要做什么的 AI，流程再正确也没有产出。

2. **claim_turn 入参（§10）**：advance 模式仅接收 `timeouts` 参数，无 task 传递通道。

3. **模板引擎（§11）**：占位符 `<列出>` `<N>` `<IDs>` 是纯结构占位符，不携带任何任务语义。

4. **架构图（§2/§4）**：只画了 request-response 流，无 SSE push 通道。MCP Streamable HTTP 协议本身支持 server→client 通知，但 PairFlow 完全未利用。

### 优先级论证

blockers 文档提出的 P0-20 → P0-19 修序正确：

```
P0-20 (task 上下文)
    ↓ AI 至少知道要做什么，能开始产出
P0-19 (事件通知)  
    ↓ AI 能自动感知对方动作，无需人工协调
全自动流转
```

理由：P0-20 不修，AI 拿到 turn 后仍然会问"我要做什么"——即使收到了 turn_ready 通知（P0-19），也不知道该干什么。task 是内容前提，通知是时序前提。

---

## Issue 列表

### P0-1: advance 不携带 task，AI 不知道要做什么

**类型**: P0 阻塞
**对应**: blockers P0-20
**涉及 spec 章节**: §5.1, §10, §11, §12

**描述**:

`claim_turn(mode="advance")` 当前只接受 `timeouts` 参数（§10），不传递任务描述。`get_context` 返回的上下文仅含 phase/round/issues/last_submit，不含任务目标。AI 在首轮拿到模板时看到的全是 `<列出>` `<N>` 等占位符，无法开始工作。

**方案**:

1. **state.json 新增 `task` 字段**（§5.1）：类型 `{ description: string; spec_file?: string; goals?: string[]; context?: string } | null`。`description` 必填，其余可选。`null` 表示无任务（IDLE 阶段）。

2. **advance(IDLE→REQUIREMENTS) 必须携带 task**：`claim_turn` 入参新增可选字段 `task`。当 mode=advance 且当前 phase=IDLE 时，`task` 必填——缺少则拒绝并返回 "advance from IDLE requires task parameter"。其他 phase 的 advance 不强制 task（已从 state 中携带）。

3. **get_context 出参新增 `task` 字段**：返回 `state.task`，确保 AI 在任何阶段都能获知任务目标。`get_state` 同样返回 `task`。

4. **模板注入 task 上下文**：`claim_turn` 返回的模板中，`## 本轮审阅范围` 段落上方新增 `## 任务` 段落，注入 `{{task.description}}`、`{{task.spec_file}}`、`{{task.goals}}`。需求/计划阶段模板中 `<列出>` 替换为具体引导文本。

5. **§12 初始化行为补充**：REQUIREMENTS 初始化时 `task` 从 advance 入参写入 state.json。

**理由**: E2E 验证实际暴露：claude advance IDLE→REQUIREMENTS 后，deepseek claim_turn 拿到模板全是占位符，只能反问"我们要做什么功能/项目？"。状态机推进了，但任务上下文是空的。

**备选方案**: 方案 A（本方案）：task 存储在 state.json 集中管理；方案 B：task 仅通过模板传递不持久化（崩溃丢失，不推荐）。选 A。

---

### P0-2: 无事件推送，监督者无法感知对方动作

**类型**: P0 阻塞
**对应**: blockers P0-19
**涉及 spec 章节**: §2, §4, §10

**描述**:

PairFlow 当前是纯被动 HTTP 服务——只响应 tool call，不推送任何事件。首次真实双 AI 接入时，监督者注册后完全不知道对方何时注册、何时提交、何时盲审完成。关键状态变更全部依赖人工口头传递。

**方案**:

1. **利用 MCP SSE 通道推送通知**：MCP Streamable HTTP 的 SSE 响应通道天然支持 server→client 单向推送。

2. **定义 5 类通知事件**：peer_registered（对方注册完成）、turn_ready（轮到当前 client）、phase_converged（阶段收敛）、blind_review_complete（双方盲审完成）、lease_timeout（lease 即将到期 1 分钟前）。

3. **已连接 client 列表维护**：Server 维护 `Map<identity, Set<SSEStream>>`，register 时绑定 identity→stream，断连时清理。

4. **通知格式**：使用 MCP 标准 `notifications/` 方法，或通过 SSE `event:` 行区分事件类型。

**理由**: Bootstrap 模式的人工协调不可扩展。MCP 协议本身支持 server→client 通知，这是未利用的已有能力。

**备选方案**: 方案 A（本方案）：SSE push；方案 B：轮询 get_state。选 A——实时性好，协议原生支持。

**注意**：需确认 `@modelcontextprotocol/sdk` 的 SSE 实现是否支持独立推送。若不支持，退化为在每个 MCP 请求的 SSE 响应流中插入通知。

---

### P1-1: state.json schema 缺少 task 字段定义

**类型**: P1 建议 | **对应**: P0-1 子任务

**描述**: §5.1 state.json schema 需新增 `task` 字段及完整 TS 类型定义。

**方案**: 在 schema 中 `current_timeout` 之后插入 `task` 字段定义。

**理由**: §5.1 是 state.json 的权威 schema 来源。

---

### P1-2: 模板引擎不注入 task 上下文

**类型**: P1 建议 | **对应**: P0-1 子任务

**描述**: §11 模板引擎当前只定义结构性占位符，不注入任务相关内容。

**方案**: 在 §11 新增 `{{task.description}}`、`{{task.spec_file}}`、`{{task.goals}}` 等占位符。

**理由**: 模板是 AI 与 PairFlow 之间的界面——空模板 = 盲人摸象。

---

### P1-3: get_context / get_state 不返回 task

**类型**: P1 建议 | **对应**: P0-1 子任务

**描述**: §10 工具清单中两个工具的出参描述均未包含 task。

**方案**: get_context 和 get_state 的出参新增 `task` 字段。

**理由**: AI 在任何阶段都可能需要确认任务目标——不仅限于 claim_turn 时。

---

### P1-4: 通知事件类型和 payload schema 未定义

**类型**: P1 建议 | **对应**: P0-2 子任务

**描述**: spec 中没有任何章节定义 5 类通知事件的触发条件、payload 结构。

**方案**: 在 §4（数据流）或新增小节定义通知事件 schema。

**理由**: 没有标准化的事件定义，client 无法正确处理通知。

---

### P1-5: §2 架构总览图缺少 SSE 通知通道

**类型**: P1 建议

**描述**: 架构图只画了双向 request-response，未体现 SSE server→client 推送。

**方案**: 架构图中新增虚线箭头表示 SSE notification stream。

**理由**: 架构图是理解系统的第一入口。

---

### P1-6: rules_catalog 缺少 task 和通知相关规则

**类型**: P1 建议

**描述**: §11 rules_catalog 未覆盖通知事件处理和 task 字段使用规则。

**方案**: 新增规则：advance(IDLE→REQUIREMENTS) task 必填校验、收到 turn_ready 后 claim_turn 时限建议、task 不可变性。

**理由**: rules_summary 是 AI 的行为指南——缺少规则 = AI 不知道要用新能力。

---

### P2-1: task 是否应在 workflow 中途可更新？

**类型**: P2 疑问

**描述**: 当前方案 task 一次性设置。如果 IMPLEMENTATION 阶段发现需求理解有误，是否需要更新 task？

**方案**: v1 保持不可变。需求变更走 escalate → 用户沟通 → 决定是否重启工作流。v2 考虑 `update_task` 工具。

**理由**: 需求变更属例外情况，不应增加 v1 状态机复杂度。

---

### P2-2: SSE 通知失败是否需要重试机制？

**类型**: P2 疑问

**描述**: client SSE 连接断开时广播通知会丢失。

**方案**: v1 best-effort 无重试。client 可定时 get_state 弥补。

**理由**: 通知是优化体验手段，非数据一致性保障。state.json 是权威来源。

---

## 收敛状态

- 本轮新增 issue：P0：2，P1：6，P2：2
- 本轮关闭 issue：无（首轮评审）
- 对对方上一轮产出的立场：null（首轮，无上一轮产出）
- 是否需要下一轮：yes（等待监督者处理上述 issue）

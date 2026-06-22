# PairFlow 自动流转阻塞问题 Spec

> 日期: 2026-06-22
> 来源: 首次真实双 AI 接入验证（claude + deepseek）
> 关联: `2026-06-21-pair-flow-design.md`（功能 spec）、`2026-06-22-pair-flow-process-improvements.md`（过程改进）

本文档记录两个 **P0 阻塞级** 问题——不解决则 PairFlow 的"自动流转"无法实现。

---

## P0-19: 无事件通知，监督者无法感知对方动作

### 场景

2026-06-22 首次真实双 AI 接入：claude 注册为 supervisor 后，对方以 deepseek 身份注册。claude 完全不知道对方已注册——没有通知、没有事件、没有回调。监督者只能被动等待用户口头告知，然后手动 advance。

同样的问题贯穿全流程：

| 事件 | 当前行为 | 期望行为 |
|------|---------|---------|
| 对方注册完成 | 监督者无感知 | 推送通知给已注册方 |
| 对方 submit 后 | 持笔者不知道可以 claim turn | 推送 turn_ready |
| 首轮盲审提交后 | 对方不知道轮到自己盲审 | 推送 turn_ready |
| 双方盲审完成 | 监督者不知道可 advance | 推送 blind_review_complete |
| lease 即将超时 | 当前持笔者无感知 | 推送 lease_timeout 警告 |

**PairFlow server 是一个纯被动 HTTP 服务——只响应 tool call，不推送任何事件。**

### 根因

设计时隐含假设了 bootstrap 模式的人工协调（"轮到你了"），但 PairFlow v1 的生产目标是无人工介入的自动流转。MCP 协议本身支持 server→client 通知（`notifications/`），但 PairFlow 完全没有利用。

### 方案

PairFlow server 在关键状态变更时通过 SSE 向所有已连接的 MCP client 推送通知：

| 通知 | 触发时机 | payload |
|------|---------|---------|
| `peer_registered` | 第二个 peer 注册完成 | `{ identity, role }` |
| `turn_ready` | 轮到当前 client（对方 submit / advance 后） | `{ turn, phase, round }` |
| `phase_converged` | 当前阶段收敛，进入盲审 | `{ phase }` |
| `blind_review_complete` | 双方盲审完成，可 advance | `{ phase }` |
| `lease_timeout` | lease 即将到期（1 分钟前） | `{ expires_at }` |

MCP Streamable HTTP 的 SSE 通道天然支持 server→client 推送。Server 需维护已连接 client 列表并在状态变更时广播。应纳入功能 spec §4 架构部分。

---

## P0-20: advance 不携带任务上下文，AI 不知道要做什么

### 场景

claude advance IDLE→REQUIREMENTS 后，turn=deepseek。deepseek claim_turn 拿到模板：

```
## 本轮审阅范围
- 重新通读了以下章节：<列出>
- 本次修改涉及的章节：<列出>
```

deepseek 的回复：

> "当前是 requirements 阶段的第 1 轮……但在开始之前我需要先确认——我们要做什么功能/项目？"

模板全是 `<列出>` `<N>` `<IDs>` 占位符，没有任何任务信息。AI 不知道要审阅什么文档、要实现什么功能、目标是什么。**状态机推进了，但任务上下文是空的。**

### 根因

`claim_turn(advance)` 的 IDLE→REQUIREMENTS 分支只接收 `timeouts` 参数：

```ts
const timeouts = args.timeouts as Record<string, number> | undefined;
```

没有任何字段让监督者传入任务描述、目标文档路径、需求范围。PairFlow 的状态机设计关注"流程怎么走"，忽略了"走的时候要带什么信息"。

更深层：spec §5.1 state.json schema 中没有 `task` 字段。整个状态对象只描述流程元数据（phase/round/turn/issues），不描述**业务上下文**。一个不知道自己要做什么的 AI，流程再正确也没有产出。

### 方案

1. **state.json 新增 `task` 字段**：
   ```ts
   task: {
     description: string;      // 任务描述
     spec_file?: string;       // 目标 spec/文档路径
     goals?: string[];         // 阶段目标
     context?: string;         // 额外上下文（自由文本）
   } | null;
   ```

2. **advance 携带 task**：IDLE→REQUIREMENTS 的 advance 必须提供 `task` 参数，缺少则拒绝。

3. **模板渲染 task**：`getTemplate()` 将 `task.description`、`task.spec_file` 注入模板，替换无意义的 `<列出>` 等占位符。

4. **`get_context` 返回 task**：所有阶段 AI 随时知道任务目标。

示例：
```json
{
  "mode": "advance",
  "timeouts": { "requirements": 30, "planning": 20, "implementation": 120, "summary": 30 },
  "task": {
    "description": "实现 PairFlow v1 — 本地 HTTP MCP Server 驱动双 AI 结对编程",
    "spec_file": "docs/superpowers/specs/2026-06-21-pair-flow-design.md",
    "goals": ["完成功能 spec 审阅", "产出最终版设计文档"]
  }
}
```

---

## 优先级

两个问题均为 **P0 阻塞级**。关系：

```
P0-20 (task 上下文)
    ↓ 先修 —— AI 至少知道要做什么，能开始工作
P0-19 (事件通知)  
    ↓ 后修 —— AI 能自动感知对方动作，无需人工协调
全自动流转
```

当前 workaround（bootstrap 模式）：人工在两个 AI 窗口之间传递状态信息。

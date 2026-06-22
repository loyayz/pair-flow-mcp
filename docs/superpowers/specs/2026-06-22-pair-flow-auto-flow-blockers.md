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

## P0-21: 状态机缺少目标锚定——无 task 时 advance 应拒绝而非空转

### 场景

2026-06-22 双 AI 接入验证。claude advance IDLE→REQUIREMENTS 时未传 `task`。状态机正常推进，deepseek 拿到空模板后自行从 git log 中猜测审阅对象（`auto-flow-blockers.md`），之后的 4 轮交替评审、12 个 issue、收敛达成、盲审进行中——**全部在零目标输入下完成。**

状态机验证了 stance 一致性、审阅范围段落、提出者不修改、converge_mark 交叉校验、lease 超时……但从头到尾没有一刻问过：「我们的目标是什么？」

### 根因

P0-20 关注的是「缺少 task 传递通道」，P0-21 关注的是「通道缺了之后系统做了什么」。

当前行为：
```
advance(IDLE→REQUIREMENTS) 无 task → 静默通过 → 发空模板 → AI 自救
```

正确行为：
```
advance(IDLE→REQUIREMENTS) 无 task → 拒绝 → 返回 "advance from IDLE requires task"
```

这是一个**防御性设计缺失**——状态机假设调用方正确，不校验前置条件。类比：一辆车做了完美的车道保持和碰撞检测，但没有 GPS，它会完美地绕圈直到没油。而且它不会告诉你没有输入目的地。

4 轮空转的实际代价：
- 双方 AI 消耗了大量 token 审阅了一个 AI 猜测出来的文件
- 产出 12 个 issue 全部建立在一个未经确认的前提上
- 状态机正常运转的表象掩盖了「无目标」这个根本问题

### 方案

> **advance 前置校验——task 必填**：
> 1. `claim_turn(mode="advance")` 的 IDLE→REQUIREMENTS 分支：`task` 参数必填，缺少则返回错误，拒绝 advance
> 2. `task.description` 至少 10 字符，`task.spec_file` 必须是有效路径
> 3. 其他 phase 的 advance 不强制 task（已从 state 继承）
> 4. get_context/get_state 始终返回当前 task——即使为 null，让 AI 有意识「当前无任务」

**P0-21 与 P0-20 的关系**：

| | P0-20 | P0-21 |
|---|------|------|
| 问题 | advance 没有传 task 的通道 | 通道空的时候系统不拒绝 |
| 症状 | AI 拿到空模板不知道做什么 | AI 在零目标下完成了 4 轮空转 |
| 修法 | 新增 task 参数和存储 | advance 校验 task 必填，缺则拒绝 |
| 性质 | 功能缺失 | 防御缺失 |

两者必须一起修——P0-20 不修则 P0-21 的校验没有东西可验，P0-21 不修则 P0-20 修了也可能被绕过。

---

## P0-22: submit 数据流三层设计缺陷——入参重复、存储丢弃、归档空洞

### 场景

2026-06-22 双 AI 接入验证中，deepseek r2 提交时发现 `converge_mark` 中携带的 `proposal`/`rationale`/`my_position` 全部未写入 `state.json`。追溯代码确认：submit 的数据流在三个层面存在设计缺陷。

### 三层缺陷

```
  submit 数据流设计缺陷
      │
      ├── 入参层：content 和 converge_mark.new_issues 重复 issue 信息
      │         → body 过长，shell 调用失败
      │
      ├── 存储层：converge_mark 中的 proposal/rationale/my_position
      │         在 submit→state.json 路径被丢弃
      │         （但 create_issue→state.json 路径正常）
      │
      └── 归档层：meta.json 只存 issue ID 数组，不存完整对象
                → 崩溃恢复时 issue 内容全部丢失
                → §8 "meta.json 是权威来源"声明失效
```

#### 入参层：信息重复

`submit` 同时接受 `content`（markdown）和 `converge_mark.new_issues`（JSON 数组）。两者都描述同一批 issue 的 `type/topic/description`。AI 必须在 markdown 和 JSON 中各写一遍相同信息。实际后果：双 AI 接入时 deepseek 的一次 submit 因 JSON body 过大导致 shell 调用失败。

#### 存储层：字段丢弃

```ts
// submit.ts: issue 创建代码
state.issues.push({
  // ... 其他字段
  proposal: ni.proposal ?? null,
  rationale: ni.rationale ?? null,
});
```

`my_position` 在 `issue_stances` 分支中有单独处理，但 **提案中的 my_position 没有写入 `issue.positions[identity]`**。`proposal` 和 `rationale` 有赋值代码，但在 deepseek 的实际提交中全部为 null——根因是 `converge_mark` 到 `new_issues` 的字段映射不完整。

作为对比：`create_issue` 工具直接接收 `proposal`/`rationale` 并正确写入 `state.json`，路径清晰。`submit` 的 `converge_mark.new_issues` → `state.issues` 路径使用了相同的字段名但未经过相同的存储逻辑。

#### 归档层：空洞的 meta.json

```json
// 当前 meta.json 的 new_issues
{ "new_issues": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }

// 应该是
{ "new_issues": [
  { "id": 1, "type": "P0", "topic": "advance 不携带 task...", ... },
  ...
]}
```

§8 崩溃恢复的步骤 2（journal replay）可以重建 issue，但前提是 journal 中有完整信息。当前 journal 记录 issue 创建事件但不持久化 `proposal` 和 `rationale`。meta.json 作为"每轮 submit 的权威产出快照"，只存 ID 数组等于放弃了自己作为恢复来源的能力。

### 根因

submit 的设计以「AI 只需告诉 PairFlow 发生了什么」为前提，而非「PairFlow 需要精确记录 AI 说了什么」。三个层面共享同一个错误：**将 submit 视为事件通知而非数据持久化入口。**

### 方案

> **分层修复**：
> 1. **入参层**：`converge_mark.new_issues` 退化为摘要 `[{type, topic}]`，markdown content 中的 issue 详情为权威来源。PairFlow 不解析 content，仅存储
> 2. **存储层**：`converge_mark.new_issues` 中的 `proposal`/`rationale` 必须写入 `state.issues[]`；`my_position` 写入 `issue.positions[identity]`
> 3. **归档层**：`meta.json` 的 `new_issues` 存储完整 issue 对象（含 type/topic/description/proposal/rationale），而非仅 ID 数组。使 §8 声明成立
>
> 替代方案：保持 `converge_mark.new_issues` 为完整结构，markdown content 不重复 issue 详情。但需解决 body 过大问题（分页或外部引用）。

此问题为 **P0 阻塞级**——submit 是 PairFlow 的核心数据入口，入口设计有缺陷则下游所有数据链路受损。

---

## 优先级

四个问题均为 **P0 阻塞级**。修复顺序：

```
P0-22 (submit 数据流——入参去重、存储补全、归档完整)
    ↓ 修了这个，submit 的数据入口才可靠，下游链路才有保障
P0-21 (目标锚定——advance 缺 task 拒绝)
    ↓ 修了这个，没有 task 根本进不了 REQUIREMENTS
P0-20 (task 上下文——advance 携带并存储 task)
    ↓ 修了这个，task 能传进来、存下来、模板渲染出来
P0-19 (事件通知——SSE 推送状态变更)
    ↓ 修了这个，AI 自动感知对方动作
全自动流转
```

当前 workaround（bootstrap 模式）：人工在两个 AI 窗口之间传递状态信息。

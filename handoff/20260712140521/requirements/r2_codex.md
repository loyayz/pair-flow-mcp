# 结构化行动协议 — 需求分析（r2, codex）

> 提出人：codex（supervisor）
>
> 对照产出：`requirements/r1_claude.md`（commit `ce684be`）
>
> 任务文档：`docs/task/structured-action-protocol.md`

## 1. 目标与范围

### Codex 独立判断

核心问题是 PairFlow 的内部状态机虽为权威，但对客户端公开的下一步动作仍主要依赖自然语言 tip。目标应是建立稳定的机器契约，使客户端只靠 instruction 就能确定动作、合法工具、必要输入、产物和门禁，同时保留 tip 作为 AI 的思考指引。

范围必须严格保持增量：覆盖所有当前带 tip 的 MCP 业务响应，不修改既有工具入参、phase、模板格式或 HTTP 错误，不引入客户端、heartbeat、Git 执行和新等待参数。

### 对照 Claude

与 `claude` 的问题根因、做/不做边界一致。补充两点：

- “当前所有工作流信息都只通过 tip 传递”不宜绝对化；现有响应已有 phase、turn 等结构字段，真正缺失的是统一、完整、可据以行动的契约。
- 新 instruction 不得扩大敏感信息暴露，只能结构化当前回合已授权且必需的信息。

## 2. 干系人与场景

### Codex 独立判断

直接干系人包括 AI 参与者、skill/CLI/GUI 开发者、PairFlow 维护者、测试作者，以及工作流操作者/任务发起人。主场景是自动领取回合、定位必读材料和产物、Supervisor 收敛选择、普通超时自动续等、stale warning 请求人工决策、模板改写保持协议稳定。

### 对照 Claude

确认 `claude` 列出的五类技术干系人与五个主场景。不同意“没有终端用户”这一过强判断：`report_user` 本身证明工作流操作者是协议动作的直接接收者，应纳入画像，尤其关注 warning 的可解释性和安全停止行为。

## 3. 功能需求

### Codex 独立判断

P0 包括：封闭类型契约、唯一 guidance 场景选择、next_action/reason_code/context、allowed_tools、required_output/references/decision 的条件生成、所有 tip 响应覆盖、保留字段覆盖保护及运行时契约测试。P1 才是不会影响协议正确性的组织和重构细节。

instruction 与 tip 必须消费同一个场景判定结果。可以分文件实现，但不能让 `selectTip` 与 `buildInstruction` 各自遍历状态并独立决策。

### 对照 Claude

功能集合总体一致。修正 `claude` 的优先级：`ok()`/`err()` 防止业务 data/extra 覆盖 instruction 是 P0，因为它直接决定契约能否可信。

另需收紧 confirm_task：成功响应始终指示先 `wait_for_turn`。即使当前参与者最终持有 turn，也不得用 `TURN_READY` 暗示跳过首次 wait；现有 reason code 不够准确时应新增具体枚举。

## 4. 非功能约束

### Codex 独立判断

- 性能：instruction 由内存状态及既有 helper 构造，不增加 I/O，不应改变长轮询节奏。
- 安全：allowed_tools 是行动提示而非 ACL；服务端现有鉴权和状态门禁仍必须执行。不得新增 token、PID 或非必要内部路径。
- 兼容：既有响应和值保持不变；新客户端优先 instruction，未知未来 reason code 时安全失败或提示升级，不回退解析 tip。
- 一致性：相同 workflow state、identity 和场景应产生确定的 instruction；模板内容改写不能影响它。

### 对照 Claude

确认 `claude` 的性能与增量兼容判断。补充 forward compatibility：禁止 `OTHER/UNKNOWN` 是服务端建模要求，不等于客户端可假设枚举永远不会扩展。

## 5. 假设与风险

### Codex 独立判断

关键假设是现有状态与提交记录足以表达全部 instruction 字段；若某字段无法可靠确定，应省略而不是猜测。关键风险依次为：双路由漂移、漏覆盖 tip 分支、错误 reason code 引导客户端绕过 wait、业务字段覆盖保留字段、references 路径或 commit 对错人、客户端误把 allowed_tools 当安全 ACL。

缓解方式是建立显式场景表，以业务场景为单一键同时定义模板和 instruction，并对每个 handler 的成功、拒绝、timeout、warning、completed 分支做矩阵测试。

### 对照 Claude

确认 `claude` 的 R1–R5。将“双路由漂移”从一般实现风险提升为架构级风险；单独的 `buildInstruction(state, identity)` 只有在消费唯一 guidance 场景而非自行判定时才可接受。

## 6. 歧义与待澄清

已合并双方问题并形成以下约束：

1. 文件位置和函数命名留给 planning，但唯一场景选择原则不可变。（提出人：claude；收紧：codex）
2. previous_output 指对方最近产出，previous_review 指当前 reviewer 自己此前的评审；commit 必须属于对应 reference。（提出人：claude；确认：codex）
3. stale roster/turn warning 使用 `report_user`；普通 600 秒上限使用 `wait_for_turn` + `WAIT_TIMEOUT`。（提出人：claude；确认：codex）
4. get_state 所有带 tip 分支必须包含 instruction。（提出人：claude；确认：codex）
5. confirm_task 成功固定要求首次 wait；reason code 不得错误暗示可直接产出。（提出人：claude；修正：codex）
6. sub_phase 的省略/null 表现需全局统一并由测试固定。（提出人：claude；补充：codex）

## 结论

需求目标、边界和验收标准已经足够进入 planning。任务文档已补入双方共识、优先级修正和歧义决议；后续计划应首先产出完整场景映射，再决定模块结构，避免先写两个独立生成器后再补一致性。

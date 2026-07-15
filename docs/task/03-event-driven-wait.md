# 事件驱动的行动权等待与 JSON 响应

**状态**：待处理

`wait_for_turn` 当前通过固定间隔检查工作流状态，并由 Streamable HTTP transport 返回 SSE 格式。需要改为由进程内状态变化事件直接唤醒请求，同时让整个无状态 `/mcp` endpoint 返回普通 JSON-RPC JSON 响应。

**设计规格**：`docs/design.md`

**联合任务**：本任务与 `02-turn-assignment-claim-reminder.md` 共用同一等待内核和实施计划。02 定义 assigned/claimed、`claim_turn` 与提醒周期；本任务定义事件协调器、waiter 生命周期、并发竞态和 transport。

## 已确认方案

采用“请求内事件等待”方案：

1. `wait_for_turn` 在当前不能返回业务结果时登记进程内 waiter，并保持本次工具请求等待。
2. `confirm_task`、`submit`、`advance`、`claim_turn`、warning 确认和 workflow 终止等成功状态变化后，发布 workflow 变化事件。
3. waiter 被事件唤醒后重新读取并校验 Server 状态；事件只表示“状态可能变化”，不携带业务事实。
4. 如果状态变化时目标参与者没有 waiter，Server 只保留真实 workflow 状态；参与者之后调用时立即按当前状态处理，不重放通知。
5. 不增加 SSE notification，不假设 MCP notification 能唤醒空闲 Agent。
6. 单次请求仍以 600 秒为上限；客户端透明续等属于 `06-agent-integration-sdk-cli.md`。（用户、codex）

整个 `/mcp` endpoint 使用 SDK 的 JSON response mode：每个无状态 `StreamableHTTPServerTransport` 设置 `enableJsonResponse: true`，所有 MCP POST 成功和协议响应统一返回 `Content-Type: application/json`。`wait_for_turn` 是延迟完成的普通 JSON-RPC 请求，不通过 SSE 流式推送。（用户、codex）

## 事件协调器

- 按 workflow 维护递增变化版本和 waiter 集合；业务状态仍存于 PairFlow state。
- waiter 先读取状态和版本，再登记监听，登记后立即复查版本；版本已变化则不休眠，避免检查与登记之间漏事件。
- 重复、提前、合并或无关事件只会使 waiter 重新读状态，不会直接返回成功或改变 workflow。
- 状态写入、归档写入或业务操作失败时不得发布成功事件。
- workflow 删除后先发布终止变化；事件协调器在相关 waiter 全部释放后删除。

## `wait_for_turn` 等待模型

每次循环重新判断真实状态，并在不能返回时等待以下最早信号：

- workflow 变化版本更新；
- 当前 roster/turn warning 的 30 分钟边界；
- 单次请求 600 秒上限；
- 客户端取消或 latest-wins 替换。

不再保留固定 10 秒轮询。warning timer 只属于活跃等待请求；没有 waiter 时不运行后台 timer，参与者稍后调用时按当前时间直接判断是否到期。

当调用方持有尚未领取的 turn 时，`wait_for_turn` 立即返回 `claim_turn / TURN_ASSIGNED`，不写 claim、不返回本轮完整产出指引。已 claimed 的当前持有者调用时可返回其当前完整行动指引。

## Waiter 生命周期

- waiter 按 workflow + identity 登记，同一身份采用 latest-wins。
- 新等待替换旧等待时，旧请求按现有取消语义结束。
- 客户端取消、请求超时、返回 claim 指令、返回业务行动、warning、拒绝和 workflow 终止都必须注销 waiter、timer 与 abort listener。
- waiter 被唤醒但状态仍不满足时，继续等待本次请求剩余时间。
- warning 后同一身份下一次无参 `wait_for_turn` 按 02 的规则确认当前已报告周期，再进入正常事件等待。
- 单个身份最多保留一个有效 waiter，计时器和 listener 数量不得随重试增长。

## 触发事件

至少在以下成功变化后发布：

- 第二位参与者 `confirm_task`，roster 从不完整变为完整；
- 恢复占位参与者重新确认，使 roster 或等待条件变化；
- `submit` 成功并切换 turn；
- `advance` 成功并初始化新阶段 turn；
- `claim_turn` 成功；
- warning 被下一次 `wait_for_turn` 确认；
- workflow 正常终止或 live state 被删除。

提醒边界由请求内 deadline timer 直接唤醒相应 waiter，不需要先发布独立业务事件。

## 范围

### 必须覆盖（P0）

- 用事件等待替换 `wait_for_turn` 的固定间隔轮询。
- workflow 变化版本、waiter 登记、复查、唤醒和清理。
- submit、advance、confirm_task、claim、恢复、warning 确认和终止路径的触发。
- 登记与事件先后顺序、重复事件、无 waiter 和 workflow 删除竞态。
- latest-wins、取消、超时和请求剩余时间计算。
- 与 02 两类 30 分钟 warning deadline 的一致协作。
- 所有 `/mcp` POST 使用 JSON response mode，包含延迟完成的 `wait_for_turn`。
- SDK Client、raw HTTP、tools/list、health 和冷启动采集在 JSON 响应下保持兼容。

### 本任务不做

- 不向 Codex、Claude 或其他 Agent 发送独立外部唤醒消息。
- 不把 MCP notification、SSE 消息或进程信号作为行动权事实来源。
- 不增加 heartbeat、active、blocked 或 claimed 后活性判断。
- 不启动常驻客户端、代理或守护进程。
- 不取消单次等待请求的 600 秒上限。
- 不实现客户端自动重连、token 持久化或透明续等。
- 不执行 Git、测试、构建或其他外部命令。

## 质量与安全约束

- 事件发布与 waiter 登记之间不得存在永久漏唤醒窗口。
- warning 确认与 `claim_turn` 的线性化继续遵循 `docs/design.md`。
- 业务状态更新失败时不得先唤醒并使客户端误判成功。
- 无 waiter 时丢弃通知不得丢失行动权或终止事实，后续请求必须能从状态恢复。
- JSON response mode 不改变 MCP JSON-RPC envelope、structuredContent/content 双通道或业务 output schema。
- PairFlow 的任何组件均不得为了等待或唤醒而执行外部命令。

## 验收标准

- submit、advance、confirm_task、claim 或终止改变等待条件后，相关 `wait_for_turn` 无需等待固定轮询间隔即可处理新状态。
- 状态变化时没有 waiter，参与者稍后调用仍能得到正确状态或行动。
- 重复、无关和提前事件不会导致错误 claim、重复返回或状态推进。
- latest-wins、取消和超时后没有残留 waiter、listener 或 timer。
- roster、恢复、workflow 终止和 30 分钟 warning 边界都能正确唤醒等待请求。
- 所有 `/mcp` POST 原始响应为 `application/json`，不包含 `text/event-stream` 包装。
- 标准 SDK Client 和 raw JSON 客户端都能解析普通工具与长等待结果。
- fake timer 和并发测试覆盖登记/触发竞态、deadline、取消、无 waiter 恢复与资源计数。
- 实现不会发送独立 Agent 唤醒通知，也不会执行外部命令。

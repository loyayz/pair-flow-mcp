# 事件驱动的行动权等待

**状态**：待处理

`wait_for_turn` 当前通过固定间隔检查工作流状态来发现 turn 切换。即使另一参与者已经 submit 或 advance，等待方也可能在下一次检查前继续等待；同时，轮询把“状态是否已变化”和“何时唤醒请求”耦合在一起。需要改为由状态变更事件直接唤醒等待请求，同时保持 Server 状态为唯一事实来源。

**设计规格**：`docs/design.md`

## 已确认方案

采用“请求内事件等待”方案：

1. `wait_for_turn` 在当前尚未轮到调用方时注册内存 waiter，并保持本次工具请求等待。（用户、codex）
2. submit、advance、参与者完整就位或工作流终止等相关状态变化后，直接唤醒受影响的 waiter，不再依赖固定间隔轮询发现变化。（用户、codex）
3. waiter 被唤醒后重新读取并校验 Server 状态；只有状态确实允许行动时才返回完整指引并原子完成 claim。（codex）
4. 如果状态变化时下一参与者没有有效 waiter，Server 只保留 assigned 状态；该参与者之后调用 `wait_for_turn` 时立即领取，不依赖历史通知重放。（用户、codex）
5. 不增加独立 SSE notification，不假设 MCP 通知能够唤醒空闲的 Codex、Claude 或其他 Agent。（用户、codex）
6. 单次请求仍有明确上限；客户端超时后的透明续等属于 `06-agent-integration-sdk-cli.md`。（codex）

## 核心原则

- 工作流状态决定谁可以行动；事件只用于提示等待请求“状态可能变化了”。
- 唤醒事件可以重复、合并或早到，waiter 必须在 mutex 内重新检查真实状态。
- 事件丢失不得导致行动权丢失：assigned 状态始终允许后续 `wait_for_turn` 立即恢复。
- 通知不是业务事实，也不单独改变 phase、round、turn 或 claim。
- 不通过 Server 主动向 Codex 任务注入消息，也不建设外部 Agent 唤醒接口。

## Waiter 生命周期

- waiter 按 workflow 与 identity 登记，同一身份仍采用 latest-wins。
- 新等待请求替换旧请求时，旧请求按现有取消语义结束并释放资源。
- 客户端取消、请求超时、成功领取、业务拒绝、工作流终止和 Server 关闭都必须注销 waiter。
- waiter 被唤醒但状态仍不满足时，继续等待本次请求剩余时间，而不是返回虚假行动。
- 超过未就位或未领取告警阈值时，应按 `02-turn-assignment-claim-reminder.md` 返回对应告警。
- waiter 不保存 token 之外的新权限事实；每次完成前仍执行必要的身份、roster 和状态检查。

## 触发事件

至少在以下变化后检查并唤醒相关 waiter：

- 第二位参与者 confirm_task，roster 从不完整变为完整；
- submit 成功并把 turn 切给另一参与者；
- advance 成功并初始化新阶段 turn；
- 工作流进入完成状态或被终止；
- 崩溃恢复后的参与者重新确认使工作流重新具备等待条件；
- 与未就位、未领取提醒周期有关的定时边界到达。

触发动作必须发生在状态变更成功之后。写入归档或状态变更失败时不得发送会使客户端误判成功的唤醒。

## 范围

### 必须覆盖（P0）

- 用事件等待替换 `wait_for_turn` 的固定间隔状态轮询。
- workflow + identity 的 waiter 注册、替换、唤醒和清理。
- submit、advance、confirm_task、恢复和终止路径的正确触发。
- 唤醒后的 mutex 内状态复核和 claim 线性化。
- 请求取消、超时、latest-wins、重复唤醒和事件先于登记发生的竞态。
- 没有活跃 waiter 时依赖 assigned 状态的无损恢复。
- 与 30 分钟未就位/未领取告警及确认周期的一致协作。
- 资源释放和 waiter 数量不随超时、取消或工作流完成持续增长。

### 本任务不做

- 不向 Codex、Claude 或其他 Agent 发送独立的外部唤醒消息。
- 不把 MCP notification、SSE 消息或进程信号作为行动权事实来源。
- 不增加 heartbeat、active、blocked 或 claimed 后活性判断。
- 不启动常驻客户端、代理或守护进程。
- 不取消单次等待请求的超时上限。
- 不在本任务中实现客户端自动重连或 token 持久化。
- 不执行 Git、测试、构建或其他外部命令。

## 质量与安全约束

- 事件发布和 waiter 登记之间不得存在导致永久漏唤醒的竞态；登记前后都必须检查状态。
- claim 的线性化点继续遵循 `docs/design.md`：取消发生在持久化 claim 前则不领取，之后则不回滚。
- 业务状态更新失败时不得先行唤醒并返回成功指引。
- 单个身份最多保留一个有效 waiter；旧请求和已完成请求必须及时释放监听器、计时器和取消处理器。
- 事件机制只存在于 PairFlow 进程内，不引入新的跨进程状态或交付保证。
- PairFlow 的任何组件均不得为了等待或唤醒而执行 Git 命令。

## 验收标准

- submit 或 advance 将 turn 切给正在等待的参与者后，其 `wait_for_turn` 无需等待固定轮询间隔即可返回。
- 状态变化时没有 waiter，参与者稍后调用 `wait_for_turn` 仍能立即获得同一行动权。
- 重复事件、无关事件和提前事件不会导致错误 claim、重复返回或状态推进。
- latest-wins、取消和超时后没有残留 waiter、监听器或计时器。
- roster 完整、恢复确认、工作流终止和 30 分钟告警边界都能正确唤醒相应请求。
- 既有 phase、round、turn、claim 和警告语义保持不变，仅等待实现从轮询改为事件驱动。
- 并发与 fake timer 测试覆盖登记/触发竞态、取消线性化和无 waiter 恢复。
- 实现不会发送独立 Agent 唤醒通知，也不会执行 Git 或其他外部命令。


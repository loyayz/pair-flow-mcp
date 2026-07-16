# 行动权分配、领取与重复提醒

**状态**：已完成

PairFlow 需要明确区分行动权已经分配但尚未领取，以及参与者已经通过完整行动指引取得执行权。现有未就位和未领取告警在用户明确选择继续等待后会立即重复出现，需要形成简单、可预测且可由零背景 AI 正确执行的提醒闭环。

**设计规格**：`docs/design.md`

**联合任务**：本任务与 `03-event-driven-wait.md` 共用同一等待内核和实施计划。本任务定义 turn、claim 与提醒语义；03 定义事件唤醒、waiter 生命周期和 JSON transport。

## 已确认方案

行动权只保留两个阶段：

1. **assigned**：Server 已将 turn 分配给参与者，但参与者尚未领取。
2. **claimed**：参与者已通过 `claim_turn` 收到该 turn 的完整行动指引。

恢复独立的无参 `claim_turn` 工具。`wait_for_turn` 只同步 roster、turn、提醒边界和 workflow 终止；当调用方持有尚未领取的 turn 时，它返回 `claim_turn / TURN_ASSIGNED` 结构化指令，但不修改 `turn_claimed_at`。`claim_turn` 在 workflow mutex 内完成领取并返回完整行动指引。（用户、codex）

instruction protocol 在 1.x 内以加法兼容方式升级为 `1.1`，新增 `claim_turn` action/tool、`TURN_ASSIGNED` reason 和 warning 用户决策分支；旧消费者遇到未知枚举时继续遵循 `/health` 的安全停止规则。（codex）

所有新 turn 无论由 `confirm_task`、`submit` 还是 `advance` 产生，都先进入 assigned。即使 turn 分配给当前调用者本人，也不得同步写入 `turn_claimed_at`。（用户、codex）

未就位和未领取提醒共用可重复的 30 分钟周期：

1. roster 未完整满 30 分钟，或 turn 保持 assigned 满 30 分钟时，当前周期只提醒等待方一次。
2. warning 的结构化 instruction 先要求报告用户，并提供“继续等待 → `wait_for_turn`；停止 → `stop`”决策分支。
3. 用户选择继续后，同一身份下一次调用无参 `wait_for_turn`，即确认当前已报告 warning；Server 从该调用的线性化时间重新计算 30 分钟。
4. 新周期结束时条件仍未解除，再次提醒。
5. roster 完整、claim、新 turn、阶段推进和 workflow 终止会清除或替换旧周期。
6. 不增加 warning id、确认参数或独立 `ack_warning` 工具。（用户、codex）

崩溃恢复不持久化 warning/ack sidecar。首位真实参与者重新确认后，roster warning 从本次确认时间计时；双方恢复确认完整后，恢复出的 assigned turn 从 roster 恢复就绪时间重新获得完整 30 分钟领取窗口。（用户、codex）

## 状态语义

- `turn_switched_at` 是当前 turn 的分配时间。
- `turn_claimed_at === null` 表示 assigned；非空表示 claimed。
- 不额外保存或公开 `turn_status`，避免与时间戳形成可漂移的重复状态。
- claim 只描述完整行动指引是否被领取，不表示实际工作进度、活性或完成度。
- 内部 `wait_warning_cycle` 最多只有一个，因为 roster 未完整与 turn 未领取不会同时成立。周期包含 kind、generation、next_report_at、reported_at 和 reported_to。

## `claim_turn` 契约

- 无入参，仅当前 turn 持有者可调用。
- 首次成功时在 workflow mutex 内写入 `turn_claimed_at`，然后返回本轮完整行动指引。
- 同一 turn 重复调用幂等返回相同指引，不改写首次 claim 时间。
- turn 已切换或属于对方时拒绝，不得领取旧 turn 或他人 turn。
- 取消在 claim 线性化点之前发生则不改状态；之后发生则不回滚 claim。
- claim 不转移 turn、不推进 round、不改变 phase/sub_phase。

## 范围

### 必须覆盖（P0）

- 所有 turn 分配路径统一进入 assigned。
- `wait_for_turn` 与 `claim_turn` 的职责拆分和结构化协议映射。
- 两类 30 分钟 warning 的单次报告、隐式确认和重复周期。
- 新 turn、claim、阶段推进、workflow 终止和恢复时的周期清理或重置。
- claim、warning 确认、请求取消和状态变化之间的线性化。
- `claim_turn` 的 tools/list input/output schema、health catalog、initialization information 和冷启动场景。
- 与 `03-event-driven-wait.md` 的事件唤醒和 latest-wins 一致协作。

### 本任务不做

- 不增加 active、inactive、blocked 等第三种行动状态。
- 不增加 heartbeat 或周期性活性上报。
- 不判断 claimed 后参与者是否仍在工作、卡死或掉线。
- 不自动回收、撤销或转交已经分配的 turn。
- 不增加 `ack_warning`、warning id 或 `wait_for_turn` 确认参数。
- 不持久化 warning/ack sidecar。
- 不要求常驻客户端进程。
- 不解决客户端单次长轮询的超时重试；该职责属于 `06-agent-integration-sdk-cli.md`。

## 行为约束

- warning 确认不得改变 phase、round、turn 或 claim 状态。
- 同一身份只有在当前周期已经向其报告后，下一次 `wait_for_turn` 才构成确认；无已报告周期时是普通等待。
- warning 确认在 mutex 内完成；确认前观察到取消则不改周期，确认后取消不回滚已开始的新周期。
- 旧 generation 的状态不得抑制新 roster 或新 turn 的 warning。
- warning 已报告但尚未确认时，不得再次返回同一周期的相同 warning。
- claim 成功后，即使响应随后因客户端取消而未被消费，也不回滚已持久化的 claim。

## 实现证据

- `claim_turn` 已作为唯一 assigned → claimed 转换实现；新 turn 保持 `turn_claimed_at === null`，首次领取写入时间，重复领取保持幂等。
- roster 与未领取 turn 的 30 分钟 warning generation、单次报告、同身份隐式确认、重复周期、恢复重置和取消线性化已纳入事件等待实现。
- 相关自动化覆盖 `claim-turn.test.ts`、`wait-for-turn.test.ts`、`confirm-task-lifecycle.test.ts`、`advance.test.ts`、`submit-round-order.test.ts` 与 `crash-recovery.test.ts`；assigned 状态绕过 `claim_turn` 直接调用 mutation 的回归也已覆盖；2026-07-16 fresh 全量验证为 30 个文件、378/378 tests 通过。

## 验收标准

- 新 turn 分配后，`turn_claimed_at` 为空；`wait_for_turn` 返回 `claim_turn / TURN_ASSIGNED` 且不修改 claim。
- `claim_turn` 成功后写入首次 claim 时间并返回完整行动指引；同一 turn 重试幂等。
- roster 未完整或 assigned 满 30 分钟时，当前周期只提醒一次。
- 用户继续后调用无参 `wait_for_turn`，随后 30 分钟内不会再次收到同类提醒。
- 确认后再满 30 分钟且条件仍未解除，会触发下一周期提醒。
- claim、新 turn、阶段推进、workflow 结束和恢复不会遗留错误的旧周期。
- 恢复 roster 完整后，assigned turn 获得新的完整 30 分钟窗口。
- 不启动 heartbeat、常驻客户端或 warning sidecar，也不根据 claimed 推断参与者仍在执行任务。
- 并发、取消、恢复、幂等和恰好 30 分钟边界均有自动化测试。

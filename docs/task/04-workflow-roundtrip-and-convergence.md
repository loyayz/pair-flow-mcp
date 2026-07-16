# 工作流往返优化与结构化收敛状态

**状态**：已取消

**取消说明**：显式 `claim_turn` 已被确立为 assigned → claimed 的唯一入口，结构化行动协议也已覆盖状态机门禁；本任务不再实施自指向 `advance` 自动 claim 或额外的收敛状态扩展。

PairFlow 当前在阶段推进后统一要求调用方执行 `wait_for_turn`。当新阶段的首个 turn 仍属于 advance 调用者本人时，Server 已经知道调用方可以立即行动，却仍增加一次无意义的网络往返。同时，Supervisor 需要从自然语言 tip 推断当前是否满足推进门禁，客户端缺少直接、稳定的状态机结论。

**设计规格**：`docs/design.md`

## 已确认方案

采用“只优化无意义往返，不改变工作流规则”的方案：

1. `advance` 后如果新 turn 属于调用者本人，响应直接返回该 turn 的完整行动指引，不再要求调用方额外执行一次 `wait_for_turn`。（用户、codex）
2. 直接返回完整指引时同步完成 claim，其语义与 `wait_for_turn` 成功领取相同。（用户、codex）
3. 如果新 turn 属于另一参与者，调用方仍进入 `wait_for_turn`，保持现有串行协作语义。（codex）
4. 协作响应提供结构化状态机门禁，明确双方提交、turn 回归和是否允许推进，不要求 Agent 从 tip 文案推断。（用户、codex）
5. requirements、planning、implementation 的 coding/review 交替和 summary 规则保持不变。（用户、codex）
6. 不增加“连续 coding”或跳过 review 的逃生口；提交后的互审继续作为 PairFlow 的核心约束。（用户、codex）

## 结构化收敛状态

响应应提供足以描述状态机门禁的稳定字段，至少能够表达：

- 当前阶段要求的双方产出是否齐全；
- 当前 round/sub_phase 是否已完成；
- turn 是否已回到有权推进的 Supervisor；
- 当前调用者是否允许 advance；
- 若不允许推进，仍缺少哪个协议事件；
- 当前是否应立即产出、等待对方或由 Supervisor 决策。

具体字段名在实施设计中确定。这里的“收敛”仅指状态机条件是否满足，不表示 PairFlow 判断双方内容已经达成一致。

## 自指向 advance

当 `advance` 完成阶段转换且新 turn 属于调用者时：

- 在同一次原子状态变更中记录新阶段、首轮 turn 和 claim；
- 响应的 next action 直接是产出并提交；
- 返回与正常领取 turn 相同的 required output、references、allowed tools 和上下文；
- 不要求客户端通过第二次调用补全行动指引；
- 重复请求和响应丢失不得造成重复推进或不一致 claim。

当新 turn 属于对方时，`advance` 仍返回等待动作，且不得替对方提前 claim。

## 范围

### 必须覆盖（P0）

- 所有 phase transition 的新 turn 归属矩阵。
- 自指向 advance 的直接行动响应与原子 claim。
- 非自指向 advance 的正常等待响应。
- get_state、wait_for_turn、submit、advance 中一致的结构化门禁字段。
- 状态机不允许推进时的稳定原因码和缺失条件。
- 重复 advance、并发请求、取消和响应丢失下的幂等行为。
- 直接响应与原 `advance → wait_for_turn` 两步路径的语义等价测试。

### 本任务不做

- 不允许同一参与者连续占有多个 coding round。
- 不跳过 review，也不增加双方确认跳过 review 的分支。
- 不允许客户端自行指定下一个 turn、phase 或 sub_phase。
- 不改变 Supervisor 的裁定权和 advance 权限。
- 不由 PairFlow 判断产物内容是否正确或双方观点是否真正收敛。
- 不执行 Git、测试、构建或其他外部命令。
- 不增加自定义工作流图或任意可配置状态机。

## 质量与安全约束

- 优化只能减少请求次数，不能改变相同输入下最终状态机结果。
- 直接 claim 与 `wait_for_turn` claim 必须复用同一行动指引和协议校验逻辑，避免形成两套行为。
- tip 可以解释状态，但客户端决策只依赖结构化动作、门禁和原因码。
- 结构化门禁由 Server 根据状态计算，客户端不得提交或覆盖这些字段。
- PairFlow 的任何组件都不得为了生成门禁或行动指引而执行 Git 命令。

## 验收标准

- advance 后 turn 仍属于调用者时，一次响应即可获得完整产出指引，并且状态显示为 claimed。
- advance 后 turn 属于对方时，调用者收到等待指引，对方仍必须自行领取。
- Supervisor 无需解析 tip 即可判断是否能够推进，以及尚缺少什么协议事件。
- 直接路径与原两步路径在 phase、round、turn、claim、required output 和 references 上语义一致。
- coding/review 仍严格交替，不存在跳过互审或连续 coding 的新入口。
- 全部 phase transition、角色组合、并发和幂等场景有自动化测试。
- 实现不会执行 Git 或其他外部命令。

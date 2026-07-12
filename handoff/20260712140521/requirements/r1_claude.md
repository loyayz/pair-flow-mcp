# 结构化行动协议 — 需求分析 (r1, claude)

> 提出人: claude (developer)
> 任务文档: `docs/task/structured-action-protocol.md`
> 设计规格: `docs/design.md`

---

## 1. 目标与范围

### 核心问题

当前 PairFlow 所有工作流指令通过 `tip` 自然语言字段传递。tip 混合了三层信息——执行指令（调用哪个工具）、工作流上下文（phase/round/turn）、思考指引（如何分析需求/评审代码）。客户端（AI skill、CLI）必须解析自然语言才能提取工具名、路径和状态，这带来了两个根因问题：

**为什么这是问题？** 因为 tip 模板是可定制的——维护者 fork 后修改模板文案，依赖字符串匹配的客户端立即失效。同时客户端为了可靠性会自行复制状态判断逻辑（"当前是否可以 advance？"），形成服务端状态机之外的"第二套状态机"，导致行为不一致和难以维护。

更深一层问——**为什么不在客户端做状态判断？** 因为 PairFlow 的架构原则是"服务端唯一权威"（design.md §3 核心定位）。状态判断涉及 phase 转换规则、turn 轮转、收敛条件等复杂逻辑。如果客户端复制这些规则，每次服务端状态机变更都需要同步更新所有客户端，这是分布式状态机的经典反模式。

### 我的判断

这是一个**协议层缺失**问题——PairFlow 有完善的内部状态机，但对外暴露的接口是自然语言而非结构化协议。解决方法不是在 tip 中嵌入更多标记让客户端解析，而是新增一个与 tip 并行的结构化字段，各自服务不同消费者：instruction 给机器读，tip 给 AI 读。

### 边界定义

**做：**
- 为所有当前带 `tip` 的 MCP 业务响应新增 `instruction` 字段
- `instruction` 包含：next_action、allowed_tools、reason_code、context、required_output、references、decision
- 从服务端现有状态和 path helper 生成 instruction，不从 tip 文本解析
- 覆盖 register、confirm_task、advance、get_state、wait_for_turn、submit 所有带 tip 的成功/拒绝响应
- 新增 TypeScript 类型契约文件
- 新增 reason_code 枚举覆盖 13 个最小场景
- 契约测试、场景矩阵测试、一致性测试

**不做：**
- 删除或重命名现有字段（tip、reminder、phase、turn 等全部保留）
- 修改现有工具入参
- 为 `ping`、`who_am_i`（无行动的正常响应）添加 instruction
- HTTP 层错误（400/404/408/413/500）添加 instruction
- 客户端实现、CLI、token 持久化、heartbeat
- 删除 tip 中已有的结构性文字
- 模板格式或状态机 phase 变更
- Git 命令执行

> **提出人: claude**

---

## 2. 干系人与场景

### 干系人画像

| 干系人 | 角色 | 核心诉求 |
|--------|------|---------|
| AI Skill 开发者 | 编写 PairFlow 初始化/工作流 skill 的开发者 | 从 instruction 读取下一步动作，不需要维护正则或字符串匹配逻辑 |
| CLI/客户端开发者 | 构建 PairFlow 命令行工具或 GUI 的开发者 | 需要可靠的机器可读状态来判断当前阶段、是否可 advance、产出路径 |
| AI 参与者（Claude/Codex） | 实际执行工作流的 AI | 通过 tip 获取思考指引（不变）；instruction 对其透明 |
| PairFlow 维护者 | 定制 tip 模板的项目维护者 | 修改模板文案不应破坏客户端行为 |
| 测试作者 | 编写 PairFlow 集成测试的人 | reason_code 是稳定、语言无关的测试断言锚点 |

**为什么干系人只有开发者而没有终端用户？** 因为 PairFlow 是 MCP Server——它的"用户"是 AI 和集成它的客户端程序，不是人类终端用户。人类通过 AI 间接使用 PairFlow。这意味着 instruction 的设计优先级是：正确性 > 可读性 > 人类友好性。

> **提出人: claude**

### 主场景

1. **客户端自动推进**：CLI/skill 读取 `wait_for_turn` 响应 → 检查 `instruction.next_action === "produce_and_submit"` → 从 `instruction.required_output.file_path` 获取产物路径 → 从 `instruction.references` 获取必读文件列表 → 自动打开文件开始工作。不需要解析 tip 中的 "完成后 git commit，调用 submit，file_path = ..." 字符串。

2. **收敛决策 UI**：Supervisor 的 GUI 客户端读取 `instruction.next_action === "decide_convergence"` → 渲染两个按钮："Advance（阶段目标已达成）"和 "Submit（继续产出）" → 按钮标签从 `instruction.decision` 字段生成。不需要解析 tip 判断 Supervisor 是否处于决策状态。

3. **错误恢复**：客户端收到 `instruction.reason_code === "REQUEST_REJECTED"` → 从 `error` 字段获取原因展示给用户 → 自动进入修复模式。不需要同时检查 `ok: false` 和解析 tip 前缀。

4. **超时处理**：客户端收到 `instruction.reason_code === "WAIT_TIMEOUT"` → 自动重新调用 `wait_for_turn`。这是确定的程序化行为，不依赖 tip 内容。

5. **模板热更新**：维护者修改 `templates/tips/requirements/r1.md` 中的文案 → 模板重新加载 → `instruction` 字段值完全不变 → 所有客户端继续正常工作。

> **提出人: claude**

---

## 3. 功能需求

### 功能清单（按优先级排序）

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P0 | `instruction` 字段生成框架 | 统一入口，与 tip 从同一场景选择结果生成。改造 `TipSelection` 为 `GuidanceSelection`，包含模板键 + 模板变量 + instruction 数据 |
| P0 | `next_action` 枚举与路由 | 8 种动作：confirm_task / wait_for_turn / produce_and_submit / decide_convergence / advance / report_user / fix_request / stop |
| P0 | `reason_code` 枚举 | 13 个稳定代码：REGISTERED_NEEDS_CONFIRMATION 到 REQUEST_REJECTED。禁止 OTHER/UNKNOWN 逃生值 |
| P0 | `context` 字段 | workflow_id / phase / sub_phase / round / turn / holds_turn / can_advance。只返回当前状态可确定的字段，不伪造缺失值 |
| P0 | `required_output` 字段 | 仅 produce_and_submit 和 decide_convergence 未收敛分支返回。file_path 从 expectedSubmissionPath/outFile 计算 |
| P0 | `allowed_tools` 字段 | 当前状态下允许调用的 MCP 工具列表。等待时 ["wait_for_turn"]，产出时 ["submit"]，收敛决策时 ["advance", "submit"] |
| P1 | `references` 引用列表 | task / plan / previous_output / previous_review / archive，含 required 标记和 canonical commit hash |
| P1 | `decision` 决策分支 | 仅 decide_convergence 场景。criterion + when_true/when_false |
| P2 | `ok()`/`err()` 覆盖保护 | 确保 data/extra 无法覆盖 instruction，与 ok/error/tip/reminder 保护一致 |

**为什么 allowed_tools 不是完整权限 ACL？** 因为 PairFlow 不是安全边界——它信任本地进程（design.md §12）。allowed_tools 是"当前状态下合理的下一步工具"，用于客户端 UI 展示和输入校验，不是强制访问控制。如果做成完整 ACL 会引入额外的复杂度和测试负担，超出本任务范围。

**为什么 reason_code 禁止 OTHER/UNKNOWN？** 因为 reason_code 的核心价值是"客户端可以无条件信任并据此分支"。如果存在 OTHER/UNKNOWN，客户端就必须处理未知情况，等价于没有协议。每个新场景必须显式新增枚举，迫使维护者在新增状态分支时同步思考客户端行为。

> **提出人: claude**

---

## 4. 非功能约束

### 性能

**判断：instruction 生成对性能的影响可忽略。**

- instruction 数据完全来自内存状态（`PairFlowState`）和既有 path helper（`outFile`、`workflowArchivePath`），不涉及 I/O
- `GuidanceSelection` 替代现有 `TipSelection`，计算量增加为若干布尔字段和字符串赋值，远小于 tip 模板渲染（文件读取 + 正则替换）
- 最大的性能路径 `wait_for_turn`（长轮询，10s 间隔）中，instruction 在 turn-ready 时才生成一次，不影响轮询开销

### 安全

**判断：instruction 不引入新的安全风险。**

- PairFlow 仅绑定 `127.0.0.1`，信任本机进程（design.md §12）
- instruction 不暴露超过现有 tip 的信息——两者从同一状态生成
- `required_output.file_path` 已经通过 tip 的 `[产出]` 段暴露给客户端
- 需要关注的是：instruction 中的 `allowed_tools` 是否会被客户端误解为"完整权限清单"——文档需明确标注这只是"当前 tip 对应的下一步工具集合"

### 兼容性

**判断：增量兼容策略完全可行。**

- instruction 是新增可选字段，旧客户端忽略它，行为不变
- 所有既有响应字段（tip、reminder、phase、turn 等）保持不变
- 现有 40+ 个 tip 模板键和对应的模板文件不受影响
- `renderTip()` 和 `formatTip()` 调用签名不变

**为什么不在本任务中删除 tip 中的结构性文字？** 因为（1）旧客户端仍依赖这些文字；（2）tip 对 AI 参与者仍有指引价值——AI 既看 instruction 执行动作，也看 tip 获取思考策略；（3）分离关注点：本任务建立 instruction 机制，后续可另立兼容迁移任务清理 tip 中的冗余信息。

> **提出人: claude**

---

## 5. 假设与风险

### 假设

| # | 假设 | 风险预估 |
|---|------|---------|
| H1 | `selectTip()` 的每个分支可以唯一映射到一个 `next_action` | 低。当前分支结构清晰：idle → confirm_task/wait_for_turn；持有 turn → produce_and_submit 或 decide_convergence；等待 → wait_for_turn |
| H2 | `outFile()` 返回的路径就是 `required_output.file_path` | 低。task 文档 §5.1 已明确要求"file_path 必须与 Server 当前 expectedSubmissionPath/outFile 计算一致" |
| H3 | 13 个 reason_code 足以覆盖当前所有场景 | 中。当前 `selectTip()` 有 ~40 个模板键，映射到 reason_code 需要仔细审查各种等待/超时/拒绝分支。如果不够，按 task 文档 §6 允许新增具体枚举 |
| H4 | `GuidanceSelection` 改造不破坏现有 `renderTip` 行为 | 低。`renderTip` 只消费 template key 和 variables，新增的 instruction 字段不影响模板渲染 |
| H5 | 客户端会优先使用 instruction 而非 tip | 中。这是行为约定，不是技术约束。需在 task 文档 §10 兼容性部分明确声明预期，但最终由客户端开发者决定 |

### 风险

| # | 风险 | 严重度 | 缓解措施 |
|---|------|--------|---------|
| R1 | tip 与 instruction 不一致——模板变量传递错误导致 tip 说的和 instruction 指示的不同 | 高 | 一致性测试（§11.3）：同一 fixture 下验证 tip 与 instruction 的动作、turn、路径语义一致 |
| R2 | 新增字段被 `ok(data)` 覆盖——当前 `ok()` 用 spread 合并 businessData，未防御 `instruction` 注入 | 高 | `ok()`/`err()` 中显式 delete instruction（类似现有 delete tip/reminder），并从 `GuidanceSelection` 统一生成 |
| R3 | 新增 reason_code 后遗漏某个场景——客户端收到没有 instruction 的 tip 响应 | 中 | 场景矩阵测试（§11.2）逐分支覆盖；lint/契约测试确保"有 tip 必有合法 instruction" |
| R4 | `references` 中的 commit hash 不一致——小写转换在不同路径中遗漏 | 低 | 集中使用统一的 `toLowerCase()` 工具函数；commit_hash 在 state 中存储时已小写 |
| R5 | instruction TypeScript 类型与运行时值不一致——planning 阶段调整命名后类型文件未同步 | 低 | 测试覆盖 + compile check；类型文件和运行时生成使用同一模块导出 |

> **提出人: claude**

---

## 6. 歧义与待澄清

### 疑问

| # | 疑问 | 临时替代方案 |
|---|------|-------------|
| Q1 | `GuidanceSelection` 具体放在哪个文件？task 文档 §9 说"函数名由 planning 决定"。当前 `selectTip()` 在 `tip.ts`，instruction 生成逻辑放在同一个文件还是新建 `instruction.ts`？ | 暂定：新建 `src/instruction.ts`，导出 `buildInstruction(state, identity): PairFlowInstruction`。`tip.ts` 的 `selectTip()` 重命名为 `selectGuidance()`，同时返回模板选择 + instruction 数据。planning 阶段最终决定文件结构 |
| Q2 | `references` 的 `previous_output` vs `previous_review` 如何区分？当前 tip 中"对方的上一轮产出"和"你的上一轮评审"是否应映射为不同 ReferenceKind？ | 暂定：按 task 文档 §5.1 的 ReferenceKind 枚举区分——previous_output 为对方产出，previous_review 为本人此前评审。具体映射在 implementation 阶段细化 |
| Q3 | `report_user` 动作的触发条件？task 文档 §5.2 说"超过掉线/确认阈值，需要用户决定是否继续"。当前 wait_for_turn 中的 roster-warning 和 turn-warning 是否都应映射为 report_user？ | 暂定：warning 场景返回 `next_action: "report_user"` + `reason_code: "PARTICIPANT_CONFIRMATION_STALE"` 或 `"TURN_UNCLAIMED_STALE"`。等待超时返回 `next_action: "wait_for_turn"` + `reason_code: "WAIT_TIMEOUT"` |
| Q4 | `get_state` 是否也要返回 instruction？task 文档 §4.1 说"get_state 中当前带 tip 的所有分支"。当前 `get-state.ts` 中 recovery-pending/roster-pending 场景使用独立模板键返回 tip，这些场景也需要 instruction | 暂定：是。`get_state` 中所有带 tip 的响应都返回 instruction。recovery-pending → `next_action: "wait_for_turn"` + `reason_code: "ROSTER_INCOMPLETE"`（等待恢复确认完成） |
| Q5 | `confirm_task` 的 instruction 是什么？当前 confirm_task 成功后 tip 统一要求"下一步调用 wait_for_turn"。但 confirm_task 本身也可能在 idle 阶段就位后 turn 切给监督者 | 暂定：confirm_task 成功 → `next_action: "wait_for_turn"` + `reason_code` 根据场景区分（WORKFLOW_UNBOUND / ROSTER_INCOMPLETE / TURN_READY）。若已持有 turn，wait_for_turn 会立即返回 produce_and_submit |
| Q6 | `implementation` sub_phase 在 context 中是 `sub_phase` 独立字段还是编码到 phase？task 文档 §5.1 将其作为独立字段 `sub_phase?: "coding" | "review" | null` | 暂定：按 task 文档，context 中保持 phase + sub_phase 独立字段。与现有 state schema 一致 |

### 需要 planning 阶段确认的结构性决策

1. TypeScript 类型文件位置：`src/instruction.ts` vs `src/types/instruction.ts` vs 其他
2. `GuidanceSelection` 的精确形状：是否将 instruction 内嵌到 selection 中，还是 selection 只返回生成 instruction 所需的最小数据
3. `ok()`/`err()` 签名是否需要变更：当前 `ok(data, tip?)` — instruction 是作为第三个参数传入还是从 data 中提取
4. instruction 生成是否需要缓存：同一 state + identity 的 instruction 是确定的，但当前架构无缓存层

> **提出人: claude**

---

## 总结

本任务是 **protocol layer enhancement**，核心变更是将 `TipSelection` 提升为 `GuidanceSelection`，在保留 tip 自然语言通道的同时增加结构化 instruction 通道。风险集中在 tip/instruction 一致性（通过场景矩阵和一致性测试缓解）和 `ok()`/`err()` 覆盖保护（通过显式字段清理缓解）。13 个 reason_code 覆盖当前所有场景，不足时允许新增但禁止逃生值。所有既有字段和模板系统不受影响，实现纯增量。

> **提出人: claude**

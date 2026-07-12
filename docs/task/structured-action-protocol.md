# 结构化行动协议

> 来源：`docs/task/pairflow-collaboration-retrospective.md`
>
> 优先级：P0
>
> 任务类型：development
>
> 设计规格：`docs/design.md`

## 1. 背景

PairFlow 当前通过 `tip` 告诉 AI 下一步做什么。tip 同时混合了三类信息：

1. **执行指令**：调用 `wait_for_turn`、`submit`、`advance` 等；
2. **工作流上下文**：phase、round、turn、是否可 advance、产出路径；
3. **思考指引**：如何分析需求、如何评审代码、如何判断收敛。

Tip 模板化解决了第三类文案的可定制问题，但客户端仍需解析自然语言来提取工具、路径和状态。模板文案一旦被 fork 维护者修改，依赖字符串识别的客户端可能失效；客户端若自行复制状态判断，又会形成第二套状态机。

Claude 与 Codex 在工作流 `20260712104946` 的复盘中一致认为：下一步最有价值的改进是建立“**结构化行动协议 + 可编辑 tip**”双通道。服务端继续作为唯一状态机权威；结构字段告诉客户端“做什么”，tip 继续告诉 AI“如何思考”。

## 2. 目标

为所有当前包含 `tip` 的 MCP 业务响应增加可选的 `instruction` 字段，使客户端无需解析 tip 即可可靠获知：

- 当前应执行的工作流动作；
- 允许调用的 MCP 工具；
- 当前 workflow/phase/round/turn 上下文；
- 是否持有 turn、是否满足 advance 状态门禁；
- 本轮预期产物路径和提交要求；
- 必须阅读和可选参考的文件；
- 当前提示产生的稳定原因代码。

现有 `tip`、`reminder`、`phase`、`turn`、`next_turn`、`new_phase` 等字段全部保留，保证现有客户端兼容。

## 3. 核心原则

1. **服务端唯一权威**：instruction 必须由服务端现有状态和权限判断生成，客户端不得复制状态机。
2. **增量兼容**：本任务只新增字段，不删除或重命名现有字段，不改变现有工具入参。
3. **有行动才返回**：只有当前已经包含 tip 的 MCP 业务响应返回 instruction；`ping`、无行动的正常 `who_am_i` 等响应不返回空 instruction。
4. **结构优先**：动作、路径、turn 和权限以 instruction 为机器可读权威；tip 仍须与之语义一致，但不供客户端解析。
5. **不评价内容**：服务端只表达状态机门禁，不判断需求、计划或代码是否真正收敛；收敛仍由 Supervisor 决定。
6. **不执行外部命令**：instruction 可以声明 commit 要求，但 Server 不执行 Git、测试、构建或文件内容审查。
7. **路径一致**：instruction 中所有路径继续使用 POSIX 正斜杠。

## 4. 范围

### 4.1 必须覆盖

- `register` 成功响应；
- `confirm_task` 成功响应；
- `advance` 成功响应；
- `get_state` 中当前带 tip 的所有分支；
- `wait_for_turn` 的 turn-ready、等待超时、warning、workflow completed 分支；
- `submit` 成功响应；
- `err()` 生成的所有 MCP 业务拒绝响应；
- `buildTip()` 当前覆盖的 idle、requirements、planning、implementation、summary 和等待分支。

### 4.2 不包含

- `ping`、无行动的正常 `who_am_i`；
- HTTP 层 `400/404/408/413/500` 响应；
- 官方 CLI/客户端、token 持久化或 SSE 封装；
- heartbeat、wait 超时协商、客户端阻塞上报；
- Git preflight、PR、rebase、squash；
- 删除 tip 中现有的结构性文字；
- 模板格式、模板键或状态机 phase 变更。

## 5. 响应契约

### 5.1 Instruction 类型

建议新增以下 TypeScript 契约；planning 阶段允许调整类型文件位置和命名，但不得削弱字段语义：

```ts
type InstructionAction =
  | "confirm_task"
  | "wait_for_turn"
  | "produce_and_submit"
  | "decide_convergence"
  | "advance"
  | "report_user"
  | "fix_request"
  | "stop";

type PairFlowTool =
  | "confirm_task"
  | "wait_for_turn"
  | "submit"
  | "advance"
  | "get_state";

type ReferenceKind =
  | "task"
  | "requirements"
  | "plan"
  | "previous_output"
  | "previous_review"
  | "archive";

interface InstructionReference {
  kind: ReferenceKind;
  file_path: string;
  required: boolean;
  commit?: string;
}

interface RequiredOutput {
  file_path: string;
  commit_required: true;
  submit_tool: "submit";
}

interface InstructionContext {
  workflow_id?: string;
  phase?: "idle" | "requirements" | "planning" | "implementation" | "summary";
  sub_phase?: "coding" | "review" | null;
  round?: number;
  turn?: string;
  holds_turn?: boolean;
  can_advance?: boolean;
}

interface PairFlowInstruction {
  next_action: InstructionAction;
  allowed_tools: PairFlowTool[];
  reason_code: InstructionReasonCode;
  context?: InstructionContext;
  required_output?: RequiredOutput;
  references?: InstructionReference[];
  decision?: {
    criterion: "phase_goal_met";
    when_true: "advance";
    when_false: "produce_and_submit";
  };
}
```

### 5.2 字段规则

#### `next_action`

- `confirm_task`：注册后或 token 未绑定 workflow；
- `wait_for_turn`：等待 roster、对方 turn、Supervisor 交回或单次 wait 超时；
- `produce_and_submit`：调用方持有 turn，需要产出文件、commit 并调用 submit；
- `decide_convergence`：Supervisor 持有 turn，当前 phase 双方已提交且状态机允许 advance；
- `advance`：只用于没有内容判断分支的确定性推进场景；
- `report_user`：超过掉线/确认阈值，需要用户决定是否继续；
- `fix_request`：业务请求被拒绝，调用方需依据现有 `error` 修正；
- `stop`：workflow 已结束。

#### `allowed_tools`

只列当前状态下协议允许的直接 MCP 工具：

- 等待时通常为 `["wait_for_turn"]`；
- 产出时为 `["submit"]`；
- 收敛决策时为 `["advance", "submit"]`；
- workflow 结束时为空数组；
- `fix_request` 默认空数组，不推断具体重试工具。

`allowed_tools` 不是完整工具权限 ACL；它只描述当前 tip 对应的下一步工具集合。

#### `required_output`

仅当 `next_action` 为 `produce_and_submit`，或 `decide_convergence` 的未收敛分支需要继续产出时返回。`file_path` 必须与 Server 当前 `expectedSubmissionPath`/`outFile` 计算一致，不得从 tip 反向解析。

#### `references`

引用必须由当前状态和已提交记录生成：

- task/plan 等本轮不可跳过的输入使用 `required: true`；
- previous_output/previous_review 等辅助材料根据当前 tip 的实际要求标注；
- 有对应提交时附带 canonical lowercase commit hash；
- 不存在的引用不返回空占位对象。

#### `context`

只返回当前工具能够可靠确定的字段。未绑定 workflow 时可省略 workflow 字段；不得用 `"unknown"` 或空字符串伪造缺失值。

#### `reason_code`

reason code 必须是稳定、语言无关的枚举，用于客户端分支和测试；不得直接复用 tip 文本。

## 6. Reason Code 最小集合

本任务至少提供：

```ts
type InstructionReasonCode =
  | "REGISTERED_NEEDS_CONFIRMATION"
  | "WORKFLOW_UNBOUND"
  | "ROSTER_INCOMPLETE"
  | "WAITING_FOR_TURN"
  | "TURN_READY"
  | "PHASE_READY_FOR_CONVERGENCE_DECISION"
  | "WAIT_TIMEOUT"
  | "PARTICIPANT_CONFIRMATION_STALE"
  | "TURN_UNCLAIMED_STALE"
  | "SUBMISSION_ACCEPTED"
  | "PHASE_ADVANCED"
  | "WORKFLOW_COMPLETED"
  | "REQUEST_REJECTED";
```

如果一个场景无法由以上枚举准确表达，可新增具体枚举；禁止使用 `OTHER`、`UNKNOWN` 等逃生值。

## 7. Supervisor 收敛决策

Supervisor 可 advance 的场景不是单一确定动作：

- 若确认当前 phase 目标已达成，调用 `advance`；
- 若未收敛，继续产出并 `submit`。

因此该场景必须返回：

```json
{
  "next_action": "decide_convergence",
  "allowed_tools": ["advance", "submit"],
  "context": {
    "holds_turn": true,
    "can_advance": true
  },
  "decision": {
    "criterion": "phase_goal_met",
    "when_true": "advance",
    "when_false": "produce_and_submit"
  },
  "required_output": {
    "file_path": "C:/project/handoff/.../rN_identity.md",
    "commit_required": true,
    "submit_tool": "submit"
  }
}
```

服务端只声明决策与两个合法分支，不自动判断 `phase_goal_met`。

## 8. 示例

### 8.1 Developer 获得 coding turn

```json
{
  "turn": "claude",
  "phase": "implementation",
  "round": 1,
  "ok": true,
  "tip": "[行动] 根据实施计划……",
  "instruction": {
    "next_action": "produce_and_submit",
    "allowed_tools": ["submit"],
    "reason_code": "TURN_READY",
    "context": {
      "workflow_id": "20260712104946",
      "phase": "implementation",
      "sub_phase": "coding",
      "round": 1,
      "turn": "claude",
      "holds_turn": true,
      "can_advance": false
    },
    "required_output": {
      "file_path": "C:/project/handoff/20260712104946/implementation/r1_coding_claude.md",
      "commit_required": true,
      "submit_tool": "submit"
    },
    "references": [
      {
        "kind": "plan",
        "file_path": "C:/project/handoff/20260712104946/planning/r1_reviewer.md",
        "required": true
      }
    ]
  }
}
```

### 8.2 等待对方 turn

```json
{
  "instruction": {
    "next_action": "wait_for_turn",
    "allowed_tools": ["wait_for_turn"],
    "reason_code": "WAITING_FOR_TURN",
    "context": {
      "workflow_id": "20260712104946",
      "phase": "requirements",
      "round": 2,
      "turn": "codex",
      "holds_turn": false,
      "can_advance": false
    }
  }
}
```

### 8.3 业务拒绝

```json
{
  "ok": false,
  "error": "not your turn — current turn: claude",
  "tip": "[行动] 请求被拒绝：not your turn — current turn: claude",
  "instruction": {
    "next_action": "fix_request",
    "allowed_tools": [],
    "reason_code": "REQUEST_REJECTED"
  }
}
```

## 9. 生成与一致性要求

1. instruction 与 tip 必须由同一场景选择结果生成，不能在 handler 中维护两套独立分支。
2. 建议把当前 `TipSelection` 提升为统一 guidance selection，包含模板键、模板变量和 instruction；具体函数名由 planning 决定。
3. `ok()`/`err()` 不得允许业务 data/extra 覆盖 `instruction`，与现有 `ok/error/tip/reminder` 固定字段保护一致。
4. required_output 和 references 的路径必须直接来自状态/path helper，不得使用正则或字符串解析 tip。
5. 模板自定义不得改变 instruction；修改模板后结构化字段保持一致。
6. 同一状态通过 `get_state` 与 `wait_for_turn` 返回的 instruction 必须一致，除 wait 专有 timeout/warning 场景外。

## 10. 兼容性

- 所有既有响应字段和 tip 默认内容保持不变；
- instruction 是新增的可选对象；
- 不支持 instruction 的旧客户端可以忽略该字段；
- 新客户端必须优先读取 instruction，并把 tip 作为自然语言思考指引展示给 AI；
- MCP 协议错误和 HTTP 层错误不强制套用 instruction；
- 本任务不要求立刻删除 tip 中重复的结构信息，后续可在客户端普及后另立兼容迁移任务。

## 11. 测试要求

### 11.1 契约测试

- instruction 不可被 `ok(data)` 或 `err(extra)` 覆盖；
- 没有 tip 的响应不包含 instruction；
- 带 tip 的业务响应必须包含合法 instruction；
- next_action、allowed_tools、reason_code 必须来自封闭枚举；
- `produce_and_submit` 必须有 required_output；
- `stop` 的 allowed_tools 必须为空；
- 所有 instruction 路径为 POSIX 格式。

### 11.2 场景矩阵

至少覆盖：

- register → confirm_task；
- confirm_task → wait_for_turn；
- roster incomplete / recovery incomplete；
- 非本人 turn；
- requirements、planning、coding、review、summary 的本人 turn；
- Supervisor 可 advance 的收敛决策；
- submit 后等待下一 turn；
- wait 600 秒超时；
- participant confirmation stale / turn unclaimed stale；
- workflow completed；
- 业务拒绝。

### 11.3 一致性测试

- 同一 fixture 下 tip 与 instruction 的动作、turn、路径语义一致；
- 修改默认模板文案不改变 instruction；
- `get_state` 与 turn-ready `wait_for_turn` 对同一 state 生成相同 instruction；
- requirements/development 两种任务类型的 phase 推进 instruction 正确。

## 12. 验收标准

1. 所有当前带 tip 的 MCP 业务响应都返回 instruction；
2. `ping`、正常无行动的 `who_am_i` 和 HTTP 层响应保持现状；
3. 新客户端只读取 instruction 即可确定下一动作、允许工具、必要输入和产物路径，不需解析 tip；
4. Supervisor 收敛决策完整表达两个合法分支，服务端不替代内容判断；
5. tip 模板任意合法改写后，instruction 结构和值不受影响；
6. 现有测试全部通过，新增场景/契约/一致性测试通过；
7. `npx tsc --noEmit` 与 `npx vitest run` 通过；
8. `docs/design.md` 的工具出参、响应契约和 tip/instruction 权威边界同步更新；
9. 不引入客户端、heartbeat、wait 参数、Git 命令执行或新的模板语法。

## 13. 后续依赖关系

完成本任务后，以下需求可以建立在 instruction 上，而无需解析 tip：

1. 官方 PairFlow 客户端 / CLI；
2. 初始化 skill 参数回显与自动行动；
3. 可协商 wait 时长与安全重试；
4. Git preflight；
5. heartbeat 和阻塞原因上报。

这些均不属于本任务实现范围。

## 14. 需求分析共识与补充

以下结论由 `claude` 第 1 轮分析与 `codex` 第 2 轮独立分析对照形成；未改变前述范围，只消除实施前的歧义。

### 14.1 已确认共识

1. `claude`、`codex` 一致确认：核心问题是机器动作缺少稳定协议，而不是 tip 文案写得不够结构化；不得让客户端解析模板文案或复制服务端状态机。
2. `claude`、`codex` 一致确认：instruction 是增量、可选的响应字段，现有 tip、reminder、工具入参和 HTTP/MCP 封装保持兼容。
3. `claude`、`codex` 一致确认：instruction 必须由现有状态、提交记录和路径 helper 生成；禁止从渲染后的 tip 反向提取动作、路径或权限。
4. `claude`、`codex` 一致确认：主要风险是 tip/instruction 语义漂移、场景遗漏和保留字段被业务 data 覆盖，必须用契约、矩阵和一致性测试共同约束。

### 14.2 Codex 补充与优先级修正

1. `codex` 补充直接干系人“工作流操作者/任务发起人”：stale warning 的 `report_user` 会直接要求其决定是否继续等待，因此不能把人类仅视为完全间接、对 instruction 透明的角色。
2. `codex` 将 `ok()`/`err()` 的 instruction 覆盖保护定为 P0，而非 `claude` 初稿中的 P2。原因是这属于响应契约完整性和安全边界，也是验收标准的前置条件，不是可延后优化。
3. `codex` 明确 forward compatibility：reason code 禁止 `OTHER`/`UNKNOWN` 不代表客户端可以省略未知枚举兜底；客户端仍应对未来新增具体枚举采取安全失败或升级提示，但不得回退到解析 tip。
4. `codex` 补充信息暴露约束：instruction 不应新增 token、PID、内部绝对路径或其他当前业务 tip 未授权公开的信息；references 和 required_output 仅包含执行本回合所必需的工作流路径。

### 14.3 歧义决议

1. `claude` 提出 instruction 可由独立 `buildInstruction(state, identity)` 生成；`codex` 认为若该函数自行重走状态分支，会违反“同一场景选择结果”原则。planning 可拆文件，但必须先得到唯一 guidance 场景，再由该场景同时渲染 tip 和构造 instruction。
2. `claude` 对 confirm_task 成功且 roster 完整的临时方案使用 `TURN_READY`；`codex` 指出 confirm_task 的协议动作始终是先调用 `wait_for_turn`。最终要求：该响应的 `next_action` 固定为 `wait_for_turn`；reason code 必须描述 confirm 后的真实等待/领取状态，不得用 `TURN_READY` 暗示客户端可以绕过首次 wait 直接产出。若最小枚举无法准确表达，应新增具体 reason code。
3. `claude`、`codex` 确认：roster/turn stale warning 使用 `report_user`；普通 600 秒请求上限使用 `wait_for_turn` + `WAIT_TIMEOUT`，不得升级为人工决策。
4. `claude`、`codex` 确认：`sub_phase` 只在 implementation 有可靠值时返回；其他 phase 可省略或按契约返回 null，但全项目必须选择一种稳定表现并通过测试固定，不能随 handler 漂移。
5. `codex` 指出 idle 阶段必须按身份区分：roster 完整且 Supervisor 持有 turn 时，tip 明确要求调用 `advance` 启动工作流，因此 instruction 为 `next_action: "advance"`，并允许 `advance`；其他参与者等待 Supervisor 时才使用 `wait_for_turn`。`claude` 第 3 轮将两者合并为等待属于映射错误，以本条为准。
6. `claude` 第 3 轮建议客户端遇到未来未知 reason code 时回退解析 tip；`codex` 指出这会重新引入本任务要消除的字符串协议。最终要求是安全失败、请求升级或把原始 tip 仅展示给 AI/用户，不得通过解析 tip 自动决定工具、路径或状态。

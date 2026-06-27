# 优化 tip 描述 — 需求分析

> 分析人: deepseek
> 轮次: r1
> 阶段: requirements

---

## 1. 任务理解

当前 PairFlow 的 `tip` 字段是服务端返回给 AI 的自然语言指令，AI 收到后按 tip 指引决定下一步操作。但现有 tip 存在两个问题导致 AI 行为不可靠：

1. **confirm_dir** 未区分「有未完成工作流」与「无未完成工作流」的场景，AI 收到相同的 tip 模板后只能猜测应该恢复还是新建
2. **confirm_task** 成功后 tip 直接让 AI 进入下一操作（advance 或 wait_for_turn），跳过了与用户确认的步骤

核心目标是让 tip 在不同场景下给出差异化、可执行的指引，降低 AI 猜测空间。

---

## 2. 现状分析

### 2.1 confirm_dir 现状

**代码位置**: `src/tools/confirm-dir.ts:25-27`

```typescript
const tip = incomplete.length > 0
  ? `下一步调用 confirm_task 确认任务文档。未完成的工作流: ${incomplete.join(", ")}`
  : "下一步调用 confirm_task 确认任务文档";
```

**问题**：

- 有未完成工作流时，tip 只列出了 workflow_id 列表，没有告诉 AI 应该如何选择：是恢复旧工作流，还是新建工作流
- 两种选择对应的 `confirm_task` 参数不同（旧任务文档路径 vs 新任务文档路径），但 tip 没有说明
- AI 看到此 tip 后只能猜测用户意图，可能错误地选了任务文档路径
- `incomplete_workflows` 返回值已包含列表，但 tip 没有利用这个信息给出分支指引

**设计规格对照**（`confirm_dir` @ §9 MCP 工具清单）：

> 确认工作目录，返回未完成的工作流列表

规格没有强制 tip 格式，但 `register` 工具的设计（tip 明确告知下一步操作）为交互指引类 tip 提供了先例。

### 2.2 confirm_task 现状

**代码位置**: `src/tools/confirm-task.ts:79-81`

```typescript
const tip = recovered
  ? `任务已恢复，当前阶段: ${state.phase}。下一步调用 wait_for_turn 接口`
  : "下一步调用 advance 接口进入需求阶段";
```

**问题**：

- **新建任务**：tip 直接说"调用 advance 接口进入需求阶段"，AI 大概率直接调用 advance，用户对「任务文档是什么、工作流 ID 是什么、即将进入什么阶段」一无所知
- **恢复任务**：tip 直接说"调用 wait_for_turn 接口"，AI 不会先向用户复述恢复状态（恢复了什么工作流、当前什么阶段、第几轮），用户不知道发生了什么
- 两种场景都缺少"先与用户确认再继续"的指引，用户被架空

**设计规格对照**（`confirm_task` @ §9）：

> 确认任务文档路径。若 `.pid` 已存在 → 从 handoff 恢复流程状态，返回 `recovered:true`；否则全新开始。

规格只定义了返回值结构，未强制 tip 内容。但根据 §4 数据流图中 `confirm_task` 的交互序列，在 advance 或 wait_for_turn 之前，AI 应向用户展示确认信息。

---

## 3. 根因分析

两个问题的根因相同：**tip 是「单步指令」而非「场景化指引」**。

| 维度 | 当前设计 | 应然设计 |
|------|---------|---------|
| 场景覆盖 | 一个 tip 模板覆盖所有场景 | 按场景分支给出不同 tip |
| 用户交互 | AI 直接操作，用户不知情 | AI 先向用户报告状态，等确认后再操作 |
| 决策支持 | 只告知"做什么"，不告知"如何选择" | 列出选项、参数差异，引导 AI 向用户提问 |

具体来说：
- `confirm_dir` 的 tip 不需要知道用户想恢复还是新建（这只有用户能决定），但它需要告诉 AI「你面前有两个选项，你需要问用户选择哪一个，两个选项的参数分别是 X 和 Y」
- `confirm_task` 的 tip 需要告诉 AI「你已经完成了 confirm_task，但在继续之前，先向用户报告关键信息（task_path, workflow_id, phase, round 等），等用户确认后再操作」

---

## 4. 方案建议

### 4.1 confirm_dir tip 优化

**场景 A：有未完成工作流（`incomplete_workflows.length > 0`）**

tip 应包含：
1. 明确列出每个未完成工作流 ID
2. 指引 AI 向用户提问"恢复还是新建？"
3. 说明两种选择的 confirm_task 参数差异：
   - 恢复：`task_path` 为原任务文档路径（与旧 workflow 相同）
   - 新建：`task_path` 为新任务文档路径

建议 tip 模板：
```
发现 N 个未完成工作流: {ids}。
请询问用户选择:
  A) 恢复某个未完成工作流 → 以原任务文档路径调用 confirm_task
  B) 新建工作流 → 以新任务文档路径调用 confirm_task
```

**场景 B：无未完成工作流（`incomplete_workflows.length === 0`）**

保持现有 tip，无需修改：
```
下一步调用 confirm_task 确认任务文档
```

### 4.2 confirm_task tip 优化

**场景 A：新建任务（`recovered === false`）**

tip 应指引 AI 先向用户报告关键信息，等确认后再 advance：
```
已确认任务文档: {task_path}，工作流 ID: {workflow_id}。
请向用户复述以上信息并说明即将进入需求阶段，待用户确认后调用 advance 接口。
```

**场景 B：恢复任务（`recovered === true`）**

tip 应指引 AI 先向用户报告恢复状态，等确认后再 wait_for_turn：
```
已恢复工作流 {workflow_id}，当前阶段: {phase}，轮次: {round}。
请向用户复述以上恢复状态，待用户确认后调用 wait_for_turn 接口。
```

---

## 5. 影响分析

### 5.1 改动范围

| 文件 | 改动内容 |
|------|---------|
| `src/tools/confirm-dir.ts` | 修改 tip 生成逻辑，为有未完成工作流场景提供分支指引 |
| `src/tools/confirm-task.ts` | 修改 tip 生成逻辑，为新建/恢复场景分别加入「先与用户确认」指引 |
| `src/__tests__/tools.test.ts` | 更新 confirm_dir 和 confirm_task 相关测试断言 |

### 5.2 兼容性

- 不影响 `state.json` schema
- 不影响 MCP tool 入参/出参结构
- 不影响 phase 转换和 turn 切换逻辑
- tip 是纯提示文本，改动仅影响 AI 行为指引，不涉及数据结构变更
- 向下兼容：旧客户端收到新 tip 后行为更明确，不会中断

### 5.3 风险

- **低风险**：tip 是 advisory 性质，不涉及状态变更
- tip 文本过长可能超出 AI 上下文窗口的一部分——但当前 tip 远未达到这个量级
- 需要确认 MCP SDK 对 `content[0].text` 的文本长度无硬限制（通常没有）

---

## 6. 待确认事项

1. **tip 语言**：当前 tip 是中英混合（如 "Set X-AI-Identity: xxx header..."），新 tip 是否保持混合风格还是统一改为中文？——建议保持现有混合风格一致
2. **confirm_task 恢复场景**：恢复时 `state.round` 可能 >1，此时 AI 收到 wait_for_turn 后调用 claim_turn，claim_turn 的 tip 会动态生成执行指引——确认此链路中 claim_turn 的 tip 是否也需要类似的「先与用户确认」指引？
3. **confirm_dir 有多个未完成工作流时**：是否需要限制最多列出 N 个（避免 tip 过长）？——建议限制 5 个，超出时加"等"提示

---

## 7. 非功能考量

- **可测试性**：tip 是纯文本输出，单元测试覆盖各场景分支即可
- **可维护性**：tip 模板集中在工具函数内，无跨文件依赖
- **性能**：字符串拼接，无性能影响

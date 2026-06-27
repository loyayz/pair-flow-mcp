# 优化 tip 描述 — 审阅意见

> 审阅人: claude (supervisor)
> 轮次: r2，审阅 r1_deepseek
> 阶段: requirements

---

## 1. 总体评价

r1 的分析框架完整，根因定位准确（tip 是「单步指令」而非「场景化指引」），方案建议具体可执行。以下逐项确认/补充/修正。

---

## 2. 逐项审阅

### 2.1 confirm_dir — 有未完成工作流场景 ✅ 同意

**提出人: deepseek（同意: claude）**

r1 指出当前 tip 只列出 ID 但不告诉 AI 如何选择，方案建议为「列出选项 + 说明参数差异」。同意此分析与方案。

**补充（claude）**：tip 应进一步明确——「恢复」意味着 AI 需要向用户问出原来的任务文档路径；「新建」意味着 AI 需要向用户问出新的任务文档路径。若用户选恢复但不记得原路径，AI 可建议用户检查 `docs/task/` 目录下的 `.md` 文件及对应的 `.pid` 文件。

### 2.2 confirm_task — 新建任务场景 ✅ 同意

**提出人: deepseek（同意: claude）**

tip 应指引 AI 先向用户报告 task_path + workflow_id，确认后再 advance。

**补充（claude）**：tip 应额外提醒 AI 告知用户「接下来的流程」——即需求阶段由对方先产出，自己（若为监督者）将进入审阅角色。

### 2.3 confirm_task — 恢复任务场景 ✅ 同意

**提出人: deepseek（同意: claude）**

tip 应指引 AI 先向用户报告恢复状态（workflow_id, phase, round），确认后再继续。

**补充（claude）**：恢复场景中，若 `phase !== "idle"` 且 `turn` 指向当前 AI，tip 应区分：
- 若 `turn === 当前身份` → 指引调用 `claim_turn` 而非 `wait_for_turn`
- 若 `turn !== 当前身份` → 保持 `wait_for_turn` 指引

当前 tip 统一指向 `wait_for_turn`，在恢复后 turn 恰好属于监督者时会产生误导。

### 2.4 待确认事项回复

**tip 语言风格（deepseek 提出）**：同意保持现有中英混合风格。

**claim_turn tip 联动（deepseek 提出）**：确认无需联动修改。`get-state.ts` 已在各阶段各轮次给出明确指引。

**未完成工作流数量限制（deepseek 提出）**：同意限制 5 个。`scanIncompleteWorkflows` 可加 `.slice(0, 5)`，超出时加 `...等 N 个`。

---

## 3. 补充发现

### 3.1 register tip 也可微调

**提出人: claude**

`register.ts:62-64` 监督者注册成功后 tip 说「下一步调用 confirm_dir」，但未显式说明 `confirm_dir` 的 `work_dir` 参数。建议补充参数提示：

```
下一步调用 confirm_dir 接口，参数 work_dir="{workDir}"
```

非核心改动，可作为锦上添花。

### 3.2 get_state 收敛指引（超出范围）

**提出人: claude**

`get_state` 对 `round >= 2` 给出审阅指引，但未说明监督者何时应 advance。建议后续优化。

---

## 4. 双方一致结论

| 议题 | 结论 |
|------|------|
| confirm_dir 分支 tip | 通过，补充「恢复/新建」选项说明 + 参数差异 |
| confirm_task 新建 tip | 通过，补充「先向用户报告再 advance」指引 |
| confirm_task 恢复 tip | 通过，补充 turn 判断（claim_turn vs wait_for_turn） |
| 未完成工作流数量 | 限制 5 个 |
| tip 语言风格 | 保持中英混合 |
| register tip 微调 | 可选，建议一起做 |

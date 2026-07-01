# 需求分析：新增任务类型

> 提出人：deepseek（developer）| 第 1 轮需求分析

---

## 1. 需求概述

当前 PairFlow 工作流对所有任务一视同仁，执行完整的四阶段流程（requirements → planning → implementation → summary）。但实际使用中存在两种本质不同的任务场景：

| 类型 | 场景 | 所需阶段 |
|------|------|----------|
| **需求** | 用户只想做需求分析、方案讨论、输出汇总结论，不涉及代码实现 | requirements → summary |
| **开发** | 完整的结对编程流程，从需求到代码交付 | requirements → planning → implementation → summary |

> **观点（deepseek）**：当前只支持"开发"模式，缺少"需求"模式的快捷路径。用户如果只想做需求讨论，被迫走完 planning 和 implementation 阶段，体验割裂。

---

## 2. 现状分析

### 2.1 当前状态机

```
IDLE → REQUIREMENTS → PLANNING → IMPLEMENTATION → SUMMARY → IDLE
```

所有任务走相同路径，advance 操作线性推进，无分支逻辑。

### 2.2 受影响组件（deepseek 分析）

| 组件 | 文件 | 影响范围 |
|------|------|----------|
| 状态定义 | `src/state.ts` | `state.json` 的 phase 字段，需新增 `task_type` 字段 |
| confirm_task | `src/tools/confirm-task.ts` | 需新增 `task_type` 参数（`"requirements"` \| `"development"`，默认 `"development"`） |
| advance | `src/tools/advance.ts` | 核心变更——需求模式下 REQUIREMENTS → SUMMARY 跳过 PLANNING 和 IMPLEMENTATION |
| tip 生成 | `src/tip.ts` | `getAction()` / `outFile()` 需感知任务类型，需求模式下不产生 planning/implementation 阶段的指引 |
| get_state | `src/tools/get-state.ts` | 复用 `buildTip()`，跟随 tip.ts 变更 |
| submit | `src/tools/submit.ts` | 需求模式下只接受 requirements 和 summary 阶段的提交 |
| 设计规格 | `docs/superpowers/specs/2026-06-21-pair-flow-design.md` | 需同步更新状态机图、工具表 |

### 2.3 不变的部分（deepseek 分析）

- 注册（register）、身份（who_am_i）、执行权（claim_turn/wait_for_turn）逻辑不受影响
- 崩溃恢复（crash-recovery）逻辑不受影响，task_type 作为 state 字段随 state.json 持久化即可
- 归档目录结构不变——需求模式下 planning/ 和 implementation/ 目录自然为空
- 收敛判定（监督者手动 advance）逻辑不变

---

## 3. 功能需求

### FR1：任务类型定义

`confirm_task` 新增 `task_type` 参数，可选值：

- `"development"`（默认）— 执行完整四阶段流程
- `"requirements"` — 只执行 requirements + summary

任务类型在 confirm_task 时确定，不可中途变更。

> **观点（deepseek）**：不可中途变更确保工作流完整性——从"开发"切到"需求"意味着跳过已有阶段产出，语义不一致。

### FR2：Phase 跳转逻辑

需求模式下 `advance` 的跳转规则：

```
IDLE → REQUIREMENTS → SUMMARY → IDLE
```

- REQUIREMENTS 阶段 advance 时，检查 `task_type === "requirements"` → 直接跳到 SUMMARY
- 开发模式下行为不变

### FR3：Turn 分配

需求模式下的 turn 分配：

| Phase | Turn |
|-------|------|
| REQUIREMENTS | 非监督者（与开发模式一致） |
| SUMMARY | 监督者（与开发模式一致） |

### FR4：产出指引

需求模式下 tip 不生成 planning/implementation 阶段的行动指令和产出路径。SUMMARY 阶段的 submit 路径仍然正常生成。

### FR5：向后兼容

- `task_type` 默认值为 `"development"`，不传时行为与当前完全一致
- 现有 state.json 中无 `task_type` 字段的旧数据，advance 时按 development 处理

---

## 4. 非功能需求

### NFR1：类型安全

`task_type` 使用 Zod schema 约束，仅接受 `"requirements"` | `"development"`，拒绝非法值。

### NFR2：测试覆盖

新增测试覆盖：
- 需求模式下 REQUIREMENTS → SUMMARY 跳转
- 需求模式下 advance 拒绝进入 PLANNING / IMPLEMENTATION
- 开发模式下行为不变（回归）
- confirm_task 的 task_type 参数校验

### NFR3：文档同步

设计规格文档 §5（状态机）、§9（工具清单）需同步更新。

---

## 5. 边界情况

| 场景 | 处理 |
|------|------|
| confirm_task 不传 task_type | 默认 `"development"`，向后兼容 |
| confirm_task 传非法 task_type | 拒绝，返回错误提示 |
| 需求模式下监督者误调 advance 想跳到 planning | advance 内置跳转规则自动跳到 SUMMARY，不需要监督者感知差异 |
| 需求模式恢复（confirm_task 发现 .pid） | 从 handoff 恢复的 state 应包含 task_type，恢复后行为一致 |
| 需求模式 SUMMARY 完成后 | 行为与开发模式一致：删除 .pid，清空 peers，回到 IDLE |

---

## 6. 开放问题

1. **Q（deepseek）**：需求模式下是否需要在 confirm_task 时提示用户选择类型，还是由用户自行决定？当前设计是 `confirm_task` 接受可选参数，默认 development。建议由监督者 AI 在 `confirm_dir` → `confirm_task` 流程中向用户询问任务类型。
2. **Q（deepseek）**：未来是否会有更多任务类型（如"仅代码评审"）？当前设计使用字符串枚举而非布尔标记，为扩展预留空间。
3. **Q（deepseek）**：需求模式下 summary 的产出内容是否与开发模式不同？从 PairFlow 引擎角度，两者相同（都是监督者草稿 + 对方审阅的交替流程），差异由 AI 根据上下文自行决定。

---

## 7. 总结

核心改动范围小、边界清晰：在 `confirm_task` 加一个 `task_type` 参数，在 `advance` 中加一条跳转规则，tip 生成跟随 phase 自动适配。不改状态机结构，不改注册/身份/执行权逻辑，向后兼容。

# 需求分析：优化 tip 描述

> 提出人: codex

## 1. 需求理解

当前 PairFlow 的 tip 描述分散在 6 个工具文件和 1 个 `tip.ts` 文件中。tip 的目标是让 AI 在每一步明确知道：**我是谁、现在什么状态、下一步做什么、怎么做**。

核心问题：部分 tip 信息密度不足或结构混乱，AI 从中提取行动指令的成本偏高。

## 2. 当前 tip 全景扫描

### 2.1 tip 产出点分布

| 文件 | tip 数量 | 形式 |
|------|---------|------|
| `tip.ts` (`buildTip`) | 10 条 | 集中，按 phase/round 分支 |
| `advance.ts` | 5 条 | 内联字符串 |
| `submit.ts` | 4 条 | 内联，条件判断 |
| `wait-for-turn.ts` | 3 条 | 内联 |
| `register.ts` | 2 条 | 内联 |
| `confirm-dir.ts` | 2 条 | 内联 |
| `confirm-task.ts` | 2 条 | 内联 |

### 2.2 已做得好的部分

- **身份标签** (`identityLabel`)：每句 tip 都带 `当前身份: xxx(role)`，AI 不会搞混自己是谁
- **turn 归属**：`turn: xxx(你/对方)` 清晰表达谁该行动
- **文件路径明确**：`buildTip` 给出了精确的产出文件路径
- **confirm_dir/confirm_task**：A/B 选项式引导，决策路径清晰

### 2.3 发现的问题

#### P1: `buildTip` 中 prefix 信息过载

```
当前身份: codex(developer)。turn: codex(你)，阶段: requirements，轮次: 1。请先读取任务文档...
```

身份+turn+阶段+轮次 四条信息挤在一句话里，AI 需要解析才能定位到"下一步做什么"。建议结构化分层。

#### P2: advance 后 tip 不包含产出指引

advance 到 requirements 后 tip 只说"请等待对方产出需求分析。调用 wait_for_turn 接口"，但没有告诉对方（拿到 turn 的人）具体该做什么——对方需要再调 `claim_turn` / `get_state` 才能获取产出指引。这不是 bug（turn 切换后对方调 `claim_turn` 会拿到完整指引），但 advance 的 tip 可以附带一句简短提醒让对方知道。

#### P3: submit 的 tip 中 role 推断逻辑与 tip.ts 重复

`submit.ts:88-91` 手动计算 `roleLabel` 和 `nextRoleLabel`，与 `tip.ts:11-16` 的 `identityLabel` 逻辑重复。且 submit 的 tip 只给了 turn 切换信息，没有像 `buildTip` 那样给出下一轮的产出文件路径。

#### P4: wait_for_turn 超时 tip 缺乏可操作建议

超时时 tip 说"调用 wait_for_turn 继续等待"，但 600s 已过，继续等待可能无限循环。应建议 AI 向用户报告或检查对方状态。

#### P5: advance 到 summary 时 tip 缺少产出文件路径

```
阶段已推进到 summary，turn 归属: claude(你)。当前身份: claude(supervisor)。请产出汇总草稿。调用 claim_turn 获取执行权。
```

没有给出具体产出文件路径，AI 需要再调 `get_state` 才知道写哪里。

#### P6: IDLE 结束 tip 太简略

```
工作流已结束，阶段: idle。当前身份: claude(supervisor)。
```

没有告知工作流产出在 `handoff/{id}/` 下，没有收尾指引。

## 3. 优化原则

1. **行动优先**：每条 tip 的第一句或独立段落应该是"你现在该做什么"
2. **信息分层**：上下文信息（身份、阶段）与行动指令分离，用换行或分段区分
3. **消除重复**：submit 复用 `buildTip` 的身份/角色推断
4. **路径必达**：凡涉及产出，tip 必须包含精确文件路径
5. **可退出**：循环/等待类 tip 必须包含退出条件或升级建议

## 4. 具体建议

### 4.1 `tip.ts` buildTip 重构

将 prefix 改为分层格式：
```
📌 下一步: <一句话行动描述>
📂 产出文件: <绝对路径>
👤 当前身份: xxx(role) | turn: xxx(你/对方) | 阶段: xxx | 轮次: n
```

好处：AI 第一眼看到行动指令和文件路径，不需要解析长句。

### 4.2 advance tip 补充产出路径

每个 advance tip 附带当前 phase 的产出文件路径模板（基于 `buildTip` 同样的命名规则），让拿到 turn 的 AI 提前知道要写什么文件。

### 4.3 submit tip 复用 buildTip

submit 后 turn 切换，应该在 tip 中附带下一轮的产出文件路径（通过 `buildTip` 计算），而不是仅说"请等待对方操作"。

### 4.4 wait_for_turn 超时升级

超时时 tip 建议：停止轮询，向用户报告当前状态，由用户决定是否继续。

### 4.5 IDLE 结束收尾

补充工作流归档位置和下一步建议（重新 register 开始新任务）。

## 5. 范围边界

- ✅ 在范围内：tip 文本内容优化、结构分层
- ❌ 不在范围内：tip 触发逻辑变更、状态机行为变更、新增 MCP 工具
- ❌ 不在范围内：国际化 (i18n)、多语言支持

## 6. 待确认项

- tip 中是否应该使用 emoji（如 📌 📂 👤）作为视觉分隔符？emoji 在所有 AI 终端中渲染一致吗？
- `buildTip` 的分层格式是否用 `\n\n` 双换行分隔，还是用 `\n` 单换行？

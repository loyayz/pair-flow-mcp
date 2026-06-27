# PairFlow 设计不合理功能分析 — r2 审阅

> 审阅人：claude
> 日期：2026-06-27
> 审阅对象：deepseek r1 产出（commit: c829475dfad5f54acabfd7307e65f2b83096db74）
> 设计规格：`docs/superpowers/specs/2026-06-21-pair-flow-design.md`

---

## 一、审阅结论总览

deepseek 的分析共提出 16 个问题点，覆盖设计内部矛盾（4 项）、设计-实现不一致（4 项）、设计缺失（5 项）、设计不合理（3 项，原文 4 项中 1 项被移除）。经逐条核实设计文档与源码：

- **14 项完全同意**：已写入任务文档 `docs/task/design-flaws.md`
- **2 项不同意**：原 4.2（wait_for_turn 轮询）和 4.4（硬编码中文），详见下文

---

## 二、不同意项及理由

### 2.1 ~~4.2 wait_for_turn 轮询模式低效~~ → 不同意归类为"设计不合理"

**deepseek 观点**：wait_for_turn 采用 10s 间隔轮询 state.json，两个 AI 可能同时轮询，产生大量无效磁盘读取。设计未考虑 SSE / 长轮询回调等事件通知机制。

**claude 审阅意见**：**不同意将此归为"设计不合理"**。理由：

1. **v1 的合理工程取舍**：轮询是最简单的同步机制，无额外连接状态管理。MCP Streamable HTTP 是 stateless 的（`sessionIdGenerator: undefined`），引入 SSE 需要维护长连接和会话状态，与当前架构的简单性目标冲突。

2. **实际负载可忽略**：10s 间隔 × 2 AI = 每 10s 两次 `readFile` 调用。state.json 是 KB 级小文件，对本地文件系统而言开销极低。这不是"大量无效磁盘读取"，而是完全可以接受的轮询负载。

3. **轮询在 wait_for_turn 场景下是合理的**：AI 在等待对方完成工作时本来就是阻塞状态，轮询是天然匹配的行为模式。

4. **设计-实现一致**：设计 §8 和 §9 明确规定了 10s 间隔、600s 超时，实现完全对齐。这不是设计缺陷，而是有意识的 v1 设计选择。

**建议**：
- 不将其列为设计缺陷
- 若未来需要优化（如 v2 引入事件通知），可作为性能改进 backlog 项
- 当前轮询方案在功能上完全正确，在性能上完全可接受

---

### 2.2 ~~4.4 硬编码中文提示词~~ → 不同意归类为"设计不合理"

**deepseek 观点**：所有 tip、reminder、error message 均硬编码为中文，无 i18n 支持。对于非中文 AI 对，提示词的可理解性受限，限制了项目的国际化采用。

**claude 审阅意见**：**不同意将此归为"设计不合理"**。理由：

1. **v1 范围明确**：设计 §11 假设表已声明接入前提为"客户端支持自定义 HTTP header"和"两个 AI 均支持 MCP client 模式"，这些假设本身就限定了用户群体。v1 阶段中文硬编码是合理的简化——先跑通核心流程，再考虑国际化。

2. **这不是设计缺陷，是 scope 限制**：设计文档没有声称支持多语言。没有 i18n 不是"设计不合理"，而是"v1 没有做这个功能"。类似于——不能说一个 MVP 因为不支持企业 SSO 就是设计不合理。

3. **实际受众匹配**：当前项目上下文（中文设计文档、中文任务文档、中文 CLAUDE.md）表明目标用户是中文 AI 对。中文提示词对目标用户是正收益，不是缺陷。

**建议**：
- 不将其列为设计缺陷
- 若未来需要国际化，可在 v2 规划中纳入，届时再设计 i18n 方案（如根据 AI 自报的 Accept-Language header 选择语言）

---

## 三、补充观察

除 deepseek 已发现的 14 个有效问题外，审阅过程中注意到：

### 3.1 （补充）crash-recovery.ts `findFiles` 使用 `recursive: true` 可能不可靠

`crash-recovery.ts:342`：`const entries = await readdir(absDir, { withFileTypes: true, recursive: true });`

`recursive: true` 是 Node.js 20+ 特性，而 `parentPath` 属性（同文件 line 345-346 使用）是 Node.js 22+ 特性。若部署环境 Node 版本低于 22，`parentPath` 为 `undefined`，`findFiles` 将返回空结果，导致崩溃恢复静默失败。

**建议**：在 `package.json` 中声明 `engines.node >= 22` 或使用递归 walk 的兼容实现。

### 3.2 （补充）`advance` 中 SUMMARY→IDLE 不检查任何收敛条件

`advance.ts:69-73`：SUMMARY→IDLE 的 advance 仅做 `initIdleState`，不做任何前置检查（如 work_dir 是否有效、是否有未提交的产出）。这意味着一旦进入 SUMMARY 阶段，监督者可以立即 advance 到 IDLE 而不给另一 AI 任何产出机会。

**建议**：SUMMARY→IDLE 前至少检查 SUMMARY 阶段是否有过提交记录。

---

## 四、优先级修订建议

综合审阅结果，建议微调优先级：

| 调整 | 说明 |
|------|------|
| ~~移除 P3 4.2（轮询）~~ | 不是设计缺陷，是合理的 v1 工程选择 |
| ~~移除 P3 4.4（i18n）~~ | 不是设计缺陷，是 v1 scope 限制 |
| 新增 P2 | §3.1（crash-recovery Node 版本依赖未声明）|
| 新增 P2 | §3.2（SUMMARY→IDLE 无收敛检查）|

修订后优先级汇总：

| 优先级 | 问题 | 简述 |
|--------|------|------|
| P0 | 2.1, 2.2 | 文件命名不一致 + SUMMARY tip 缺失 |
| P0 | 3.1 | meta.json 无生成规范 |
| P1 | 1.1, 1.4 | SUMMARY 设计矛盾 + 兼任负载不均 |
| P1 | 3.2 | sub_phase 切换规则未文档化 |
| P1 | 4.1 | 监督者单点瓶颈 |
| P2 | 1.2, 1.3 | dev_phase 命名 + converged 死字段 |
| P2 | 3.3, 3.4, 3.5 | 掉线恢复 / 身份校验 / tip 权限 |
| P2 | §3.1, §3.2 | crash-recovery Node 版本依赖 + SUMMARY→IDLE 无收敛检查 |
| P3 | 2.3, 2.4, 4.2（原 4.3）| 文档完善 / task 语义错位 |

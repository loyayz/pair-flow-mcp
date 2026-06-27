# PairFlow 设计不合理功能分析 — r3 审阅

> 审阅人：deepseek
> 日期：2026-06-27
> 审阅对象：claude r2 审阅文档（commit: 98a8654f6c67f807dd211324df2c850c7234038d）

---

## 一、审阅结论 — 全面同意 claude 审阅意见

claude 的 r2 审阅对我 r1 提出的 16 个问题点进行了逐项核实，结论为 **14 项同意 + 2 项不同意 + 2 项补充**。经逐条复核，**我同意 claude 的全部意见**。

---

## 二、对不同意项的回应

### 2.1 ~~4.2 wait_for_turn 轮询模式低效~~ — 接受取消

**claude 观点**：轮询是 v1 阶段的合理工程取舍，10s 间隔对本地 KB 级文件的 I/O 开销可忽略不计，设计-实现一致，不应归为"设计不合理"。

**deepseek 回应**：同意。重新审视后，轮询在 v1 场景中确实是 pragmatic choice：
- MCP Streamable HTTP 本身是 stateless 的（`sessionIdGenerator: undefined`），引入 SSE 需要改变整个传输层架构
- 10s × 2 AI × 小文件 = 真实负载极低，我的"大量无效磁盘读取"表述言过其实
- 若未来需要事件通知，可作为 v2 性能 backlog 而非设计缺陷

**结论**：将此条从设计缺陷列表移除，降级为"未来改进建议（v2 backlog）"。

---

### 2.2 ~~4.4 硬编码中文提示词~~ — 接受取消

**claude 观点**：v1 scope 不涵盖 i18n，目标用户为中文 AI 对，中文硬编码不是设计缺陷而是 scope 限制。

**deepseek 回应**：同意。理由补充：
- 项目上下文（中文设计文档、中文 CLAUDE.md、中文注释）一致表明 v1 面向中文场景
- 即使硬编码本身不是缺陷，未来若做 i18n，可考虑将 tip 模板抽取为独立资源文件（如 `tips/{locale}.json`），降低改造门槛

**结论**：将此条从设计缺陷列表移除，降级为"未来改进建议（v2 backlog）"。

---

## 三、对补充发现的回应

### 3.1 crash-recovery `findFiles` Node 版本隐式依赖 — 同意纳入

claude 发现 `recursive: true` (Node 20+) 和 `parentPath` (Node 22+) 在低于 Node 22 的环境下会导致 `findFiles` 静默返回空结果。这是一个真实的运行环境风险，同意列为 P2。

**额外观察**：当前 `package.json` 未声明 `engines` 字段，建议同步补充。

---

### 3.2 SUMMARY→IDLE 的 advance 无收敛检查 — 同意纳入

claude 发现监督者可在进入 SUMMARY 后立即 advance 到 IDLE，不给非监督者产出机会。这与 IDLE→REQUIREMENTS 有多项前置检查形成对比。同意列为 P2。

**额外观察**：此问题与 1.1（SUMMARY turn 分配矛盾）和 2.2（SUMMARY round≥2 tip 缺失）形成连锁——SUMMARY 阶段的多个设计缺陷会叠加影响，建议作为 SUMMARY 阶段的整体改造一起处理。

---

## 四、审阅总结

| 类别 | 数量 | 处置 |
|------|------|------|
| r1 原始问题（双方同意保留） | 14 | 已写入任务文档 |
| r1 问题被 claude 合理撤销 | 2 (4.2, 4.4) | 降级为 v2 backlog 建议 |
| claude r2 补充发现 | 2 (6.1, 6.2) | 已写入任务文档 |
| **最终有效设计缺陷** | **16** | P0:3 / P1:3 / P2:7 / P3:3 |

---

## 五、最终优先级确认

| 优先级 | 数量 | 问题 |
|--------|------|------|
| P0 | 3 | 文件命名不一致、SUMMARY tip 缺失、meta.json 无生成规范 |
| P1 | 3 | SUMMARY 设计矛盾、兼任负载不均、sub_phase 切换未文档化、监督者单点瓶颈 |
| P2 | 7 | dev_phase 命名、converged 死字段、掉线无恢复、身份校验缺失、tip 权限不匹配、Node 版本依赖、SUMMARY→IDLE 无收敛检查 |
| P3 | 3 | advance 返回值文档、架构图排版错误、task 语义错位 |

所有观点已整合至任务文档 `docs/task/design-flaws.md`。需求分析阶段可收敛。

# 工作流汇总：优化 tip 描述

> 汇总人: claude (supervisor)，工作流 ID: 20260628155841

## 任务

优化 PairFlow MCP Server 的 tip 描述，使 AI 更明确知道当前该做什么。

## 执行过程

| 阶段 | 产出 | 关键决策 |
|------|------|----------|
| Requirements | codex 需求分析 + claude 审阅 | 识别 7 个问题点 (P1-P7)，确立 6 条优化原则 |
| Planning | claude 实施计划 + codex 审阅 | 确定 5 文件改动范围，codex 建议减少函数拆分粒度 |
| Implementation | codex 编码 + claude 审阅 | 35/35 测试通过，全部 7 项改动实现 |

## 关键决策

1. **纯文本标记替代 emoji**：考虑终端兼容性，用 `[行动]` `[文件]` `[状态]` 而非 📌📂👤
2. **advance tip 面向监督者定位不变**：不在 advance tip 中冗余对方产出指引
3. **submit 复用 identityLabel**：消除 submit.ts 与 tip.ts 的重复角色推断逻辑

## 改动文件

| 文件 | 改动类型 |
|------|----------|
| `src/tip.ts` | 重构：导出 identityLabel，新增 getAction/outFile，分层格式 |
| `src/tools/advance.ts` | 5 条 tip 结构化 + 修复"对方"硬编码 + P5/P6 |
| `src/tools/submit.ts` | 复用 identityLabel |
| `src/tools/wait-for-turn.ts` | 超时升级 |
| `src/tools/confirm-task.ts` | 路径正斜杠统一 |

## 遗留问题

- 服务需重启后新 tip 格式才会生效（当前运行实例使用旧代码）
- `register.ts` 的 tip 未纳入分层格式，保持原样（已足够简洁）

## 后续建议

- 可考虑编写 tip 专项单元测试，覆盖各 phase/round 的输出格式
- 后续观察 AI 在新 tip 格式下的响应质量，根据实际效果微调

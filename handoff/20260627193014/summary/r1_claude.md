# PairFlow 设计缺陷分析与修复 — 阶段总结报告

> 汇总人：claude（监督者）
> 日期：2026-06-27
> 工作流 ID：20260627193014
> 任务文档：`docs/task/design-flaws.md`

---

## 一、工作流概览

| 阶段 | 轮次 | 关键产出 |
|------|------|----------|
| REQUIREMENTS | r1~r5（5 轮） | 识别 16 项设计缺陷 + 2 项 v2 backlog |
| PLANNING | r1~r4（4 轮） | 18 项修复方案 + 依赖图 + 测试策略 |
| IMPLEMENTATION | r1~r4（4 轮） | 14 项已修复 + 2 项延期 + 2 项 v2 backlog |
| SUMMARY | 当前 | 本报告 |

---

## 二、关键决策

### 2.1 撤销项（需求阶段）

| 原问题 | 撤销理由 | 去向 |
|--------|----------|------|
| wait_for_turn 轮询低效 | v1 合理工程取舍，10s 轮询本地小文件 I/O 可忽略 | v2 backlog |
| 硬编码中文提示词 | v1 scope 限制，目标用户为中文 AI 对 | v2 backlog |

### 2.2 降级项（计划阶段）

| 原问题 | 降级理由 | 去向 |
|--------|----------|------|
| 兼任负载均衡 | 兼任为优化配置，不应为核心流程增加复杂度 | v2 backlog |

### 2.3 延期项（实施阶段）

| 项目 | 延期理由 |
|------|----------|
| P1-4 监督者降级（takeover 工具） | 需新增 MCP 工具 + 角色转换逻辑，独立 PR |
| P2-3 掉线恢复（escalate 工具） | 与 takeover 关联，一起实现 |

### 2.4 技术选型

- **meta.json 生成**：确定采用 submit 自动生成（方案 B），放弃 tip 指引 AI 手动创建（方案 A）
- **converged 字段**：确定删除，放弃激活方案
- **Node 版本兼容**：代码兼容（path.relative 回退）为首选 + engines 声明为补充
- **监督者降级超时**：确定为 30 分钟（与 wait_for_turn 阈值一致）

---

## 三、交付成果

### 3.1 代码变更（14 项）

| 文件 | 变更内容 |
|------|----------|
| `src/tip.ts` | P0-1 文件名 sub_phase 前缀 + P0-2 SUMMARY tip + P1-1 SUMMARY 草稿 |
| `src/tools/submit.ts` | P0-3 meta.json 自动生成 + P2-5 tip 按身份差异化 |
| `src/state.ts` | P2-1 dev_cycle 重命名 + P2-2 converged 删除 |
| `src/tools/advance.ts` | P2-7 SUMMARY→IDLE 收敛检查 + .pid 清理 |
| `src/tools/confirm-task.ts` | P2-4 崩溃恢复身份校验 + P3-3 task.description 语义修正 |
| `src/crash-recovery.ts` | P2-6 parentPath 回退兼容 + dev_cycle 重命名 |
| `package.json` | P2-6 engines.node >= 22 |
| 设计文档 | P1-3 sub_phase 切换规则 + P1-1 SUMMARY 目录 + P3-1/2 文档修正 |

### 3.2 测试

```
Test Files  5 passed (5)
     Tests  24 passed (24)
```

---

## 四、遗留问题

| 优先级 | 问题 | 建议 |
|--------|------|------|
| P1 | 监督者降级（takeover） | 独立 PR，实现 takeover 工具 + 30min 超时检测 |
| P2 | 掉线恢复（escalate） | 与 takeover 一起实现 |
| P3 | planFile 路径在非标角色下可能不准确 | v2 backlog |
| — | 轮询优化、i18n、兼任负载均衡 | v2 backlog |

---

## 五、经验总结

1. **交替审阅模型有效**：deepseek 在需求阶段发现 16 个问题，claude 审阅后撤销 2 个误报、补充 2 个遗漏。双方独立视角的交叉验证提升了分析质量
2. **计划→实施对应关系清晰**：每项修复有明确的计划条目、优先级和影响文件，实施过程中无偏离
3. **meta.json 方案选择关键**：从"依赖 AI 行为"切换到"系统自动生成"是本次最重要的架构决策——将可靠性从外部（AI 遵从指引）转移到内部（系统保证）
4. **SUMMARY 阶段连锁问题**：1.1 + 2.2 + 6.2 三个问题相互关联，集中修复避免了碎片化

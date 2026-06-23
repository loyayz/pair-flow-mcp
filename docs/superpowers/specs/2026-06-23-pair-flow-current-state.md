# PairFlow v1 P0 问题总结

> 日期: 2026-06-23
> 来源: 多轮真实双 AI 接入验证 + code-review
> 仅保留 P0 级。P1/P2 问题见 `2026-06-23-pair-flow-p1-p2-backlog.md`
>
> **修改规则**：所有问题的讨论和决议直接修改本文档，原文档（`design.md`、`auto-flow-blockers.md`、`process-improvements.md`）保持不变。本文档是当前状态的唯一权威来源。

---

## 一、已完成的 P0

| # | issue | 状态 |
|---|-------|------|
| P0-19 | 事件通知 → wait_for_turn 长轮询 | ✅ 实现 |
| P0-20 | task 上下文 | ✅ 实现 |
| P0-21 | 目标锚定——缺 task 拒绝 advance | ✅ 实现 |
| P0-22 | submit 存储层——proposal/rationale 不再为 null | ✅ Cycle 0：改为 `topic + ": " + description` |
| P0-13 | IMPLEMENTATION defer 约束 | ✅ Cycle 0：defer_issue 工具 + advance check |
| P0-14 | SUMMARY 已知问题未修即结束 | ✅ 提前实现：claim-turn.ts:193-203 |
| P0-28 | work_dir 校验 | ✅ Cycle 0：register 携带 work_dir，双方校验 |

---

## 二、未完成的 P0

> 核心认知：PairFlow 的接入方是外部 AI，不会读 PairFlow 仓库的 CLAUDE.md。两次验证都靠不住——开发者可能忘自审，评审者可能不认真看。唯一可靠的方式是服务端直接介入：硬校验（reject 缺失段落）+ submit 响应返回 checklist 提醒下一方。

### 需服务端硬校验（不合法直接 reject）

| # | issue | 待实现 |
|---|-------|--------|
| P0-15 | 开发者自审 | ✅ submit 校验：IMPLEMENTATION coding/fix 时 content 缺失 `## 开发者自审` → reject |
| P0-16 | 评审者独立测试 | ✅ submit 校验：IMPLEMENTATION review 时 content 缺失 `## 独立测试` → reject |

### submit 响应提醒 + 模板引导

| # | issue | 方案 |
|---|-------|------|
| P0-spec | 流程中未更新相关文档 | ✅ submit 模板新增 `## 文档更新确认` 段（开放格式）。submit 响应返回 `checklist` 字段，提醒下一方核查文档更新 |

### 服务端已校验，无需额外工作

| # | issue | 现状 |
|---|-------|------|
| P0-22/23 | bootstrap 启动编排 | ✅ wait_for_turn + register 流程已由服务端 enforce |
| P0-24 | 监督者 task gate | ✅ advance IDLE→REQUIREMENTS 已强制要求 task |
| P0-25/25b | 角色行为边界 | ✅ claim_turn(advance) 已拒绝非监督者 |

---

## 三、已决议的待确认 P0

### 3.1 P0-22 入参层压缩 ✅ 已决议

`ConvergeMark.new_issues` 保持为 `[{type, topic, description}]`，markdown content 为权威来源。proposal/rationale 在 meta.json 中用 `topic + ": " + description` 填充，不再为 null。v1 无 machine consumer；若未来需要程序化提取，模板约束的 `## issue` 结构可做正则解析。

### 3.2 P0-19 wait_for_turn 超时行为 ✅ 已决议

60s 超时后 AI 应循环重试 wait_for_turn，不退出。CLAUDE.md 已有明确定义。design.md §4 补全入 P1 issue #4 跟踪。

### 3.3 crash 重启机制 ✅ 已实现

改为 `console.error + releaseLock() + process.exit(1)`，由外部进程管理器（PM2/systemd/docker）负责重启。crash-recovery.ts 启动时自动恢复状态。保留 lock.ts 跨进程 crash loop 检测（30s 内 3 次 → 拒绝启动）。

### 3.4 lock.ts 僵死心跳 ✅ 已实现

方案 A（文件时间戳心跳）：setInterval 15s 更新 lock.json `last_heartbeat`，acquireLock 时 `now - last_heartbeat > 30s` 视为僵死允许覆写。与 `isPidAlive` 双重检测。releaseLock 时 clearInterval。发现 P1 bug：僵尸覆写路径未重置 crash_count。

---

## 四、当前状态与剩余工作

```
全部完成 ✅

代码实现：
  ✅ P0-22 存储层 / P0-13 defer / P0-28 work_dir / P0-14 SUMMARY
  ✅ 3.3 crash log+exit / 3.4 lock 心跳
  ✅ crash-recovery 从 handoff 恢复
  ✅ 测试隔离（绝对路径 + taskkill）

服务端 enforce：
  ✅ bootstrap 编排 / task gate / 角色边界
  ✅ P0-15 submit 硬校验 ## 开发者自审
  ✅ P0-16 submit 硬校验 ## 独立测试
  ✅ submit 响应 checklist + 模板 ## 文档更新确认

```


# PairFlow v1 P0 问题总结

> 日期: 2026-06-23
> 来源: 多轮真实双 AI 接入验证 + code-review
> 仅保留 P0 级。P1/P2 问题另提需求单。

---

## 一、已完成的 P0

| # | issue | 状态 |
|---|-------|------|
| P0-19 | 事件通知 → wait_for_turn 长轮询 | ✅ 实现 |
| P0-20 | task 上下文 | ✅ 实现 |
| P0-21 | 目标锚定——缺 task 拒绝 advance | ✅ 实现 |

---

## 二、未完成的 P0

| # | issue | 来源 spec | 状态 |
|---|-------|---------|------|
| P0-22 | submit 数据流——存储层未补全 | blockers | ⚠️ 入参层和归档层已修；positions[identity] 初始化为空、proposal/rationale 仍写 null |
| P0-13 | IMPLEMENTATION defer 无约束 | process-improvements | ❌ advance 不检查 deferred，无正当理由判定标准 |
| P0-14 | SUMMARY 已知问题未修即结束 | process-improvements | ❌ SUMMARY→IDLE advance 不检查 open/deferred issue |
| P0-15 | 开发者自审 | process-improvements | ⚠️ 模板已更新，行为约束未落地 |
| P0-16 | 评审者独立测试 | process-improvements | ⚠️ 模板已更新，行为约束未落地 |
| P0-24 | 监督者未经确认设 task | process-improvements | ❌ 纯过程规范，需写入 CLAUDE.md |
| P0-28 | handoff 落在 PairFlow 仓库而非接入项目 | process-improvements | ❌ register 需携带 work_dir，双方校验一致性 |

---

## 三、已完成但有异议或需确认的 P0

### 3.1 P0-22 入参层压缩

`ConvergeMark.new_issues` 已压缩为 `[{type, topic, description}]`。`proposal`/`rationale` 从 JSON 移除，以 markdown content 为权威来源。

**需确认**：markdown 不可机器解析——后续如需程序化提取 proposal 将不可行。是否保留机器可读路径？

### 3.2 P0-19 wait_for_turn vs SSE

已选定方案 C（长轮询）。**需确认**：60s 超时后 AI 应循环重试还是退出？行为规范未定义。

### 3.3 crash 重启机制

当前 `uncaughtException` handler 内 close + listen 重启。Node.js 文档明确不建议在 uncaughtException 后恢复运行。

**需确认**：保留当前机制还是改为 log + exit + 外部进程管理器？

### 3.4 lock.ts 存活进程锁永不被覆写

已修：存活进程的锁永不被覆写。

**需确认**：进程僵死（不响应但不退出）时锁永远不被释放。是否需要心跳机制？

---

## 四、优先级

```
立即：
  1. P0-22 存储层补全
  2. P0-13 defer 约束
  3. P0-28 work_dir

本迭代：
  4. P0-14 SUMMARY 检查
  5. P0-24 task 人机确认 gate
  6. P0-15 + P0-16 行为约束落地
```

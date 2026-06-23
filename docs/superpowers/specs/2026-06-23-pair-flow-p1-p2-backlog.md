# PairFlow v1 P1/P2 待处理问题

> 日期: 2026-06-23
> 来源: 多轮真实双 AI 接入验证 + code-review + process-improvements spec
> P0 问题见 `2026-06-23-pair-flow-current-state.md`

---

## 一、P1 问题

### P1-17: IMPLEMENTATION 文件命名不含 sub_phase

**来源**: process-improvements §8

当前 `r{round}_{identity}.md`，无法从文件名区分 coding/review/fix。

**方案**: `{round}_{subphase}_{identity}.md`（如 `r1_coding_deepseek.md`）。REQUIREMENTS/PLANNING 保持现有命名。

---

### P1-22: bootstrap 身份混淆

**来源**: process-improvements §11

AI 默认用产品名（Claude Code → "claude"）作为 PairFlow identity，而非注册名（"deepseek"）。

**方案**: bootstrap 启动第一步必须调 `who_am_i` 确认身份。写入 CLAUDE.md。

---

### P1-23: 缺少启动编排

**来源**: process-improvements §12

`wait_for_turn` 解决了"怎么等"，没解决"什么时候开始等"。AI 注册后不知道下一步。

**方案**: 与 P1-22 合并——注册后立即进入 `wait_for_turn` 循环。统一 bootstrap 流程写入 CLAUDE.md。

---

### P1-25: 开发者行为越权

**来源**: process-improvements §13

deepseek 多次在 turn=claude 时 claim_turn、告知用户"需要重启 server"——这些是监督者权限。

**方案**: converged 时拒绝 peer 的 claim_turn（返回 "wait for supervisor"）。CLAUDE.md 写入 developer 行为约束。

---

### P1-25b: 开发者未确认计划直接编码

**来源**: process-improvements §14

IMPLEMENTATION 拿到 turn 后直接开始写代码，未确认 PLANNING 最终计划和本轮范围。

**方案**: IMPLEMENTATION coding 模板提示确认计划。CLAUDE.md 写入 coding 前置检查清单。

---

### P0-26 → P1: 重启绕过崩溃恢复

**来源**: process-improvements §15

每次重启 `rm -rf .pairflow` 绕过 §8 恢复机制，产生废弃 workflow 目录。

**方案**: 操作规范文档化 + `scripts/clean.ts` 清理脚本 + 服务端启动时 orphan handoff 预警。

---

### P0-27 → P1: 双方均未 commit

**来源**: process-improvements §16

4 轮交替评审完成但 git log 无 AI 产生的 commit。AI 不能执行 git，server 不应越界。

**方案**: 使用方运维责任。非 PairFlow 职责范围。

---

### P1: get_archived_file_content 缺少 phase 参数

**来源**: 功能 spec §10 / 真实接入发现

文件在 `handoff/{wfId}/{phase}/` 子目录下，工具只接受 `filename`，需通过 `requirements/r1_deepseek.md` 拼接路径。

**方案**: 新增可选 `phase` 参数。

---

### P1: rules_catalog 仅 14 条（P1-72/P1-73）

**来源**: process-improvements §4

- P1-73: getRulesSummary trigger 过滤不完整
- P1-72: catalog 覆盖率 lint 未实现

**方案**: 扩展 catalog + 实现 lint。

---

## 二、P2 问题

### P2-18: converge_mark 首轮 need_next_round 永远 null

**来源**: process-improvements §9

REQUIREMENTS/PLANNING 首轮持笔者 `stance=null, need_next_round=null`——字段存在但不承载语义。

**方案**: 方案 A——文档明确标注 null 语义，不改 schema。

---

### P2: SSE 事件推送

**来源**: 功能 spec §4

当前降级为 wait_for_turn 轮询。

**方案**: v2 考虑升级为 SSE push。

---

## 三、优先级

```
本迭代：
  1. P1-22+P1-23 统一 bootstrap 流程
  2. P1-25+P1-25b 开发者行为约束
  3. get_archived_file_content phase 参数

下迭代：
  4. P1-17 文件命名
  5. P0-26 清理脚本
  6. P2-18 文档标注

v2:
  7. SSE 事件推送
  8. rules_catalog 扩展
```

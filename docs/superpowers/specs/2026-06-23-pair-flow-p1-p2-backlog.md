# PairFlow v1 P1/P2 待处理问题

> 日期: 2026-06-23
> 来源: 多轮真实双 AI 接入验证 + code-review + process-improvements spec
> P0 问题见 `2026-06-23-pair-flow-current-state.md`
>
> **修改规则**：所有问题的讨论和决议直接修改本文档，原文档（`design.md`、`auto-flow-blockers.md`、`process-improvements.md`）保持不变。本文档是 P1/P2 问题的唯一权威来源。

---

## 一、P1 问题

> **2026-06-23 更新**：P1-22、P1-23、P1-25、P1-25b 已升级为 P0，合并入 `2026-06-23-pair-flow-current-state.md` §二"AI 行为规范落地"。这些不是"改进"而是流程成立的基础契约——如果双方不遵守行为边界，PairFlow 本身不成立。

### P1-17: IMPLEMENTATION 文件命名不含 sub_phase

**来源**: process-improvements §8

当前 `r{round}_{identity}.md`，无法从文件名区分 coding/review/fix。

**方案**: `{round}_{subphase}_{identity}.md`（如 `r1_coding_deepseek.md`）。REQUIREMENTS/PLANNING 保持现有命名。

---

### P1: 接口返回值中引导 AI 下一步动作

**来源**: 本 session 真实接入发现

上一轮实践中 AI 频繁困惑于"接下来该调什么接口"——拿到 submit 返回后不知道该 wait_for_turn，拿到 wait_for_turn 返回后不知道该 claim_turn。虽然 CLAUDE.md 写了行为表，但外部 AI 不读 PairFlow 仓库文档。更可靠的方案是**服务端在每次返回时直接告知下一步**，类似 `wait_for_turn` 已有的 `note` 字段。

**方案**: 每个接口的返回值新增 `next` 字段，值为建议的下一步接口名 + 触发条件。服务端根据当前状态动态生成，不依赖 AI 记忆或外部文档。

| 当前接口 | 条件 | `next` 建议 |
|---------|------|------------|
| `who_am_i` | 未注册 | `register` |
| `who_am_i` | 已注册 | `wait_for_turn` |
| `register` | 第二个 peer 刚注册 | `wait_for_turn`（告知 supervisor 可 advance） |
| `register` | 仅自己注册 | `wait_for_turn`（等对方） |
| `claim_turn(advance)` | advance 成功 | `wait_for_turn`（turn 切给对方） |
| `claim_turn(turn)` | 获取 turn 成功 | `get_state` + 按 template 产出 + `submit` |
| `submit` | 提交成功，turn 切换 | `wait_for_turn`（等对方 review） |
| `submit` | 收敛，进入盲审 | `claim_turn`（盲审特例） |
| `wait_for_turn` | turn=自己 | `claim_turn` |
| `wait_for_turn` | timeout / note | `wait_for_turn`（继续等） |
| `create_issue` | 成功 | `submit`（将 issue 写入收敛标记） |
| `force_converge` | 成功 | `claim_turn`（盲审） |

**优先级**: 本迭代（与 `reminder` 已实现的基础设施配套，改动范围 ~10 个文件）

---

### P1: 崩溃恢复不应总是自动执行——缺少"新 session"入口

**来源**: 本 session 真实接入发现

当前 state.json 丢失时 `recoverState()` 自动从 handoff 重建状态，没有给用户选择"开始新 workflow"的机会。每次想全新开始都得手动清理 `.pairflow/` + `handoff/`，操作门槛高且容易误删归档。

**方案**: 提供显式的新 session 入口。选项：
- A) `register` 时若检测到恢复状态，返回 `recovered: true` 提示，由监督者决定 continue/reset
- B) 新增 `reset` 工具，清空运行时状态，保留 handoff 归档
- C) 启动时检查环境变量 `PAIRFLOW_FRESH_START=true` 跳过恢复

**优先级**: 本迭代

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
  1. get_archived_file_content phase 参数
  2. P0-26 清理脚本
  3. P1-17 文件命名
  4. P2-18 文档标注
  5. SSE 事件推送
  6. rules_catalog 扩展
```

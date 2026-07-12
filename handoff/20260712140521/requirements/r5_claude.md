# 结构化行动协议 — 需求审阅（r5, claude）

> 提出人：claude（developer）
>
> 对照产出：`requirements/r4_codex.md`（commit `8dacafbd863868d17b3e8bc293ab6a2e32907eac`）

## 总体判断

同意 codex 的全部修正。两处修正均为 r3 映射表中的精度问题，不影响核心架构。无新增分歧。

---

## 逐项确认

### 1. Idle Supervisor 映射

**同意修正。** r3 中我将 idle.supervisor 映射为 `wait_for_turn` 是错误的。idle 阶段 roster 完整后，Supervisor 的 turn 用于调用 `advance` 启动工作流——这是确定性推进，不需要内容判断。

修正后的映射：

| 场景 | next_action | allowed_tools |
|------|-------------|--------------|
| idle + 非 Supervisor | wait_for_turn | ["wait_for_turn"] |
| idle + Supervisor | advance | ["advance"] |

> **提出人：codex；确认：claude**

### 2. 未知 Reason Code 客户端行为

**同意修正。** 我之前建议的"fallback 到 tip 解析"与本任务的核心目标矛盾。如果客户端遇到未知 reason_code 时回退解析 tip，等于在协议层出现缺口时重新引入字符串依赖。

正确行为：客户端遇未知 reason_code → 安全失败 + 提示升级 PairFlow Server。tip 仅作为自然语言展示给 AI/用户，不用于自动决策。

> **提出人：codex；确认：claude**

---

## 最终收敛确认

双方已在以下所有维度达成共识，无未决议题：

- ✅ 核心问题与目标
- ✅ 范围边界（做/不做）
- ✅ 干系人画像
- ✅ 功能优先级（P0→P2）
- ✅ 架构约束（单一 guidance 场景入口、禁止双路由）
- ✅ 非功能约束（性能、安全、兼容、前向兼容）
- ✅ 风险识别与缓解
- ✅ 6 个歧义约束 + 2 个映射修正
- ✅ 兼容策略

**同意进入 planning 阶段。**

> **提出人：claude**

# PairFlow 第四次回顾 — 实现后验证发现

> 日期: 2026-06-24
> 触发: Session 3 代码实现后的首次重启验证
> 发现: `require_re_register` 机制的 60s 窗口误判
> 产出: 1 commit (`551e60c`)

---

## 一、背景

Session 3 实现了 6 项关键缺陷修复（commit `9fb778e`），其中包括 #1+#4：崩溃恢复后通过 `require_re_register` 机制要求双方重新注册。该机制在本次重启中首次获得实战验证。

## 二、问题发现

### 2.1 操作序列

```
1. 停止服务 → rm -rf .pairflow → 启动服务（最新代码）
2. claude 调用 register → 成功，re_register: true, all_re_registered: true ✅
3. deepseek 调用 register → "current: implementation" ❌ require_re_register 未触发
```

### 2.2 根因

`get_state` 输出显示：

```json
{
  "recovered": true,
  "require_re_register": false,
  "peers": [
    { "identity": "claude",   "registered_at": "2026-06-24T03:11:40.290Z" },
    { "identity": "deepseek", "registered_at": "2026-06-24T03:11:32.654Z" }
  ]
}
```

整个因果链：

```
崩溃恢复 → reconstructFromHandoff() → peers.registered_at = new Date().toISOString()
  → claude 调用 register → 60s 窗口检查
    → claude 的 registered_at 更新为当前时间 ✅
    → deepseek 的 registered_at 仍为恢复时间（5 秒前）→ 窗口内 → 误认为"已重新注册"
  → all_re_registered = true → require_re_register 被清除 → false
```

**核心缺陷**：崩溃恢复时 peers 的 `registered_at` 设为 `new Date().toISOString()`，与真正的 register 调用写入的时间无法区分。60 秒窗口内，刚恢复的 peer 看起来像"刚注册的 peer"。

### 2.3 后果

- `require_re_register` 在第一方注册后立即被清除
- 第二方注册时 `require_re_register` 为 false → register 检查 `state.phase !== "idle"` → 拒绝注册
- 第二方无法进入 PairFlow 流程——即使服务已恢复，对方被锁在外面

## 三、修复

**文件**: `src/crash-recovery.ts` — `reconstructFromHandoff()`

**方案**: 恢复时 peers 的 `registered_at` 设为 epoch（`1970-01-01T00:00:00.000Z`），而非当前时间。

```diff
 state.peers.push({
   identity: id,
   role: isSup ? "supervisor" : "peer",
   is_developer: isDev,
-  registered_at: now,
+  registered_at: "1970-01-01T00:00:00.000Z",
 });
```

**效果**: epoch 距今 50+ 年 → `Date.now() - epoch.getTime()` ≈ 1.7×10¹² ms ≫ 60,000 ms → 60s 窗口检查正确返回 false → 只有真正的 register 调用才能通过窗口检查。

## 四、教训

### 4.1 恢复时间戳 ≠ 注册时间戳

崩溃恢复写入的 `registered_at` 表示"peer 身份被恢复到 state 中的时间"，而非"peer 确认在线的时间"。前者是数据恢复行为，后者是协议行为——不应共享同一个语义。

### 4.2 60 秒窗口是 fragile 的

用时间窗口区分"新注册"和"旧注册"本身就脆弱。更 robust 的方案：

- 用显式的枚举值标记状态（`"recovered" | actual_time_string`）
- 或用单独的 `re_registered: boolean` 字段跟踪每方是否已重新注册

但 epoch 方案已足够解决当前问题——它把"恢复时间戳"和"注册时间戳"彻底区分开来。

### 4.3 改进项自身的 bug 需要实战发现

本次修复的 6 项改进中，#1+#4（崩溃恢复 + require_re_register）包含一个只有在重启后才能暴露的 bug。静态分析和单元测试（crash-recovery.test.ts）未覆盖这个场景，因为测试中的时间窗口行为与真实环境不同。

**启示**：改进项实现后必须立即重启验证——在下一个 session 开始时而非结束后。

---

## 五、结论

一次实战验证发现一个 bug。`require_re_register` 机制的设计思路正确，但 60s 窗口的时间源选择错误。修复后，恢复的 peers 必须真正调用 register 才能继续参与流程——这正是"幽灵注册"问题的解决方案。

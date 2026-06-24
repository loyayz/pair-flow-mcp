# PairFlow 第四次回顾 — 实现后验证发现

> 日期: 2026-06-24
> 触发: Session 3 代码实现后的首次重启验证
> 发现: `require_re_register` 机制的 60s 窗口误判
> 产出: 2 commits (`551e60c` + `b8690c0`)

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

### 4.2 修复验证——epoch 方案自身暴露了第二个问题

epoch 修复（`551e60c`）部署后，立即进行了第二次重启验证：

```
1. 服务重启 + crash recovery → peers registered_at = epoch
2. claude 调用 register → re_register: true, all_re_registered: false ✅
3. deepseek 调用 register → re_register: true, all_re_registered: false ❌
```

`all_re_registered` 仍为 false，但双方都已调用 register。查看 state：

```json
{
  "require_re_register": true,
  "peers": [
    { "identity": "claude",   "registered_at": "2026-06-24T03:20:20.833Z" },
    { "identity": "deepseek", "registered_at": "2026-06-24T03:21:47.861Z" }
  ]
}
```

双方 `registered_at` 都已更新为非 epoch 值——但 register.ts 中的检测逻辑**仍是 60s 时间窗口**，而非 epoch 哨兵检查。

根因：第一次修复只改了 crash-recovery.ts（写入侧），未同步修改 register.ts（读取侧）。register.ts 仍用 `(Date.now() - t) < 60_000` 判断，而两次 register 间隔 87 秒 > 60 秒 → claude 被窗口排除 → allReRegistered = false。

**这不是窗口参数调大能解决的问题**——任何固定时间窗口都会在某个间隔下失效。正确方案是 register.ts 和 crash-recovery.ts 使用同一个哨兵值：

```diff
// register.ts
- const allReRegistered = state.peers.every((p) => {
-   const t = new Date(p.registered_at).getTime();
-   const nowMs = Date.now();
-   return (nowMs - t) < 60_000;
- });
+ const EPOCH = "1970-01-01T00:00:00.000Z";
+ const allReRegistered = state.peers.every((p) => p.registered_at !== EPOCH);
```

**commit `b8690c0`**：彻底移除 60s 时间窗口，读写两侧统一使用 epoch 哨兵。

### 4.3 教训：写入侧和读取侧的约定必须同步

一个字段的语义由写入侧定义，但由读取侧解释。修改写入侧（crash-recovery.ts 写 epoch）后，必须同步修改读取侧（register.ts 读 epoch）。只改一侧，另一侧仍用旧逻辑——这是分布式系统中"读写不一致"的经典模式，在单进程单文件中同样存在。

### 4.3 改进项自身的 bug 需要实战发现

本次修复的 6 项改进中，#1+#4（崩溃恢复 + require_re_register）包含一个只有在重启后才能暴露的 bug。静态分析和单元测试（crash-recovery.test.ts）未覆盖这个场景，因为测试中的时间窗口行为与真实环境不同。

**启示**：改进项实现后必须立即重启验证——在下一个 session 开始时而非结束后。

---

## 五、结论

一次实战验证发现**两个连锁 bug**：

1. **写入侧时间源错误**（`551e60c`）：恢复时写入当前时间，与真注册无法区分 → 改用 epoch
2. **读取侧逻辑未同步**（`b8690c0`）：修复了写入侧但遗留 60s 窗口 → 彻底改用 epoch 哨兵

`require_re_register` 机制经过两次重启验证后确认有效。epoch 哨兵方案比时间窗口更简单、更可靠——它把"是否已注册"变成了布尔命题而非时间算术。

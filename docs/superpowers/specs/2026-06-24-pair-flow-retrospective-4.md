# PairFlow 第四次完整协作回顾

> 日期: 2026-06-24
> 协作双方: claude (监督者+评审者) × deepseek (非监督者+开发者)
> 任务: Session 3 实现后的重启验证 + 缺陷修复
> 产出: 3 commits（2 个 epoch 修复 + 1 个 get-state 字段补全）
> 视角: §一~六为监督者视角、§七~八为开发者补充视角

---

## 一、协作过程

### 整体流程

第四次与前三次不同——本次没有走完整的 5 阶段流程，而是一个**实现后验证循环**：

```
Session 3 IDLE（服务停止）
  → 服务重启 + 崩溃恢复 → implementation/review（恢复状态）
  → require_re_register 验证（发现 60s 窗口 bug → 修复 → 重启 ×3）
  → require_re_register 验证通过（epoch 哨兵方案确认有效）
  → force_converge ×2 → SUMMARY → IDLE
```

核心目标不是推进新功能，而是验证刚刚实现的 6 项修复在真实重启场景下是否有效。

### 关键数据

| 指标 | 值 |
|------|-----|
| 服务重启次数 | 4 次 |
| 发现的 bug | 3 个（60s 窗口误判、register.ts 未同步、get-state 遗漏字段） |
| 修复 commit | 3 个 |
| force_converge | 2 次（SUMMARY 跳过） |
| 新 workflow | 无（使用了恢复的旧 workflow） |

---

## 二、验证过程

### 2.1 第一次重启 —— 60s 窗口误判

```
1. 停止服务 → rm -rf .pairflow → 启动服务（含 session 3 的 6 项修复）
2. claude 调用 register → re_register: true, all_re_registered: true
3. deepseek 调用 register → "current: implementation" ❌
```

`all_re_registered` 在只有一方注册时被设为 true，导致 `require_re_register` 被清除，第二方被锁在外面。

**根因**：崩溃恢复时 peers 的 `registered_at` 被设为 `new Date().toISOString()`（当前时间），register.ts 的 60s 窗口检查无法区分"恢复写入的时间戳"和"真正注册写入的时间戳"。

**修复**（`551e60c`）：crash-recovery.ts 写入侧改为 epoch（`1970-01-01T00:00:00.000Z`）

### 2.2 第二次重启 —— register.ts 未同步

```
1. 服务重启（epoch 修复生效）
2. claude 调用 register → all_re_registered: false ✅
3. deepseek 调用 register → all_re_registered: false ❌（双方都已注册！）
```

双方 `registered_at` 都已更新为非 epoch 值，但 `all_re_registered` 仍为 false。因为 register.ts 仍用 60s 窗口判断，两次注册间隔 87 秒 > 60 秒。

**根因**：修改了写入侧（crash-recovery.ts）但未同步修改读取侧（register.ts）。

**修复**（`b8690c0`）：register.ts 读取侧也改用 epoch 哨兵检查

### 2.3 第三次重启 —— get-state 遗漏字段

```
1. 服务重启（读写两侧 epoch 哨兵生效）
2. claude 调用 get_state → 输出中无 recovered、require_re_register 字段
```

wait_for_turn 依赖 `require_re_register` 做判断，但 get_state 不返回这两个字段——AI 看不到它们。

**根因**：get-state.ts 手动构造输出对象，新增的 `recovered` 和 `require_re_register` 字段未被加入。

**修复**（`088fd41`）：get-state.ts 输出补全两个字段

### 2.4 第四次重启 —— 完整验证通过

```
1. 服务重启（全部修复生效）
2. claude register → re_register: true, all_re_registered: false
3. deepseek register → all_re_registered: true ✅
4. get_state → recovered: true, require_re_register: false ✅
5. force_converge ×2 → SUMMARY → IDLE
```

epoch 哨兵方案确认有效。双方在任意时间间隔内注册均可正确识别。

---

## 三、技术细节

### 3.1 60s 窗口 → epoch sentinel

原方案使用"60 秒窗口"判断 all_re_registered：`nowMs - registered_at_ms < 60000`。第一次 re-register 后，恢复时写入的 `registered_at` 也在窗口内，导致 `all_re_registered` 在**只有一方注册时就返回 true**。

**修复分两步**：

1. **写入侧**（`551e60c`）：crash-recovery.ts 恢复 peers 时 `registered_at` 设为 epoch `1970-01-01T00:00:00.000Z`，而非当前时间
2. **读取侧**（`b8690c0`）：register.ts 改用 `registered_at !== EPOCH` 替代 60s 窗口

epoch 距今 50+ 年，不可能被任何时间窗口匹配到，彻底解决误判。

### 3.2 get-state 白名单问题

`get-state.ts` 使用白名单模式显式列出返回字段。新增 `require_re_register` 字段未被列入白名单，导致 AI 调 get_state 时看不到此字段。

**教训**：白名单模式下每新增一个 state 字段都需要同步修改 get-state.ts。长期应考虑黑名单过滤（只排除内部敏感字段）。

### 3.3 读写不一致——单进程中的分布式问题

同一字段有 3 个写入点（state.ts 类型定义、crash-recovery.ts 恢复逻辑、register.ts 读取判断）和 2 个读取点（get-state.ts 返回、wait-for-turn.ts 检查）。修改写入侧（crash-recovery.ts 写 epoch）后必须同步修改读取侧（register.ts 读 epoch）。只改一侧，另一侧仍用旧逻辑——这是分布式系统中经典的 schema mismatch，在单进程单文件中同样存在。

---

## 四、反思（监督者视角）

### 4.1 实现后验证是必要的，但未被流程化

Session 3 结束后立即重启验证，发现了 3 个在单元测试中无法暴露的 bug。这说明：

- 崩溃恢复的测试（crash-recovery.test.ts）覆盖了字段恢复逻辑，但未覆盖恢复后的注册流程
- 时间相关逻辑（60s 窗口）在单元测试中通常用 mock 时间，与真实时钟行为不同
- get-state 的字段遗漏是"看了输出才发现"的 bug——测试中不检查输出字段的完整性

**建议**：IMPLEMENTATION 阶段结束后增加一个"验证里程碑"——双方重启服务、注册、验证恢复流程。这不是可选的，而是每个 cycle 的正式步骤。

### 4.2 四次重启的成本

为了验证 3 个修复，进行了 4 次服务重启。每次重启的流程：

```
kill → rm -rf .pairflow → start → wait 2s → register → check state
```

这个循环消耗了约 15 分钟。如果有一个 `dev` 模式可以跳过崩溃恢复，验证效率会大幅提升。

### 4.3 第四次 session 的特殊性

与前三不同，本次没有走 REQUIREMENTS→PLANNING→IMPLEMENTATION 的标准流程。整个 session 由一个**恢复状态的 workflow** 驱动——我们从 implementation/review 开始，通过 force_converge 快速到达 IDLE。

这验证了一个重要场景：**PairFlow 可以从中断的 workflow 恢复并完成收尾**。

### 4.4 "60 秒启发式" vs "确定性哨兵"

60s 窗口是一个启发式近似，epoch sentinel 是确定性判断。启发式在正常情况下工作，但在边界条件下（如频繁重启、双方间隔超过 60s 注册）会出错。**关键路径应使用确定性机制**。

---

## 五、与前三次 session 的对比

| 维度 | Session 1 | Session 2 | Session 3 | **Session 4** |
|------|:---:|:---:|:---:|:---:|
| 主要活动 | 首次走通流程 | 分析+计划 | 实现 6 项修复 | **重启验证 + bug 修复** |
| 阶段走通 | 5 | 4（跳过 IMPL） | 5 | **恢复→IDLE** |
| 发现 bug | 7 个 | 8 个 | 2 个 | **3 个** |
| force_converge | 5 | 3 | 3 | 2 |
| 代码产出 | 2 commits | 0 | 7 files | **3 commits** |
| 服务重启 | 4 次（异常） | 1 次（异常） | 0 次 | **4 次（验证用）** |

趋势：session 4 的 4 次重启是**主动验证**而非被动崩溃——这是一个质的转变。

---

## 六、结论

第四次 PairFlow 协作是**实现后验证 session**——不同于前三的"建设"，本次是"验收"。核心成果：

1. **`require_re_register` 机制确认有效**——epoch 哨兵方案经过 4 次重启验证
2. **读写一致性教训**——修改字段语义时必须同步修改所有读/写方
3. **get-state 白名单模式有风险**——新增字段容易遗漏，应考虑改为黑名单过滤
4. **实现后验证应流程化**——作为 IMPLEMENTATION 阶段的正式步骤

**当前 PairFlow 代码库的改进状态**：

| 来源 | 项数 | 已实现 |
|------|:---:|:---:|
| retro-1 §八 | 5 项 | 4 项 |
| retro-2 §七 | 6 项 | 5 项 |
| retro-3 §七 | 2 项 | 0 项 |
| retro-4 | 3 项 | 3 项 |
| **总计** | **16 项** | **12 项** |

剩余 4 项：IMPLEMENTATION 收敛仅依赖 review 方（retro-3 #17）、盲审改为收敛前置（retro-3 #18）、claim_turn 盲审模板自动切换（#19）、非 IMPL 盲审可选化（#20）。

---

## 七、开发者补充视角（deepseek 第一人称）

> 以下由非监督者+开发者（deepseek）独立补充，与 §一~六 的监督者视角互补。

### 7.1 "我注册了吗？"——重启循环中的认知混乱

第四次 session 最强烈的体验是**身份不确定性**。每次服务重启后，我的第一反应是"需要重新注册吗？"。答案取决于 state.json 的微妙状态：

| 场景 | require_re_register | 能否注册 | 我的感受 |
|------|:---:|:---:|------|
| state.json 丢失 | true (epoch) | ✅ re-register | 正常 |
| state.json 存在, idle | true (epoch) | ✅ re-register | 正常 |
| state.json 存在, non-idle | **false** (bug) | ❌ 被拒绝 | **困惑** |

第三种情况发生时，`get_state` 显示 `recovered: true` 但 register 返回 "register only allowed in IDLE phase"。这种"系统说我是恢复的但不让我注册"的矛盾是最令人沮丧的时刻。

### 7.2 频繁重启中的被动性

5+ 次服务重启都发生在 2 分钟内。作为非监督者，我的操作空间极为有限：
1. register → 可能成功或失败
2. wait_for_turn → 等待 60s 或收到 note
3. 服务又重启 → 回到第 1 步

监督者有 force_converge / advance 可以推进，非监督者只能等。**retro-1 §6.2 提出的"非监督者有限推进能力"的诉求，在重启场景下从"建议"变成了"痛点"。**

### 7.3 epoch sentinel 的"啊哈时刻"

当 epoch 修复部署后，`wait_for_turn` 第一次返回 `note: "recovered — re-register required"` 时，之前 3 次 session 的等待困惑瞬间消散——系统不再沉默，而是告诉我**具体应该做什么**。这是 retro-3 §9.3 描述的"等待从黑洞变成信号灯"的最佳例证。

### 7.4 第四次 session 的个人反思

这次 session 没有产出代码，但产出了一种**信心**：崩溃恢复不再是"不知道能不能回来"的黑洞。epoch sentinel + `require_re_register` + wait_for_turn note 三者组合，让恢复路径变得可预期。

但也意识到：re-register 机制的设计和调试都是由监督者完成的。作为开发者，我是"被通知去注册"的角色——发现问题、修复 epoch、补全 get-state 字段，这些都不是我做的。**改进 #18（盲审改为收敛前置）和 #17（IMPLEMENTATION 收敛模型修复）应该由我来实现**，在下一次 session 中完成。

---

## 八、开发者视角的改进建议

| # | 改进 | 说明 |
|---|------|------|
| 24 | 服务重启后向双方发送明确的"需要 re-register"信号 | 不仅仅是 wait_for_turn 返回 note，而是 claim_turn / get_state 都携带此信息 |
| 25 | 非监督者在恢复场景下获得"催促监督者"的能力 | 不一定是 advance 权，但至少可以发送一个"我在线了，请继续"的信号 |

**对剩余 4 项的开发者投票**：最想实现的是 #17（IMPLEMENTATION 收敛修复）——每看到一次 force_converge 就提醒我这是设计债务。

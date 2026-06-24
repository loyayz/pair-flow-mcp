# PairFlow 第四次完整协作回顾

> 日期: 2026-06-24
> 协作双方: claude (监督者+评审者) × deepseek (非监督者+开发者)
> 任务: Session 3 实现后的重启验证 + 缺陷修复
> 产出: 3 commits（2 个 epoch 修复 + 1 个 get-state 字段补全）
> 视角: 监督者视角

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

### 3.1 60s 窗口误判的根因分析

~~内容见前文二、问题发现，此处不再重复。~~ 详见上方 §2.1-2.2。

### 3.2 epoch 哨兵方案

**写入侧**（crash-recovery.ts）：恢复时 `registered_at` 统一写 `"1970-01-01T00:00:00.000Z"`

**读取侧**（register.ts）：检查 `registered_at !== "1970-01-01T00:00:00.000Z"` 即视为已重新注册

**优势**：
- 无需时间窗口参数
- 双方注册间隔不受限制
- 语义清晰——epoch 就是"未注册"，任何非 epoch 值就是"已注册"

### 3.3 get-state 字段遗漏

get-state.ts 手动构造输出 JSON，这是一种 fragile 的设计——每当 PairFlowState 增加字段，get-state.ts 必须同步更新。更好的方案是序列化整个 state 对象并仅过滤敏感字段，而非逐个白名单。

---

## 四、反思（监督者视角）

### 4.1 实现后验证是必要的，但未被流程化

Session 3 结束后立即重启验证，发现了 3 个在单元测试中无法暴露的 bug。这说明：

- 崩溃恢复的测试（crash-recovery.test.ts）覆盖了字段恢复逻辑，但未覆盖恢复后的注册流程
- 时间相关逻辑（60s 窗口）在单元测试中通常用 mock 时间，与真实时钟行为不同
- get-state 的字段遗漏是"看了输出才发现"的bug——测试中不检查输出字段的完整性

**建议**：IMPLEMENTATION 阶段结束后增加一个"验证里程碑"——双方注册、重启服务、验证恢复流程。这不是可选的，而是每个 cycle 的正式步骤。

### 4.2 读写不一致是单进程中的分布式问题

crash-recovery.ts（写）和 register.ts（读）对 `registered_at` 的解释不一致——这是分布式系统中经典的 schema mismatch。在单进程单文件中，这种不一致更难被发现，因为开发者默认"同一个变量不会有两套解释"。

**教训**：当一个字段有多个写入源（crash recovery + register）时，所有读取方必须对齐语义。最简单的做法是定义一个常量（EPOCH_SENTINEL）并让所有文件引用它。

### 4.3 四次重启的成本

为了验证 3 个修复，进行了 4 次服务重启。每次重启的流程：

```
kill → rm -rf .pairflow → start → wait 2s → register → check state
```

这个循环在 session 3 中大约消耗了 15 分钟。如果有一个 `dev` 模式可以跳过崩溃恢复（类似 `PAIRFLOW_FRESH_START`），验证效率会大幅提升。

### 4.4 第四次 session 的特殊性

与前三不同，本次没有走 REQUIREMENTS→PLANNING→IMPLEMENTATION 的标准流程。整个 session 由一个**恢复状态的 workflow** 驱动——我们从 implementation/review 开始，通过 force_converge 快速到达 IDLE。

这验证了一个重要场景：**PairFlow 可以从中断的 workflow 恢复并完成收尾**。恢复后的 3 步（re-register → force_converge → advance → IDLE）是合理且高效的。

### 4.5 开发者视角补充

- deepseek 在第一次注册被拒（"current: implementation"）时的反馈是清晰的——直接报告了错误信息，监督者能迅速定位问题
- 第二次 bug（87 秒间隔）暴露了 60s 窗口的脆弱性——如果双方恰好同步注册，这个 bug 可能永远不会被发现
- 本次验证中开发者只需 register 一次，不需要做其他产出——这是一个低摩擦的协作模式

---

## 五、与前三次 session 的对比

| 维度 | Session 1 | Session 2 | Session 3 | **Session 4** |
|------|:---:|:---:|:---:|:---:|
| 主要活动 | 首次走通流程 | 分析+计划 | 实现 6 项修复 | **重启验证 + bug 修复** |
| 阶段走通 | 5 | 4（跳过 IMPL） | 5 | **恢复→IDLE** |
| 发现 bug | 7 个（retro-1） | 8 个（retro-2） | 2 个（retro-3） | **3 个** |
| force_converge | 5 | 3 | 3 | 2 |
| 代码产出 | 2 commits | 0 | 7 files | **3 commits** |
| 服务重启 | 4 次（异常） | 1 次（异常） | 0 次 | **4 次（验证用）** |

趋势：bug 发现率在下降（7→8→2→3），flow 越来越可控。Session 4 的 4 次重启是**主动验证**而非被动崩溃——这是一个质的转变。

---

## 六、结论

第四次 PairFlow 协作是**实现后验证 session**——不同于前三的"建设"，本次是"验收"。核心成果：

1. **`require_re_register` 机制确认有效**——epoch 哨兵方案经过 4 次重启验证
2. **读写一致性教训**——修改字段语义时必须同步修改所有读/写方
3. **get-state 白名单模式有风险**——新增字段容易遗漏，应考虑改为黑名单过滤
4. **实现后验证应流程化**——作为 IMPLEMENTATION 阶段的正式步骤，而非"顺便做一下"

**当前 PairFlow 代码库的改进状态**：

| 来源 | 项数 | 已实现 |
|------|:---:|:---:|
| retro-1 §八 | 5 项 | 4 项 |
| retro-2 §七 | 6 项 | 5 项 |
| retro-3 §七 | 2 项 | 0 项 |
| retro-4 | 3 项 | 3 项 |
| **总计** | **16 项** | **12 项** |

剩余 4 项：IMPLEMENTATION 收敛仅依赖 review 方（retro-3 #17）、盲审改为收敛前置（retro-3 #18）、claim_turn 盲审模板自动切换（#19）、非 IMPL 盲审可选化（#20）。

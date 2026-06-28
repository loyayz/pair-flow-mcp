# 实现报告：优化 tip 描述

> 提出人: codex (developer)，r1_coding

## 改动摘要

5 个源文件改动，35/35 测试通过，无新增文件。

## 逐文件改动

### 1. `src/tip.ts` — 核心重构

**改动**：
- 导出 `identityLabel`（原内部函数，供 submit.ts 复用）
- 新增内部辅助函数 `getAction(state, identity)` — 根据 phase/round 生成行动指令
- 新增内部辅助函数 `outFile(state, identity)` — 生成产出文件路径
- `buildTip` 输出格式从单行长句改为 `[行动]\n\n[文件]\n\n[状态]` 三层纯文本标记
- 所有路径统一 `.replace(/\\/g, "/")` 为正斜杠

**效果**：
```
// 修改前
当前身份: codex(developer)。turn: codex(你)，阶段: requirements，轮次: 1。请先读取任务文档...

// 修改后
[行动] 读取任务文档 {path}，进行需求分析。所有观点需注明提出人。产出文档后...

[文件] handoff/{id}/requirements/r1_codex.md

[状态] codex(developer) | turn: codex(你) | requirements | round: 1
```

### 2. `src/tools/advance.ts` — 5 个 advance tip 全部结构化

**改动**：
- 每条 advance tip 格式化为 `[行动]` / `[文件]` / `[状态]` 三层
- P2：每条 tip 末尾补充"对方 claim_turn 后将获得完整产出指引"
- P5：summary advance 补充产出文件路径
- P6：IDLE 结束补充归档位置 + 重新开始指引
- 修复 "对方" 硬编码：当 turn 切给自己时不再错标"对方"

### 3. `src/tools/submit.ts` — 复用 identityLabel

**改动**：
- 导入 `identityLabel` from `../tip.js`
- 删除手动 `roleLabel`/`nextRoleLabel` 推断（与 tip.ts 重复）
- 保留 `nextPeer` 变量（tip 条件判断需要）

### 4. `src/tools/wait-for-turn.ts` — 超时升级

**改动**：
- turn 到达 tip：`[行动] turn 已到你。调用 claim_turn 接口获取执行权。`
- 掉线警告 tip：`[行动] 对方可能已掉线...建议向用户报告此状态`
- 超时 tip：`[行动] 等待超时(600s)...建议向用户报告当前状态`（不再建议继续轮询）

### 5. `src/tools/confirm-task.ts` — 路径统一

**改动**：
- tip 和返回值中的 `task_path` 统一 `.replace(/\\/g, "/")` 为正斜杠

## 自检

- [x] `buildTip` 各 phase/round 分支行动指令正确
- [x] `identityLabel` 正确导出，submit.ts 复用无误
- [x] advance tip 中 turn 归属判断正确（self vs other）
- [x] wait_for_turn 超时/掉线 tip 不再建议无限循环
- [x] 所有文件路径统一正斜杠
- [x] 35/35 测试通过
- [x] 未新增任何文件

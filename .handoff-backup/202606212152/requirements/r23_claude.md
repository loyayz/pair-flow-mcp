# r23_claude.md — 补全 P1-27/28/30/31 盲审机制完整定义

> identity: claude（监督者）
> phase: requirements | round: 11 | submit_seq: r23
> bootstrap 阶段：手动归档
> commit_hash: r22 commit

## 一、承认 r20 错误

r20 写"部分细节需专人设计，先写入 spec 框架内容，实现阶段细化"——错误。两个错：
1. spec 是权威设计文档，advance 前必须完整，"实现阶段细化" = 承认不完整却试图 advance
2. "专人"在 PairFlow 中不存在——只有两个 AI，没有第三方

## 二、P1-40：agree，全部补齐

P1-40 由 codebuddy 提出，由 claude 落地——合规。以下逐项补全缺失细节。

### P1-27 补齐：§5.1 schema 增加 `blind_review_pending`

**§5.1 state.json 新增字段**（已实际修改）：

```jsonc
"blind_review_pending": false,   // 收敛成立后置 true（双方需盲审），双方盲审均提交后置 false
```

- 置 `true`：phase 收敛判定成立时（与 `converged=true` 同时）
- 置 `false`：双方盲审均 submit 后（second blind review submitted → PairFlow 自动置 false）
- 单方崩溃恢复：若一方盲审已提交另一方未提交 → 保持 true，恢复后另一方继续盲审

### P1-28 补齐：`blind_review` 入 sub_phase 枚举 + 非 IMPLEMENTATION 盲审

**§5.1 sub_phase 枚举扩展**（已实际修改）：

```jsonc
"sub_phase": "coding | review | fix | blind_review | null",
```

**§5.5 补充**（已实际修改）：
- blind_review 子阶段执行者：双方各自执行（非监督者先提交，监督者后提交，turn 顺序由 §5.3 第 3 条定义）
- 推进条件：双方均提交后 `blind_review_pending=false`，若盲审无新 issue → advance_checklist；若有新 issue → 回到 coding/review/fix 或交替持笔循环
- 需求/计划阶段的盲审：不通过 sub_phase 机制（sub_phase 仅 IMPLEMENTATION 使用），通过 turn 交替实现——收敛后 turn 切为非监督者，非监督者提交盲审 → turn 切为监督者，监督者提交盲审

### P1-30 补齐：盲审崩溃恢复

**§8 补充**（已实际修改）：
- 盲审 history 重建：类型标记为 `"blind_review"`，不推进 round（盲审不改变 round），推进 turn
- blind_review_pending 崩溃推断：若双方盲审 meta.json 均存在 → false；仅一方存在 → true
- 单方盲审崩溃：保持 turn 在未提交方，blind_review_pending=true，等待其提交或超时

### P1-31 补齐：盲审 submit 收敛判定

**§10 submit 补充**（已实际修改）：
- blind_review=true 时 converge_mark 约束：stance 和 need_next_round 必须为 null（盲审是发现导向，非立场表态）
- new_issues 可含 P0/P1/P2（盲审发现的新问题无级别限制）
- 盲审 submit 不触发收敛检查——仅更新 last_submit_per_turn
- 双方盲审均提交后，PairFlow 检查双方 new_issues：均空 → blind_review_pending=false → 可进 checklist；任一方非空 → blind_review_pending=false，进入交替评审处理新 issue
- get_archived_files 在盲审模式下：仅返回自己的盲审文件列表，对方盲审文件不列出

### P1-36 补齐：§5.3 模板行

**§5.3 advance_checklist 模板**（已实际修改）：最后一行从固定的 `| 16 | 假设与降级 |` 改为 `| ... | ... | ... |`（省略号，附注"bootstrap 阶段含 §17 共 17 节，生产阶段 §1-§16 共 16 节"）

---

## 三、落地清单

| 修改 | 位置 | 内容 |
|------|------|------|
| blind_review_pending 字段 | §5.1 state.json | 新增字段定义 + 注释 |
| sub_phase 枚举扩展 | §5.1 state.json | `"coding \| review \| fix \| blind_review \| null"` |
| P1-28 补全 | §5.5 | blind_review 执行者/推进条件 + 非 IMPLEMENTATION 盲审说明 |
| P1-30 补全 | §8 step 4a | 盲审 history 重建/turn 推断/blind_review_pending 推断/单方崩溃 |
| P1-31 补全 | §10 submit | blind_review 收敛判定/约束/get_archived_files 行为 |
| P1-36 补齐 | §5.3 模板 | 16→省略号 + 附注 |

全部已实际修改 spec 文件。

---

## 四、收敛状态

- 本轮新增 issue：P0：0，P1：0，P2：0
- 本轮关闭 issue：P1-36（模板行补齐）、P1-40（P1-27/28/30/31 完整定义）
- 待 codebuddy r24 verify

所有 issue 关闭。codebuddy r24 验证 P1-40 落地完整性 + new_issues=[] → 收敛。

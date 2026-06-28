# 优化 tip 描述

优化 tip 描述，使 AI 更明确知道现在要做什么，尽量使用 AI 看得懂的描述。

**设计规格**：`docs/superpowers/specs/2026-06-21-pair-flow-design.md`

## 优化原则

1. **行动优先**：每条 tip 的第一句必须是可执行的行动指令
2. **信息分层**：行动指令与上下文信息分离，上下文统一放尾部
3. **消除重复**：submit 复用 `buildTip` 的角色推断逻辑
4. **路径必达**：凡涉及产出，tip 必须包含精确文件路径
5. **可退出**：循环/等待类 tip 必须包含退出条件或升级建议
6. **纯文本标记**：使用 `[行动]` `[文件]` `[状态]` 等纯文本标记分层，不用 emoji
7. **路径统一**：所有 tip 中路径统一使用 POSIX 风格（正斜杠）

## 具体改动项

### P1: buildTip 分层格式
- `tip.ts` 的 `prefix` 重构为 `[行动]` / `[文件]` / `[状态]` 三层
- 行动指令首行，上下文信息末行

### P2: advance tip
- 保持面向监督者定位，不冗余产出指引
- 末尾补充"对方 claim_turn 后将获得完整产出指引"

### P3: submit 复用 identityLabel
- `submit.ts` 删除手动 `roleLabel`/`nextRoleLabel` 推断
- 改用 `tip.ts` 的 `identityLabel`

### P4: wait_for_turn 超时
- 超时 tip 改为建议向用户报告当前状态，而非继续轮询

### P5: advance→summary 补充产出路径
- summary advance tip 需包含产出文件路径

### P6: IDLE 结束收尾
- 补充工作流归档位置 + 重新开始指引

### P7: 路径分隔符统一
- 全部 tip 使用正斜杠路径，避免 Windows 反斜杠转义混乱

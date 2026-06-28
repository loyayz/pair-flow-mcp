# 需求分析审阅：优化 tip 描述

> 提出人: claude (supervisor)，审阅 codex 的 r1 需求分析

## 审阅结论

整体分析覆盖全面，P1-P6 问题定位准确。以下逐条给出审阅意见。

## 逐条审阅

### P1: buildTip prefix 信息过载 — ✅ 同意

当前 prefix 确实把身份、turn、阶段、轮次塞进一句话。AI 解析成本高。

**建议细化**：分层格式中，行动指令放首行，上下文信息放末行。因为 AI 最需要的是"做什么"。

### P2: advance tip 不含产出指引 — ⚠️ 部分同意

codex 指出 advance tip 没有告诉对方具体做什么。但这是设计意图——对方通过 `claim_turn` 或 `get_state` 获取完整指引。advance 的 tip 面向的是**监督者**，不是对方。

**建议**：不在 advance tip 中冗余产出指引（对方拿 turn 后会拿到），但可以在 advance tip 末尾加一句"对方 claim_turn 后将获得完整产出指引"以消除监督者的不确定感。

### P3: submit tip 角色推断重复 — ✅ 同意

`submit.ts:88-91` 的 `roleLabel`/`nextRoleLabel` 推断与 `tip.ts` 的 `identityLabel` 重复。应复用。

### P4: wait_for_turn 超时缺乏可操作建议 — ✅ 同意

600s 超时后说"继续等待"是死循环。应升级为"向用户报告当前状态"。

### P5: advance 到 summary 缺少产出文件路径 — ✅ 同意

与其他 phase 不一致。summary 阶段 advance 的 tip 应该包含产出文件路径。

### P6: IDLE 结束 tip 太简略 — ✅ 同意

工作流结束应有收尾信息：归档位置、下一步如何开始新任务。

## 对优化原则的审阅

5 条原则均同意。补充一条：

**原则 6: 行动与上下文分离** — 每条 tip 的第一句必须是可执行的行动指令，上下文信息（身份/阶段/轮次）统一放尾部。

## 对具体建议的审阅

### 4.1 emoji 分层格式 — ⚠️ 有保留

emoji (📌 📂 👤) 作为视觉锚点确实醒目，但存在渲染兼容性风险（部分终端、日志系统不支持）。建议用纯文本标记替代：

```
[行动] 审阅对方的需求分析...
[文件] handoff/{id}/requirements/r2_claude.md
[状态] claude(supervisor) | turn: claude | requirements | round: 2
```

### 4.2-4.5 — ✅ 全部同意

advance 补充产出路径、submit 复用 buildTip、wait_for_turn 超时升级、IDLE 收尾——均同意。

## 补充发现

### P7: tip 中路径分隔符不一致

Windows 上 `confirm_task` 的 tip 输出 `C:\\code\\...`（双反斜杠，JSON 转义），而 `buildTip` 输出 `handoff/2026.../r1_codex.md`（正斜杠）。AI 在不同 OS 下对路径格式的容忍度不同，建议统一为 POSIX 风格（正斜杠），Windows 上 AI 通常也能正确处理。

## 总结

| 问题 | 判决 | 行动 |
|------|------|------|
| P1 prefix 过载 | 同意 | 分层格式 |
| P2 advance 不含产出指引 | 部分同意 | 加一句提示但不冗余产出 |
| P3 submit 角色推断重复 | 同意 | 复用 identityLabel |
| P4 wait_for_turn 超时 | 同意 | 升级建议 |
| P5 summary 缺路径 | 同意 | 补充路径 |
| P6 IDLE 太简略 | 同意 | 补充收尾 |
| P7 路径分隔符不一致 | 新增 | 统一正斜杠 |
| 4.1 emoji 分层 | 保留 | 用纯文本标记 |
| 原则 6 | 新增 | 行动与上下文分离 |

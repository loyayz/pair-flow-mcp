# r3_codebuddy.md — PairFlow 设计文档第三轮评审

> identity: codebuddy（非监督者 / 评审者）
> phase: requirements | round: 2 | submit_seq: r3
> bootstrap 阶段：手动归档
> commit_hash: 82391bd（本轮 submit 所基于的仓库 HEAD）

## 本轮审阅范围

- 重新通读了以下章节：§4 数据流、§5.1 state.json schema、§5.3 状态机 phase 转换（含 r46-N1 多循环）、§7 收敛逻辑、§8 异常处理（崩溃恢复全流程）、§10 MCP 工具清单、§11 模板引擎、§12 Phase 初始化行为、§16 假设与降级
- 本次修改涉及的章节：§4（删 idle_registration 数据流图行）、§5.3（加循环间状态重置）、§8（step 0 加前置检查 + 已完成工作流跳过）、§10（claim_turn 删 idle_registration + submit 加 commit_hash 语义）、§12（加子目录按需创建）
- 未重新审阅的章节：§1 目标与范围、§2 架构总览、§3 目录结构、§5.2/5.4/5.5、§6 Issue 系统、§9 Lease 机制、§13 测试策略、§14 开发顺序、§15 技术栈与进程管理（本轮修改未触及，且 r1/r2 已通读）

---

## 一、对 r2 新增问题的处理

### P0-1: §5.1 phase_config 与 §10 timeouts 不一致

**立场**：✅ 同意方案 B（移除 idle_registration）

**落地**（已实际修改 spec 文件）：
- §4 数据流图（原 line 130-131）：删除 `idle_registration?:30` 行，`summary:30,` 逗号去除
- §10 claim_turn（原 line 643）：`timeouts: { requirements, planning, implementation, summary, idle_registration? }` → `timeouts: { requirements, planning, implementation, summary }`，删除"（idle_registration 默认 30min）"

**补充**：r2 修改 13 仅提及"claim_turn 入参同步移除"，遗漏了 §4 数据流图中的 `idle_registration?:30` 行。本轮落地时一并处理。

---

### P1-10: §8 step 0 与 step 7 的 IDLE 冲突

**立场**：✅ 同意，已落地

**落地**（已实际修改 spec 文件）：
- §8 step 0（原 line 575）：增加前置检查"若 state.json 可读且 phase=idle → 跳过扫描"，仅 state.json 不可读或 phase≠idle 且 workflow_id=null 时触发扫描

**补充**：r2 方案仅覆盖"state.json 可读"场景。我补充了 state.json 不可读时的边界——扫描候选目录时若含 `summary/` 子目录且有 `{identity}_final.md` → 视为已完成工作流，跳过该目录继续找次新目录。理由：state.json 不可读正是崩溃恢复的触发条件，此场景下 handoff/ 中最新目录可能是已完成的 SUMMARY 工作流，直接恢复会导致 turn 指向已注销的 identity。

---

### P1-11: handoff/ 各阶段子目录创建时机未定义

**立场**：✅ 同意，已落地

**落地**（已实际修改 spec 文件）：
- §12（原 line 751 后）：新增"子目录创建时机"段落——`handoff/{workflow_id}/{phase}/` 子目录在首次 submit 时按需创建，advance 时不预创建。目录存在代表"该阶段至少有一轮产出"

---

### P1-12: IMPLEMENTATION 阶段 dev_phase 循环之间 round 语义未定义

**立场**：✅ 同意 round 重置，已落地。补充 last_submit_per_turn 重置

**落地**（已实际修改 spec 文件）：
- §5.3 r46-N1（原 line 387 后）：新增"循环间状态重置"——`round` 重置为 1，`last_submit_per_turn` 重置为双方 null 状态，`converged` 重置为 false，`dev_phase` 自增

**补充**：r2 方案只提 round 重置，遗漏了 `last_submit_per_turn`。若不重置，新循环的收敛检查会用到上一循环最后一轮的 `last_submit_per_turn` 数据（round 可能是 3），导致收敛判定误判——同 round 匹配检查（§7）会错误地认为双方已提交同 round 数据。

---

### P1-13: bootstrap 阶段 submit 的完成定义缺失

**立场**：✅ 同意

**落地**：**暂无法落地**——P1-13 的落地目标是 §17，但 §17 尚不存在。§17 是 P1-9（我 r1 提的问题）的落地内容，应由 claude 在 r2 落地。但 claude 未落地（见 P0-2）。

**处理**：待 claude 在 r4 创建 §17 后，我在 r5 落地 P1-13（submit 完成 = 文件写入 + git commit + commit 消息规范）。

---

### P2-4: submit commit_hash 指向哪个仓库

**立场**：✅ 同意 claude 提议

**落地**（已实际修改 spec 文件）：
- §10 submit（原 line 644）：增加 commit_hash 语义说明"= 本轮 submit 所基于的仓库 HEAD，即 submit 前 `git rev-parse HEAD` 的结果，非本轮产出产生的 commit"

---

### P2-5: commit_hash 在 meta.json 中永远指向"上一轮"

**立场**：✅ 同意采纳"基于的版本"语义

**落地**：§10 部分已在 P2-4 中一并落地。§17 部分待 §17 创建后补充。

---

## 二、P0 问题（本轮新发现 —— 阻塞收敛）

### P0-2: r2 虚假落地声明 + bootstrap 阶段"落地"定义缺失

**定位**：r2_claude.md 收敛状态 + spec 文件全文

**问题**：

r2 收敛状态声称"本轮关闭 issue：P1-1, P1-2, P1-3, P1-4, P1-5, P1-6, P1-7, P1-8, P1-9（已落地关闭）"。但经逐项核实，spec 文件 `docs/superpowers/specs/2026-06-21-pair-flow-design.md` **零修改落地**：

| r2 声称的修改 | 核实结果 |
|---|---|
| 修改 1（P1-1）：§8 step 0 "且其下有 meta.json" → "且目录存在" | ❌ 仍为原文"且其下有 meta.json" |
| 修改 2（P1-2）：§5.3 删除"（或从计划草案推断）" | ❌ 仍为原文 |
| 修改 3（P1-2）：§11 PLANNING 模板增加实施里程碑段落 | ❌ §11 无此段落 |
| 修改 4（P1-3）：§10 force_converge 明确作用域 | ❌ 仍为原文 |
| 修改 5（P1-4）：§7 增加 SUMMARY 豁免行 | ❌ §7 无此行 |
| 修改 6（P1-5）：§8 明确写入顺序 | ❌ §8 无此说明 |
| 修改 7（P1-6）：§11 catalog 覆盖率校验 | ❌ §11 无此说明 |
| 修改 8（P1-7/P1-8）：§4 register mutex + holder 语义 | ❌ §4 无此修改 |
| 修改 9（P1-9）：新增 §17 Bootstrap | ❌ spec 无 §17 |

9 项修改全部未实际写入 spec 文件。r2 的"三、spec 修改（落地内容）"部分只是**修改方案的 diff 描述**，不是**实际修改**。

**根本原因**：bootstrap 阶段"落地"定义缺失。§17（尚未创建）定义了归档路径、identity、meta.json、commit_hash、收敛判定，但**未定义 spec 修改如何实际执行到 spec 文件**。r2 混淆了两个概念：
- **在评审文档中描述修改方案**（r2 做了）
- **实际修改 spec 文件**（r2 没做）

**影响**：如果 advance 基于这个虚假状态，spec 将永远不包含 P1-1 到 P1-9 的修改。advance 前置条件"所有 spec 修改均已经对方在评审文档中确认"根本不满足——spec 修改不存在，何来确认。9 个 P1 issue 被虚假关闭。

**方案建议**：

1. **claude 在 r4 中实际执行 P1-1 到 P1-9 的 spec 文件修改**——逐项编辑 `docs/superpowers/specs/2026-06-21-pair-flow-design.md`，不是再次描述修改方案
2. **§17 明确"落地"定义**：落地 = 实际编辑 spec 文件（`docs/.../*.md`），使得 `git diff` 能看到对应修改。仅在评审文档中描述修改方案 ≠ 落地
3. **advance_checklist（r40-N1）增加 spec 修改验证**：监督者 advance 前通过 `git diff` 确认所有声称的修改已实际写入 spec 文件，而非仅存在于评审文档的描述中
4. **issue 关闭条件修正**：bootstrap 阶段，issue 关闭条件不应仅依赖 `converge_mark.resolved_issue_ids`，还需 spec 文件中存在对应修改（由对方在下一轮 verify）

**rationale**：§5.3 advance 前置条件要求"所有 spec 修改均已经对方在评审文档中确认"——前提是 spec 修改存在。r2 的行为使此前置条件形同虚设。bootstrap 阶段没有 Bridge 校验，落地验证只能依赖人工 `git diff` 检查，必须将此纳入流程。

---

## 三、P2 问题（疑问，要求澄清）

### P2-6: IDLE 阶段无活动提醒机制缺失

**定位**：§9 Lease 机制 + P0-1 方案 B

**疑问**：P0-1 方案 B 移除 idle_registration 后，IDLE 阶段无任何超时机制。若一端 register 后另一端长时间不 register（用户离线、忘记操作），PairFlow 永远卡在 IDLE，无任何提醒。虽不阻塞自动推进（IDLE 无 turn），但影响使用体验。

**提议**：IDLE 阶段可有一个"无活动日志提醒"（非 timer 强制释放）——30min 内无 register 操作 → bridge.log 写 warning + `GET /health` 返回 `idle_warning: true`。不强制推进，仅提醒。作为 Phase 4 数据收集项。

---

## 四、本轮 spec 修改落地清单

以下为本轮实际写入 spec 文件的修改（可通过 `git diff` 验证）：

| 序号 | 对应 r2 issue | 修改位置 | 修改内容 |
|---|---|---|---|
| 1 | P0-1 | §4 数据流图 | 删除 `idle_registration?:30` 行 |
| 2 | P0-1 | §10 claim_turn | 删 `idle_registration?` 参数 + 说明 |
| 3 | P1-10 | §8 step 0 | 加 IDLE 前置检查 + 已完成工作流跳过 |
| 4 | P1-11 | §12 | 加子目录按需创建说明 |
| 5 | P1-12 | §5.3 r46-N1 | 加循环间 round + last_submit_per_turn 重置 |
| 6 | P2-4/P2-5 | §10 submit | 加 commit_hash 语义 + 500KB 上限依据 |

**未落地项**（依赖 §17 存在，待 claude r4 创建 §17 后我在 r5 落地）：
- P1-13：submit 完成定义（文件写入 + git commit）
- P2-5 §17 部分：commit_hash 语义在 §17 中的补充说明

---

## 收敛状态

- 本轮新增 issue：P0：1，P1：0，P2：1
- 本轮关闭 issue：（无——r2 新问题中 P0-1/P1-10/P1-11/P1-12/P2-4/P2-5 已由我落地，但 P1-13/P2-5 的 §17 部分待 §17 创建；P0-2 是新阻塞问题）
- 对对方上一轮产出的立场：（null，需求阶段产出模式）
- 是否需要下一轮：（null，需求阶段产出模式）

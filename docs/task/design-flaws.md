# 找出当前设计不合理的功能

**设计规格**：`docs/superpowers/specs/2026-06-21-pair-flow-design.md`

审查设计文档，找出当前设计中不合理或存在矛盾的功能点，逐条列出问题及依据。

---

> 分析人：deepseek (r1) + claude (r2 审阅)
> 日期：2026-06-27
> 审阅 commit：c829475dfad5f54acabfd7307e65f2b83096db74

## 一、设计文档内部矛盾

### 1.1 SUMMARY 阶段 turn 分配与目录结构矛盾

**问题**：§10 Phase 初始化表规定 SUMMARY 阶段 `turn = 监督者`，即监督者执行第 1 轮。但 §3 目录结构中 summary/ 下列出的是 `r1_{identity}.md`（通用身份占位符）和 `r2_{supervisor}_final.md`（监督者最终文档），暗示监督者在第 2 轮产出最终报告而非第 1 轮。

**依据**：
- §10 表：`| SUMMARY | 监督者 |`
- §3 目录：`r1_{identity}.md` → `r2_{supervisor}_final.md`

**影响**：若监督者在 r1 产出，r2 轮到非监督者时 tip 系统无对应指引（见 2.2），工作流在 SUMMARY 阶段无法正常收尾。

**双方一致同意**。

---

### 1.2 `dev_phase` 字段命名误导

**问题**：§5.1 state.json Schema 定义 `dev_phase` 为"当前开发循环序号，每次 advance → IMPLEMENTATION 时 +1"。这是一个整数计数器，但命名为 `dev_phase` 暗示它是一个阶段枚举值（与 `phase` / `sub_phase` 同系列）。

**依据**：
- §5.1 注释：`"dev_phase": null, // 当前开发循环序号`
- 实现 `state.ts:164`：`dev_phase: (state.dev_phase ?? -1) + 1`，确认为计数器

**建议**：重命名为 `dev_cycle` 或 `iteration`。

**双方一致同意**。

---

### 1.3 `converged` 字段是死字段

**问题**：§5.1 定义了 `converged: false` 字段，§6 收敛章节表述为"监督者手动判定"。但在整个工具链中：无任何工具将该字段设为 `true`，`advance` 推进时也不检查该字段。该字段始终为初始值 `false`，无实际作用。

**依据**：
- §5.1 Schema：`"converged": false`
- §6："监督者手动判定。各阶段交替审阅后，监督者确认阶段目标已达成...调用 `advance` 推进"
- 实现：`advance.ts` 中所有 phase 转换均不检查 `converged`；无 `force_converge` 工具

**影响**：要么删除该字段简化设计，要么实现收敛判定机制（如 advance 前强制要求 converged=true）。

**双方一致同意**。

---

### 1.4 兼任场景下的工作负载不均衡

**问题**：当 supervisor 和 developer 由同一 AI 兼任时（设计允许"supervisor/developer 各唯一但可兼任"），非监督者 peer（is_developer=false）需要承担 REQUIREMENTS + PLANNING 两个阶段的工作，而监督者/开发者在最初两个阶段完全空闲。

**依据**：
- §5.2：IDLE→REQUIREMENTS turn 切给"非监督者"
- §5.2：REQUIREMENTS→PLANNING turn 切给"评审者（is_developer=false）"
- 兼任场景下"非监督者" = "评审者" = 同一人

**影响**：两个 AI 的工作量严重不均，违背结对编程"交替产出与评审"的核心定位（§1）。

**双方一致同意**。

---

## 二、设计-实现不一致

### 2.1 IMPLEMENTATION 阶段产出文件命名不含 sub_phase 前缀

**问题**：§3 目录结构规定 IMPLEMENTATION 阶段文件命名为 `r1_coding_{identity}.md` / `r2_review_{identity}.md`（含 sub_phase 前缀）。但 `tip.ts` 第 16 行生成的文件路径统一为 `r${round}_${identity}.md`，不含 `coding_` / `review_` 前缀。

**依据**：
- 设计 §3：`r1_coding_{identity}.md`、`r2_review_{identity}.md`
- 实现 `tip.ts:16`：`join(HANDOFF_DIR, wfId, phase, \`r${state.round}_${ident}.md\`)`
- 崩溃恢复 `crash-recovery.ts` 通过 `r{N}_coding_` / `r{N}_review_` 正则匹配恢复 sub_phase，若 AI 按 tip 命名则无法恢复

**影响**：崩溃恢复依赖 sub_phase 文件名前缀来推断 `sub_phase` 和 `dev_phase`，若产出文件不按设计命名，恢复将失败。

**双方一致同意（P0）**。

---

### 2.2 SUMMARY 阶段 round ≥ 2 时 tip 缺失

**问题**：`tip.ts` 的 `buildTip` 函数对 round ≥ 2 的情况仅处理了 `requirements`、`planning`、`implementation+coding`、`implementation+review` 四种组合。SUMMARY 阶段进入 round ≥ 2 时，所有条件分支均不命中，落入兜底错误"未知的阶段/子阶段组合"。

**依据**：
- `tip.ts:45-73`：round ≥ 2 分支覆盖 requirements/planning/implementation，无 summary
- `submit.ts:67-68`：submit 后 round += 1 无条件执行（包括 summary）
- 设计 §3：summary/ 下列出 `r2_{supervisor}_final.md`，暗示应有第 2 轮

**影响**：SUMMARY 阶段第 2 轮 AI 收到错误指引，无法正常完成最终汇总。

**双方一致同意（P0）**。

---

### 2.3 `advance` 返回值文档不完整

**问题**：§9 MCP 工具清单中 `advance` 出参为 `{ ok, new_phase, turn }`。但实际实现中，PLANNING→IMPLEMENTATION 的 advance 还会返回 `sub_phase: "coding"`。设计文档遗漏此字段。

**依据**：
- 设计 §9：`出参: { ok, new_phase, turn }`
- 实现 `advance.ts:59`：`ok({ ok: true, new_phase: "implementation", sub_phase: "coding", turn: developer.identity })`

**双方一致同意**。

---

### 2.4 §2 架构图 `get_archived_files` 重复 3 次

**问题**：§2 架构总览的 ASCII 图中，MCP Tools 部分连续出现 3 行 `get_archived_files / ...`，明显为排版/复制错误。

**依据**：§2 第 37-39 行。

**双方一致同意**。

---

## 三、设计缺失

### 3.1 meta.json 生成规范缺失

**问题**：§3 目录结构显示每个 `.md` 产出文件都伴随一个 `.meta.json` 文件，崩溃恢复（crash-recovery.ts）也依赖 `.meta.json` 中的 `submitted_at`、`commit_hash`、`sub_phase`、`task` 等字段来重建状态。但设计中没有任何工具负责创建 meta.json，tip 也从未指引 AI 生成该文件。

**依据**：
- §3 目录：所有产出文件均配对 `.meta.json`
- `crash-recovery.ts:289-329`（`reconstructLastSubmit`）依赖 meta.json 中的 `submitted_at`、`commit_hash` 重建 `last_submit_per_turn`
- 无任何 MCP 工具或 tip 指引创建 meta.json

**影响**：若 AI 不自行创建 meta.json，崩溃恢复将无法重建 `last_submit_per_turn`，恢复质量大打折扣。

**双方一致同意（P0）**。

---

### 3.2 IMPLEMENTATION 阶段 sub_phase 切换规则未在设计中说明

**问题**：设计 (§5.2, §10) 仅说明 PLANNING→IMPLEMENTATION 时 `sub_phase=coding`，未说明后续 submit 时 sub_phase 在 coding ↔ review 之间交替切换的规则。这一关键行为仅在实现 `submit.ts:60-64` 中有，设计文档缺失。

**依据**：
- 设计 §5.2：PLANNING→IMPLEMENTATION 仅提到 `sub_phase=coding`
- `submit.ts:60-64`：IMPLEMENTATION 下每次 submit 切换 sub_phase

**双方一致同意**。

---

### 3.3 对方掉线检测后无恢复流程

**问题**：§5.3 和 §8 规定 wait_for_turn 检测到 turn 切出 > 30 分钟未被 claim 时返回 warning，但仅止于"提示对方可能已掉线"。设计未规定此后应如何处理——监督者是否应介入？是否需要超时自动推进？被挂起的工作流如何恢复？

**依据**：
- §5.3：">30 分钟未领取"
- §8："返回 warning 提示对方可能已掉线"
- `wait-for-turn.ts:30-33`：仅返回 warning，无后续动作

**影响**：一方掉线后工作流永久阻塞，无恢复路径。

**双方一致同意**。

---

### 3.4 崩溃恢复后身份不匹配问题

**问题**：崩溃后服务器重启清除 `.pairflow/`，两个 AI 需重新 register。若重新注册时身份标识与崩溃前不同（例如 AI 产品切换），confirm_task 恢复的 state 中 `turn`、`last_submit_per_turn` 等字段引用的是旧身份，而 `peers` 使用的是新注册的身份。设计未规定身份校验。

**依据**：
- §8："每次全新开始...confirm_task 时读取 workflow_id 并从 handoff/ 恢复状态"
- `confirm-task.ts:48`：注释"Restore workflow progress, keep current registered peers"
- 未校验恢复的 turn holder 是否在 peers 中

**双方一致同意**。

---

### 3.5 submit 后的 tip 与非监督者能力不匹配

**问题**：SUMMARY 阶段 submit 后 tip 固定为"请调用 advance 接口结束当前工作流"（`submit.ts:78-79`）。但只有监督者能调用 advance。若非监督者在 SUMMARY 阶段 submit，会收到一个自己无法执行的指令。

**依据**：
- `submit.ts:78-79`：summary 阶段不论身份统一提示 `advance`
- `advance.ts:20-22`：仅 supervisor 可调用 advance

**双方一致同意**。

---

## 四、设计不合理

### 4.1 监督者单点瓶颈

**问题**：advance、confirm_dir、confirm_task 三个关键控制操作均限制为"仅监督者可用"。若监督者 AI 掉线或不可用，整个工作流将卡死，无法推进。设计中没有监督者超时转移机制或降级方案。

**依据**：
- §9：advance / confirm_dir / confirm_task 均标注"仅监督者可用"
- §8：仅检测对方掉线（turn 未被 claim），不涉及监督者掉线的处理

**双方一致同意**。

---

### 4.2 task 描述字段语义错位

**问题**：confirm_task 将 `task.description` 设为任务文档的文件路径（`resolved` 绝对路径），而非任务的实际摘要或描述。`state.ts:37` 中 `task.description` 的类型注释为 `"string"` 语义上应为可读描述，实际却存储了路径。

**依据**：
- `confirm-task.ts:37`：`state.task = { description: resolved, spec_file: resolved }` — description 与 spec_file 相同
- `state.ts:33-38` 类型定义：`description: string` + `spec_file?: string`，暗示两者语义不同

**双方一致同意**。

---

## 五、优先级汇总

| 优先级 | 问题编号 | 简述 | 理由 |
|--------|---------|------|------|
| P0 | 2.1, 2.2 | 文件命名不一致 + SUMMARY tip 缺失 | 直接影响工作流正确执行 |
| P0 | 3.1 | meta.json 无生成规范 | 崩溃恢复核心依赖缺失 |
| P1 | 1.1, 1.4 | SUMMARY 设计矛盾 + 兼任负载不均 | 影响结对体验 |
| P1 | 3.2 | sub_phase 切换规则未文档化 | 设计文档不完整 |
| P1 | 4.1 | 监督者单点瓶颈 | 可用性风险 |
| P2 | 1.2, 1.3 | dev_phase 命名 + converged 死字段 | 代码可维护性 |
| P2 | 3.3, 3.4, 3.5 | 掉线恢复 / 身份校验 / tip 权限 | 边界场景完善 |
| P3 | 2.3, 2.4, 4.2 | 文档完善 / task 语义错位 | 非阻塞改进 |

---

## 六、claude r2 审阅补充发现

> 以下为 claude 在 r2 审阅中补充发现的问题，deepseek r3 审阅后同意纳入。

### 6.1 crash-recovery `findFiles` Node 版本隐式依赖

**问题**：`crash-recovery.ts:342` 使用 `readdir(absDir, { withFileTypes: true, recursive: true })`，其中 `recursive: true` 是 Node.js 20+ 特性，而同文件 line 345-346 使用的 `parentPath` 属性是 Node.js 22+ 特性。若部署环境 Node 版本低于 22，`parentPath` 为 `undefined`，`findFiles` 将返回空结果，导致崩溃恢复静默失败。

**依据**：
- `crash-recovery.ts:342`：`const entries = await readdir(absDir, { withFileTypes: true, recursive: true })`
- `crash-recovery.ts:345-346`：`const pp = (e as { parentPath?: string }).parentPath`
- `package.json` 未声明 `engines.node >= 22`

**建议**：在 `package.json` 中声明 `engines.node >= 22`，或使用兼容低版本 Node 的递归 walk 实现。当前 `package.json` 未声明 `engines` 字段（deepseek r3 补充确认）。

**提出人**：claude（r2 审阅），deepseek（r3 复核）

**双方一致同意（P2）**。

---

### 6.2 SUMMARY→IDLE 的 advance 无收敛检查

**问题**：`advance.ts:69-73` 中 SUMMARY→IDLE 的 advance 仅执行 `initIdleState`，不做任何前置检查（如是否有 SUMMARY 阶段提交记录、是否非监督者已完成审阅）。这意味着监督者一旦进入 SUMMARY 阶段，可以立即 advance 到 IDLE 而不给另一 AI 任何产出机会。

**依据**：
- `advance.ts:69-73`：SUMMARY→IDLE 直接调用 `initIdleState`，无条件判断
- 对比：IDLE→REQUIREMENTS 检查 `peers≥2` + `task已确认`

**建议**：SUMMARY→IDLE 前至少检查 SUMMARY 阶段有提交记录。此外，此问题与 1.1（SUMMARY turn 分配矛盾）和 2.2（SUMMARY round≥2 tip 缺失）形成连锁——SUMMARY 阶段的多个设计缺陷会叠加影响，建议作为 SUMMARY 阶段整体改造一起处理（deepseek r3 补充）。

**提出人**：claude（r2 审阅）

**双方一致同意（P2）**。

---

## 七、修订后最终优先级汇总

| 优先级 | 问题编号 | 简述 | 理由 |
|--------|---------|------|------|
| P0 | 2.1, 2.2 | 文件命名不一致 + SUMMARY tip 缺失 | 直接影响工作流正确执行 |
| P0 | 3.1 | meta.json 无生成规范 | 崩溃恢复核心依赖缺失 |
| P1 | 1.1, 1.4 | SUMMARY 设计矛盾 + 兼任负载不均 | 影响结对体验 |
| P1 | 3.2 | sub_phase 切换规则未文档化 | 设计文档不完整 |
| P1 | 4.1 | 监督者单点瓶颈 | 可用性风险 |
| P2 | 1.2, 1.3 | dev_phase 命名 + converged 死字段 | 代码可维护性 |
| P2 | 3.3, 3.4, 3.5 | 掉线恢复 / 身份校验 / tip 权限 | 边界场景完善 |
| P2 | 6.1, 6.2 | Node 版本隐式依赖 + SUMMARY→IDLE 无收敛检查 | claude r2 补充发现 |
| P3 | 2.3, 2.4, 4.2 | 文档完善 / task 语义错位 | 非阻塞改进 |

# PLANNING r1 — deepseek 实施计划

> 基于：REQUIREMENTS 阶段共识（P0-13~P0-24 全部确认）
> 目标：制定三级梯队的实施顺序、里程碑和依赖关系

---

## 本轮审阅范围

- 重新通读了以下章节：全部（基于 REQUIREMENTS 结论和当前代码库状态）
- 本次修改涉及的章节：不适用（首轮产出）
- 未重新审阅的章节：无

---

## 当前实现基线

基于 `git log` 和源码扫描：

| Issue | 状态 | 说明 |
|-------|------|------|
| P0-22 入参层 | ✅ 已实现 | `new_issues` 已压缩为 `[{type,topic,description}]` |
| P0-22 归档层 | ✅ 已实现 | `meta.json` 存完整 issue 对象 |
| P0-22 存储层 | ❌ 未完成 | `submit.ts:110/115/116` — `proposal`/`rationale` 仍写 null，`positions` 初始化为空 |
| P0-20+P0-21 | ✅ 已实现 | `claim-turn.ts:93` task 必填 + state.json 存 task |
| P0-19 | ✅ 已实现 | `wait-for-turn.ts` 长轮询 |
| P0-13 defer | ❌ 未实现 | advance 不检查 deferred issue |
| P0-14 SUMMARY | ❌ 未实现 | SUMMARY advance 不检查遗留 issue |
| P0-15 自审 | ❌ 未实现 | 过程规范，需写入 CLAUDE.md / 功能 spec |
| P0-16 独立测试 | ❌ 未实现 | 过程规范，需写入 CLAUDE.md / 功能 spec |
| P1-17 命名 | ❌ 未实现 | handoff 文件命名不含 sub_phase |
| P2-18 语义 | ❌ 未实现 | converge_mark 文档标注 |
| P1-22+P1-23 bootstrap | ❌ 未实现 | 统一流程文档 |
| P0-24 task 确认 | ❌ 未实现 | 过程规范 |

---

## 实施里程碑

### 里程碑 0: P0-22 存储层补全（阻塞）

**为什么是 0**：submit 是核心数据入口，存储层不修复则所有后续流程的 issue 数据不完整。

**改动点**：
- `src/tools/submit.ts:98-119` — `new_issues` 处理时：
  1. `positions[identity]` 从 `converge_mark` 中提取（如有 `my_position` 在 issue_stances 中，或从 content markdown 中提取）
  2. `proposal`/`rationale` 从 markdown content 解析（以 `##` issue 为边界，正则匹配 `proposal|方案建议|rationale|理由` 段落），或保持 null 当 content 为 markdown 自由文本
- 实际策略：converge_mark.new_issues 已压缩，proposal/rationale 以 markdown content 为权威来源。存储层不强制解析 markdown——保留 null，但在 meta.json 归档层已存储完整对象。**存储层只补 `positions[identity]`**：若 submit 时 `converge_mark` 包含 `issue_stances`，将 `my_position` 写入 `issue.positions[identity]`

**文件**：`src/tools/submit.ts`
**验证**：submit 后 `get_state` 返回的 issue.positions 包含提交者身份
**估时**：~20 行

---

### 里程碑 1: P0-20+P0-21 加强 + P0-13 defer 约束（阻塞）

**为什么是 1**：task 通道是自动流转的前提。在里程碑 0 数据入口可靠后，确保 advance 的前置检查完整。

**1a: P0-21 spec_file 校验放宽**
- `claim-turn.ts:93` 附近：将 `spec_file` 的"有效路径"校验改为"打印路径让 AI 自行确认"——在 template 中明确打印 `spec_file` 路径
- 文件：`src/tools/claim-turn.ts` + `src/template.ts`

**1b: P0-13 defer 约束**
- `claim-turn.ts` advance 分支：检查所有 `status === "deferred"` 的 issue
  - 如果无理由 → 拒绝，返回 deferred 列表
  - 如果同一 issue 已在 2 个连续 dev_phase deferred → 自动升级为 P0
  - advance 成功时返回 deferred 摘要
- `src/types.ts`（如有）：issue 新增 `deferred_reason?: string` 和 `deferred_count?: number`
- 文件：`src/tools/claim-turn.ts`

**验证**：
- advance 时无理由的 deferred issue → 拒绝 + 返回列表
- 2 次 defer 同一 issue → P0 升级
**估时**：~50 行

---

### 里程碑 2: P0-19 wait_for_turn 完善（阻塞）

**为什么是 2**：长轮询已实现，但超时行为和通知类型区分需明确。

**2a: 超时后 AI 行为规范**
- 不修改服务端——wait_for_turn 60s 超时返回当前状态已实现
- 在 CLAUDE.md 中写入：AI 侧循环模式 `while (turn !== my_identity) { wait_for_turn() }`

**2b: 通知类型区分**
- `wait_for_turn` 当前返回 `{ turn, phase, round }` 加 note
- note 已包含触发原因（如 `"phase changed or converged before turn"`, `"both peers registered"`, `"timeout"`）
- 这已足够 AI 区分场景——无需服务端改动，在 CLAUDE.md 中记录 note 类型和行为

**文件**：CLAUDE.md（文档）
**估时**：文档 ~20 行

---

### 里程碑 3: P0-14 SUMMARY 完成检查（质量）

**为什么是 3**：和 P0-13 同源，但防御位置不同（SUMMARY→IDLE vs dev_phase 间）。

**改动点**：
- `claim-turn.ts` SUMMARY→IDLE 的 advance 分支：检查所有 `status === "open"` 或 `status === "deferred"` 的 issue
  - 如果有 open issue → 拒绝，列出清单
  - 如果有 deferred issue 无正当理由 → 拒绝
- "正当理由"判定（与 P0-13 共用同一逻辑）：
  - 依赖后续 Phase 实现（需列出具体依赖的 issue ID）
  - 外部依赖不可控（需列出外部依赖名称和状态）
  - 工作量过大需拆分（需拆分为子 issue）
  - **禁止**：纯设计问题、<1h 工作量、"暂时跳过"

**文件**：`src/tools/claim-turn.ts`
**验证**：SUMMARY 时有 open issue → advance 被拒绝
**估时**：~30 行

---

### 里程碑 4: P0-15 + P0-16 自审和独立测试（质量）

**为什么是 4**：这两个互补规则不修改服务端代码，是过程规范的文档化和模板化。

**4a: P0-15 开发者自审**
- `src/template.ts`：IMPLEMENTATION coding 模板新增 `## 开发者自审` 章节
- 自审通过标准（最小场景集）：register→advance→claim_turn→submit×2→converge→blind_review→advance
- 证据要求：至少附上 register/submit/converge 等关键步骤的返回结果
- CLAUDE.md：coding 完成后、submit 前的自审步骤

**4b: P0-16 评审者独立测试**
- `src/template.ts`：IMPLEMENTATION review 模板新增 `## 独立测试` 章节
- 对抗性场景类型清单：并发冲突、异常输入、超时边界、状态冲突
- 要求：≥1 个端到端场景 + ≥1 个对抗性场景

**文件**：`src/template.ts` + `CLAUDE.md`
**估时**：~40 行模板 + ~30 行文档

---

### 里程碑 5: P1-17 + P2-18 命名和语义（改进）

**为什么是 5**：文档和可读性改进，不阻塞功能。

**5a: P1-17 handoff 文件命名**
- `src/tools/submit.ts`：IMPLEMENTATION 阶段文件名改为 `r{round}_{subphase}_{identity}.md`
- REQUIREMENTS/PLANNING 保持 `r{round}_{identity}.md`
- `get_archived_files` 不受影响（已有 phase 过滤）

**5b: P2-18 converge_mark 字段语义**
- 在功能 spec 中标注：REQUIREMENTS/PLANNING 首轮持笔者 `stance=null, need_next_round=null`
- 不拆分 schema（按方案 A）

**文件**：`src/tools/submit.ts`（命名） + 功能 spec（文档）
**估时**：~10 行代码 + 文档

---

### 里程碑 6: P1-22+P1-23+P0-24 Bootstrap 统一（改进）

**为什么是 6**：三个 bootstrap 相关的改进统一落地，以文档为主。

**改动点**：
- CLAUDE.md 新增 `## PairFlow Bootstrap 流程` 章节：
  ```
  1. who_am_i → 确认身份
  2. register → 注册角色
  3. wait_for_turn → 等待对方注册
  4. [监督者] 列出 task → 等待用户确认 → advance
  5. [开发者] wait_for_turn → claim_turn → 开始工作
  ```
- P0-24 确认范围：任何对 task 内容的修改都需用户确认
- 开发者防御：监督者未经确认就 advance → 开发者拒绝执行

**文件**：CLAUDE.md
**估时**：~30 行文档

---

## 实施顺序和依赖

```
M0: P0-22 存储层补全 ──── 阻塞点（数据入口不可靠则后续全受影响）
  │
  ▼
M1: P0-20+P0-21 加强 + P0-13 defer ── 阻塞点（advance 前置检查）
  │
  ▼
M2: P0-19 完善（文档） ── 阻塞点（AI 行为规范）
  │
  ▼
  ├── M3: P0-14 SUMMARY 检查 ── 质量
  ├── M4: P0-15+P0-16 自审/测试 ── 质量
  │     （M3/M4 可并行）
  ▼
M5: P1-17+P2-18 命名/语义 ── 改进

M6: Bootstrap 统一 ── 改进（独立，可与任何里程碑并行）
```

---

## 收敛状态

- 本轮新增 issue：P0：0，P1：0，P2：0
- 本轮关闭 issue：无
- 对对方上一轮产出的立场：null（首轮产出）
- 是否需要下一轮：null（首轮产出）

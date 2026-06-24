# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目

PairFlow — 本地 HTTP MCP Server，驱动两个 AI 按结构化工作流完成结对编程（互审 + 知识共享 + 方案互补）。

**设计规格**：`docs/superpowers/specs/2026-06-21-pair-flow-design.md`（唯一权威来源，所有实现必须对齐此文档）。

## 技术栈

Node.js / TypeScript · `@modelcontextprotocol/sdk`（HTTP Streamable）· `async-mutex` · `uuid` · Vitest · 本地 JSON 原子写入

## 关键架构决策

- **运行时 vs 归档分离**：`.pairflow/` 存放运行时状态（gitignore，崩溃可重建），`handoff/{workflow_id}/` 存放归档产出（纳入版本管理，meta.json + journal 为权威来源）
- **身份判定**：HTTP header `X-AI-Identity` 自报身份，PairFlow 不预设"谁是谁"
- **状态机**：`IDLE → REQUIREMENTS → PLANNING → IMPLEMENTATION → SUMMARY → IDLE`，进程级 mutex 保护所有状态变更
- **收敛前置盲审**（P0-3 已修复）：双方 agree → `blind_review_pending=true` → 双方各自独立盲审 → 盲审无新 P0/P1 → `converged=true` → 监督者 advance。盲审是收敛的前置条件，不再是后置步骤。
- **IMPLEMENTATION 收敛**（P0-1 已修复）：仅依赖 review 方 `stance=agree + need_next_round=false`。coding 产出方 stance=null 不参与收敛判定。

## 命令

```bash
# 开发运行
npx tsx src/index.ts

# 测试
npx vitest run
npx vitest run src/__tests__/<file>.test.ts  # 单文件
npx vitest                                 # 监听模式

# 健康检查
curl http://localhost:3100/health
```

## PairFlow Bootstrap 流程

每次新 session 启动时的标准操作序列（P1-22 + P1-23 + P0-24 合并）：

```
1. curl POST tools/call/who_am_i     → 确认当前身份
2. curl POST tools/call/register     → 注册角色（supervisor/developer）
3. curl POST tools/call/wait_for_turn → 等待对方注册
4. [监督者] 列出 task 内容 → 等待用户确认 → advance
5. [开发者] wait_for_turn → claim_turn → 按模板产出 → submit
```

**身份铁律**：`X-AI-Identity` header 必须与 `who_am_i` 返回的 `identity` 一致，不是产品名（Claude Code 不等于 "claude"，DeepSeek 不等于 "deepseek"——端看注册时用了什么名字）。

## 角色行为约束

### 监督者
- 调用 `claim_turn(advance)` 推进阶段（独有权限）
- 调用 `force_converge` 强制收敛（独有权限）
- advance 前将 task 内容打印给用户，等待确认（P0-24）
- advance 前检查 deferred issue 列表有无正当理由（P0-13）

### 非监督者（peer/developer）
- **只在自己的 turn 内行动**（get_state 检查 turn === identity）
- **永远不调 claim_turn(advance)** —— advance 是监督者权限
- **永远不调 force_converge** —— 监督者权限
- `blind_review_pending=true` 时：调用 claim_turn → 获取盲审模板 → 独立审视 spec 全文 → submit（`blind_review: true`）
- `converged=true` 时不做任何操作，只 wait_for_turn（等待监督者 advance）
- 对方已产出后不做重复产出——以审阅者立场 review
- 不替监督者做运维决策（如"重启 server"）

### IMPLEMENTATION 阶段
- **开发者**（is_developer=true）：coding/fix 子阶段产出代码
- **评审者**（is_developer=false）：review 子阶段代码审查
- coding 完成后 → 开发者自审（启动 server 跑端到端流程）→ submit（P0-15）
- review 时 → 独立测试（1+ 端到端场景 + 1+ 对抗性场景）→ submit（P0-16）
- coding 前 → 确认 PLANNING 归档中的实施计划，明确本轮范围（P1-25b）

## wait_for_turn 行为规范

wait_for_turn 返回 `{ turn, phase, round, waited_ms, note }`。超时 600s。note 类型和行为对照：

| note | 含义 | AI 行为 |
|------|------|---------|
| `"both peers registered"` | 双方已注册，等待 advance | 继续 wait_for_turn |
| `"timeout"` (600s) | 等待超时 | 继续 wait_for_turn（循环） |
| `"phase changed or converged before turn"` | 阶段变更、收敛或盲审开始 | 检查 get_state → 如果 turn=自己或 blind_review_pending=true 则 claim_turn，否则继续 wait |
| `"recovered — re-register required"` | 崩溃恢复，需重新注册 | 调用 register 重新确认在线状态 |
| `"converged — waiting for supervisor to advance"` | 阶段已收敛，等待监督者 | 继续 wait_for_turn（非监督者不主动 advance） |
| 无 note（turn=自己） | turn 已切换到调用方 | claim_turn → 开始工作 |

标准循环模式：`while (turn !== my_identity) { wait_for_turn() }`

## 盲审流程（收敛前置）

盲审是收敛的**前置条件**（P0-3 已修复），不再是收敛后的额外步骤：

```
双方 submit agree + need_next_round=false + 无新增 P0/P1
  → blind_review_pending=true（converged 仍为 false）
  → 双方各自 claim_turn（盲审期间任何已注册 peer 可 claim）
  → getTemplate 返回盲审模板（逐节审视 spec 全文）
  → submit（blind_review: true, stance=null, need_next_round=null）
  → 双方盲审无新问题 → converged=true + blind_review_pending=false
  → turn 释放给监督者 → 监督者 advance
```

关键参数：
- 盲审 submit：`blind_review: true`, `stance: null`, `need_next_round: null`
- 盲审模板自动触发条件：`blind_review_pending=true`（不再依赖 `sub_phase === "blind_review"`）
- 盲审 claim_turn：`blind_review_pending=true` 时任何已注册 peer 均可 claim，绕过正常 turn 检查

## 收敛模型

各阶段收敛条件：

| 阶段 | 收敛条件 |
|------|---------|
| REQUIREMENTS | 双方无新增 P0/P1 + 无 open P0 → `blind_review_pending=true` |
| PLANNING | 同上 |
| IMPLEMENTATION | review 方 `stance=agree + need_next_round=false` + 无 open P0/escalated → `blind_review_pending=true` |
| SUMMARY | 同上 |
| 盲审后 | 双方盲审无新 issue → `converged=true` |

IMPLEMENTATION 收敛**仅依赖 review 方**（P0-1 已修复）——coding 产出方 stance=null 不参与判定。

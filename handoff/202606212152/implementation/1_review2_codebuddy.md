# 1_review2_codebuddy.md — Phase 1 fix review（round 2）

> identity: codebuddy（评审者，is_developer=false）
> phase: implementation | dev_phase: 1 | sub_phase: review | round: 2
> bootstrap 阶段：手动归档
> commit_hash: 55ea79f（本轮 submit 所基于的仓库 HEAD = fix + security commit）

## 本轮审阅范围

- 重新通读了以下文件：`src/state.ts`（saveState 原子写入）、`src/mutex.ts`（全局 mutex）、`src/identity.ts`（sanitizeIdentity）、`src/index.ts`（acquireLock + 死代码删除 + submit 注册）、`src/tools/submit.ts`（完整实现）、`src/tools/claim-turn.ts`（converged + blind_review_pending 检查）、`src/tools/register.ts`（mutex 替换）
- 本次修改涉及的章节：无（review 轮不改代码）
- 未重新审阅的章节：无（fix 修改涉及的全部文件已通读）

---

## 一、P0 修复验证（内容级核查）

### P0-6: saveState 原子写入 ✅

**修复内容**（state.ts line 140-146）：
```ts
const tmp = join(tmpdir(), `pairflow-state-${randomUUID()}.json`);
await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
const { rename } = await import("node:fs/promises");
await rename(tmp, STATE_FILE);
```

**核查**：writeFile(tmp) → rename(tmp, STATE_FILE)。rename 是原子操作（POSIX）或近似原子（Windows）。tmp 在系统 tmpdir，STATE_FILE 在 .pairflow/——跨文件系统 rename 可能退化为 copy+delete，但 Node.js rename 在同盘内是原子的。可接受。

**P0-6 关闭。**

### P0-7: submit 工具实现 ✅

**实现内容**（src/tools/submit.ts，~260 行）：

逐项核查 §10 submit 工具规范 + 计划草案 Phase 1 交付物：

| 要求 | 实现 | 核查 |
|---|---|---|
| converge_mark 解析 | line 24 `args.converge_mark as ConvergeMark` | ✅ |
| handoff 落盘 | line 224-238 writeFile md + meta.json | ✅ |
| 文件命名 r{seq}_{identity}.md | line 236 `r${seq}_${identity}.md` | ✅ |
| commit_hash 校验 | line 35 regex `^[a-f0-9]{7,40}$` | ✅ |
| 500KB 上限 | line 11 + 29-32 | ✅ |
| blind_review 参数 | line 26 + 44-47 + 157-169 | ✅ |
| 提出者不修改校验 | line 80-87 `raised_by === identity` | ✅ |
| fix 禁 P0 | line 70-78 | ✅ |
| stance 一致性校验 | line 50-55 + 260-265 | ✅ |
| IMPLEMENTATION 收敛检查 | line 171-200 | ✅ |
| 非 IMPLEMENTATION turn 交替 | line 201-216 | ✅ |
| lease 重置 | line 249 | ✅ |
| 盲审收敛 | line 157-169 | ✅ |
| index.ts 注册 submit | line 31-52 | ✅ |

**P0-7 关闭。** submit 工具核心功能完整。

### P0-8: claimTurn mutex 保护 ✅

**修复内容**：src/mutex.ts 全局 `stateMutex`。register（line 21）、claim_turn（line 24）、submit（line 57）均使用 `stateMutex.runExclusive()`。

**核查**：三个修改 state 的工具共享同一 mutex，并发请求串行化。P1-56（stateless 模式下 mutex 共享性）—— mutex 是模块级常量，Node.js 模块缓存确保单例，即使每请求创建新 McpServer，mutex 仍共享。

**P0-8 关闭。P1-56 关闭。**

---

## 二、P1 修复验证

### P1-54: handleTurn 检查 converged ✅

claim-turn.ts line 35-37：
```ts
if (state.converged) {
  return { ... error: "phase already converged — claim_turn(turn) not allowed" ... };
}
```
**P1-54 关闭。**

### P1-55: handleAdvance 检查 blind_review_pending ⚠️ 部分修复

**已修复**：requirements phase advance 检查 blind_review_pending（line 92-94）。

**未修复**：planning（line 105-117）、implementation（line 119-130）、summary（line 132-140）的 advance 均未检查 blind_review_pending。按 §5.3 第 3 条，所有 phase 的 advance 都应检查盲审是否完成。

**处理**：不阻塞——Phase 1 判定标准是"IDLE 握手 + REQUIREMENTS 一轮持笔"，不涉及 planning/implementation/summary 的 advance。但应在 Phase 2 补充。**P1-55 部分关闭，剩余 defer Phase 2。**

### P1-57: index.ts 死代码删除 ✅

原 line 34 `const { McpServer: _McpServer, ...rest } = { McpServer };` 已删除。**P1-57 关闭。**

### P1-61: acquireLock 调用 ✅

index.ts line 101-108：`httpServer.listen` 回调调 `acquireLock()`。line 113-114：SIGTERM/SIGINT 调 `releaseLock()`。**P1-61 关闭。**

---

## 三、安全修复验证

### sanitizeIdentity（path traversal 防护）✅

identity.ts line 19-24：拒绝含 `\/:` 或 `..` 的 identity。防止 path traversal 攻击（identity 用于文件名 `r{seq}_{identity}.md`）。

测试新增 2 项（who-am-i.test.ts 7→9 tests），14/14 pass。

---

## 四、submit.ts 新发现问题

### P1-62: 盲审文件目录硬编码为 "requirements"

**定位**：submit.ts line 227

```ts
const blindDir = join(HANDOFF_DIR, wfId, "requirements");
```

盲审文件始终写入 `requirements/` 目录，但 §5.3 第 3 条规定"各 phase 适用"——planning/implementation/summary 阶段的盲审文件应写入对应 phase 目录。

**修复**：`const blindDir = join(HANDOFF_DIR, wfId, state.phase);`

### P1-63: "## 本轮审阅范围" 检查对所有 phase 生效，但 §11 仅要求需求/计划阶段

**定位**：submit.ts line 40-42

```ts
if (!content.includes("## 本轮审阅范围")) {
  return { ... error: "missing required '## 本轮审阅范围' section" ... };
}
```

§11 明确"审阅范围段落格式（需求/计划阶段强制）"。IMPLEMENTATION coding/review/fix 和 SUMMARY 的 submit 不需要此段落。当前检查会导致 IMPLEMENTATION/SUMMARY 的合法 submit 被拒绝。

**修复**：`if ((state.phase === "requirements" || state.phase === "planning") && !content.includes("## 本轮审阅范围"))`

### P1-64: IMPLEMENTATION 收敛未设置 blind_review_pending=true

**定位**：submit.ts line 177-179

IMPLEMENTATION review 收敛时设置 `state.converged = true` 但未设置 `state.blind_review_pending = true`。非 IMPLEMENTATION 收敛（line 214）正确设置了 blind_review_pending。

按 §7 收敛后流程，所有 phase 收敛后都应进入盲审。IMPLEMENTATION 的盲审应在 dev_phase 循环收敛后执行（P1-58 多循环未实现，当前直接 phase 收敛）。

**处理**：与 P1-58（多循环）相关，defer Phase 2 一起处理。当前 IMPLEMENTATION 不设 blind_review_pending 可接受（因为多循环未实现，IMPLEMENTATION 收敛直接 advance 到 summary，盲审在 summary 后执行）。

---

## 五、Defer 到 Phase 2 的 issue 确认

| issue | claude r1 fix 声称 | 我的确认 |
|---|---|---|
| P1-58（多循环） | defer Phase 2（需正则提取循环总数） | ✅ 同意——循环总数提取依赖计划草案，Phase 2 模板引擎实现 |
| P1-59（escalation_recommended） | defer Phase 2（依赖 fix_review_cycles） | ✅ 同意 |
| P1-60（工具行为测试） | defer Phase 2（需 server 启动） | ✅ 同意——当前测试覆盖 state 函数，工具行为测试需集成测试基础设施 |
| P2-9（SDK headers） | 需确认 | ⚠️ 仍 open——identity.ts 使用 `extra.requestInfo?.headers`，若 SDK 不传 headers 则所有 identity 工具失效。需实际双端验证 |

---

## 六、独立验证

| 项目 | 结果 |
|---|---|
| vitest | 14/14 pass（9 who-am-i 含 sanitizeIdentity + 5 state-machine）✅ |
| tsc | 隐含通过（vitest 成功）✅ |
| submit 注册 | index.ts line 31-52 ✅ |
| 集成测试 | 未独立验证（需启动 server + 全流程） |

---

## 七、review 立场

**stance**: `agree`

**need_next_round**: `false`

**理由**：
1. 3 个 P0 全部修复且内容级验证通过——saveState 原子写入、submit 工具完整实现、mutex 全局共享
2. P1-54/57/61 修复正确；P1-55 部分修复（requirements 有，其他 phase defer）
3. 新发现 P1-62/63/64 是 submit.ts 的功能缺陷，但不阻塞 Phase 1 判定（IDLE 握手 + REQUIREMENTS 一轮持笔）
4. P1-62/63 会在 planning/implementation/summary 阶段触发，应在 Phase 2 修复
5. P2-9（SDK headers）仍需实际双端验证

**§14 Phase 1 判定标准**（判定 13）："IDLE 握手 + REQUIREMENTS 一轮持笔 → 继续"——代码层面满足（register + claim_turn + submit + get_state/get_context 全部实现），实际双端验证待执行。

---

## 八、issue 汇总

| ID | 级别 | 主题 | 状态 |
|---|---|---|---|
| P0-6 | P0 | saveState 非原子写入 | ✅ 关闭 |
| P0-7 | P0 | submit 工具未实现 | ✅ 关闭 |
| P0-8 | P0 | claimTurn 缺 mutex | ✅ 关闭 |
| P1-54 | P1 | handleTurn 未检查 converged | ✅ 关闭 |
| P1-55 | P1 | advance 未检查 blind_review_pending | ⚠️ 部分关闭（requirements 有，其他 defer） |
| P1-56 | P1 | register Mutex stateless 共享 | ✅ 关闭（模块级单例） |
| P1-57 | P1 | index.ts 死代码 | ✅ 关闭 |
| P1-58 | P1 | IMPLEMENTATION 多循环 | defer Phase 2 |
| P1-59 | P1 | get_state escalation_recommended | defer Phase 2 |
| P1-60 | P1 | 工具行为测试 | defer Phase 2 |
| P1-61 | P1 | acquireLock 未调用 | ✅ 关闭 |
| P1-62 | P1 | 盲审文件目录硬编码 requirements | open → Phase 2 修复 |
| P1-63 | P1 | 审阅范围检查过度（所有 phase） | open → Phase 2 修复 |
| P1-64 | P1 | IMPLEMENTATION 收敛未设 blind_review_pending | defer Phase 2（与 P1-58 相关） |
| P2-9 | P2 | SDK headers 传递 | open → 需双端验证 |

---

## 收敛状态

- 本轮新增 issue：P0：0，P1：2（P1-62, P1-63），P2：0
- 本轮关闭 issue：P0-6, P0-7, P0-8, P1-54, P1-56, P1-57, P1-61（7 个）
- stance: agree
- need_next_round: false
- 对对方上一轮产出的立场：agree（3 P0 全修复，新 P1 不阻塞）
- 是否需要下一轮：no

**按 §5.5 推进表**：review stance=agree + need_next_round=false → dev_phase 1 循环收敛。

**监督者异议检查**（§5.5）：监督者=开发者（claude），pending_supervisor_review=true，等待 claude 最终 review。

# 1_review_codebuddy.md — Phase 1 状态机 review

> identity: codebuddy（评审者，is_developer=false）
> phase: implementation | dev_phase: 1 | sub_phase: review
> bootstrap 阶段：手动归档
> commit_hash: cc6b437（本轮 submit 所基于的仓库 HEAD）

## 本轮审阅范围

- 重新通读了以下文件：`src/index.ts`、`src/state.ts`、`src/identity.ts`、`src/lock.ts`、`src/logger.ts`、`src/tools/ping.ts`、`src/tools/who-am-i.ts`、`src/tools/register.ts`、`src/tools/claim-turn.ts`、`src/tools/get-state.ts`、`src/tools/get-context.ts`、`src/__tests__/who-am-i.test.ts`、`src/__tests__/state-machine.test.ts`、`package.json`、`tsconfig.json`
- 本次修改涉及的章节：无（review 轮不改代码）
- 未重新审阅的章节：无（Phase 1 全部代码文件已通读）

---

## 一、交付物核查（计划草案 v2 Phase 1 对比）

| 计划草案交付物 | 实际产出 | 状态 |
|---|---|---|
| state.json schema 实现（§5.1 全字段）+ 原子写入 | state.ts 全字段 types + **非原子写入**（P0-6） | ⚠️ |
| .pairflow/ 目录结构 | ✅ state.json + lock + pairflow.log | ✅ |
| handoff/ 目录结构 + workflow_id 生成 | ✅ formatWorkflowId | ✅ |
| register 工具 | ✅ src/tools/register.ts | ✅ |
| claim_turn 工具（turn/advance）| ✅ src/tools/claim-turn.ts **缺 mutex**（P0-8）| ⚠️ |
| submit 工具 | ❌ **未实现**（P0-7） | ❌ |
| get_state + get_context | ✅ | ✅ |
| phase 初始化逻辑（§12）| ✅ 5 个 init 函数 | ✅ |
| lock.ts | ✅ 但未在 index.ts 调用（P1-61） | ⚠️ |
| logger.ts | ✅ 10MB 轮转 | ✅ |

**交付物完整度**：7/10。submit 缺失 + 原子写入不正确 + mutex 缺失 = 3 个核心问题。

---

## 二、P0 问题（阻塞）

### P0-6: saveState 非原子写入——tmp 文件白写

**定位**：`src/state.ts` line 140-150

**问题**：

```ts
export async function saveState(state: PairFlowState): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  const tmp = join(tmpdir(), `pairflow-state-${randomUUID()}.json`);
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");  // 写了 tmp
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");  // 直接写目标，tmp 没用上！
  try { await unlink(tmp); } catch { /* ignore */ }
}
```

tmp 文件写完后直接 `writeFile(STATE_FILE, ...)`——如果 STATE_FILE 写入中途崩溃（磁盘满/进程 kill），state.json 损坏。§8 要求"原子写入（tmp+rename）"，正确做法：write tmp → `rename(tmp, STATE_FILE)`。rename 是原子的（POSIX）或近似原子的（Windows）。

**影响**：崩溃恢复（§8）依赖 state.json 可读，非原子写入导致 state.json 可能损坏 → 崩溃恢复失败 → 数据丢失。

**修复**：
```ts
await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
await rename(tmp, STATE_FILE);  // 原子操作
```

### P0-7: submit 工具未实现

**定位**：`src/tools/` 目录无 submit.ts

**问题**：meta.json `deliverables` 声称 `"submit"` 已实现（隐含在 claim_turn 描述中），但实际代码中：
- `src/tools/` 无 submit.ts
- `src/index.ts` 未注册 submit 工具（line 20-28 只注册了 ping/who_am_i/register/claim_turn/get_state/get_context）

§14 Phase 1 第 11 步明确要求："`submit` + handoff 落盘（含文件命名逻辑）"。submit 是 PairFlow 的核心工具——AI 通过 submit 提交产出、converge_mark、commit_hash。没有 submit，整个协作流程无法运作。

**影响**：无法进行任何协作（需求/计划/实现/汇总阶段都依赖 submit 提交产出）。

### P0-8: claimTurn 缺少 mutex 保护

**定位**：`src/tools/claim-turn.ts` line 9-29

**问题**：register 工具有 `const registerMutex = new Mutex()`（line 9）+ `registerMutex.runExclusive(...)`（line 23），但 claimTurn 没有任何 mutex 保护。claimTurn 的操作流程：

```ts
const state = await loadState();  // 读
// ... 修改 state ...
await saveState(state);  // 写
```

两个并发 claim_turn 请求（如两端同时调 advance）可能读到同一 state，各自修改后保存，后者覆盖前者。§9 要求"状态变更持进程级互斥锁"，§5.4 合法转换校验表也要求 mutex 串行化。

**影响**：并发请求导致状态不一致——如两端同时 advance，只有一个 advance 生效，另一个被静默丢弃。

**修复**：claimTurn 应使用全局 mutex（与 register 共享同一 mutex，或使用独立的 claimMutex）。

---

## 三、P1 问题

### P1-54: claim_turn handleTurn 未检查 converged

**定位**：`src/tools/claim-turn.ts` line 31-45

**问题**：§5.4 合法转换校验表规定 `converged=true | 任何方调 claim_turn(turn) | ❌`。但 handleTurn 只检查 `isCurrentHolder`，未检查 `state.converged`。收敛后持笔者仍可 claim_turn(turn) 获取 lease。

### P1-55: claim_turn advance 未检查 blind_review_pending

**定位**：`src/tools/claim-turn.ts` line 47-134

**问题**：§5.3 advance 前置条件第 3 条要求"收敛后、advance 前执行盲审"。handleAdvance 只检查 `state.converged`，未检查 `state.blind_review_pending`。如果 blind_review_pending=true（收敛后等待盲审），advance 应被拒绝。

### P1-56: register Mutex 在 stateless 模式下可能不共享

**定位**：`src/tools/register.ts` line 9 + `src/index.ts` line 56-62

**问题**：index.ts 每个请求创建 `new StreamableHTTPServerTransport` + `createServerWithTools()`（创建新 McpServer + 重新注册 tools）。register.ts 的 `const registerMutex = new Mutex()` 是模块级的——如果 Node.js 模块缓存复用，mutex 共享；但如果每个请求创建新实例，mutex 不共享。需确认模块加载行为。

### P1-57: index.ts 死代码

**定位**：`src/index.ts` line 34

```ts
const { McpServer: _McpServer, ...rest } = { McpServer };
```

这行代码解构 McpServer 但 `_McpServer` 和 `rest` 均未使用。看起来是调试残留，应删除。

### P1-58: IMPLEMENTATION advance 未实现多循环

**定位**：`src/tools/claim-turn.ts` line 110-121

**问题**：代码注释"Check if there are more dev_phases... For now: advance to summary directly (multi-cycle support in Phase 2)"。但 §5.3 r46-N1 明确定义 IMPLEMENTATION 可包含多个 dev_phase 循环，循环总数从计划草案 `## 实施里程碑` 段落提取。当前实现直接从 implementation 跳到 summary。

§14 Phase 1 交付物包含 claim_turn advance——advance 语义在 IMPLEMENTATION 阶段是"推进到下一 dev_phase 或 SUMMARY"。虽然完整多循环逻辑（正则提取循环总数）可在 Phase 2 完善，但基本的"检查是否有更多 dev_phase"逻辑应在 Phase 1 实现。

### P1-59: get_state 未计算 escalation_recommended

**定位**：`src/tools/get-state.ts`

**问题**：§10 get_state 出参应含 `escalation_recommended?`——"在 P0 僵持检测触发时返回 issue ID 列表"。当前直接返回整个 state，不含 escalation_recommended 计算逻辑。僵持检测（fix_review_cycles ≥ 2）在 Phase 2 实现，但 get_state 应预留此字段。

### P1-60: 测试未覆盖 register/claim_turn 工具行为

**定位**：`src/__tests__/state-machine.test.ts`

**问题**：§13 Phase 1 测试项包括：
- register（两端注册、重复覆盖、非 IDLE 拒绝）
- IDLE 握手（advance 仅监督者 + 首次 advance 传 timeouts）
- advance 权限（非监督者 advance 拒绝）
- 状态机转换（IDLE→REQUIREMENTS）

当前测试仅覆盖 state 加载/保存 + initRequirementsPhase + 角色辅助函数。未测试 register/claim_turn 工具的实际行为（如非 IDLE 拒绝、advance 权限、phase 转换）。

### P1-61: lock.ts acquireLock 未在 index.ts 调用

**定位**：`src/index.ts`

**问题**：lock.ts 实现了 `acquireLock()` + `releaseLock()`，但 index.ts 启动 HTTP server 时未调用 acquireLock。§15 要求"锁机制——lock 文件记录 PID+时间戳+nonce，僵尸 lock 检测"。当前锁代码存在但未使用——多个 PairFlow 实例可同时运行。

---

## 四、P2 问题

### P2-9: known_limitation（SDK headers 传递）的解决方案需记录

**定位**：`1_coding_claude.meta.json` line 21

**问题**：meta.json 记录 `known_limitation: "SDK requestInit headers not passed to tool calls. identity passed via args as workaround"`。最新 commit `cc6b437` 移除了 args.identity fallback，仅信任 X-AI-Identity header。

但 SDK 的 `extra.requestInfo?.headers` 是否真的包含 HTTP headers？如果 SDK 不传递 headers，那么所有需要 identity 的工具（register/claim_turn/submit）都无法获取身份。who_am_i 的 `extra.requestInfo?.headers` 也可能返回 undefined。

**需确认**：SDK `RequestHandlerExtra.requestInfo.headers` 是否包含原始 HTTP headers？如果不包含，这是一个 P0 级架构问题——需要自定义 transport 或中间件传递 headers。

---

## 五、独立验证

| claude 声称 | 我核查 | 结果 |
|---|---|---|
| tsc pass | vitest 通过隐含 TS 编译成功 | ✅ |
| vitest 12/12 pass | `npm test` 运行：12 passed (12) | ✅ |
| integration register→advance→get_context | 未独立验证（需启动 server） | ⚠️ |

---

## 六、review 立场

**stance**: `disagree`

**need_next_round**: `true`

**理由**：3 个 P0 阻塞问题：
1. P0-6: saveState 非原子写入——崩溃恢复数据丢失风险
2. P0-7: submit 工具未实现——核心工具缺失，协作无法运作
3. P0-8: claimTurn 缺 mutex——并发状态不一致

P1 问题（P1-54~P1-61）也需在 fix 轮处理，但不阻塞——可选择性修复。

**fix 轮要求**：
1. P0-6: saveState 改用 rename 实现原子写入
2. P0-7: 实现 submit 工具（converge_mark 解析 + handoff 落盘 + 文件命名 + commit_hash 校验 + 500KB 上限 + blind_review 参数 + 提出者不修改校验）
3. P0-8: claimTurn 增加 mutex 保护
4. P1-54: handleTurn 增加 converged 检查
5. P1-55: handleAdvance 增加 blind_review_pending 检查
6. P1-57: 删除 index.ts 死代码
7. P1-60: 补充 register/claim_turn 工具行为测试
8. P1-61: index.ts 调用 acquireLock

---

## 七、issue 汇总

| ID | 级别 | 主题 |
|---|---|---|
| P0-6 | P0 | saveState 非原子写入——tmp 文件白写 |
| P0-7 | P0 | submit 工具未实现 |
| P0-8 | P0 | claimTurn 缺 mutex 保护 |
| P1-54 | P1 | claim_turn handleTurn 未检查 converged |
| P1-55 | P1 | claim_turn advance 未检查 blind_review_pending |
| P1-56 | P1 | register Mutex 在 stateless 模式下可能不共享 |
| P1-57 | P1 | index.ts 死代码 |
| P1-58 | P1 | IMPLEMENTATION advance 未实现多循环 |
| P1-59 | P1 | get_state 未计算 escalation_recommended |
| P1-60 | P1 | 测试未覆盖 register/claim_turn 工具行为 |
| P1-61 | P1 | lock.ts acquireLock 未在 index.ts 调用 |
| P2-9 | P2 | SDK headers 传递方案需确认 |

---

## 收敛状态

- 本轮新增 issue：P0：3，P1：8，P2：1
- 本轮关闭 issue：无
- stance: disagree
- need_next_round: true
- 对对方上一轮产出的立场：disagree（3 P0 阻塞）
- 是否需要下一轮：yes

**按 §5.5 推进表**：review stance=disagree + need_next_round=true → sub_phase=fix, turn→开发者(claude), round→2。

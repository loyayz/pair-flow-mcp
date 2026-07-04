# 重构状态管理——实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 state.json 文件 I/O（改为进程内存 Map），支持并行多工作流，简化 register、删除 confirm_dir、重构 confirm_task 为成对绑定。

**Architecture:** 核心思路——`states: Map<string, PairFlowState>` 替代文件，`tokenMap: Map<string, Session>` 扩展为 token→{identity, workflowId} 路由所有请求，`getMutex(workflowId)` 替代全局 mutex。register 纯身份声明，confirm_task 成对绑定（同 task_path 的两个 AI 归入一个 workflow）。

**Tech Stack:** TypeScript · `async-mutex` · Vitest

## Global Constraints

- 设计规格：`docs/superpowers/specs/2026-07-04-state-refactor-design.md` 唯一权威来源
- 所有 tip 使用 `[行动]/[产出]/[当前]` 三层自然语言格式
- 路径统一 POSIX 正斜杠
- 测试保持不变（35/35），新增测试覆盖并行场景

---

### Task 1: state.ts — 内存化

**Files:**
- Modify: `src/state.ts`

**Interfaces:**
- Produces: `getState(wfId): PairFlowState | undefined`, `setState(wfId, state): void`, `deleteState(wfId): void`, `getMutex(wfId): Mutex`, `defaultState()` 保留，`PairFlowState` 不变
- Removes: `loadState()`, `saveState()`, `stateFileExists()`, `STATE_DIR`, `STATE_FILE` 常量

- [ ] **Step 1: 重写 state.ts**

```typescript
// 删除所有 fs I/O 相关 import（writeFile, mkdir, readFile, rename, tmpdir）
// 删除 dirname, join, randomUUID imports
import { Mutex } from "async-mutex";

// ── Types (不变) ──
export type Phase = "idle" | "requirements" | "planning" | "implementation" | "summary";
export type SubPhase = "coding" | "review" | null;
export type PeerRole = "supervisor" | "peer";
// ... 所有 interface 不变 ...

// ── In-memory state store ──
const states = new Map<string, PairFlowState>();
const mutexes = new Map<string, Mutex>();

export function getState(workflowId: string): PairFlowState | undefined {
  return states.get(workflowId);
}

export function setState(workflowId: string, state: PairFlowState): void {
  states.set(workflowId, state);
}

export function deleteState(workflowId: string): void {
  states.delete(workflowId);
}

export function getMutex(workflowId: string): Mutex {
  let m = mutexes.get(workflowId);
  if (!m) {
    m = new Mutex();
    mutexes.set(workflowId, m);
  }
  return m;
}

// defaultState() 保留不变
// initRequirementsPhase, initPlanningPhase, initImplementationPhase
// initSummaryPhase, initIdleState 保留不变
// isCurrentHolder, isSupervisor, getOtherIdentity, getPeerByIdentity 保留不变
```

- [ ] **Step 2: 运行测试，预期编译通过但测试可能失败（loadState/saveState 被删除）**

Run: `npx vitest run`
Expected: compile OK, some tests fail due to deleted exports

- [ ] **Step 3: 提交**

```bash
git add src/state.ts
git commit -m "refactor: state.ts — in-memory Map replaces state.json file I/O"
```

---

### Task 2: identity.ts + token-map.ts — parseSession

**Files:**
- Modify: `src/identity.ts`, `src/token-map.ts`

**Interfaces:**
- Produces: `parseSession(headers): { identity: string; workflowId: string | null }`
- Modifies: `registerToken(identity): string` 不变；`resolve()` 改为返回 `Session | null`

- [ ] **Step 1: 扩展 token-map.ts 的 Session 类型**

```typescript
// token-map.ts
import { randomUUID } from "node:crypto";

export interface Session {
  identity: string;
  workflowId: string | null;
}

const tokenMap = new Map<string, Session>();

export function registerToken(identity: string): string {
  const token = randomUUID();
  tokenMap.set(token, { identity, workflowId: null });
  return token;
}

export function bindWorkflow(token: string, workflowId: string): void {
  const session = tokenMap.get(token);
  if (session) session.workflowId = workflowId;
}

export function resolveSession(raw: string): Session | null {
  return tokenMap.get(raw) ?? null;
}
```

- [ ] **Step 2: 重写 identity.ts 的 parseIdentity → parseSession**

```typescript
// identity.ts
import type { IsomorphicHeaders } from "@modelcontextprotocol/sdk/types.js";
import { resolveSession } from "./token-map.js";

export function parseSession(headers: IsomorphicHeaders | undefined): {
  identity: string;
  workflowId: string | null;
} {
  const raw = headers?.["x-ai-identity"];
  if (typeof raw === "string" && raw.trim().length > 0) {
    const session = resolveSession(raw.trim());
    if (session) return session;
    // Fallback: plaintext identity (backward compatible, no workflow bound)
    return { identity: sanitizeIdentity(raw.trim()), workflowId: null };
  }
  return { identity: "unknown", workflowId: null };
}

export function sanitizeIdentity(identity: string): string {
  if (/[\\/:]/.test(identity) || identity.includes("..")) {
    throw new Error(`Invalid identity: must not contain path separators or ".."`);
  }
  return identity;
}
```

- [ ] **Step 3: 运行测试，验证编译通过**

Run: `npx vitest run`
Expected: compile OK

- [ ] **Step 4: 提交**

```bash
git add src/identity.ts src/token-map.ts
git commit -m "refactor: parseSession returns identity+workflowId, Session type in token-map"
```

---

### Task 3: 删除 confirm_dir

**Files:**
- Modify: `src/index.ts`（删除 registerTool 调用行）
- Delete: `src/tools/confirm-dir.ts`（或 keep 不编译，在 index.ts 删注册行即生效）
- Modify: `src/__tests__/tools.test.ts`（删除确认目录相关测试）

**Interfaces:**
- None (纯删除)

- [ ] **Step 1: 删除 confirm_dir 注册**

删除 `src/index.ts` 中以下三行：
```typescript
import { confirmDir } from "./tools/confirm-dir.js";
mcp.registerTool("confirm_dir", ...);
```

- [ ] **Step 2: 删除 confirm-dir.ts 文件**

```bash
rm src/tools/confirm-dir.ts
```

- [ ] **Step 3: 删除测试中 confirm_dir 相关代码**

确认 `tools.test.ts` 中没有 confirm_dir 的测试引用。

- [ ] **Step 4: 提交**

```bash
git add src/index.ts src/tools/confirm-dir.ts src/__tests__/tools.test.ts
git commit -m "refactor: delete confirm_dir tool"
```

---

### Task 4: register 简化

**Files:**
- Modify: `src/tools/register.ts`

**Interfaces:**
- Consumes: `parseSession` → 否，register 仍用 body identity（不用 header token）
- Produces: tip 指向 confirm_task（不指向 confirm_dir）

- [ ] **Step 1: 去掉 supervisor/developer 参数 + 校验**

```typescript
export async function register(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = args.identity as string;
  if (!identity) return err(badParam("identity", "缺失"));
  try { sanitizeIdentity(identity); } catch { return err(badParam("identity", "非法")); }

  const workDir = args.work_dir as string;
  if (!workDir) return err(badParam("work_dir", "缺失"));

  // 不再校验 supervisor/developer/role constraints
  // 不再 loadState/saveState —— register 只生成 token

  const token = registerToken(identity);

  const tip = `Set X-AI-Identity: ${token} header on all subsequent requests。你已注册。
询问用户以下信息后调用 confirm_task({...})。两个 AI 使用相同的 task_path 自动成对，
服务端校验角色唯一性和 work_dir 一致性。

confirm_task 入参：

task_path   — 任务文档绝对路径。两个 AI 必须传相同值才能成对。
task_type   — 任务类型。"development"（开发）走完整四阶段流程；
              "requirements"（需求）只做需求分析+汇总，跳过 planning 和 implementation。
supervisor  — 是否为监督者（true/false）。双方只能有一个监督者。
developer   — 是否为开发者（true/false）。双方只能有一个开发者。
work_dir    — 项目根目录绝对路径。两个 AI 必须一致。`;

  return ok({ ok: true, identity, token, phase: "idle" }, tip);
}
```

- [ ] **Step 2: 更新 register 的 Zod schema**

`src/index.ts` 中 register 的 inputSchema 去掉 supervisor/developer：
```typescript
inputSchema: { identity: z.string().optional(), work_dir: z.string().optional() }
```

- [ ] **Step 3: 运行测试，检查编译**

Run: `npx vitest run`
Expected: register 相关测试可能需要更新断言

- [ ] **Step 4: 提交**

```bash
git add src/tools/register.ts src/index.ts
git commit -m "refactor: register simplified — identity+work_dir only, tip points to confirm_task"
```

---

### Task 5: confirm_task 重构

**Files:**
- Modify: `src/tools/confirm-task.ts`

**Interfaces:**
- Consumes: `parseSession`, `tokenMap`, `states`
- Produces: workflow creation/binding, token→workflow 绑定

- [ ] **Step 1: 重写 confirm_task 核心逻辑**

```typescript
export async function confirmTask(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const { identity } = parseSession(extra.requestInfo?.headers);
  if (identity === "unknown") return err("identity required");

  const taskPath = args.task_path as string;
  if (!taskPath) return err("task_path is required");

  const resolved = resolve(taskPath);
  if (taskPath.includes("..")) return err("task_path must not contain path traversal");

  // Task type
  const taskType = (args.task_type as string) || "development";
  if (taskType !== "requirements" && taskType !== "development") {
    return err(`invalid task_type "${taskType}" — must be "requirements" or "development"`);
  }

  // Role declaration
  const supervisor = args.supervisor === true;
  const developer = args.developer === true;

  // work_dir
  const workDir = (args.work_dir as string) || "";
  if (!workDir) return err("work_dir is required");

  // Validate task file exists
  try { await access(resolved); } catch {
    return err(`task file not found: ${resolved.replace(/\\/g, "/")}`);
  }

  let wfId: string;
  let recovered = false;
  let isFirst = false;

  // 1. 查内存 — 是否有同 task_path 的活跃工作流
  let existing = findWorkflowByTaskPath(taskPath);  // 遍历 states Map

  // 2. 查磁盘 — handoff 扫描未完成工作流
  if (!existing) {
    const handoffWfId = await findIncompleteByTaskPath(taskPath);
    if (handoffWfId) {
      // 恢复
      const state = await reconstructFromHandoff(defaultState(), handoffWfId);
      if (state) {
        setState(handoffWfId, state);
        existing = handoffWfId;
        recovered = true;
      }
    }
  }

  if (!existing) {
    // 全新工作流
    wfId = formatWorkflowId();
    const state = defaultState();
    state.workflow_id = wfId;
    state.task = { spec_file: resolved, task_type: taskType as "requirements" | "development" };
    setState(wfId, state);
    isFirst = true;
  } else {
    wfId = existing;
    const state = getState(wfId)!;
    const peers = state.peers;

    // 检查是否已满
    if (peers.length >= 2) {
      return err("this task already has 2 peers — cannot join");
    }

    // 角色校验
    const firstPeer = peers[0];
    if (supervisor && firstPeer.role === "supervisor") {
      return err("supervisor already exists for this task");
    }
    if (developer && firstPeer.is_developer) {
      return err("developer already exists for this task");
    }

    // work_dir 一致性
    if (firstPeer.work_dir !== workDir) {
      return err(`work_dir mismatch: "${workDir}" vs "${firstPeer.work_dir}"`);
    }

    // 加入
    state.peers.push({
      identity,
      role: supervisor ? "supervisor" : "peer",
      is_developer: developer,
      registered_at: new Date().toISOString(),
      work_dir: workDir,
    });
    setState(wfId, state);
  }

  // 绑定 token → workflow
  const raw = extra.requestInfo?.headers?.["x-ai-identity"] as string;
  if (raw) bindWorkflow(raw.trim(), wfId);

  // 写 .pid
  const pidFile = `${resolved}.pid`;
  await writeFile(pidFile, wfId, "utf-8").catch(() => {});

  const statusLine = `[当前] 你是 ${identity}（${supervisor ? "supervisor" : "developer"}）。工作流 ${wfId}${recovered ? `，${getState(wfId)!.phase} 阶段第 ${getState(wfId)!.round} 轮` : "，idle 阶段"}。`;

  let actionLine: string;
  if (isFirst) {
    actionLine = `${recovered ? "已恢复" : "已创建"}工作流 ${wfId}。等待对方 AI 以相同 task_path 调用 confirm_task 加入。调用 wait_for_turn，根据服务端提示继续下一步。`;
  } else {
    const p = getState(wfId)!.peers;
    const names = p.map(x => `${x.identity}（${x.role === "supervisor" ? "supervisor" : "developer"}）`).join(" + ");
    actionLine = `已加入工作流 ${wfId}。双方已就位：${names}。调用 wait_for_turn，根据服务端提示继续下一步。`;
  }

  return ok({
    task_path: resolved.replace(/\\/g, "/"),
    workflow_id: wfId,
    phase: getState(wfId)!.phase,
    recovered,
  }, `[行动] ${actionLine}\n\n${statusLine}`);
}
```

- [ ] **Step 2: 更新 confirm_task 的 Zod schema**

```typescript
inputSchema: {
  task_path: z.string(),
  task_type: z.enum(["requirements", "development"]).optional(),
  supervisor: z.boolean(),
  developer: z.boolean(),
  work_dir: z.string().optional(),
}
```

- [ ] **Step 3: 补全 handoff 扫描逻辑**

在 confirm_task 内部调用新函数 `findIncompleteWorkflow(taskPath: string)`：
```
扫 handoff/ 下所有 14 位目录
→ 每个目录读 meta.json 的 task.spec_file
→ 匹配 taskPath
→ 检查 isWorkflowComplete
→ 返回最新未完成 workflow_id
```

- [ ] **Step 4: 运行测试并修复**

Run: `npx vitest run`
Expected: 多个测试需要更新（confirm_task 的参数变了）

- [ ] **Step 5: 提交**

```bash
git add src/tools/confirm-task.ts src/index.ts
git commit -m "refactor: confirm_task — role declaration, token binding, handoff scan, per-workflow state"
```

---

### Task 6: 所有工具迁移到 parseSession + getState/getMutex

**Files:**
- Modify: `src/tools/advance.ts`
- Modify: `src/tools/claim-turn.ts`
- Modify: `src/tools/submit.ts`
- Modify: `src/tools/wait-for-turn.ts`
- Modify: `src/tools/get-state.ts`
- Modify: `src/tools/archive-tools.ts`

**Interfaces:**
- Consumes: `parseSession`, `getState(workflowId)`, `setState(workflowId, state)`, `getMutex(workflowId)`
- 每个工具改为：parseSession 获取 identity + workflowId → getState(workflowId) → 操作 → setState(workflowId)

- [ ] **Step 1: advance.ts 迁移**

```typescript
import { parseSession } from "../identity.js";
import { getState, setState, getMutex, isSupervisor, ... } from "../state.js";

// 迁移模式:
const { identity, workflowId } = parseSession(extra.requestInfo?.headers);
if (identity === "unknown") return err("identity required");
if (!workflowId) return err("not bound to a workflow — call confirm_task first");

return getMutex(workflowId).runExclusive(async () => {
  const state = getState(workflowId);
  if (!state) return err("workflow not found");
  // ... 原有逻辑 ...
  setState(workflowId, state);
});
```

- [ ] **Step 2: 其他 5 个工具同样迁移**

claim-turn.ts, submit.ts, wait-for-turn.ts, get-state.ts, archive-tools.ts

- [ ] **Step 3: 运行测试并修复**

Run: `npx vitest run`

- [ ] **Step 4: 提交**

```bash
git add src/tools/ src/index.ts
git commit -m "refactor: all tools use parseSession + getState/getMutex per workflow"
```

---

### Task 7: index.ts 清理 + crash-recovery.ts 简化

**Files:**
- Modify: `src/index.ts`（删除 .pairflow 清理、lock 相关）
- Modify: `src/crash-recovery.ts`（如果 reconstructFromHandoff 不用 state.json）

**Interfaces:**
- None (清理冗余)

- [ ] **Step 1: 删除启动时的 .pairflow 清理**

```typescript
// 删除:
await rm(STATE_DIR, { recursive: true, force: true });
await acquireLock();
// 删除 lock.ts import
```

- [ ] **Step 2: crash-recovery.ts 现在只从 handoff 读**

不需修改（它读 handoff/ 下的 meta.json 和产出文件），去掉 `stateFileExists` 相关逻辑。

- [ ] **Step 3: 运行完整测试套件**

Run: `npx vitest run`
Expected: 35+ 测试全部通过

- [ ] **Step 4: 提交**

```bash
git add src/index.ts src/crash-recovery.ts src/lock.ts
git commit -m "refactor: remove .pairflow startup cleanup, lock file, stateFileExists"
```

---

### Task 8: 更新设计文档

**Files:**
- Modify: `docs/superpowers/specs/2026-06-21-pair-flow-design.md`

**Interfaces:**
- None (文档)

- [ ] **Step 1: 同步 §3（目录结构）**——去掉 .pairflow/ 引用
- [ ] **Step 2: 同步 §4（数据流）**——register 简化、confirm_task 成对绑定
- [ ] **Step 3: 同步 §5（状态机）**——状态改为进程内存
- [ ] **Step 4: 同步 §9（工具表）**——删除 confirm_dir、修改 register/confirm_task
- [ ] **Step 5: 提交**

```bash
git add docs/
git commit -m "docs: sync design spec with state refactoring changes"
```

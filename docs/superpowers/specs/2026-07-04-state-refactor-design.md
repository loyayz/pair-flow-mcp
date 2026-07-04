# 重构状态管理——进程内存 + 并行多工作流

> 设计日期: 2026-07-04

---

## 1. 目标

1. 删除 `.pairflow/state.json`，状态改为进程内存变量
2. 支持同一端口并行多个独立工作流（多对 AI 同时结对）

---

## 2. 状态管理重构

### 2.1 现状

- `loadState()` 读 `.pairflow/state.json`，`saveState()` 原子写磁盘
- 每个 HTTP 请求 new 一个 `McpServer`，`state.json` 作为跨请求共享内存
- 全局 `stateMutex`

### 2.2 改为

```typescript
// state.ts
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
  mutexes.delete(workflowId);
}

export function getMutex(workflowId: string): Mutex {
  let m = mutexes.get(workflowId);
  if (!m) {
    m = new Mutex();
    mutexes.set(workflowId, m);
  }
  return m;
}
```

- 删除 `loadState()`、`saveState()`、`stateFileExists()` 及其所有磁盘 I/O
- 启动时不再 `rm -rf .pairflow`
- 重启后所有状态丢失，需重新 `register` + `confirm_task`
- 归档（`handoff/`）仍在磁盘保留，崩溃恢复从 `handoff/` 重建

### 2.3 崩溃恢复

`confirm_task` 内部扫描 `handoff/`，按 `task_path` 匹配未完成工作流，取最新的进行恢复。恢复时将重建的 state 写入内存 `states` map。

---

## 3. Token 映射扩展

### 3.1 现状

```typescript
tokenMap: Map<string, string>  // token → identity
```

### 3.2 改为

```typescript
interface Session {
  identity: string;
  workflowId: string | null;  // null 表示已注册但未加入工作流
}

tokenMap: Map<string, Session>
```

`register` 写入 `{ identity, workflowId: null }`。`confirm_task` 将 `workflowId` 设为实际工作流 ID。

### 3.3 parseSession

```typescript
// identity.ts
export function parseSession(headers): { identity: string; workflowId: string | null } {
  const raw = headers?.["x-ai-identity"];
  if (!raw) return { identity: "unknown", workflowId: null };
  const session = resolveSession(raw);  // token → Session
  return session ?? { identity: sanitizeIdentity(raw), workflowId: null };
}
```

所有工具通过 `parseSession` 同时获取 `identity` 和 `workflowId`，无需额外 `X-Workflow-Id` header。

---

## 4. 工作流成对绑定

### 4.1 绑定时机

`confirm_task` 是成对绑定点。同一个 `task_path` 最多绑定 2 个 token。第一个创建 workflow，第二个加入。

### 4.2 角色约束

`register` 不再声明 `supervisor`/`developer`。`confirm_task` 时声明角色：

```
confirm_task({
  task_path: "/path/a.md",
  task_type: "development" | "requirements",
  supervisor: true | false,
  developer: true | false,
  work_dir: "/project"
})
```

角色校验：
- 同 `task_path` 最多 2 个 token
- 不能两个都是 `supervisor`
- 不能两个都是 `developer`
- `work_dir` 双方必须一致

### 4.3 绑定流程

**第一个 AI 调用 confirm_task：**
1. 扫 `handoff/` 按 `task_path` 查找未完成工作流
2. 有 → 恢复最新未完成工作流到内存，绑定 token；无 → 创建新 workflow
3. 返回 tip: "等待对方加入。调用 wait_for_turn，根据服务端提示继续下一步。"

**第二个 AI 调用 confirm_task（同 task_path）：**
1. 校验角色约束 + work_dir 一致性
2. 绑定 token 到已存在的 workflow
3. 返回 tip: "双方已就位。调用 wait_for_turn，根据服务端提示继续下一步。"

**第三个 AI 调用 confirm_task（同 task_path）：**
1. 拒绝：同 `task_path` 已绑定 2 个 token

---

## 5. register 简化

### 5.1 入参

```typescript
register({
  identity: string,    // 从 body 取
  work_dir: string
})
```

去掉 `supervisor`/`developer`。

### 5.2 Tip

```
Set X-AI-Identity: {token}...你已注册。询问用户任务文档路径、任务类型（development/requirements）和你的角色（supervisor/developer），然后调用 confirm_task。
```

双方 tip 相同，不再区分监督者/非监督者。

---

## 6. confirm_dir 删除

`confirm_dir` 删除。其职责合并到：
- 未完成工作流列表 → `confirm_task` 内部扫描 `handoff/`
- 任务类型/角色引导 → `register` tip + `confirm_task` 入参

---

## 7. 工具清单变更

| 操作 | 说明 |
|------|------|
| 删除 `confirm_dir` | 合并到 confirm_task |
| 修改 `register` | 去掉 supervisor/developer，tip 指向 confirm_task |
| 修改 `confirm_task` | 新增 supervisor/developer/work_dir 参数、扫描 handoff、token 绑定 |
| 修改所有工具 | `parseIdentity` → `parseSession`，`stateMutex` → `getMutex(workflowId)` |
| 修改 `state.ts` | 文件 I/O → 内存 Map |
| 删除 `.pairflow/` 相关 | 启动清理、lock 文件 |

---

## 8. 范围边界

- ✅ 在范围内：状态内存化、并行多工作流、register 简化、confirm_task 重构成对绑定、删除 confirm_dir
- ❌ 不在范围内：归档格式变更、AI 身份认证机制升级、网络层改造

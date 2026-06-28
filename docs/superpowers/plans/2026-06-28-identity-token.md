# Identity Token Verification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace self-declared plaintext identity with UUID token in `X-AI-Identity` header.

**Architecture:** Process-level `Map<token, identity>` in a new `token-map.ts`. `parseIdentity` passes the header value through `tokenMap.resolve()` — if it's a known token, return the mapped identity; otherwise return the raw value (backward compatible).

**Tech Stack:** Node.js `crypto.randomUUID()`, TypeScript `Map<string, string>`

## Global Constraints

- 仅 localhost 使用，token 不持久化（进程级生命周期）
- 向后兼容：旧 header（明文 identity）仍接受

---

## File Structure

| 文件 | 职责 |
|------|------|
| `src/token-map.ts`（新增） | token 生成 + `Map` 存储 + `resolve` 查找 |
| `src/identity.ts`（修改） | `parseIdentity` 调用 `resolve` |
| `src/tools/register.ts`（修改） | 生成 token、返回值扩展、tip 改 token |
| `src/__tests__/tools.test.ts`（修改） | token 相关断言更新 |

---

### Task 1: Create `src/token-map.ts`

**Files:**
- Create: `src/token-map.ts`

**Interfaces:**
- Produces: `registerToken(identity: string): string` — generate UUID token, map it to identity, return token
- Produces: `resolve(raw: string): string` — look up token in map, return identity if found, else return raw unchanged

- [ ] **Step 1: Create the file**

```typescript
import { randomUUID } from "node:crypto";

/**
 * Process-level token → identity mapping.
 * Tokens expire on process restart — crash recovery re-registers.
 */
const tokenMap = new Map<string, string>();

/** Generate a UUID token and map it to the given identity. Returns the token. */
export function registerToken(identity: string): string {
  const token = randomUUID();
  tokenMap.set(token, identity);
  return token;
}

/**
 * Resolve a raw X-AI-Identity header value.
 * If the value is a known token, return the mapped identity.
 * Otherwise return the value unchanged (backward compatible with plaintext
 * identity headers).
 */
export function resolve(raw: string): string {
  return tokenMap.get(raw) ?? raw;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/token-map.ts
git commit -m "feat: add token-map — process-level token→identity mapping"
```

---

### Task 2: Modify `src/identity.ts` — wire `resolve` into `parseIdentity`

**Files:**
- Modify: `src/identity.ts`

**Interfaces:**
- Consumes: `resolve(raw: string): string` from `src/token-map.ts`
- Produces: `parseIdentity(headers): string` — same signature, now resolves tokens

- [ ] **Step 1: Update parseIdentity**

```typescript
import type { IsomorphicHeaders } from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "../token-map.js";

/**
 * 从 HTTP header 解析 AI 身份。
 * 无有效 X-AI-Identity header → "unknown"。
 * Token 值会被解析为注册时对应的身份名。
 */
export function parseIdentity(headers: IsomorphicHeaders | undefined): string {
  const raw = headers?.["x-ai-identity"];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return resolve(sanitizeIdentity(raw.trim()));
  }
  return "unknown";
}

/**
 * Sanitize identity for safe use in filenames.
 * Rejects path separators and ".." to prevent path traversal.
 */
export function sanitizeIdentity(identity: string): string {
  if (/[\\/:]/.test(identity) || identity.includes("..")) {
    throw new Error(`Invalid identity: must not contain path separators or ".."`);
  }
  return identity;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/identity.ts
git commit -m "feat: parseIdentity resolves tokens via token-map"
```

---

### Task 3: Modify `src/tools/register.ts` — return token, update tip

**Files:**
- Modify: `src/tools/register.ts:1-10` (imports)
- Modify: `src/tools/register.ts:57-71` (return block)

**Interfaces:**
- Consumes: `registerToken(identity: string): string` from `src/token-map.ts`
- Produces: register return value now includes `token: string`

- [ ] **Step 1: Update imports**

```typescript
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseIdentity } from "../identity.js";
import { loadState, saveState } from "../state.js";
import { logEvent } from "../logger.js";
import { stateMutex } from "../mutex.js";
import { err, ok } from "../response.js";
import { registerToken } from "../token-map.js";
```

- [ ] **Step 2: Replace tip + return block** (lines 60-71)

```typescript
    const token = registerToken(identity);

    const prefix = `Set X-AI-Identity: ${token} header on all subsequent requests`;
    const identityInfo = `当前身份: ${identity}(${supervisor ? "supervisor" : developer ? "developer" : "reviewer"})`;
    const tip = supervisor
      ? `${prefix}。${identityInfo}。下一步调用 confirm_dir 接口，参数 work_dir="${workDir}"`
      : `${prefix}。${identityInfo}。下一步调用 wait_for_turn 接口，等待 supervisor 推进`;

    return ok({
      ok: true, identity, token, is_supervisor: supervisor, is_developer: developer,
      phase: state.phase,
    }, tip);
```

- [ ] **Step 3: Run tests to verify no regression**

```bash
npx vitest run
```
Expected: All 24 tests pass

- [ ] **Step 4: Commit**

```bash
git add src/tools/register.ts
git commit -m "feat: register returns token, tip uses token instead of plaintext identity"
```

---

### Task 4: Update tests

**Files:**
- Modify: `src/__tests__/tools.test.ts`

**Interfaces:**
- Consumes: register return value now includes `token` field

- [ ] **Step 1: Read current test expectations for register**

```bash
grep -n "register\|token" src/__tests__/tools.test.ts
```

- [ ] **Step 2: Update register test assertions**

Update `register` test to verify `token` field is present and is a non-empty string:

```typescript
// After the existing register test assertion:
expect(r.token).toBeDefined();
expect(typeof r.token).toBe("string");
expect(r.token.length).toBeGreaterThan(0);
```

- [ ] **Step 3: Add tokenMap behavior test**

Verify that a token resolves back to the correct identity:

```typescript
import { registerToken, resolve } from "../token-map.js";

it("resolves token to identity", () => {
  const token = registerToken("claude");
  expect(resolve(token)).toBe("claude");
});

it("passes through unknown values", () => {
  expect(resolve("unknown-identity")).toBe("unknown-identity");
  expect(resolve("")).toBe("");
});
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run
```
Expected: 26+ tests passed (24 existing + 2+ new)

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/tools.test.ts
git commit -m "test: token resolution + register token field assertions"
```

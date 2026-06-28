# PairFlow 身份 Token 验证 — 设计

> 设计日期: 2026-06-28  
> 关联工作流: 20260628005251（tip 优化）

---

## 1. 问题

§9 tip 优化工作流中识别了 P0-3：`X-AI-Identity` header 是 AI 自报的明文身份，无任何验证机制。AI-A 将 header 从 `deepseek` 改为 `claude` 即可冒充监督者。tip 层面加了身份边界提示，但这是 advisory 的——不提供强制保证。

## 2. 方案

`register` 成功后返回一个 UUID token。后续请求用 token 值替代明文身份名放入 `X-AI-Identity` header。服务端维护进程内 token→identity 映射，`parseIdentity` 自动识别 token 并解析为对应身份。

## 3. 架构

```
register({ supervisor:true, work_dir:"/p" })
  │  X-AI-Identity: claude
  ├──────────────────────────────► PairFlow
  │◄── { ok:true, token:"uuid-xxx", tip:"Set X-AI-Identity: uuid-xxx" }
  │
  │  claim_turn
  │  X-AI-Identity: uuid-xxx     ← 后续请求用 token
  ├──────────────────────────────► PairFlow: parseIdentity → tokenMap.resolve("uuid-xxx") → "claude"
  │◄── { ok:true }
```

## 4. 组件

### 4.1 Token 映射表（新增 `src/token-map.ts`）

```typescript
// 进程级 token → identity 映射，重启清空
const tokenMap = new Map<string, string>();

export function registerToken(identity: string): string {
  const token = crypto.randomUUID();
  tokenMap.set(token, identity);
  return token;
}

export function resolve(raw: string): string {
  return tokenMap.get(raw) ?? raw;  // token 命中 → identity；否则原样返回
}
```

### 4.2 `parseIdentity` 改动（`src/identity.ts`）

```typescript
// 改前
export function parseIdentity(headers) {
  return sanitizeIdentity(headers?.["x-ai-identity"]) || "unknown";
}

// 改后
export function parseIdentity(headers) {
  const raw = headers?.["x-ai-identity"];
  if (!raw) return "unknown";
  const sanitized = sanitizeIdentity(raw.trim());
  return resolve(sanitized);  // token → identity；明文 identity 原样返回
}
```

### 4.3 `register` 改动（`src/tools/register.ts`）

- 调用 `registerToken(identity)` 生成 token
- 返回值新增 `token` 字段
- tip 改为 `"Set X-AI-Identity: {token} header on all subsequent requests"`（不暴露明文身份名）

## 5. 兼容性

| 维度 | 评估 |
|------|------|
| 旧客户端 | register 返回值新增 `token` 字段，旧客户端忽略即可；`resolve` 对明文 identity 原样返回——旧行为不变 |
| 崩溃恢复 | token 随进程丢失，但崩溃后 `.pairflow/` 清除 + 重新 register 是既定流程 |
| 安全边界 | UUID 伪随机对 localhost-only 足够；不防御同机恶意进程 |
| 测试 | `token-map.ts` 纯函数 + 无状态依赖，可独立测试；`identity.ts` 改动仅多一次 `resolve` 调用 |

## 6. 改动范围

| 文件 | 改动 |
|------|------|
| `src/token-map.ts` | 新增：token 生成 + 解析 |
| `src/identity.ts` | `parseIdentity` 调用 `resolve` |
| `src/tools/register.ts` | 生成 token + 返回值扩展 + tip 修改 |
| `src/__tests__/tools.test.ts` | token 相关断言更新 |

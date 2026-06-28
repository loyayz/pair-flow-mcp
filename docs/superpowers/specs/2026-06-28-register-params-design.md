# 修改注册接口入参和校验错误提示

> 设计日期: 2026-06-28

---

## 1. 目标

将 `register` 的 `identity` 从 HTTP header (`X-AI-Identity`) 改为 body 参数，并在所有入参校验失败时返回 curl 格式参考 + 参数说明。

## 2. 背景

当前 `register` 的 `identity` 从 header 取。header 在注册后用于携带 token 做身份认证，但注册前用来传原始 identity 名——同一个 header 承担两种语义，容易造成混淆。改为 body 参数后，header 只做 token 认证，语义统一。

## 3. 入参变更

### 3.1 修改前

```
register({ supervisor: bool, developer: bool, work_dir: string })
identity 从 X-AI-Identity header 取
```

### 3.2 修改后

```
register({ identity: string, supervisor: bool, developer: bool, work_dir: string })
identity 从 body 取
```

### 3.3 校验规则

校验顺序（按以下优先级）：

1. `identity` 缺失 → `err("identity 参数缺失。...curl 参考...")`
2. `identity` 含非法字符（`sanitizeIdentity` 抛出）→ `err("identity 参数非法...curl 参考...")`
3. `work_dir` 缺失 → `err("work_dir 参数缺失。...curl 参考...")`
4. 后续校验（phase/唯一性/角色约束/work_dir 一致性）→ 现有错误信息不变

### 3.4 影响范围

| 文件 | 改动 |
|------|------|
| `src/tools/register.ts` | 入参新增 `identity`，校验失败返回 curl 参考 |
| `src/__tests__/tools.test.ts` | `register` 调用增加 `identity` 参数 |
| `CLAUDE.md` | 不需改动（已无注册 curl 示例） |

其他工具不受影响——它们仍然从 header 取 token 解析身份。

## 4. 校验失败返回格式

每条校验失败返回两部分：错误原因 + curl 参考，用双换行 (`\n\n`) 分隔。

### 4.1 模板

```
{参数名} 参数缺失。正确格式参考（尖括号内为变量）：

curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"register","arguments":{"identity":"<你的身份名>","supervisor":<true|false>,"developer":<true|false>,"work_dir":"<项目根目录绝对路径>"}}}'

- identity: 你的身份名称，如 "claude"。只能包含字母、数字、下划线、连字符
- supervisor: 是否为监督者，true 或 false。两个 AI 中只能有一个监督者
- developer: 是否为开发者，true 或 false。两个 AI 中只能有一个开发者
- work_dir: 项目根目录绝对路径，两个 AI 必须相同
```

`identity` 非法字符时将 `{参数名} 参数缺失` 替换为 `{参数名} 参数非法`，其他内容一致。

### 4.2 错误信息格式规范

错误信息统一用 `参数 xxx {原因}。正确格式参考（尖括号内为变量）：` 开头，后跟 curl + 参数说明。与 tip 的 `[行动]/[产出]/[当前]` 体系并列——tip 是正常流程指引，错误信息是参数纠错指引。

## 5. 范围边界

- ✅ 在范围内：`register` 入参变更、校验错误返回 curl 参考
- ❌ 不在范围内：其他工具的 identity 解析变更、token 机制变更、状态机行为变更

## 6. 实现细节

### 6.1 Zod Schema

`identity` 和 `work_dir` 在 Zod schema 中标记为 `.optional()`，防止 SDK 层在校验失败时返回 Zod 默认错误（`-32602`）而非自定义 curl 参考。实际必填校验在 handler 代码中完成：

```typescript
inputSchema: {
  identity: z.string().optional(),
  supervisor: z.boolean(),
  developer: z.boolean(),
  work_dir: z.string().optional(),
}
```

### 6.2 校验顺序

1. `identity` 缺失 → `badParam("identity", "缺失")`
2. `identity` 非法字符（`sanitizeIdentity` 抛出）→ `badParam("identity", "非法")`
3. `work_dir` 缺失 → `badParam("work_dir", "缺失")`
4. 获取锁 → phase/唯一性/角色/work_dir 一致性校验（现有错误信息不变）

### 6.3 安全说明

注册阶段 identity 来自 body，服务端无法验证其真实性。安全边界在注册后：返回的随机 UUID token 是后续所有请求的唯一认证凭据，token→identity 映射在服务端进程内存中，不可伪造。

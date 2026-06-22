# 0_coding_claude.md — Phase 0 骨架 coding

> identity: claude（开发者 / 监督者）
> phase: implementation | dev_phase: 0 | sub_phase: coding
> bootstrap 阶段：手动归档
> commit_hash: cab122e（PLANNING→IMPLEMENTATION advance 前 commit）

## 交付物

按计划草案 v2 Phase 0：

1. `package.json` + `tsconfig.json` + 依赖安装
2. HTTP MCP Server skeleton（localhost:3100/mcp）
3. `ping` 工具
4. `who_am_i` 工具（X-AI-Identity header 解析）
5. `.pairflow/` 目录加入 `.gitignore`
6. Vitest 集成验证

## 实现要点

- MCP Server 使用 `@modelcontextprotocol/sdk` 的 StreamableHTTP 传输
- 身份解析从 HTTP header `X-AI-Identity` 读取，无 header → "unknown"
- ping 返回 `{ ok: true, uptime }`，uptime 从 server 启动时开始计算
- who_am_i 对未注册 identity 返回 `{ identity, registered: false }`

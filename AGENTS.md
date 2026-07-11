# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## 项目

PairFlow — 本地 HTTP MCP Server，驱动两个 AI 按结构化工作流完成结对编程（互审 + 知识共享 + 方案互补）。

**设计规格**：`docs/design.md`（唯一权威来源，所有实现必须对齐此文档）。

## 技术栈

Node.js / TypeScript · `@modelcontextprotocol/sdk`（HTTP Streamable）· `async-mutex` · `uuid` · Vitest · 本地 JSON 原子写入

## 命令

```bash
npx tsx src/index.ts                          # 开发运行
npx vitest run                                # 测试
npx vitest run src/__tests__/<file>.test.ts   # 单文件测试
npx vitest                                    # 监听模式
curl http://localhost:35690/health            # 健康检查
```

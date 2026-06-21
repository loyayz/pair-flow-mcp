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
- **开发阶段**：按 Phase 0→4 顺序推进，每 Phase 有硬性判定标准（见 spec §14）。当前处于 Phase 0，代码尚未开始

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

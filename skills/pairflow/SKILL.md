---
name: pairflow
description: 启动 PairFlow MCP Server 并完成 register + confirm_task 结对编程初始化。当用户提到"启动 pairflow"、"结对编程"、"开始结对"、"初始化工作流"、"pair" 时使用此 skill。
---

# PairFlow Setup

启动 PairFlow MCP Server，依次调用 register 和 confirm_task 完成结对编程初始化。

## 1. 收集参数

向用户收集以下信息（一问一答，不要一口气全问）：

**a) 监督者** — "你是监督者吗？监督者控制流程推进（advance）、处理 P0 升级、汇总阶段负责最终报告。"

**b) 开发者** — "你是开发者吗？开发者在实现阶段负责代码产出。"

**c) 身份名** — "你的身份名是什么？" 建议用工具名（如 `"claude"`、`"codex"`）。

**d) 项目根目录** — "项目根目录绝对路径？" 建议用当前 git 仓库根（`git rev-parse --show-toplevel`）。

**e) 任务文档路径** — "任务文档相对于项目根目录的路径是什么？"（如 `docs/task/xxx.md`）。调用 confirm_task 时拼装为 `<work_dir>/<task_path>`。

**f) 任务类型** — "任务类型是 development（开发，完整四阶段）还是 requirements（需求，跳过 planning 和 implementation）？" 默认 development。

每个问题给出建议值让用户直接回车确认即可，减少输入成本。

## 2. 启动 PairFlow MCP Server

检查 server 是否已在运行：

```bash
curl -s http://localhost:3100/health
```

若返回 `{"ok":true,...}` 则跳过启动步骤。

若未运行，询问用户 **"PairFlow MCP 代码在哪个目录？"** 然后启动：

```bash
cd <pairflow代码目录> && npx tsx src/index.ts &
```

## 3. 调用 register

使用确认好的 identity 调用 register：

```
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --noproxy "*" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"register","arguments":{"identity":"<你的身份名>"}}}'
```

从响应中提取 `token`，后续所有请求通过 `X-AI-Identity: <token>` header 携带。

## 4. 调用 confirm_task

使用收集到的参数调用 confirm_task：

```
curl -s -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-AI-Identity: <token>" \
  --noproxy "*" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"confirm_task","arguments":{"task_path":"<work_dir>/<task_path>","task_type":"<development|requirements>","supervisor":<true|false>,"developer":<true|false>,"work_dir":"<项目根目录>"}}}'
```

## 5. 处理响应

根据 confirm_task 返回的 tip 判断所处场景：

- **"等待对方 AI 加入"** — 你是第一个。提醒用户"等待对方 AI 用相同 task_path 调用 confirm_task 加入"
- **"双方已就位"** — 结对已成功建立。根据 tip 提示调用 `wait_for_turn` 继续
- **错误** — 根据错误信息修正参数后重试

将 token 告诉用户或保存以备后续使用。

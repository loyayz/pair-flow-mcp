---
name: pairflow
description: 启动 PairFlow MCP Server 并完成 register + confirm_task 结对编程初始化。当用户提到"启动 pairflow"、"结对编程"、"开始结对"、"初始化工作流"、"pair" 时使用此 skill。
---

# PairFlow Setup

启动 PairFlow MCP Server，依次调用 register 和 confirm_task 完成结对编程初始化。

## 1. 收集参数

向用户收集以下信息（一问一答，不要一口气全问）：

**a) 监督者** — "你是监督者吗？监督者控制流程推进（advance）、判断分歧是否升级用户、汇总阶段负责最终报告。"

**b) 开发者** — "你是开发者吗？开发者在实现阶段负责代码产出。"

**c) 身份名** — "你的身份名是什么？" 建议用工具名（如 `"claude"`、`"codex"`），长度 1–64，只能包含字母、数字、下划线、连字符；不得使用保留字 `unknown` 或 `idle`（大小写不敏感）。

**d) 项目根目录** — "Git 仓库根目录绝对路径？" 必须是含 `.git` 文件或目录的已存在仓库根，可用当前 git 仓库根（`git rev-parse --show-toplevel`）。

**e) 任务文档路径** — "任务文档绝对路径是什么？" 必须是位于 work_dir 下的已存在文件，且不得包含 `.` 或 `..` 路径段。

**f) 任务类型** — "任务类型是 development（开发，完整四阶段）还是 requirements（需求，跳过 planning 和 implementation）？" 默认 development。

若用户明确要求自定义端口，再询问端口；否则使用默认端口 `35690`。以下命令中的 `<port>` 均使用该值。

每个问题给出建议值让用户直接回车确认即可，减少输入成本。

## 2. 启动 PairFlow MCP Server

检查 server 是否已在运行：

```bash
curl -s --noproxy "*" http://127.0.0.1:<port>/health
```

若返回 `{"ok":true,...}` 则跳过启动步骤。

若未运行，询问用户 **"PairFlow MCP 代码在哪个目录？"** 然后启动：

```bash
cd <pairflow代码目录> && npx tsx src/index.ts --port <port> &
```

## 3. 调用 register

使用确认好的 identity 调用 register：

```
curl -s -X POST http://127.0.0.1:<port>/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --noproxy "*" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"register","arguments":{"identity":"<你的身份名>"}}}'
```

从响应中提取 `token`，后续所有请求通过 `X-AI-Identity: <token>` header 携带。

## 4. 调用 confirm_task

使用收集到的参数调用 confirm_task：

```
curl -s -X POST http://127.0.0.1:<port>/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-AI-Identity: <token>" \
  --noproxy "*" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"confirm_task","arguments":{"task_path":"<任务文档绝对路径>","task_type":"<development|requirements>","is_supervisor":<true|false>,"is_developer":<true|false>,"work_dir":"<项目根目录绝对路径>"}}}'
```

## 5. 处理响应

根据 confirm_task 返回的 tip 判断所处场景：

- **"等待对方 AI 加入"** — 你是第一个加入的。调用 `wait_for_turn`；它会先等待对方 AI 使用相同 task_path 完成 confirm_task，再继续等待 turn 到你并自动返回。
- **"双方已就位"** — 结对已成功建立：
  - **你是监督者**：`wait_for_turn` 会立即返回（turn 已切给你），按指引调 `advance` 开始工作流
  - **你不是监督者**：调 `wait_for_turn`，等待监督者 advance 后将 turn 切给你
- **错误** — 根据错误信息修正参数后重试

无论当前是哪种成功场景，`confirm_task` 后的下一步都调用 `wait_for_turn`。将 token 告诉用户或保存以备后续使用。

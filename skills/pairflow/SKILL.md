---
name: pairflow
description: Use when the user asks to "启动 pairflow", "结对编程", "开始结对", "初始化工作流", or otherwise wants to start a PairFlow MCP pairing session and complete register + confirm_task initialization.
---

# PairFlow Setup

启动 PairFlow Server，完成当前 AI 的 `register`、`confirm_task` 和首次 `wait_for_turn`。初始化后，后续行动以 PairFlow 返回的 tip 为准，不在 skill 中复制状态机。

## 收集参数

优先复用上下文中已经明确的信息。缺少的信息一次只问一个，并给出建议值：

1. **identity**：建议使用工具名，如 `codex` 或 `claude`。长度 1-64，仅允许字母、数字、下划线、连字符；`unknown`、`idle` 是保留字。服务端统一转为小写。
2. **任务类型**：`development` 走完整流程；`requirements` 跳过 planning 和 implementation。默认建议 `development`。
3. **监督者**：询问当前 AI 是否为 Supervisor，对应 `is_supervisor`。
4. **开发者**：询问当前 AI 是否为 Developer，对应 `is_developer`。requirements 任务建议 `is_developer=false`。
5. **work_dir**：包含非链接 `.git` 文件或目录的仓库根目录绝对路径。
6. **task_path**：位于 work_dir 内的已有任务文档绝对路径。
7. **port**：用户未要求自定义时使用 `35690`。

`work_dir` 和 `task_path` 不得包含独立的 `.` 或 `..` 路径段。不要替用户猜测或静默改写非法路径。

职责组合由两位参与者共同满足：始终恰好一个 Supervisor；development 任务还要恰好一个 Developer；requirements 任务允许没有 Developer；Supervisor 与 Developer 可以由同一参与者兼任。

## 启动 Server

先检查：

```bash
curl -s --noproxy "*" http://127.0.0.1:<port>/health
```

返回 `{"ok":true,...}` 时复用现有 Server。否则确认 PairFlow 代码目录，并在该目录运行：

```bash
npx tsx src/index.ts --port <port>
```

使用当前环境适用的后台进程方式启动，保持日志可检查；不要固定套用 Unix `&` 语法。启动后再次检查 health，成功后才继续。

## 初始化当前参与者

若 PairFlow MCP 工具已经直接可用，优先直接调用工具；否则使用 HTTP MCP 请求。

### register

```bash
curl -s -X POST http://127.0.0.1:<port>/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --noproxy "*" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"register","arguments":{"identity":"<identity>"}}}'
```

从响应提取 canonical lowercase `identity` 和 `token`。后续请求都携带 `X-AI-Identity: <token>`。token 仅作为当前 AI 的本地工作流凭据；不要主动向用户展示 token，也不要写入任务文档或提交到 Git。

### confirm_task

```bash
curl -s -X POST http://127.0.0.1:<port>/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-AI-Identity: <token>" \
  --noproxy "*" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"confirm_task","arguments":{"task_path":"<task_path>","task_type":"<development|requirements>","is_supervisor":<true|false>,"is_developer":<true|false>,"work_dir":"<work_dir>"}}}'
```

两个 AI 必须传入相同的规范化 task_path 和 work_dir。任何成功响应都表示当前 token 已加入对应 workflow；不要根据“首位参与者”或“双方已就位”等文案选择不同下一步。

### wait_for_turn

无论当前是哪种成功场景，`confirm_task` 后的下一步都调用 `wait_for_turn`：

```bash
curl -s -X POST http://127.0.0.1:<port>/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-AI-Identity: <token>" \
  --noproxy "*" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"wait_for_turn","arguments":{}}}'
```

它会先等待另一位参与者完成 confirm_task，再等待 turn 到当前 AI。首次返回后初始化完成，按响应 tip 执行工作流。

## 错误处理

| 情况 | 处理 |
|---|---|
| health 失败 | 检查启动日志和代码目录；端口冲突时报告原因，并用 `--port` 选择用户确认的其他端口 |
| identity 非法 | 按 register tip 修正；不要使用保留字 |
| work_dir / task_path 非法 | 使用真实存在的绝对路径；不得用相对路径或包含 `.`、`..` 的路径重试 |
| 职责组合冲突 | 向用户说明两位参与者的 Supervisor/Developer 组合冲突；在职责冻结前用正确布尔值重新 confirm_task |
| confirm_task 成功但 roster 未完整 | 不打断用户，保持本次 `wait_for_turn` |
| 单次等待达到 600 秒 | 这是请求上限，不是 workflow 失败；自动继续调用 `wait_for_turn` |
| 返回超过 30 分钟未确认或未领取 warning | 向用户报告 PairFlow 返回的具体状态，由用户决定是否继续等待 |
| 返回 `phase:"idle", turn:"idle"` | workflow 已结束，停止等待 |

不要通过频繁调用 `get_state` 代替等待。只有 `advance` 响应不确定时，才先调用 `get_state` 判断是否已推进。

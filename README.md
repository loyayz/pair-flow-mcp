# PairFlow

本地 HTTP MCP Server，驱动两个 AI 按结构化工作流完成结对编程——持续互审 + 知识共享 + 方案互补。

## 工作流

```
IDLE → 需求分析 → 实施计划 → 代码实现(coding↔review) → 汇总 → IDLE
```

两个 AI 交替产出与评审，监督者控制阶段推进。development 任务执行完整四阶段；requirements 任务在需求分析后直接进入汇总。

## 快速开始

### 1. 安装

```bash
git clone <repo-url> && cd pair-flow-mcp
npm install
```

### 2. 启动

```bash
npx tsx src/index.ts
```

Server 仅监听 `127.0.0.1`，默认端口为 `35690`。需要自定义端口时传入 CLI 参数：

```bash
npx tsx src/index.ts --port 3200
```

端口必须是 `1–65535` 的整数。服务提供 HTTP MCP（`/mcp`）+ 健康检查（`/health`）。
运行 `npx tsx src/index.ts --help` 可查看启动参数。
每个 workflow 的产出归档固定写入目标项目的 `<work_dir>/handoff/{workflow_id}/`。`work_dir` 必须是含 `.git` 文件或目录的 Git 仓库根，支持普通仓库和 linked worktree。

### 3. 使用

**推荐方式：用 pairflow skill 初始化**

项目内置了 pairflow skill（`skills/pairflow/SKILL.md`），可引导 AI 自动完成 server 启动、register、confirm_task 全流程，逐项收集参数并给出建议值。

安装 skill（以 Claude Code 为例）：

```bash
cp -r skills/pairflow ~/.claude/skills/pairflow
```

安装后对 AI 说"启动 pairflow"即可，skill 会自动引导完成 register + confirm_task 初始化。两个 AI 各执行一次，用相同的规范化绝对 task_path 自动成对。

**手动方式：**

两个 AI 分别调 MCP 工具：

| 工具 | 说明 |
|------|------|
| `register` | 声明身份，获取 token |
| `confirm_task` | 确认任务文档和职责组合，两个 AI 相同规范化绝对 task_path 成对 |
| `wait_for_turn` | 长轮询等待 turn 到自己（10s 间隔，600s 超时） |
| `submit` | 提交产出（绝对 file_path + git_commit_hash） |
| `advance` | 监督者推进到下一阶段 |
| `get_state` | 查看当前状态和行动指引；需要有效注册 token |

除 `ping`、`who_am_i`、`register` 外，所有工具都要求通过 HTTP header `X-AI-Identity: <token>` 携带有效注册 token。register 返回 token，confirm_task 绑定 token 到工作流。
PairFlow 信任本机进程，不提供外部用户身份认证；token 用于参与者身份路由和工作流操作授权，避免正常协作中的串身份与串工作流。

完整设计文档见 `docs/design.md`。

## 定制 Tip 模板

PairFlow 所有 AI 行动指引（`tip` 字段）均由 `templates/tips/` 下的纯文本模板控制。fork 维护者可直接编辑这些文件来定制提示文案，无需修改 TypeScript 源码。

**编辑流程**：
1. 编辑 `templates/tips/` 下对应场景的 `.md` 文件
2. 运行 `npx vitest run` 确认模板校验通过
3. 重启 PairFlow 服务

详细语法、变量列表和编辑示例见 `templates/tips/README.md`。

> **注意**：v1 不支持 `--templates` CLI 参数或热加载。模板修改后需重启服务生效。模板加载失败会导致服务启动失败（不静默回退）。

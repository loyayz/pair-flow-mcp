# PairFlow

本地 HTTP MCP Server，驱动两个 AI 按结构化工作流完成结对编程——持续互审 + 知识共享 + 方案互补。

## 工作流

```
IDLE → 需求分析 → 实施计划 → 代码实现(coding↔review) → 汇总 → IDLE
```

两个 AI 交替产出与评审，监督者控制阶段推进。完整四阶段覆盖从需求到交付的软件开发生命周期。

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

Server 监听 `localhost:3100`，提供 HTTP MCP（`/mcp`）+ 健康检查（`/health`）。

### 3. 使用

**推荐方式：用 pairflow skill 初始化**

项目内置了 pairflow skill（`skills/pairflow/SKILL.md`），可引导 AI 自动完成 server 启动、register、confirm_task 全流程，逐项收集参数并给出建议值。

安装 skill（以 Claude Code 为例）：

```bash
cp -r skills/pairflow ~/.claude/skills/pairflow
```

安装后对 AI 说"启动 pairflow"即可，skill 会自动引导完成 register + confirm_task 初始化。两个 AI 各执行一次，用相同 task_path 自动成对。

**手动方式：**

两个 AI 分别调 MCP 工具：

| 工具 | 说明 |
|------|------|
| `register` | 声明身份，获取 token |
| `confirm_task` | 确认任务文档和角色（supervisor/developer），两个 AI 相同 task_path 成对 |
| `wait_for_turn` | 长轮询等待 turn 到自己（10s 间隔，600s 超时） |
| `submit` | 提交产出（file_path + git_commit_hash） |
| `advance` | 监督者推进到下一阶段 |
| `get_state` | 查看当前状态和行动指引 |
| `get_archived_files` | 列出归档文件 |
| `get_archived_file_content` | 读取归档文件内容 |

所有请求通过 HTTP header `X-AI-Identity: <token>` 携带身份。register 返回 token，confirm_task 绑定 token 到工作流。

完整设计文档见 `docs/design.md`。

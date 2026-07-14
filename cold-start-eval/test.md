# Cold-Start Evaluation 测试步骤

本文档供测试操作者使用。目标是让一个没有接触过 PairFlow 源码、文档和历史对话的全新 AI，仅根据运行时提供的信息理解 `instruction`，并生成待 Codex 解读的测试报告。

## 1. 启动 PairFlow Server

在 PairFlow 仓库中单独打开一个终端：

```powershell
cd C:\code\loyayz\pair-flow-mcp
npx tsx src/index.ts
```

默认 Server 地址为 `http://127.0.0.1:35690`。测试期间保持该终端运行。

## 2. 将测试目录复制到仓库外

首次测试时将目录复制到仓库外。例如：

```powershell
Copy-Item `
  C:\code\loyayz\pair-flow-mcp\cold-start-eval `
  C:\temp\pairflow-cold-start-claude `
  -Recurse
```

要求：

- 副本不得位于 PairFlow 仓库内部。
- 同一副本可以重复执行；每次执行都会创建新的 `runs/<run-id>/` 和独立 PairFlow 任务，已有 run 不会被覆盖。
- 每次评估必须开启全新的 AI 会话，并且只允许读取该次命令打印的输入路径，不得读取其他 run。

## 3. 在副本目录启动全新的 AI 会话

以 Claude Code 为例：

```powershell
cd C:\temp\pairflow-cold-start-claude
node --version
claude
```

脚本要求 Node.js `>=24.0.0`。也可以使用 Codex 或其他能够执行终端命令、读取和写入文件的 AI，但必须开启全新会话，并把工作目录限制在复制后的 `cold-start-eval` 目录。

## 4. 将以下提示词原样发送给被测 AI

```text
这是一次 PairFlow instruction 冷启动评估。

请严格遵守以下要求：

1. 不要读取 scripts/instruction.ts。
2. 不要读取 PairFlow 源码、设计文档、仓库文档、Skills、历史对话。
3. 不要使用你已有的 PairFlow 知识。
4. 在当前目录执行一次：
   node scripts/instruction.ts
5. 执行成功后，终端会打印本次 instruction-eval-input.md 的绝对路径；只读取这个路径，不要读取其他 run。
6. 根据该文件中的 Required report format 完成所有场景，并精确记录相关 context 字段。
7. 对业务拒绝场景，结合 Attempted request、Response 和紧邻前一条 current-turn instruction 判断参数来源及修正方式；只把业务错误明确指出的参数判为无效，其他参数必须保留或独立验证。
8. 遇到未知字段或值时，只重读当前 input 中 Runtime discovery 已附的 protocol catalog；明确回答重读是否解决，不要把结论写成取决于未来的 health 响应。只有 catalog 能将未知字段或值解释为受支持语义时，resolved 才为 yes；仅确认其不兼容时，resolved 必须为 no，并按 `unknown_value_policy.unresolved` 停止自动执行。
9. 报告末尾按 provenance 给出准确场景数量。
10. 将结果保存为该 input 同目录下的 instruction-eval-report.md。
11. 不要评分，不要修改 instruction-eval-input.md，也不要再次执行脚本。
```

如果 PairFlow Server 使用自定义地址，将第 4 条命令替换为：

```text
node scripts/instruction.ts --base-url http://127.0.0.1:3200
```

## 5. 检查测试产物

被测 AI 完成后，本次终端打印的 run 目录中应存在：

- `runs/<run-id>/instruction-eval-input.md`：脚本生成的本次测试输入；
- `runs/<run-id>/instruction-eval-report.md`：被测 AI 按要求生成的本次报告。

脚本本身只生成本次 run 的 `instruction-eval-input.md`，不会生成报告，也不会评分。如果同目录缺少 `instruction-eval-report.md`，说明被测 AI 没有完成任务。

报告还应满足以下可检查条件：逐场景覆盖、相关 context 与输入一致、业务拒绝分析引用本 case 的 attempted request 且不把未报错参数擅自判废、未知值给出明确的重读结果，并在末尾提供准确的 provenance 计数。

## 6. 将报告交给 Codex 解读

向负责本任务的 Codex 提供报告路径，例如：

```text
请解读这份冷启动报告：
C:\temp\pairflow-cold-start-claude\runs\<run-id>\instruction-eval-report.md
```

Codex 负责评分和解读报告，判断零背景 AI 是否能够理解 instruction 的字段、动作、工具、参数来源、引用、产物、决策分支、异常处理、protocol catalog 重读规则及 observed context。被测 AI 不负责给自己评分。

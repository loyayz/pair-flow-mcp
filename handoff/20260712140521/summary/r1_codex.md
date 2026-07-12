# 结构化行动协议 — 阶段总结草稿（r1, codex）

> 汇总人：codex（supervisor）
>
> 工作流：`20260712140521`
>
> 任务文档：`docs/task/structured-action-protocol.md`

## 1. 交付结果

PairFlow 已新增与自然语言 `tip` 并行的机器可读 `instruction` 协议。服务端仍是唯一状态机权威；客户端可只读取 instruction 确定下一动作、允许工具、可靠上下文、必读引用、预期产物和 Supervisor 收敛分支，无需解析可编辑模板文案。

本次交付包含：

- `src/instruction.ts`：8 种 action、5 种工具、15 个稳定 reason code、context/reference/output/decision 契约与 `Guidance` 构造器；
- `src/response.ts`：instruction 保留字段保护，业务拒绝统一 `fix_request / REQUEST_REJECTED`；
- `src/tip.ts`：`selectTip` 提升为单一 `selectGuidance` 场景入口，`buildGuidance()` 同时生成 tip 与 instruction，`buildTip()` 保持兼容；
- register、confirm_task、get_state、wait_for_turn、advance、submit 的全部现有 tip 业务分支迁移；
- 契约、状态场景、模板独立性、wait timeout/warning 回归测试；
- `docs/design.md` §10.5 及工具出参同步更新。

提出人：claude（实现）；codex（评审确认）。

## 2. 关键决策

1. **单一场景选择。** tip 和 instruction 必须消费同一个 guidance 场景，禁止两个生成器各自重走状态分支。（提出人：claude、codex，共识）
2. **Confirm 后首次 wait。** confirm_task 成功固定返回 `wait_for_turn`；新增 `CONFIRMED_NEEDS_TURN_CLAIM`，避免用 `TURN_READY` 暗示绕过首次 wait。（提出人：codex；claude 确认）
3. **Idle Supervisor 确定性 advance。** roster 完整时 idle Supervisor 获得 `advance`；其他参与者等待。需求阶段纠正了把两者合并为 wait 的错误映射。（提出人：codex；claude 确认）
4. **Supervisor 收敛是双分支。** `decide_convergence` 同时允许 advance 与 submit，并携带 decision 和继续产出所需 required_output；服务端不替代内容判断。（提出人：claude、codex，共识）
5. **Advance 后仍先 wait。** 非最终 advance 返回 `wait_for_turn / PHASE_ADVANCED`；完整新回合 instruction 由后续 wait/get_state 提供，且不把尚未存在的未来产出伪装成 reference。（提出人：codex；claude 确认）
6. **Timeout 与 stale 分离。** 普通 600 秒上限自动续等；30 分钟 roster/turn stale 才 `report_user`。两类专有响应均携带可靠 context。（提出人：claude、codex，共识）
7. **未知 reason code 安全失败。** 客户端可提示升级或展示 tip，但不得回退解析 tip 自动决定工具/路径/状态。（提出人：codex；claude 确认）
8. **引用必要性可执行。** tip 明确要求审阅/结合的 previous_output、previous_review、archive 使用 `required:true`；commit 存在时规范为小写，不存在则省略。（提出人：codex；claude 修复）

## 3. 实施与评审过程

Claude 按 5 个实现任务完成首版：契约与响应封装、状态 guidance、注册/等待 handler、advance/submit handler、文档与验收层。Codex 首轮代码评审独立运行全量验证后发现两个 P1：必读 references 被标为可选；wait timeout/warning 缺少 instruction.context。

Claude 在 `cf57488` 修复生产代码。Codex 复审确认代码正确，但发现关键边界没有回归测试，因此未提前 advance。Claude 随后在 `fb1691c` 补充四个 wait 专有分支和 implementation round>2 previous_review 测试，测试总数由 251 增至 253。

这两轮互审确保完成标准不仅是“当前代码可运行”，还包括协议语义和防回归证据。

提出人：claude（实现/修复）；codex（两轮评审与验收）。

## 4. 最终验证

Supervisor 在进入 summary 前使用工作区 Node 运行时重新执行：

```text
TypeScript: node node_modules/typescript/bin/tsc --noEmit
Exit code: 0

Focused: wait-for-turn.test.ts + instruction-scenarios.test.ts
2 files passed, 33 tests passed, Exit code: 0

Full Vitest:
24 files passed, 253 tests passed, Exit code: 0

git diff --check 65bdec6..fb1691c
Exit code: 0，无格式错误

git status --short
无业务代码或用户未提交改动
```

验证人：codex。

## 5. 遗留问题

没有阻塞本任务验收的未决功能或测试失败。

唯一已知非阻塞兼容债务：`response.ok()` 暂时仍接受 legacy string tip 参数；当前所有业务 handler 已迁移为 Guidance，因此现有响应没有遗漏 instruction，但该内部兼容路径不能从类型层强制“有 tip 必有 instruction”。Claude 建议暂保留以避免隐式兼容破坏，Codex 接受其作为独立后续清理项，而非扩大本任务范围。

## 6. 后续建议

1. 官方 skill/CLI/GUI 接入时优先消费 instruction，并将 tip 仅作为自然语言思考指引展示。
2. 客户端对未知 reason code 采取安全失败与升级提示，不解析 tip 做自动化兜底。
3. 可单独建立内部 API 清理任务，移除 `ok(data, stringTip)` legacy 路径，使“tip 与 instruction 同生”成为编译期约束。
4. 后续 heartbeat、可协商 wait、Git preflight 等需求建立在 instruction 上，不在本次实现中回填状态判断。

## 7. 验收结论

任务文档 §12 的九项验收标准均有实现与测试证据：所有现有 tip 业务响应具备 instruction；无行动和 HTTP/MCP 协议层响应保持现状；Supervisor 双分支、模板独立性、POSIX 路径、完整场景矩阵、类型检查、全量测试和设计文档同步均已完成。

建议对方审阅本草稿；若无新增事实性问题，summary 阶段可收敛并结束工作流。

# 结构化行动协议 — 实施计划审阅（r2, claude）

> 提出人：claude（developer）
>
> 对照产出：`planning/r1_codex.md`（commit `93b2eeb0aa75317e6674fcf1a048b010795e2d2a`）

## 总体评价

计划质量高，5 个任务分解合理，TDD 流程清晰，每个任务有明确的文件、接口和 RED→GREEN→commit 步骤。以下逐任务审阅，标注同意点和需调整点。

---

## Task 1: Instruction contract and protected response envelope

**同意整体设计。** 类型文件 `src/instruction.ts` 和受保护的 `ok()`/`err()` 是最合理的第一步——建立不变量基础设施后再铺开到各 handler。

### 同意点

- `Guidance = { tip, instruction }` 作为统一载体，确保同源生成
- `err()` 统一生成 `REQUEST_REJECTED`，简化拒绝路径
- `ok()` 从 business data 副本中 delete instruction，防止注入
- 不引入 Zod 等额外依赖——PairFlow 已是纯 TS 项目，不需要运行时 schema 校验

### 建议调整

**S1.1: reason_code 数量需与 task 文档对齐。** Step 3 列出了 15 个 reason code（含 `CONFIRMED_NEEDS_TURN_CLAIM` 和 `UNSUPPORTED_WORKFLOW_STATE`），比 task 文档 §6 的 13 个多了 2 个。这两个新增是合理的——`CONFIRMED_NEEDS_TURN_CLAIM` 满足 confirm_task 首次必须 wait 的约束，`UNSUPPORTED_WORKFLOW_STATE` 覆盖 `state.unknown` 分支。建议在 plan 中补充说明这两个新增枚举的业务原因，避免读者认为枚举数量与 spec 不一致是遗漏。

**S1.2: `guidance()` 构造器入参。** 当前签名 `guidance(key, variables, instruction)` 中 instruction 作为完整对象传入。但 instruction 中的 `required_output.file_path` 必须与 `outFile()` 一致，`context` 必须从 state 推导。这意味着直接调用 `guidance()` 的 handler（如 register、advance）需要自己构造正确的 instruction——如果它们算错了 file_path 或 context，tip 和 instruction 就会不一致。

建议：在 plan 中增加一条约束——所有 handler 中传给 `guidance()` 的 `file_path` 和 `context` 必须使用与 `selectGuidance()` 相同的 path helper（`outFile()`、`workflowArchivePath()` 等），不得手动拼接路径字符串。Task 5 的一致性测试应覆盖这一点。

> **提出人：claude**

---

## Task 2: Single state-guidance selector

**同意。** 这是整个实现的核心——`selectTip` → `selectGuidance`，每个分支返回 `{ key, variables, instruction }`。

### 同意点

- `buildGuidance(state, identity)` 统一入口
- `buildTip` 保留为 `buildGuidance(...).tip`，保证现有调用方兼容
- `holds_turn` 和 `can_advance` 的判定规则明确
- `state.unknown` → `report_user` + `UNSUPPORTED_WORKFLOW_STATE`，不伪装为 `REQUEST_REJECTED`

### 建议调整

**S2.1: Idle Supervisor 测试 fixture 完整性。** Step 1 的 idle Supervisor 测试断言了 `can_advance: true`。需要额外验证：当 roster 不完整时，idle Supervisor 的 `next_action` 应为 `wait_for_turn`（不是 `advance`），因为 advance 要求两位参与者就位。

**S2.2: references 的 commit hash 来源。** `references` 中的 commit hash 来自 `last_submission_by_participant`。Step 3 提到"References are built from task, planning document, previous output/review and archive paths already used by that same template branch"——需要明确：当对应 submission 的 `commit_hash` 为 null 时（phase 首轮），reference 的 `commit` 字段应省略，不传入空字符串。

> **提出人：claude**

---

## Task 3: Registration, confirmation, state and wait guidance

**同意。** Handler 迁移路径清晰——把 `ok(data, renderTip(key, vars))` 替换为 `ok(data, guidance(key, vars, instruction))`。

### 同意点

- register success 不包含 token 或 context 在 instruction 中——正确，token 是 HTTP header 的事
- confirm_task 成功固定返回 `wait_for_turn`，即使调用者最终持有 turn
- `CONFIRMED_NEEDS_TURN_CLAIM` vs `ROSTER_INCOMPLETE` 的区分
- get_state 与 wait_for_turn 语义一致性测试（Step 4）

### 建议调整

**S3.1: register 的参数校验拒绝也需 instruction。** register handler 中 identity 缺失或非法时调用 `err()`，这已经通过 Task 1 的 `err()` 改造自动获得 `fix_request` + `REQUEST_REJECTED`。但需要确认：register 的 `badParam()` 辅助函数返回的 `err()` 走的是同一个 `err()` 封装，不会被遗漏。

**S3.2: get_state unbound/inactive 的 reason_code。** Step 1 说 `get-state.inactive` → `WORKFLOW_UNBOUND`。但 `get-state.unbound`（token 有效但未绑定 workflow）也应该用 `WORKFLOW_UNBOUND`。两者应统一还是区分？建议统一用 `WORKFLOW_UNBOUND`——因为两者的客户端行为相同（重新 confirm_task）。

> **提出人：claude**

---

## Task 4: Advance and submit guidance

**同意核心设计决策。** advance 返回 `wait_for_turn` + `PHASE_ADVANCED`（而非直接返回 `produce_and_submit`）是正确的分层——advance 触发 phase 变更，新 phase 的完整指引由后续 `wait_for_turn` 返回。这避免了在 advance handler 中复制 `buildGuidance` 的逻辑。

### 同意点

- 非最终 advance → `wait_for_turn` + `PHASE_ADVANCED`
- 最终 advance（summary→idle）→ `stop` + `WORKFLOW_COMPLETED`
- submit 所有变体 → `wait_for_turn` + `SUBMISSION_ACCEPTED`
- submit.advance-ready 不返回 `decide_convergence`（submit 的调用者已交出 turn）
- exact replay 复用同一 helper 且产生相同 instruction

### 建议调整

**S4.1: advance 的 reference 字段。** Step 3 说"the already computed `reqFile/planFile/implFile/summaryFile` may appear as a reference but not as a `required_output`"。这个区分很重要——advance 响应中的文件路径是"对方将产出到 X"的参考信息，不是调用者本人的产出任务。建议在 plan 中明确：advance 响应的 `references` 中，新 phase 首个产出文件用 `kind: "requirements"` / `"plan"` / `"previous_output"`（视 phase 而定）+ `required: false`（因为调用者不是产出者）。

**S4.2: submit exact replay 的场景测试。** 需要在 submit 测试中显式覆盖 exact replay 返回相同 instruction 的场景——不只是 tip 相同，instruction 的每个字段都应与首次 submit 一致。

> **提出人：claude**

---

## Task 5: Cross-handler contract matrix and template independence

**同意。** 这是验收层——确保全局一致性。

### 同意点

- 全场景矩阵覆盖
- 模板独立性测试（改模板文案后 instruction 不变）
- design.md 同步更新
- self-review checks（rg 检查占位符残留）
- 完整验证（tsc + vitest + git diff --check）

### 建议调整

**S5.1: 模板独立性测试需额外验证。** Step 2 说"render the same state before and after rewriting its template action text"。建议同时验证：
- 修改 `[产出]` 段不改变 `required_output`
- 修改 `[当前]` 段不改变 `context`
- 完全替换模板文件（保留 section marker 结构）不改变 instruction 任何字段

**S5.2: 验收标准追踪。** 建议在 Task 5 中显式引用 task 文档 §12 的 9 条验收标准，逐条标注对应的测试或用 `N/A` 说明不适用原因，确保无遗漏。

> **提出人：claude**

---

## 总结

计划结构完整、可执行。5 个建议调整均为精度问题，不影响任务分解和顺序：

| 建议 | 严重度 | 说明 |
|------|--------|------|
| S1.1 新增 reason code 说明 | 低 | 文档对齐，plan 补充即可 |
| S1.2 path helper 一致性约束 | 中 | 防止 handler 中手工拼接路径 |
| S2.1 idle roster 不完整测试 | 低 | 边界条件补充 |
| S2.2 references commit null 处理 | 低 | 空值语义明确 |
| S3.2 get-state reason code 统一 | 低 | WORKFLOW_UNBOUND 覆盖两种场景 |
| S4.1 advance reference kind | 低 | 语义精确化 |
| S4.2 exact replay instruction 一致性 | 中 | 幂等保证 |
| S5.1 模板独立性扩展验证 | 低 | 更全面的不变性保证 |
| S5.2 验收标准追踪 | 低 | 可追溯性 |

**同意按此计划实施。** 所有建议可在对应 Task 实施时直接纳入，无需重写 plan。

> **提出人：claude**

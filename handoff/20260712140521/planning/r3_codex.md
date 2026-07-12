# 结构化行动协议 — 实施计划审阅（r3, codex）

> 提出人：codex（supervisor）
>
> 对照产出：`planning/r2_claude.md`（commit `809df35`）

## 已纳入计划的建议

`codex` 接受并已直接修订 `planning/r1_codex.md`：

1. 说明两个新增 reason code 相对最小集合的业务必要性。（提出人：claude）
2. 所有 handler 的路径/context 必须复用同一状态和 path helper，禁止手拼路径。（提出人：claude）
3. 增加 idle Supervisor roster 不完整时只能 wait 的边界测试。（提出人：claude）
4. submission hash 为 null 时省略 reference.commit，不输出空串。（提出人：claude）
5. 明确 register 参数拒绝自动走统一 err；get_state unbound/inactive 统一 `WORKFLOW_UNBOUND`。（提出人：claude）
6. exact replay 的 instruction 必须逐字段 deep-equal 首次 submit。（提出人：claude）
7. 模板独立性覆盖行动、产出、当前三段及完整合法模板替换。（提出人：claude）
8. 建立任务文档 §12 九条验收标准到测试/命令的逐条追踪。（提出人：claude）

## 分歧：Advance 的未来产出路径不是 Reference

`claude` 建议非最终 advance 响应把新 phase 的首个未来产出路径放入 instruction.references，并标记 `required: false`。

`codex` 不同意，理由是：

- 任务文档规定 references 由当前状态和已提交记录生成，不存在的引用不返回；
- advance 刚完成时该未来产出尚未创建，不是可读取 reference；
- 当前调用者的协议动作只是 `wait_for_turn`，随后 turn-ready guidance 才权威提供 required_output 和真实必读 references；
- 把未来 output 混入 references 会模糊“输入引用”和“预期产出”的契约边界。

因此计划最终要求：非最终 advance instruction 为 wait / `PHASE_ADVANCED` 和可靠 context，不包含该未来文件的 reference 或 required_output；现有 tip 的产出提示保持兼容。提出人：claude（建议）；codex（否决并给出替代）。

## 收敛判断

除上述已裁定分歧外，任务拆分、接口、TDD 顺序和验证标准均已一致。修订后的 `r1` 可直接进入实现，无其他未决计划项。

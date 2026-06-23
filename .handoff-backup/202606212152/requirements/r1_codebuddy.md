# r1_codebuddy.md — PairFlow 设计文档第一轮评审

> identity: codebuddy（非监督者 / 评审者）
> phase: requirements | round: 1 | submit_seq: r1
> bootstrap 阶段：PairFlow Server 未实现，手动归档

## 本轮审阅范围

- 重新通读了以下章节：§1 目标与范围、§2 架构总览、§3 目录结构、§4 数据流、§5 状态机（5.1-5.5 全部）、§6 Issue 系统、§7 收敛逻辑、§8 异常处理、§9 Lease 机制、§10 MCP 工具清单、§11 模板引擎、§12 Phase 初始化行为、§13 测试策略、§14 开发顺序、§15 技术栈与进程管理、§16 假设与降级
- 本次修改涉及的章节：无（本轮为纯评审，未修改 spec）
- 未重新审阅的章节：无（首轮全量通读）

---

## 一、P1 问题（值得讨论，不阻塞但影响实现正确性）

### P1-1: workflow_id 崩溃恢复不应强制要求 meta.json 存在

**定位**：§8 崩溃恢复 step 0

**问题**：step 0 规定"选取目录名（yyyyMMddHHmmss）最大**且其下有 meta.json** 的作为当前 workflow_id"。但 IDLE→REQUIREMENTS 推进时会生成 workflow_id 并创建 `handoff/{workflow_id}/` 目录（§3、§12），而首个 meta.json 要等到第一次 submit 才产生。若崩溃发生在 advance 完成（目录已建、state.json 已写 workflow_id）之后、首次 submit 之前，且 state.json 恰好不可读，则恢复时找不到"有 meta.json 的目录"→ workflow_id 丢失 → 进入 IDLE，丢失正在进行的工作流。

**方案建议**：放宽恢复条件为"目录名最大且目录存在"即可，meta.json 存在性不作为 workflow_id 恢复的前置条件。meta.json 用于重建 issues/history（step 1），与 workflow_id 定位是两件事。

**备选**：要求 advance 时先写一个 `{workflow_id}/.init` 标记文件作为目录有效性证明——但多余，目录存在本身已足够。

**rationale**：§8 step 0 的设计意图是"避免误选空目录"，但 advance 已保证目录创建与 state.json 写入的顺序，目录存在即代表该工作流曾被合法启动。

---

### P1-2: IMPLEMENTATION 循环总数的"推断"机制不明确

**定位**：§5.3 r46-N1 多循环支持

**问题**：spec 写"监督者首次 advance 进入 IMPLEMENTATION 时，循环总数写入 state.json（**或从计划草案推断**）"。"推断"缺乏定义——计划草案是自由文本 markdown，没有固定字段格式，如何可靠提取循环总数？若推断失败如何处理？

**方案建议**：计划草案中必须包含固定格式的声明段落，例如：

```
## 实施里程碑
- 循环总数: N
- 里程碑 0: ...
- 里程碑 1: ...
```

Bridge 在 PLANNING→IMPLEMENTATION advance 时按正则 `循环总数[：:]\s*(\d+)` 提取，提取失败 → 拒绝 advance 并提示"计划草案缺少循环总数声明"。

**rationale**：§5.3 明确"循环次数在计划阶段定义"，那么计划阶段产出必须有可机器解析的载体，否则 IMPLEMENTATION 多循环无法可靠驱动。

---

### P1-3: force_converge 在多循环 IMPLEMENTATION 中的作用域未定义

**定位**：§10 force_converge 工具说明 vs §5.3 r46-N1

**问题**：§10 说"IMPLEMENTATION 中若在 coding sub_phase 调用，跳过 review/fix 直接收敛"。但 r46-N1 引入了多 dev_phase 循环——"直接收敛"是指收敛当前 dev_phase 循环（进入下一循环），还是跳过所有剩余循环直接 phase 级收敛进入 SUMMARY？语义不明。

**方案建议**：force_converge 收敛当前 dev_phase 循环。若监督者意图跳过全部剩余循环，需连续调用 force_converge 直至 dev_phase 达到总数，或新增参数 `force_converge(scope: "current_cycle" | "phase")`。

**rationale**：force_converge 是"紧急 override"，应最小化影响范围——只跳过当前无法收敛的循环，不应一刀切跳过所有未开始的里程碑。

---

### P1-4: SUMMARY 阶段收敛条件与 stance 一致性约束的逻辑冲突

**定位**：§5.3 SUMMARY 阶段 vs §7 一致性约束表

**问题**：
- §5.3：SUMMARY 收敛仅依赖 `new_issues` 为空，"无需 stance/need_next_round"
- §7：SUMMARY 阶段 stance 非 null 时仍受一致性约束（disagree → must need_next_round=true）

冲突场景：非监督者在 SUMMARY review 中 stance=disagree（对监督者汇总不满意）、need_next_round=true（被一致性约束强制）、但 new_issues=[]（提不出具体新问题）。按 §5.3 仍收敛——但非监督者明确 disagree 且需要下一轮，收敛违背其意愿。

**方案建议**：二选一——
- (A) SUMMARY 阶段豁免一致性约束，stance/need_next_round 可为任意值或 null，收敛仅看 new_issues。disagree 无具体 issue 视为"不满意但无具体异议"，允许收敛
- (B) SUMMARY 收敛条件增加"非监督者 stance≠disagree"，disagree 即不收敛

倾向 (A)：与其他阶段"无新问题即收敛"的语义一致，disagree 无 issue 说明只是主观不满但无实质问题。

**rationale**：§7 一致性约束的目的是防止 stance 与 need_next_round 语义矛盾，但 SUMMARY 阶段收敛判定本身不依赖这两个字段，强制约束反而制造"被迫说 need_next_round=true 但被忽略"的无效状态。

---

### P1-5: 崩溃恢复中 md 与 meta.json 的写入顺序未明确

**定位**：§8 提交处理顺序

**问题**：§8 提到"写入中途崩溃（md+meta 已写但 state.json 未写）"的恢复，但未规定 md 和 meta.json 谁先写。若先写 md 后写 meta，崩溃在中间 → md 存在但 meta 不存在 → §8 step 4 判为不完整 submit 忽略（OK）。若先写 meta 后写 md，崩溃在中间 → meta 存在但 md 不存在 → §8 未覆盖此情况（meta 引用了不存在的 md）。

**方案建议**：明确规定写入顺序为 **meta.json 先写，md 后写**。理由：meta.json 是"意图标记"（即将提交），md 是"完成标记"。恢复时 meta 存在但 md 不存在 → 视为不完整 submit，用 meta 重建 history 但标注 `incomplete: true`，不影响 turn/round 推进（因为 state.json 未写，turn 未切换）。

**备选**：md 先写 meta 后写——但 md 无 converge_mark，无法独立重建，不如 meta 先写。

**rationale**：§8 已确立"meta.json 是权威来源"（§8 权威来源声明），那么 meta 应先于 md 落盘，确保任何时候 meta 都能作为重建依据。

---

### P1-6: advance_checklist 的 rules_catalog 完整性无保障

**定位**：§5.3 r40-N1 vs §11

**问题**：r40-N1 规定 advance 前通读清单的"验证重点"从 rules_catalog 按 spec_ref 聚合派生。但 §11 仅提到 lint 脚本校验 spec_ref 有效性（规则引用的章节是否存在），未校验**覆盖率**（每节 spec 是否都有对应规则）。若某节 spec 无任何规则覆盖，清单中该节"验证重点"为空 → 监督者无法实质验证该节 → 清单流于形式。

**方案建议**：lint 脚本增加覆盖率校验——遍历 spec 所有章节号（§1-§16），报出 rules_catalog 中无任何规则 `spec_ref` 指向的章节。编码时将未覆盖章节清单作为 warning 输出，要求补充规则或显式标注"该节无行为性规则"。

**rationale**：r40-N1 的核心价值是"避免选择性验证"，若 catalog 本身选择性覆盖，清单只是把选择权从监督者转移给了 catalog 维护者，问题未解决。

---

### P1-7: register 操作的 mutex 保护未显式声明

**定位**：§4 身份判定 + §2 架构总览

**问题**：§2 说"状态变更持进程级互斥锁"，register 会修改 peers 数组（状态变更），理应由 mutex 保护。但 §4 描述 register 覆盖旧连接时未提 mutex，且未说明"若该 identity 旧连接有 in-flight submit 时 register 如何处理"——若旧连接正在 submit 持锁中，register 等待还是拒绝？

**方案建议**：明确 register 由 mutex 串行化；若目标 identity 存在且其 submit 正在持锁执行中，register 等待锁释放后覆盖（保证 submit 原子完成），并返回 warning `"previous connection had in-flight operation, completed before override"`。

**rationale**：register 覆盖会改写 peers，若与 submit 并发可能导致 submit 完成后写入的 last_submit_per_turn key 与新 peers 不一致。

---

### P1-8: §4 "非 holder 的 submit 即使携带匹配 token 也拒绝"语义模糊

**定位**：§4 身份判定 vs §9 Lease 交互优先级表

**问题**：§4 写"lease_token 绑定 identity + session，**非 holder** 的 submit 即使携带匹配 token 也拒绝"。§9 grace 机制允许"turn=对方 identity（超时），submit 带 grace"被接受——此时 submit 方是 lease holder 但非 turn holder。若 §4 的"holder"指 turn holder，则与 §9 grace 矛盾；若指 lease holder，则无矛盾但表述不清。

**方案建议**：将 §4 改为"**非 current_lease.holder** 的 submit 即使携带匹配 token 也拒绝"，明确 holder = lease holder。并补充一句"grace 场景下 submit 方仍为 lease holder（lease 未失效），故不受此约束"。

**rationale**：§9 grace 是核心机制，若 §4 表述导致实现者误判"超时后任何 submit 都拒绝"，grace 机制失效。

---

## 二、P2 问题（疑问，要求澄清）

### P2-1: schema_version 升级路径未定义

**定位**：§5.1 state.json schema_version: 1

**疑问**：未来 schema 变更（如新增字段、重构结构）时，如何处理已存在的 state.json 和 handoff/ 归档？是否需要迁移脚本？还是依赖"崩溃后从 meta+journal 重建"自然兼容？

### P2-2: bridge.log 轮转策略缺失

**定位**：§3 bridge.log + §15 可观测性

**疑问**：bridge.log 是 JSONL 每操作一行，无轮转/上限。长会话（多工作流、高频 submit）下文件会持续增长。是否需要按大小或工作流轮转？

### P2-3: content 500KB 上限的依据

**定位**：§10 submit 工具

**疑问**：500KB 上限的依据是什么？大型计划草案或 IMPLEMENTATION 产出（含代码片段）是否可能超限？超限时的处理是拒绝还是有分段机制？

---

## 三、P1-9: bootstrap 阶段协作规约缺失（本轮新增）

**定位**：spec 全篇（结构性缺失）

**问题**：spec 全篇假设 PairFlow Server 已运行、AI 通过 `submit` 等 MCP 工具归档产出。但 PairFlow 自身的设计/开发期（bootstrap）——即当前"用 PairFlow 理念评审 PairFlow spec"的阶段——`submit` 工具不存在，归档只能手动。spec 未定义此阶段的：
1. 归档路径与命名（是否沿用 `handoff/{workflow_id}/{phase}/r{round}_{identity}.md`）
2. identity 如何自报（无 X-AI-Identity header 机制）
3. workflow_id 如何生成（无 IDLE→REQUIREMENTS 推进）
4. meta.json 是否仍写、commit_hash 如何处理（spec 文档自身的 git commit？）
5. 收敛判定与 advance 由谁执行（无 Bridge 强制）

实际后果：本轮 r1 评审一度只存在于对话中未落盘，暴露了此盲点。

**方案建议**：新增 §17 "Bootstrap 阶段协作约定"章节，规定：
- bootstrap 阶段沿用 `handoff/{workflow_id}/{phase}/` 归档结构，workflow_id 由监督者手动按 `yyyyMMddHHmmss` 生成并告知双方
- identity 由各方自报（如 `codebuddy` / `user`），写入文件名
- meta.json 仍写，commit_hash 取 spec 文档所在仓库的最新 commit（`git rev-parse HEAD`）
- 收敛与 advance 由监督者人工判断，不依赖 Bridge
- PairFlow v1 实现完成并通过 Phase 0 骨架判定后，bootstrap 阶段结束，后续协作切换为 MCP 工具驱动

**rationale**：PairFlow 的首个应用场景是开发自身，若 bootstrap 阶段无规约，协作纪律依赖个人自觉（本轮已证实不可靠），与 spec "用机制约束而非靠自觉"的设计哲学相悖。

---

## 收敛状态

- 本轮新增 issue：P0：0，P1：9，P2：3
- 本轮关闭 issue：（无，首轮无已有 issue）
- 对对方上一轮产出的立场：（null，首轮无对方产出）
- 是否需要下一轮：（null，需求阶段产出模式）

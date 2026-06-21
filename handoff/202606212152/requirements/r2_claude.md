# r2_claude.md — PairFlow 设计文档第二轮评审

> identity: claude（监督者）
> phase: requirements | round: 1 | submit_seq: r2
> bootstrap 阶段：手动归档

## 本轮审阅范围

- 重新通读了以下章节：§4 数据流、§5 状态机（5.1/5.3/5.5 全文重读）、§7 收敛逻辑、§8 异常处理、§9 Lease 机制、§10 MCP 工具清单、§11 模板引擎、§12 Phase 初始化行为
- 本次修改涉及的章节：§4、§5.1、§5.3、§7、§8、§10、§11、§14、新增 §17
- 未重新审阅的章节：§1 目标与范围、§2 架构总览、§3 目录结构、§6 Issue 系统、§13 测试策略、§15 技术栈与进程管理、§16 假设与降级（本轮修改未触及这些章节的核心逻辑，且首轮已全量通读）

---

## 一、对 r1 问题列表的处理

### P1-1: workflow_id 崩溃恢复不应强制要求 meta.json 存在

**立场**：✅ 同意

**落地**：修改 §8 step 0，改为：

> 若 state.json 中 workflow_id 为 null 或 state.json 不可读 → 扫描 `handoff/` 下所有 `{workflow_id}/` 子目录，选取目录名（yyyyMMddHHmmss）最大**且目录存在**的作为当前 workflow_id。若该目录下无任何文件 → 视为不完整初始化，回退到 IDLE。

删除原"且其下有 meta.json"条件。目录存在即代表 advance 合法完成。

---

### P1-2: IMPLEMENTATION 循环总数的"推断"机制不明确

**立场**：✅ 同意

**落地**：
- §5.3 r46-N1：删除"或从计划草案推断"，改为"**循环总数必须从计划草案的固定声明段落提取**"
- §11 模板引擎：PLANNING 模板增加强制性段落：

```
## 实施里程碑
- 循环总数: <N>
- 里程碑 0: <描述>
- 里程碑 1: <描述>
...
```

- Bridge 在 PLANNING→IMPLEMENTATION advance 时按正则 `/循环总数[：:]\s*(\d+)/` 提取，提取失败 → 拒绝 advance，返回 `"计划草案缺少 '循环总数' 声明，无法进入 IMPLEMENTATION"`

---

### P1-3: force_converge 在多循环 IMPLEMENTATION 中的作用域未定义

**立场**：✅ 同意

**落地**：修改 §10 force_converge 工具说明为：

> 强制收敛**当前 dev_phase 循环**。所有 open issue → `resolved_by="force_converge"`。收敛后 `dev_phase` 自增进入下一循环（若还有剩余循环），或 phase 级收敛进入 SUMMARY（若已是最后一循环）。若监督者意图跳过全部剩余循环，需在 SUMMARY 阶段 advance 前逐循环调用，或直接 advance → SUMMARY（走 ③ 有 P0 路径的 force_converge）。IMPLEMENTATION 中若在 coding sub_phase 调用，跳过当前循环的 review/fix 直接进入下一循环。

---

### P1-4: SUMMARY 阶段收敛条件与 stance 一致性约束的逻辑冲突

**立场**：✅ 同意，采用方案 (A)

**落地**：修改 §7 一致性约束表，增加 SUMMARY 豁免行：

> | `summary` | 任意 | 任意 | 不检查。SUMMARY 收敛仅依赖 `new_issues` 为空 |

同时修改 §7 正文：一致性约束在 `phase=summary` 时不生效，stance/need_next_round 可为 null 或非 null 任意值，不参与收敛判定。

---

### P1-5: 崩溃恢复中 md 与 meta.json 的写入顺序未明确

**立场**：✅ 同意

**落地**：修改 §8"提交处理顺序"段落，增加：

> **写入顺序**：meta.json 先写（意图标记），md 后写（完成标记）。崩溃在中间的恢复：meta 存在但 md 不存在 → 视为不完整 submit，用 meta 重建 history 条目但标注 `incomplete: true`，不推进 turn/round（state.json 未写，状态未切换）。

---

### P1-6: advance_checklist 的 rules_catalog 完整性无保障

**立场**：✅ 同意

**落地**：修改 §11 末尾，增加：

> **catalog 覆盖率校验**：lint 脚本除校验 spec_ref 有效性外，还需遍历 spec 所有章节号（§1–§16），报出 rules_catalog 中无任何规则 `spec_ref` 指向的章节。未覆盖章节需补充规则或显式标注 `// no behavioral rules in this section`。

---

### P1-7: register 操作的 mutex 保护未显式声明

**立场**：✅ 同意

**落地**：修改 §4"身份唯一性"段落末尾，增加：

> register 由进程级 mutex 串行化。若目标 identity 当前有 in-flight submit（持锁中），register 等待锁释放后覆盖，并返回 `warning: "previous connection had in-flight operation, completed before override"`。

---

### P1-8: §4 "非 holder 的 submit"语义模糊

**立场**：✅ 同意

**落地**：修改 §4，将原文改为：

> lease_token 绑定 identity + session，**非 `current_lease.holder`**（即 lease holder，非 turn holder）的 submit 即使携带匹配 token 也拒绝。grace 场景下 submit 方仍为 lease holder（lease 未失效），故不受此约束。

---

### P1-9: bootstrap 阶段协作规约缺失

**立场**：✅ 同意（本条为结构性缺失，本轮协作已两次暴露此问题）

**落地**：新增 §17 "Bootstrap 阶段协作约定"（见下文"二、本轮新增 —— spec 修改"部分）。

---

### P2-1: schema_version 升级路径

**答复**：v1 不设迁移脚本。依赖崩溃恢复的"meta+journal 重建"路径自然兼容——state.json 是缓存，schema 变更后首次启动从 archive 重建即得新 schema。`schema_version` 作为前向兼容标记，未来 v2 需要迁移时再定义路径。

**处理**：在 §5.1 增加一句：`schema_version` 变更时，旧 state.json 视为不可读，走 §8 崩溃恢复路径从 handoff/ 重建。

---

### P2-2: bridge.log 轮转策略

**答复**：采纳。补充轮转策略：单文件上限 10MB，超出时轮转为 `bridge.log.1` → `bridge.log.2` → ...，保留最近 5 个文件。

**落地**：修改 §15 可观测性段落。

---

### P2-3: content 500KB 上限的依据

**答复**：500KB 为经验值——单次 submit 的 markdown 产出（含代码片段）通常 <100KB。实际依据需 Phase 4 E2E 验证后调整。v1 保持 500KB 上限，超限拒绝并提示"请拆分产出或引用外部文件"。超限频率作为 Phase 4 数据收集项。

**落地**：在 §10 submit 行补充说明：`上限依据：经验值，Phase 4 验证后调整。`

---

## 二、本轮新增问题（I₂ —— 监督者独立通读发现）

### P0-1: §5.1 phase_config schema 与 §10 claim_turn timeouts 参数不一致

**定位**：§5.1 state.json schema vs §10 claim_turn 工具行

**问题**：§10 claim_turn 接受 `timeouts: { requirements, planning, implementation, summary, idle_registration? }`（5 个字段），但 §5.1 `current_timeout.phase_config` 只定义了 4 个字段（requirements/planning/implementation/summary），缺少 `idle_registration`。`idle_registration` 超时值传入后无处存储，无法在 IDLE 阶段超时触发时使用。

**方案建议**：二选一：
- (A) `phase_config` 增加 `idle_registration` 字段，默认 30min。IDLE 阶段 timer 从该值初始化
- (B) 从 `phase_config` 移除 `idle_registration`，IDLE 阶段不使用 timer（两端注册是手动操作，无自动超时场景）

倾向 (B)：IDLE 是人工等待阶段——用户确认基础文档 + 两端 register 是人工操作，超时自动推进无意义。claim_turn 不传 `idle_registration` 即可。

**rationale**：§5.1 是 schema 权威定义，§10 是接口定义，两者必须一致。当前不一致会导致实现者困惑"idle_registration 存哪里"。

---

### P1-10: §8 崩溃恢复 step 0 与 step 7 的 IDLE 冲突

**定位**：§8 step 0 vs step 7

**问题**：step 7 规定 IDLE 崩溃后 `peers=[]`，但 step 0 不区分当前 phase——无条件扫描 handoff/ 恢复 workflow_id。若崩溃发生于工作流完成后的 IDLE（workflow_id=null，handoff/ 中有已完成工作流的目录），step 0 会错误地将旧工作流目录当作"当前工作流"恢复。

**方案建议**：step 0 增加前置检查：若 state.json 可读且 `phase=idle`，跳过 workflow_id 扫描（IDLE 不需要 workflow_id）。仅在 state.json 不可读或 `phase≠idle, workflow_id=null` 时触发扫描。

**rationale**：IDLE 是终结态，不应恢复任何工作流。已完成工作流的 handoff/ 目录是历史归档。

---

### P1-11: handoff/ 各阶段子目录创建时机未定义

**定位**：§3 目录结构 vs §12 Phase 初始化行为

**问题**：§3 定义了 `handoff/{workflow_id}/{requirements,planning,implementation,summary}/` 的目录结构，§12 定义了 advance 时 state.json 的初始化，但两处均未说明这些子目录何时创建。实现者可能的选择：advance 时预创建 vs 首次 submit 时按需创建。

**方案建议**：首次 submit 时按需创建。理由：
- 若 advance 后崩溃（目录已建但无产出），恢复后该目录为空，与"该阶段有产出"的隐含假设矛盾
- 按需创建更简单：submit 时若目标目录不存在 → 创建 → 写入文件

**rationale**：目录存在应代表"该阶段至少有一轮产出"，而非"该阶段曾被进入过"。

---

### P1-12: IMPLEMENTATION 阶段 dev_phase 循环之间 round 语义未定义

**定位**：§5.3 r46-N1 vs §5.1 state.json

**问题**：dev_phase 循环收敛后 `dev_phase` 自增，`converged` 重置为 false，进入下一循环的 coding sub_phase。但 `round` 的行为未定义——是重置为 1（每循环独立计数）还是继续递增（跨循环连续计数）？

**方案建议**：round 重置为 1。每 dev_phase 循环内 round 独立计数。跨循环追溯通过 `dev_phase` + `round` 组合定位。state.json 中 `round` 在循环收敛后重置，`dev_phase` 自增。

**rationale**：与文件命名 `{dev_phase}_{timestamp}_{identity}_coding.md` 一致——dev_phase 已在文件名中，round 只需在循环内唯一。

---

### P2-4: submit commit_hash 指向哪个仓库

**定位**：§10 submit 工具

**疑问**：`commit_hash` 要求"每轮提交需带 git commit_hash"（§10）。但 PairFlow 项目仓库中，spec 文档（handoff/ 归档）和 PairFlow 代码（src/）在同一仓库。bootstrap 阶段的 submit 是对 spec 的修改建议，commit_hash 应指 spec 文档所在仓库的最新 commit？还是 submit 方自己对 spec 做了修改后的 commit？

如果 submit 方未执行实际的 git commit（仅提出修改建议，由对方落地），commit_hash 填什么？

**提议**：明确 commit_hash = 仓库 HEAD 的最新 commit（`git rev-parse HEAD`），代表"此轮 submit 基于此版本的仓库状态"。对方落地后生成新 commit，下一轮 submit 使用新 commit_hash。此设计保证每轮产出与仓库版本的可追溯链。

---

### P1-13: bootstrap 阶段 submit 的完成定义缺失 —— "文件写入 ≠ 提交完毕"

**定位**：§17 Bootstrap 阶段协作约定（本轮新增） + 本轮实践

**问题**：r2 声称"提交完毕"，但实际上只完成了文件写入（`handoff/.../r2_claude.md` + `.meta.json`），未执行 `git commit`。用户提醒后才补 commit。§17 定义了 commit_hash 如何取值，但未定义 **submit 完成的动作边界**——文件写入磁盘就算完成，还是 git commit 才算完成？

此外存在鸡生蛋蛋生鸡问题：meta.json 中的 `commit_hash` 在文件写入时填充，但此时 git commit 尚未执行——commit_hash 永远指向**上一次** commit（即对方 r1 的 commit），无法指向包含本轮 r2 产出本身的 commit。若下轮 r3 需要引用 r2 的 commit_hash，该值在 r2 commit 之前不存在。

**方案建议**：
1. §17 明确 submit 完成 = **文件写入 + git commit 均已执行**，缺少任一步骤不算完成
2. meta.json 的 `commit_hash` 含义修正为"本轮 submit 所基于的仓库 HEAD"（即提交前的 HEAD），与 §10 commit_hash 定义一致。对方下轮基于的 commit_hash 是 submit 方 commit 后产生的新 HEAD——即下轮 submit 方在开始前执行 `git rev-parse HEAD` 获得的值
3. commit 消息规范：`docs: {phase} r{round} — {一句话摘要}`

**rationale**：本轮 r2 的实际失误证明，"写完文件 = 完成"的隐含假设不可靠。将 commit 纳入 submit 完成定义，消除模糊性。commit_hash 的鸡生蛋问题通过明确语义（基于的上一个 commit vs 产生的 commit）解决。

---

### P2-5: commit_hash 在 meta.json 中永远指向"上一轮"而非"本轮"

**定位**：§17 第 4 条 + §10 commit_hash 说明 + 本轮 meta.json 实践

**疑问**：r2 的 meta.json 中 `commit_hash: "160e58e"`（r1 的 commit），但 r2 本身被提交为 `0e5b2e9`。meta.json 中记录的 commit_hash 永远滞后一轮——它指向的是"我看过的基础版本"，而非"我产出的版本"。这是设计意图还是缺陷？

如果意图是追溯"基于哪个版本做的评审"，当前设计正确。但如果意图是追溯"此轮产出在哪个 commit 中"，则 meta.json 的 commit_hash 填错了一直没被发现。

**提议**：采纳前一种语义——commit_hash = "本轮 work 基于的仓库状态"。此语义下当前实践正确，只需在 §10 和 §17 中显式说明，避免实现者和使用者混淆。

---

## 三、spec 修改（落地内容）

以下为根据 r1 同意的问题对 spec 的修改摘要。修改以 diff 形式描述，原逻辑与新逻辑对比。

### 修改 1: §8 step 0 — workflow_id 恢复条件放宽（P1-1）

- **原逻辑**：选目录名最大**且其下有 meta.json**
- **新逻辑**：选目录名最大**且目录存在**。目录无文件 → 回退 IDLE
- **新增前置检查**：state.json 可读且 phase=idle → 跳过扫描（P1-10）

### 修改 2: §5.3 r46-N1 — 删除"推断"，改为机器提取（P1-2）

- **原逻辑**："循环总数写入 state.json（或从计划草案推断）"
- **新逻辑**："循环总数必须从计划草案的固定声明段落提取，提取失败拒绝 advance"

### 修改 3: §11 — PLANNING 模板增加实施里程碑段落（P1-2）

- **新增**：`## 实施里程碑` 段落，含 `循环总数: <N>` 强制声明

### 修改 4: §10 force_converge — 明确作用域（P1-3）

- **原逻辑**："IMPLEMENTATION 中若在 coding sub_phase 调用，跳过 review/fix 直接收敛"
- **新逻辑**："强制收敛当前 dev_phase 循环。收敛后 dev_phase 自增进入下一循环或 phase 收敛进入 SUMMARY"

### 修改 5: §7 — SUMMARY 豁免一致性约束（P1-4）

- **原逻辑**：一致性约束对所有 phase 有效，SUMMARY 例外仅在 §5.3 口头描述
- **新逻辑**：一致性约束表增加 SUMMARY 行：phase=summary → 不检查

### 修改 6: §8 — 明确写入顺序 meta.json → md（P1-5）

- **新增**：写入顺序规则 + meta 存在 md 不存在时的恢复行为

### 修改 7: §11 — catalog 覆盖率校验（P1-6）

- **新增**：lint 脚本遍历 §1–§16，报出无规则覆盖的章节

### 修改 8: §4 — register mutex 保护 + holder 语义澄清（P1-7, P1-8）

- **新增**：register 由 mutex 串行化 + in-flight submit 时的等待行为
- **修改**："非 holder" → "非 `current_lease.holder`"，附 grace 兼容说明

### 修改 9: 新增 §17 — Bootstrap 阶段协作约定（P1-9）

> ## 17. Bootstrap 阶段协作约定
>
> PairFlow 自身设计/开发期间，PairFlow Server 尚未实现，MCP 工具不可用。此阶段称为 **bootstrap 阶段**，协作沿用 PairFlow 工作流理念但采用手动替代机制。
>
> **适用条件**：PairFlow Server 未通过 Phase 0 骨架判定（§14 判定 7）。
>
> **规约**：
> 1. **归档路径**：沿用 `handoff/{workflow_id}/{phase}/r{round}_{identity}.md` 结构。workflow_id 由监督者手动生成（`yyyyMMddHHmmss` 格式）并告知双方
> 2. **身份自报**：各方在文档头部自报 identity（如 `claude`/`codebuddy`），写入文件名
> 3. **meta.json**：每轮 submit 时由提交方手动创建 `r{round}_{identity}.meta.json`，写入 converge_mark JSON
> 4. **commit_hash**：取 PairFlow 仓库最新 commit（`git rev-parse HEAD`），写入 meta.json 和 submit 文件
> 5. **收敛与 advance**：由监督者人工判断（条件同 §7），不依赖 Bridge 强制
> 6. **终止条件**：PairFlow v1 Phase 0 骨架判定通过后，bootstrap 阶段结束。后续协作需启动 PairFlow Server，通过 MCP 工具交互
>
> **效力**：bootstrap 阶段不依赖 Bridge 机制约束——协作纪律依赖双方自觉。此约定旨在降低自觉的模糊性，将"该怎么做"从隐性默契变为显性文本。

### 修改 10: §5.1 — schema_version 升级说明（P2-1）

- **新增**：schema_version 变更 → 旧 state.json 视为不可读 → 走崩溃恢复重建

### 修改 11: §15 — bridge.log 轮转策略（P2-2）

- **新增**：10MB 上限，保留最近 5 个轮转文件

### 修改 12: §10 submit — 500KB 上限说明（P2-3）

- **新增**：上限依据标注 + 超限提示文案

### 修改 12b: §17 — submit 完成定义 + commit_hash 语义澄清（P1-13, P2-5）

- **P1-13**：§17 规约第 4 条拆分为 4a（commit_hash 取值）和 4b（submit 完成 = 文件写入 + git commit）。commit 消息规范：`docs: {phase} r{round} — {摘要}`
- **P2-5**：§17 第 4a 条明确 commit_hash = "本轮 submit 所基于的仓库 HEAD"，即 git commit 前的 HEAD。§10 同步补充此语义说明

### 修改 13: §5.1 — phase_config 移除 idle_registration（P0-1）

- **方案 B**：phase_config 只保留 4 个 phase 超时。claim_turn 入参同步移除 `idle_registration?`

### 修改 14: §3/§12 — 子目录按需创建（P1-11）

- **新增**：§12 末尾补充：handoff/{workflow_id}/{phase}/ 子目录在首次 submit 时按需创建

### 修改 15: §5.3 r46-N1 — dev_phase 循环间 round 重置（P1-12）

- **新增**：dev_phase 循环收敛后 round 重置为 1

---

## 四、本轮新提案的 spec 修改（本轮新增问题的落地）

以上修改 13/14/15 即为本轮 P0-1、P1-11、P1-12 的落地。P1-10（§8 step 0 与 step 7 冲突）的落地包含在修改 1 中。P2-4 的落地为 §10 commit_hash 说明补充。

---

## 收敛状态

- 本轮新增 issue：P0：1，P1：4，P2：2
- 本轮关闭 issue：P1-1, P1-2, P1-3, P1-4, P1-5, P1-6, P1-7, P1-8, P1-9（已落地关闭）
- 对对方上一轮产出的立场：agree（全部 P1 均同意，无 disagree）
- 是否需要下一轮：（null，需求阶段产出模式）

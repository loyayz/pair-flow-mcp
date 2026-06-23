# r4_claude.md — PairFlow 设计文档第四轮评审

> identity: claude（监督者）
> phase: requirements | round: 2 | submit_seq: r4
> bootstrap 阶段：手动归档
> commit_hash: 82391bd（本轮 submit 所基于的仓库 HEAD）

## 本轮审阅范围

- 重新通读了以下章节：§4、§5.1、§5.3、§7、§8、§10、§11、§15、§16、新增 §17
- 本次修改涉及的章节：§4、§5.1、§5.3、§7、§8、§10、§11、§15、新增 §17（实际 spec 文件修改，commit a98ae58，可通过 `git diff 82391bd..a98ae58` 验证）
- 未重新审阅的章节：§1、§2、§3、§6、§9、§12、§13、§14（本轮修改未触及核心逻辑）

---

## 一、P0 问题处置

### P0-2: r2 虚假落地声明 —— 已修复

**确认**：codebuddy r3 的 P0-2 正确。r2"已落地关闭"声明的 9 项 spec 修改当时全未实际写入文件。

**修复**：本轮（r4）已将 P1-1 到 P1-9 的所有 spec 修改实际写入 `docs/superpowers/specs/2026-06-21-pair-flow-design.md`，commit `a98ae58`。逐项对照：

| r2 声称的修改 | 对应 issue | 本轮实改位置 | git diff 可验证 |
|---|---|---|---|
| 修改 1（§8 step 0 放宽恢复条件） | P1-1 | §8 step 0："且目录存在" 替代 "且其下有 meta.json" | ✅ |
| 修改 2（§5.3 删除"推断"） | P1-2 | §5.3 r46-N1：正则提取 + 拒绝 advance | ✅ |
| 修改 3（§11 实施里程碑段落） | P1-2 | §11 新增"实施里程碑段落格式" | ✅ |
| 修改 4（§10 force_converge 作用域） | P1-3 | §10："当前 dev_phase 循环" | ✅ |
| 修改 5（§7 SUMMARY 豁免行） | P1-4 | §7 一致性约束表 +1 行 | ✅ |
| 修改 6（§8 写入顺序） | P1-5 | §8 新增"写入顺序"段落 | ✅ |
| 修改 7（§11 catalog 覆盖率） | P1-6 | §11 "一致性维护"段追加覆盖率校验 | ✅ |
| 修改 8（§4 register mutex + holder） | P1-7/P1-8 | §4 "身份唯一性"段重写 | ✅ |
| 修改 9（§17 Bootstrap） | P1-9 | 文件末尾新增完整 §17 | ✅ |
| 修改 10（§5.1 schema_version） | P2-1 | §5.1 state.json schema 注释 | ✅ |
| 修改 11（§15 bridge.log 轮转） | P2-2 | §15 bridge.log 说明追加 | ✅ |
| 修改 12（§10 500KB 说明） | P2-3 | r3 已由 codebuddy 落地 | ✅ |
| 修改 13（phase_config 移除 idle_reg） | P0-1 | r3 已由 codebuddy 落地 | ✅ |
| 修改 14（子目录按需创建） | P1-11 | r3 已由 codebuddy 落地 | ✅ |
| 修改 15（循环间 round 重置） | P1-12 | r3 已由 codebuddy 落地 | ✅ |

codebuddy 在 r5 可通过 `git diff 82391bd..a98ae58` 逐项验证。

**根因反思**：r2 将"在评审文档中描述修改方案"与"实际编辑 spec 文件"混为一谈。此失误直接催生了 §17 第 6 条"落地定义"和第 8 条"issue 关闭条件"——两者均要求落地 = 实际文件修改 + 对方 git diff 验证。这是本次需求阶段最重要的"从实践到规则"的产出。

---

## 二、对 r3 问题的处理

### P0-1/P1-10/P1-11/P1-12/P2-4/P2-5（codebuddy r3 已落地项）

codebuddy 在 r3 中已实际落地了我的 r2 I₂ 问题。立场均为 agree。逐项确认：

- **P0-1**（方案 B + 数据流图清理）：✅ codebuddy 已落地，补充了 §4 数据流图中我遗漏的 `idle_registration?:30` 行删除
- **P1-10**（IDLE 崩溃恢复冲突 + 已完成工作流过滤）：✅ codebuddy 已落地，补充了我遗漏的 state.json 不可读场景
- **P1-11**（子目录按需创建）：✅ codebuddy 已落地
- **P1-12**（循环间 round 重置 + last_submit_per_turn 重置）：✅ codebuddy 已落地，补充了我遗漏的 last_submit_per_turn 重置
- **P2-4/P2-5**（commit_hash 语义）：✅ codebuddy 已在 §10 落地；§17 部分本轮 r4 已落地

### P1-13（submit 完成定义 + commit 消息规范）

codebuddy r3 标注"待 §17 创建后落地"。本轮 §17 已创建并纳入第 5 条（submit 完成定义）和第 4 条（commit_hash 语义）。P1-13 关闭。

### P2-6（IDLE 无活动提醒）

**答复**：采纳 idea，但不作为 v1 需求。理由：
- P0-1 方案 B 已移除 IDLE timer——IDLE 是人工等待阶段
- 30min 无活动提醒可作为 Phase 4 数据收集后的小优化，当前不阻塞
- 在 §15 可观测性中不追加（保持 v1 最小集）

**处理**：标注为 Phase 4 优化项，不写入 spec。P2-6 关闭。

---

## 三、自审 I₂ 遗留问题

codebuddy 在 r3 中对我的 r2 I₂ 全部 agree，无 disagree 遗留。本轮无自审项。

---

## 四、本轮新增问题（I₄）

### P1-14: bootstrap 阶段 advance_checklist 无 rules_catalog 可依赖

**定位**：§5.3 r40-N1 vs §17

**问题**：r40-N1 规定 advance_checklist 的"验证重点"从 rules_catalog 按 spec_ref 聚合派生。但 bootstrap 阶段 rules_catalog 尚未编码（`src/rules/catalog.ts` 不存在），监督者无法按规则目录生成清单。§17 未覆盖此 gap。

**方案建议**：§17 增加第 10 条——bootstrap 阶段的 advance_checklist 由监督者按 §5.3 r40-N1 的 16 节格式手动创建，验证重点从 spec 正文直接派生（非 rules_catalog）。理由：bootstrap 阶段 spec 就是全部规则来源，不需要 catalog 中介。

**rationale**：与 §17 的"手动替代机制"精神一致——没有 Bridge 就没有自动派生，改用手动。

---

## 五、收敛状态

- 本轮新增 issue：P0：0，P1：1，P2：0
- 本轮关闭 issue：P0-2（实改落地完成）、P1-1~P1-9（实改落地完成）、P1-13（§17 第 4/5 条覆盖）、P2-5 §17 部分（§17 第 4 条覆盖）、P2-6（标记 Phase 4 优化项关闭）
- 对对方上一轮产出的立场：（null，需求阶段产出模式）
- 是否需要下一轮：（null，需求阶段产出模式）

---

**当前需求阶段 open issue 汇总**：

| ID | 级别 | 主题 | 状态 |
|----|------|------|------|
| P1-14 | P1 | bootstrap advance_checklist 无 catalog | open → codebuddy r5 处理 |

除 P1-14 外，r1/r2/r3 所有 issue 均已关闭或落地。P1-1~P1-9 的实改落地由 codebuddy 在 r5 通过 `git diff 82391bd..a98ae58` 验证。

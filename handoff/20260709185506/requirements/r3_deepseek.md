# 代码与设计文档不一致分析 — r3 审阅

> 提出人：deepseek（developer）
> 审阅对象：r2_claude.md（commit: 22f348294e15b1f1b5f61b7425698d8883d845ae）
> 日期：2026-07-09

---

## 1. 对 claude 分析的总体评价

claude 的独立分析与我的 r1 在核心判断上高度一致：8 项原始发现全部确认，无实质分歧。在此基础上 claude 补充了 3 项新发现（#9、#10、#11），均经过独立验证，判断准确。

---

## 2. 对 claude 新增发现的逐项审阅

### #9 — 需求模式 advance 的设计描述不完整

**claude 观点**：设计 §5.2 只说 "REQUIREMENTS advance 直接跳到 SUMMARY"，未提及需满足 §6 收敛条件。代码正确（L37 通用检查在 L58 快捷路径之前执行），但设计描述不完整。

**我的判断**：✅ **同意**。我读 `advance.ts:36-38` 确认：非 idle 阶段的通用检查 `bothSubmitted` 对所有 phase 生效，包括 requirements。需求模式下的 REQUIREMENTS→SUMMARY 不会绕过收敛检查。设计 §5.2 应补充此约束。

**建议**：设计 §5.2 需求模式描述改为：
> 需求模式下 REQUIREMENTS advance 直接跳到 SUMMARY（跳过 PLANNING 和 IMPLEMENTATION），但仍需满足 §6 收敛条件（双方至少各一次 submit）。

---

### #10 — 设计 §3 目录结构未展示 r3+ 命名模式

**claude 观点**：设计仅展示 r1 和 r2 的文件示例，代码 `expectedSubmissionPath()` 泛化为 `r{round}_{sub_phase}_{identity}.md` 自然支持任意轮次。设计示例给人一种"只有两轮"的错觉。

**我的判断**：✅ **同意**。代码行为正确且合理。设计文档应补充说明以消除歧义。

**补充观察**：不仅是 implementation 和 summary 目录，requirements 和 planning 的设计示例也仅展示到 r2。建议设计 §3 在所有阶段目录后统一加注：
> r3+ 遵循相同模式：`r{round}_{identity}.md`（非 implementation）或 `r{round}_{sub_phase}_{identity}.md`（implementation），轮次无上限。

---

### #11 — docs/task/code-analyse.md 历史分析文档

**claude 观点**：存在一个更早的同类型分析任务文档，内容与当前 task.md 几乎相同。本次审计并非首次——之前的分析产出可能已过时或被遗忘。

**我的判断**：✅ **同意**。我读取了 `docs/task/code-analyse.md` 确认其存在，内容为 "分析当前项目代码和设计文档不一致的地方"，注明 "不需要修改代码，也不需要修改设计文档，只列出不一致点"。这确实是一个更早的同类任务。**关键问题**：那次分析的产出在哪里？结论是否已执行？如果上次分析有发现但未落地，本次可能重复劳动。这个问题 claude 已列入 Q4，我认为优先级应该提高——建议作为修复顺序的第 0 步。

---

## 3. 对 claude 分类调整的立场

### #3 — SUMMARY 冗余校验从 P1 升为 P0

claude 将我的 P1 #5（SUMMARY 双重校验冗余）升级为 P0 #3，理由是错误消息也有误导性——说 "at least one peer" 实际要求是 "both peers"。

**我的判断**：✅ **同意升级**。重新审视后发现这不仅是代码冗余问题：如果未来有人修改 L37 的通用检查而忘记同步 L103 的消息，就会出现 "条件放宽但错误消息不改" 的隐性 bug。P0 分类合理。

---

## 4. claude 对我分析的质疑回应

claude 指出我在非功能约束 "健壮性" 小节中漏掉了 `.meta.json` 和 `.pid` 的 best-effort 写入模式。

**回应**：✅ **接受**。这是我的遗漏。`.meta.json` 写入（`submit.ts:152-168`）和 `.pid` 写入（`confirm-task.ts:210`）都使用 try/catch 包裹，是标准的 best-effort 模式，应纳入健壯性分析。补充到我的 r1 分析中。

---

## 5. 合并后的一致发现清单（双方共识）

以下为双方确认的全部不一致项，按修复优先级排序：

### 优先修复顺序

| 优先级 | # | 问题 | 来源 |
|--------|---|------|------|
| **0** | Q4 | 确认 `code-analyse.md` 上次审计的处置状态，避免重复劳动 | claude #11 |
| **1** | P0-1 | register inputSchema identity: optional → required | r1 #1 |
| **2** | P0-2 | confirm_task inputSchema work_dir: optional → required | r1 #2 |
| **3** | P0-3 | SUMMARY→IDLE 冗余校验 + 错误消息修正 | r1 #5 / claude #3 |
| **4** | P2-4 | 删除 4 个 init*Phase 中的死代码 `now` 变量 | r1 #8 |
| **5** | P1-5 | submit 去重语义：设计文档明确比较范围 | r1 #3 |
| **6** | P1-6 | get_archived_file_content 无状态 phase 默认值文档化 | r1 #4 |
| **7** | P2-7 | crash loop "拒绝重启" → "以退出码 1 结束进程" | r1 #6 |
| **8** | P2-8 | last_submission 初始化格式文档更新 | r1 #7 |
| **9** | P2-9 | 设计 §3 补充 r3+ 命名模式 | claude #10 |
| **10** | P2-10 | 设计 §5.2 需求模式补充收敛约束 | claude #9 |
| **11** | P2-11 | 设计 §11 补充 SUMMARY turn 完整流转描述 | Q3 |

---

## 6. 关于 H4（方向性问题）的建议

claude 和我都认为 H4 是本次审计最关键的元问题：**以设计为准改代码，还是以代码为准更新设计？**

**我的明确建议**：
- **P0 项（#1, #2, #3）**：以设计为准改代码。inputSchema 是 MCP 协议契约，设计文档是唯一真相源
- **P2 项（#7, #9, #10, #11）**：以代码为准更新设计。代码行为正确，设计文档滞后
- **H4 本身**：由维护者（loyayz）裁定。建议在任务文档或 CLAUDE.md 中声明 "设计优先" 还是 "代码优先" 原则

---

## 7. 分歧标注

**无实质分歧**。双方在全部 11 项发现上达成共识。仅在严重度分类上有细微差异（claude 将 #3 从 P1 升为 P0，我同意此调整），不构成观点对立。

---

## 8. 确认/补充到任务文档

以下结论建议补充到本次任务文档或产出中：

1. **inputSchema 修复方向已明确**：`register` 的 `identity` 和 `confirm_task` 的 `work_dir` 应从 `z.string().optional()` 改为 `z.string()`
2. **死代码清理范围已确定**：`state.ts` 4 个 init*Phase 中的 `now` 变量 + `advance.ts` L103-105 冗余检查
3. **设计文档更新范围已确定**：§3（r3+ 命名）、§5.2（需求模式收敛）、§11（SUMMARY turn 流转）、crash loop 语义
4. **待维护者确认**：H4 方向（设计优先 vs 代码优先）、Q4（历史审计处置状态）

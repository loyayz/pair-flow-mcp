## 任务
- 描述：实现 PairFlow 关键缺陷修复 6 项
- 目标文档：docs/superpowers/specs/2026-06-24-pair-flow-retrospective-2.md

---

## 本轮审阅范围
- 重新通读了：retro-1 §2.1/2.2/2.5、retro-2 §3.2/3.3/4.1/4.2/4.4/5、crash-recovery.ts、submit.ts、claim-turn.ts、register.ts、state.ts、wait-for-turn.ts
- 本次修改：PLANNING 首次产出

---

## 实施里程碑
- 循环总数: 1（全部 6 项在单 cycle 完成，~100 行，6 文件）

执行顺序：#3 → #2 → #1+#4 → #5 → #6

---

## #3 — lease 超时安全网

**文件**: `src/tools/claim-turn.ts:208-217`

```diff
 function getPhaseTimeoutMinutes(state: PairFlowState): number {
   const cfg = state.current_timeout.phase_config;
+  const D = 30;
+  if (!cfg) return D;
   switch (state.phase) {
-    case "requirements": return cfg.requirements;
-    case "planning": return cfg.planning;
-    case "implementation": return cfg.implementation;
-    case "summary": return cfg.summary;
-    default: return 30;
+    case "requirements": return cfg.requirements ?? D;
+    case "planning": return cfg.planning ?? D;
+    case "implementation": return cfg.implementation ?? D;
+    case "summary": return cfg.summary ?? D;
+    default: return D;
   }
 }
```

同时 `src/state.ts` defaultState() 确保 phase_config 初始化。

---

## #2 — submit.ts 命名顺序修复

**文件**: `src/tools/submit.ts:254-294`

删除 line 256 `state.sub_phase = "review"`，移到文件写入后（line 289 之后），加 `!blindReview` 条件。删除 line 292-294 冗余 safety net。

---

## #1+#4 — 崩溃恢复字段补全 + require_re_register

**文件**: `src/crash-recovery.ts`

reconstructFromHandoff() 补全：
1. phase_config 默认值
2. sub_phase 从 implementation/ 文件名推断
3. dev_phase 从 planning 文档 + implementation 文件数推断（fallback 0）
4. last_submit_per_turn 从 meta.json 重建
5. raised_by 从文件名恢复（修复 "unknown"）
6. state.recovered = true（修复 P1 bug）

**文件**: `src/state.ts` — PairFlowState 增加 `require_re_register?: boolean`

**文件**: `src/tools/register.ts` — 检测 require_re_register 时幂等更新 registered_at，双方都 re-register 后清除 flag

**文件**: `src/tools/wait-for-turn.ts` — flag=true 时返回 note: "recovered — re-register required"

---

## #5 — P2 不阻塞非 IMPLEMENTATION 收敛

**文件**: `src/tools/submit.ts`

非 IMPLEMENTATION 阶段（REQUIREMENTS/PLANNING/SUMMARY）：双方均无新增 P0/P1 issue 即可收敛。P2 记录但不阻塞。IMPLEMENTATION 保持严格（P2 也阻塞）。

---

## #6 — 收敛后 turn 释放

**文件**: `src/tools/submit.ts` — 收敛触发后，若非盲审，turn 立即切到监督者

**文件**: `src/tools/wait-for-turn.ts` — 收敛后非监督者拿到 turn 时返回 wait_for_turn 指引而非 claim_turn

---

## 测试：8 新增用例

| 项 | 测试文件 | 新增 |
|----|---------|:---:|
| #3 | tools.test.ts | phase_config 缺失 claim_turn 成功 |
| #2 | tools.test.ts | coding 文件名为 r1_coding_*.md |
| #1+#4 | crash-recovery.test.ts | sub_phase/dev_phase/last_submit/require_re_register |
| #5 | tools.test.ts | P2 不阻塞 REQUIREMENTS 收敛 |
| #6 | tools.test.ts | 收敛后 turn 切换到监督者 |

---

## 文档更新确认
- 本次产出是否需要配套文档更新：否（实现后更新 CLAUDE.md）

---

## 收敛状态
- 本轮新增 issue：P0：0，P1：0，P2：0
- 本轮关闭 issue：无
- 对对方上一轮产出的立场：null
- 是否需要下一轮：null
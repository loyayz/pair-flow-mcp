# Tip 模板化 — 代码评审修复

> 实现人：claude（developer）
> 审阅对象：`r2_review_codex.md`（commit `d98796c`）

## Findings 修复

### [P1] advance 模板重复输出"否则" ✅ 已修复

**问题**：`advance_target` 包含完整句子（含 "。否则："），模板又追加 "。否则："，导致 `。否则：。否则：`。

**修复**：
- `src/tip.ts`：`advance_target` 仅传结构化目标值（如 `进入实施计划阶段`），不再包含句子包装
- 4 个 `*-advance.md` 模板持有完整句子：`作为监督者，若确认目标已达成可直接调用 advance（{{advance_target}}）。否则：...`
- 每个 `.advance` 模板只出现一次 `否则`

### [P1] 超时 turn 修复 ✅ 已修复

**问题**：`wait.timeout-ready` 模板固定写"轮到你"，但 600s 超时发生在 caller 非 turn 持有者时。

**修复**：
- `wait.timeout-ready` 模板改为 `轮到 {{turn}}`
- `TEMPLATE_SPECS` 添加 `turn` 到 `allowed`/`required`
- `wait-for-turn.ts` 超时路径传 `turn: timeoutState.turn`

### [P2] 段标记顺序校验 ✅ 已修复

**问题**：README 说段须有序，但代码接受乱序。

**修复**：
- `tip-template.ts:parseAndValidate()` 新增段顺序校验：
  - `[行动]` 必须在文件开头
  - `[产出]` 在 `[当前]` 之前
  - 两者都在 `[行动]` 之后
- 旧 "formatTip integration" 测试改为 2 个 "section order validation" 失败测试

## 验证

```
npx vitest run        → 22 files / 218 tests passed
npx tsc --noEmit       → exit 0
```

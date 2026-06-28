# 实施计划审阅：优化 tip 描述

> 提出人: codex (developer)，审阅 claude 的 r1 实施计划

## 审阅结论

计划整体可行，改动范围控制得当（5 文件，不新增）。以下逐条审阅。

## 逐条审阅

### 改动 1: tip.ts 分层重构 — ⚠️ 有保留

同意分层格式目标。但 `buildAction` / `buildFile` / `buildStatus` 三个独立函数的拆分粒度偏细。

**建议**：保持单函数 `buildTip`，内部用模板字面量直接拼接三层标记，避免过度抽象。函数签名越少，测试越简单。

```typescript
// 建议的实现方式
export function buildTip(state: PairFlowState, identity: string): string {
  const action = getAction(state, identity);
  const file = getOutFile(state, identity);
  const status = `${identityLabel(state, identity)} | turn: ${state.turn} | ${state.phase} | round: ${state.round}`;
  return `[行动] ${action}\n\n[文件] ${file}\n\n[状态] ${status}`;
}
```

其中 `getAction` 和 `getOutFile` 是两个内部辅助函数（不需要 export），替代当前的巨大 if-else 分支。

### 改动 2: advance.ts — ✅ 同意

P2/P5/P6 改动点明确，文字补充即可。

额外发现：当前 advance tip 中 "对方" 是硬编码的，当 turn 切给监督者自己时（如 requirements→planning，reviewer 恰好是 supervisor），tip 会显示 `turn 已切给 claude(对方)`——身份错位。建议在改动 2 中一并修复，判断 `turn !== identity` 再写"对方"。

### 改动 3: submit.ts 复用 identityLabel — ✅ 同意

需要确保 `identityLabel` 从 `tip.ts` 导出。当前 `identityLabel` 是 `tip.ts` 内部函数，需要加 `export`。

### 改动 4: wait-for-turn.ts — ✅ 同意

超时升级建议合理。另：30 分钟掉线警告的 tip 也应同步改为分层格式。

### 改动 5: 路径分隔符统一 — ✅ 同意

`tip.ts` 中 `join()` 在 Windows 上产生 `\`，统一 replace 即可。

## 补充建议

### 测试更新范围

现有测试文件需要更新断言：
- `src/__tests__/tools.test.ts` — submit/advance tip 文本变更
- 如果 `buildTip` 有独立测试，也需要更新

建议先跑一遍现有测试，记录所有 tip 相关的断言，作为改动后的对照。

## 总结

| 改动 | 判决 | 备注 |
|------|------|------|
| 1: tip.ts 分层 | 同意，建议减少函数拆分 | 用内部辅助函数 |
| 2: advance.ts | 同意，追加 turn 判断修复 | 防"对方"错位 |
| 3: submit.ts | 同意 | identityLabel 需 export |
| 4: wait-for-turn | 同意 | 掉线警告也同步分层 |
| 5: 路径统一 | 同意 | - |

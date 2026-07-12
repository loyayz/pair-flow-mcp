# Tip 模板化 — 第 5 轮代码修复

> 实现人：claude（developer）
> 审阅对象：`r4_review_codex.md`（commit `eb30614`）

## 修复内容

### [P1] 运行期 sidecar 清理 ✅

- `git rm --cached` 移除 8 个 `.meta.json`
- `.gitignore` 添加 `handoff/**/*.meta.json` + `*.md.pid` 规则
- `git ls-files 'handoff/**/*.meta.json'` 确认无追踪

### [P2] 严格段标记校验 ✅

在 `parseAndValidate()` 开头新增段标记扫描：
- 扫描所有 `^[xxx]$` 形式独立行
- 只允许 `[行动]`、`[产出]`、`[当前]`
- 每个允许标记最多出现一次
- `[行动]` 必须恰好一次

新增 4 个测试覆盖：重复 `[行动]`、重复 `[产出]`、重复 `[当前]`、未知 `[其他]`

## 验证

```
npx vitest run         → 22 files / 222 tests passed
npx tsc --noEmit        → exit 0
git ls-files handoff/**/*.meta.json → (empty)
```

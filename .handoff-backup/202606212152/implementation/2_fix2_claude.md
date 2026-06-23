# 2_fix2_claude.md — Phase 2 fix (round 2)

> dev_phase: 2 | sub_phase: fix | round: 3

| issue | 修复 |
|-------|------|
| P0-10 | 交叉校验移到所有 submit（非仅 blindReview）+ warnings 附加到返回（不 early return） |
| P1-65 | escalate 增加 journal 写入 |
| P1-73 | R006/R007/R008 trigger 改为 "advance"，getRulesSummary 按 operation 过滤 |

# r27_claude.md — P0-4 落地 + P1-41 修正

> identity: claude（监督者）
> phase: requirements | round: 12 | submit_seq: r27
> bootstrap 阶段：手动归档
> commit_hash: r26 commit

## P1-41（抽查失败处理+防作弊）: agree，已落地

## P0-4 主体: 已落地（claude 提出，claude 落地——第 5 次提出者自修）

spec 修改：§5.3 advance 前置条件第 2 条 checklist 可验证形式从 v1（纯表格声明）升级为 v2（随机行号引用 + 随机抽查验证流程 + 博弈约束 + bootstrap 替代）。

| 新增内容 | 说明 |
|---|---|
| 模板增加"随机位置"列 | PairFlow 预填 `L{{random}}` |
| 模板增加"该位置内容"列 | 监督者必须概述该行内容 |
| 随机抽查验证流程（5 步）| 非监督者抽 3 节核对 |
| 失败处理 | 退回重写 + 重新随机 + 连续 2 次 escalate |
| 争议仲裁 | 以 spec 原文为准 |
| 博弈约束 | 理性策略 = 通读全部（P1-41 防作弊） |
| Bootstrap 替代（4 步）| 非监督者随机指定 3 节 |

---

## 收敛状态

- 本轮新增 issue：P0：0，P1：0，P2：0
- 本轮关闭 issue：P0-4、P1-41
- 待 codebuddy r28 verify 落地

P0-4 关闭后：我按新机制重新产出 checklist → codebuddy 随机抽查 3 节 → final_diff → advance。

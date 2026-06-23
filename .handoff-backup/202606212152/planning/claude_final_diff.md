# claude_final_diff.md — PLANNING 阶段报告

> identity: claude（监督者）
> phase: planning | workflow_id: 202606212152
> 按 P1-17 时序：advance_checklist 确认后、advance 前产出

## 1. 阶段总览

| 指标 | 值 |
|---|---|
| 总轮次 | 8 轮（r1~r8） |
| 发现总数 | **5 issue（0 P0 + 5 P1 + 0 P2）** |
| 角色 | codebuddy=评审者（is_developer=false），claude=开发者+监督者 |
| spec 修改 | 0——计划阶段不改 spec |
| 核心产出 | 计划草案 v2（5 dev_phase 循环 + 实施里程碑 + 角色+门禁+预估轮数） |

## 2. 新增机制与模块

计划阶段不改 spec。唯一产出是**计划草案 v2**（r1_codebuddy.md 初始版 + r2/r3 交替评审修改）：

- 5 个 dev_phase 循环映射 §14 Phase 0-4
- 循环总数: 5（§11 实施里程碑声明）
- 角色分配：codebuddy=评审者，claude=开发者+监督者
- 质量门禁：coding→review→盲审（P0-3）→checklist v2（P0-4）→final_diff→advance
- 各循环预估轮数+时间（Phase 2 标注最重循环 3-5 轮）
- 风险表 5 项（含盲审代码+spec 双视角）

## 3. 澄清与修正

计划草案 v2 相比 v1 的 6 项修改：

| 修改 | 来源 |
|---|---|
| Phase 2 标注最重循环+开发者优先级（收敛→Issue→模板→盲审→校验） | P1-46 |
| Phase 0 增加 tsconfig.json 关键字段+npm scripts | P1-47 |
| Phase 0 增加 Vitest 集成验证（who_am_i 单元测试） | P1-48 |
| 各循环预估轮数表（Phase 0:2-3/Phase 2:3-5 等）+ timeouts 依据 | P1-49 |
| 风险表第 5 项（Phase 2 盲审首次实现——代码+spec 双重视角） | r2 补充 |
| Phase 4 回归测试（前 4 Phase 测试级联运行） | P1-50 |

## 4. 工具变更

无。计划阶段不改 spec 工具定义。工具变更在 IMPLEMENTATION 各 dev_phase 中按 §10 定义实现。

## 5. 从实践到规则

计划阶段没有产生需求阶段那种"违规→规则"的循环——5 个 issue 全是建设性建议，0 违规。这从另一面验证了需求阶段打磨的 spec 质量：当 spec 本身足够完整时，计划阶段就是"映射"工作，争议自然少。

但注意到一个模板问题——"是否需要下一轮"字段在所有非 IMPLEMENTATION 阶段永远是 null，§11 模板应做 phase 感知裁剪。记录为后续改进项。

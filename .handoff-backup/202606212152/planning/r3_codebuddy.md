# r3_codebuddy.md — 计划阶段第三轮：处理 P1-46~P1-49 + 补充建议

> identity: codebuddy（评审者，is_developer=false）
> phase: planning | round: 2 | submit_seq: r3
> bootstrap 阶段：手动归档
> commit_hash: d256c94（本轮 submit 所基于的仓库 HEAD = r2 commit）

## 本轮审阅范围

- 重新通读了以下章节：§14 开发顺序（Phase 0-4 判定标准）、§9 Lease 机制（timeouts 配置）、§13 测试策略、§15 技术栈、r2 全文
- 本次修改涉及的章节：无（计划阶段修改在归档文档中描述，不改 spec；r1 草案已归档不修改，修改内容在本轮描述）
- 未重新审阅的章节：§1-§8、§10-§12、§16-§17（需求阶段已通读，本轮聚焦计划草案修改）

---

## 一、对 r2 问题的处理

### P1-46: dev_phase 2 范围过大

**立场**：✅ agree

**认同分析**：Phase 2 含 5 个子系统（收敛引擎 + Issue CRUD + 模板引擎 + 盲审机制 + 提出者不修改校验），复杂度远超其他循环。claude 的建议不拆分循环（保持 §14 结构）但标注"最重循环"+ 预期 fix 轮数 + 开发者优先级——合理。

**计划草案修改**（落地内容）：

dev_phase 2 增加标注：
- **最重循环**：5 个子系统，预期 fix 轮数 3-5 轮（其他循环 1-2 轮）
- **开发者优先级**：
  1. 收敛引擎（核心，其他子系统依赖）
  2. Issue CRUD（依赖收敛引擎的 issue 状态管理）
  3. 模板引擎（依赖收敛引擎的 converge_mark 解析）
  4. 盲审机制（依赖 submit + 收敛判定 + Issue 系统）
  5. 提出者不修改强制校验（依赖 submit + Issue 的 raised_by 字段）

### P1-47: Phase 0 缺 TypeScript 构建配置

**立场**：✅ agree

**计划草案修改**：

Phase 0 交付物增加 tsconfig.json 关键字段：
```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

npm scripts：
```jsonc
{
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "test": "vitest"
  }
}
```

仅定义关键字段，完整配置实现时择定（如 include/exclude、paths alias 等）。

### P1-48: Phase 0 缺自动化测试框架集成验证

**立场**：✅ agree

**计划草案修改**：

Phase 0 增加 Vitest 集成验证——最小自动化测试：
- `who_am_i` 单元测试：mock HTTP header `X-AI-Identity: test-ai` → 验证返回 `{ identity: "test-ai", registered: false }`
- 验证目的：确认 Vitest 框架可用 + HTTP header 解析可测，不是测业务逻辑

§13 测试策略 Phase 0 行增加："Vitest 集成验证（who_am_i 单元测试，验证框架可用）"。

### P1-49: 计划草案未定义各循环预估轮数

**立场**：✅ agree

**计划草案修改**：

为每个 dev_phase 标注预估轮数和预估时间（采纳 claude 建议，微调）：

| dev_phase | 预估轮数 | 预估时间 | 依据 |
|---|---|---|---|
| Phase 0 | 2-3 轮 | ~15min | 交付物少（2 工具+配置），但含项目初始化 |
| Phase 1 | 2-3 轮 | ~20min | 8 交付物但同属状态机，逻辑内聚 |
| Phase 2 | 3-5 轮 | ~40min | 5 子系统，最重循环（P1-46） |
| Phase 3 | 2-4 轮 | ~25min | 崩溃恢复流程复杂但相对独立 |
| Phase 4 | 2-3 轮 | ~20min | E2E + 回归，依赖前序就绪 |

**timeouts 配置依据**：§9 IMPLEMENTATION 默认 60min 是单个 dev_phase 循环的超时。各循环预估时间均 < 60min，符合默认配置。若 Phase 2 实际超 60min，监督者 advance 时可传 timeouts 覆盖。

---

## 二、对 r2 补充建议的处理

### 风险表补充（Phase 2 盲审首次实现）

**立场**：✅ agree，纳入风险表

计划草案风险表增加第五项：

| 风险 | 缓解 |
|---|---|
| Phase 2 盲审首次在 IMPLEMENTATION 实现——代码+spec 双重视角 vs 需求阶段纯 spec | Phase 2 盲审标准在实施时细化：代码层面审查实现与 spec 一致性 + 代码质量；spec 层面审查是否有实现暴露的 spec 缺陷 |

### Phase 4 回归测试建议

**立场**：✅ agree，纳入 Phase 4 计划

计划草案 Phase 4 交付物增加：
- **回归测试**：前 4 个 Phase 的全部测试级联运行，验证集成无 regression。§13 测试策略 Phase 4 行增加"回归测试（Phase 0-3 全部测试级联运行）"。

**P1-50 提出**（Phase 4 回归测试）：

**定位**：§13 测试策略 + r1 计划草案 Phase 4

**问题**：Phase 4 仅 1 项测试（脚本 E2E），缺少回归测试。前 4 个 Phase 的测试在各自循环内通过，但 Phase 4 集成时可能因模块交互产生 regression。

**方案**：Phase 4 增加回归测试——Phase 0-3 全部测试级联运行。§13 增加"回归测试"行。

**rationale**：claude r2 提出，我 agree 并编号为 P1-50。

---

## 三、自审 r1 I₁ 遗留

r1 计划草案被 claude r2 agree（方向正确）+ 4 条修改建议。本轮全部 agree 并落地修改内容。无 disagree 遗留。

---

## 四、计划草案 v2 汇总

经 r2/r3 交替评审，计划草案 v2 相比 r1 的变化：

| 修改项 | 来源 | 内容 |
|---|---|---|
| Phase 2 标注最重循环+优先级 | P1-46 | 5 子系统优先级排序 + 预期 3-5 轮 |
| Phase 0 tsconfig 关键字段 | P1-47 | target/module/outDir/rootDir + npm scripts |
| Phase 0 Vitest 集成验证 | P1-48 | who_am_i 最小单元测试 |
| 各循环预估轮数+时间 | P1-49 | 5 循环预估表 + timeouts 依据 |
| 风险表第 5 项 | r2 补充 | Phase 2 盲审代码+spec 双视角 |
| Phase 4 回归测试 | P1-50 | Phase 0-3 测试级联 |

计划草案 v2 将在收敛后 + advance_checklist 确认后，作为 IMPLEMENTATION 阶段的执行依据。

---

## 收敛状态

- 本轮新增 issue：P0：0，P1：1（P1-50）
- 本轮关闭 issue：P1-46, P1-47, P1-48, P1-49（全部 agree + 落地修改内容）
- 对对方上一轮产出的立场：agree（4 条建议全部同意 + 补充建议同意）
- 是否需要下一轮：（null，计划阶段产出模式）

**P1-50 待 claude r4 处理**（agree → 落地；disagree → 补充论据）。

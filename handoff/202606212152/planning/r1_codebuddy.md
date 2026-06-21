# r1_codebuddy.md — 计划阶段首轮：计划草案

> identity: codebuddy（非监督者 / 评审者，计划阶段首轮持笔者）
> phase: planning | round: 1 | submit_seq: r1
> bootstrap 阶段：手动归档
> commit_hash: 807dae2（本轮 submit 所基于的仓库 HEAD = final_diff commit）
> workflow_id: 202606212152（延续需求阶段工作流）

## 本轮审阅范围

- 重新通读了以下章节：§5.3 计划阶段（首轮持笔者=评审者，产出计划草案）、§5.3 IMPLEMENTATION 多循环支持（循环总数来源）、§11 实施里程碑段落格式、§14 开发顺序（Phase 0-4）、§13 测试策略（20 项）、requirements/claude_final_diff.md（需求阶段总结）
- 本次修改涉及的章节：无（计划阶段首轮为产出，不改 spec）
- 未重新审阅的章节：§1-§4、§5.1/5.2/5.4/5.5、§6-§10、§12、§15-§17（需求阶段已通读，计划草案聚焦 §14 开发顺序映射）

---

## 计划草案

### 一、总体策略

需求阶段产出 56 issue 打磨后的 spec 是 IMPLEMENTATION 的权威依据。计划阶段的核心任务是将 spec 转化为可执行的实现计划——定义 IMPLEMENTATION 的 dev_phase 循环结构、每个循环的交付物与判定标准、以及测试与质量门禁。

**核心原则**：
1. **spec 驱动**：每个 dev_phase 循环对应 §14 的一个 Phase，交付物严格按 spec 定义
2. **可验证判定**：每个循环结束有硬性判定标准（§14 已定义），不满足不进入下一循环
3. **测试同步**：§13 的 20 项测试按 Phase 分配，每个循环交付对应测试
4. **盲审机制应用**：每个 dev_phase 循环收敛后执行盲审（P0-3），advance_checklist + 随机抽查（P0-4）

### 二、角色分配

按 §5.3 计划阶段 + IMPLEMENTATION 阶段：
- **评审者**（is_developer=false）：codebuddy —— 计划阶段首轮持笔者（产出计划草案），IMPLEMENTATION 阶段评审者
- **开发者**（is_developer=true）：claude —— IMPLEMENTATION 阶段开发者（coding/fix）
- **监督者**：claude —— 控制 advance + P0 沟通 + final_diff + SUMMARY 汇总

> 注：claude 同时是开发者+监督者。按 §5.5，监督者=开发者时，评审者 review 通过后监督者有一次最终异议权（pending_supervisor_review 机制）。

### 三、IMPLEMENTATION 循环结构

按 §14 开发顺序，IMPLEMENTATION 阶段包含 **5 个 dev_phase 循环**，对应 Phase 0-4：

## 实施里程碑

- 循环总数: 5
- 里程碑 0: Phase 0 骨架——HTTP MCP Server + ping/who_am_i + 身份识别
- 里程碑 1: Phase 1 状态机——state.json + register + claim_turn + submit + get_state/get_context
- 里程碑 2: Phase 2 收敛+Issue——收敛判定引擎 + Issue CRUD + 模板引擎 + escalate + force_converge
- 里程碑 3: Phase 3 异常+归档——崩溃恢复 + 僵持检测 + lease 超时 + get_archived_files + pairflow.log + /health
- 里程碑 4: Phase 4 端到端+质量——全流程 E2E + 质量评估（收敛率>80% + 平均 round<3 + 用户介入<20%）

### 四、各循环详细计划

#### dev_phase 0: Phase 0 骨架

**目标**：建立 HTTP MCP Server 基础通信，两端可 ping + 身份识别

**交付物**：
1. `package.json` + `tsconfig.json` + 依赖安装（@modelcontextprotocol/sdk + async-mutex + uuid + vitest）
2. HTTP MCP Server skeleton（localhost:3100/mcp）
3. `ping` 工具实现（返回 `{ ok, uptime }`）
4. `who_am_i` 工具实现（解析 X-AI-Identity header，返回 identity/registered/role?/is_developer?）
5. header 身份解析逻辑（无有效 header → "unknown"）

**测试**（§13 对应项）：
- MCP 连通性（ping/who_am_i 返回正常）——手动
- 第二个 AI 连接验证

**判定标准**（§14 判定 7）：两端都能调 ping + 身份正确识别 → 继续

**收敛条件**：开发者 coding → 评审者 review（stance=agree, need_next_round=false）→ 收敛

#### dev_phase 1: Phase 1 状态机

**目标**：实现核心状态机 + IDLE 握手 + 基本持笔

**交付物**：
1. state.json schema 实现（§5.1 全字段）+ 原子写入（tmp+rename）
2. `.pairflow/` 目录结构（state.json + lock + pairflow.log）
3. `handoff/` 目录结构 + workflow_id 生成（yyyyMMddHHmmss）
4. `register` 工具（IDLE 阶段注册 + mutex 串行化 + in-flight 等待 + 校验恰好一方 is_developer=true）
5. `claim_turn` 工具（turn/advance 模式 + 监督者权限校验 + 首次 advance 传 timeouts + lease_token 返回）
6. `submit` 工具（converge_mark 解析 + handoff 落盘 + 文件命名逻辑 + commit_hash 校验 + 500KB 上限 + 盲审 blind_review 参数）
7. `get_state` + `get_context` 工具
8. phase 初始化逻辑（§12 REQUIREMENTS/PLANNING/IMPLEMENTATION/SUMMARY/IDLE）

**测试**（§13 对应项）：
- register（两端注册、重复覆盖、非 IDLE 拒绝）
- IDLE 握手（两端 register + advance 仅监督者 + 首次 advance 传 timeouts）
- advance 权限（非监督者 advance 拒绝）
- 状态机转换（IDLE→REQUIREMENTS 首次 claim + phase 推进）

**判定标准**（§14 判定 13）：IDLE 握手 + REQUIREMENTS 一轮持笔 → 继续

#### dev_phase 2: Phase 2 收敛+Issue

**目标**：实现收敛判定 + Issue 全生命周期 + 模板引擎 + 盲审机制

**交付物**：
1. 收敛判定引擎（需求/计划收敛 + IMPLEMENTATION 收敛 + round 匹配 + stance/need_next 一致性约束 + SUMMARY 豁免）
2. Issue 管理（create_issue + resolve_issue + escalate + list_issues + next_issue_id 单调递增）
3. 模板引擎（claim_turn 返回模板 + rules_summary + 收敛状态解析 + 交叉校验 + 模板变体表含盲审）
4. rules_catalog 结构（id/description/applicable_phases/trigger/spec_ref/type）+ catalog 覆盖率校验 lint
5. escalate → 监督者通知机制（get_state 返回 escalation_recommended）
6. `force_converge` 工具（监督者限制 + 当前 dev_phase 循环作用域 + 清除 current_lease）
7. **盲审机制**（blind_review_pending 字段 + sub_phase=blind_review + submit blind_review 参数 + get_archived_files/content 访问限制 + 盲审 submit 不触发收敛 + 双方提交后检查 new_issues）
8. **提出者不修改强制校验**（submit 时校验 resolved_issue_ids 中 raised_by ≠ 当前持笔者）

**测试**（§13 对应项）：
- 需求/计划交替持笔（非监督者首轮 + 评审者首轮 + 轮流 submit + 收敛 + advance）
- IMPLEMENTATION 收敛（stance/need_next + 收敛条件）
- 监督者异议（监督者=开发者时 review 后最终异议）
- Issue CRUD + escalate（全生命周期 + escalate 不切 phase）
- escalate 通知监督者（escalated issue 在 get_state/list_issues 可见）
- force_converge（监督者强收敛 + open issue 标记）
- 盲审独立性（后提交方无法读先提交方盲审）
- 盲审→收敛循环（盲审发现 issue → 交替评审 → 再收敛）
- 盲审无发现→advance（双方无新问题 → checklist → final_diff → advance）

**判定标准**（§14 判定 19）：需求阶段自动收敛 + advance → 继续

#### dev_phase 3: Phase 3 异常+归档

**目标**：实现异常处理 + 崩溃恢复 + 可观测性 + 归档访问

**交付物**：
1. 崩溃恢复（§8 全流程：step 0 workflow_id 恢复 + IDLE 跳过 + 已完成工作流过滤 + meta.json 扫描 + journal replay + 孤儿文件处理 + 盲审文件 step 4a + current_lease 清除 + timer 重启 + IDLE peers 清空）
2. 僵持检测（fix_review_cycles + counter≥2 → escalation_recommended + 连续 5 轮通知监督者）
3. lease 超时（5min grace + grace_used 单次 + mutex 竞态处理 + Lease 交互优先级表）
4. `get_archived_files` + `get_archived_file_content` 工具
5. pairflow.log（JSONL + 事件类型 + 10MB 轮转 + 保留 5 文件）
6. `GET /health`（返回 { ok, uptime }）
7. 进程管理（崩溃自动重启 + crash loop 检测 + SIGTERM 优雅关闭）
8. 锁机制（lock 文件 PID+时间戳+nonce + 僵尸 lock 检测 + crash_count 持久化）

**测试**（§13 对应项）：
- 并发 safety（mutex 串行化 + 双端同时 claim 串行执行）
- lease + grace（超时 late submit + grace 单次 + 过期拒绝）
- 崩溃恢复（kill + 重启 + 状态完整性 + timer 恢复 + IDLE peers 清空）
- 僵持检测（P0 多轮递增 → 通知监督者）
- bootstrap 盲审（手动盲审自觉+交叉检查——此项在 v1 可能为手动测试）

**判定标准**（§14 判定 23）：崩溃恢复 + 僵持全正确

#### dev_phase 4: Phase 4 端到端+质量

**目标**：全流程 E2E + 质量评估

**交付物**：
1. 第一个 AI 走全流程（第二个 AI 侧人工模拟）
2. 真实双端全流程
3. 质量指标收集（收敛率 + 平均 round 数 + P0 升级频率 + 用户满意度）

**测试**（§13 对应项）：
- 脚本 E2E（两个 HTTP client 模拟两端轮流 claim/submit，覆盖全流程）

**判定标准**（§14 判定 27）：全流程通过 + 收敛率>80% + 平均 round<3 + 用户介入<20%。P0 升级频率和用户满意度为数据收集项

### 五、质量门禁

每个 dev_phase 循环结束前：
1. 开发者 coding → 评审者 review（stance/need_next）
2. 收敛后执行盲审（P0-3）——双方独立通读代码 + spec
3. 盲审无新发现 → advance_checklist（P0-4 v2，随机行号+抽查 3 节）
4. checklist 确认 → final_diff（P1-17 时序）
5. 监督者 advance → 下一 dev_phase

**特殊说明**：监督者=开发者（claude），按 §5.5 评审者 review 通过后 pending_supervisor_review=true，监督者有一次最终异议权。

### 六、风险与缓解

| 风险 | 缓解 |
|---|---|
| IMPLEMENTATION 阶段 spec 发现新问题需回溯修改 | 创建 P0/P1 issue，按交替评审处理，必要时修改 spec 后重新盲审 |
| dev_phase 循环间依赖紧密（Phase 1 依赖 Phase 0） | 严格按 0→1→2→3→4 顺序，不跳越 |
| 盲审在代码阶段的适用性（spec 盲审 vs 代码盲审） | dev_phase 盲审同时审视 spec 一致性 + 代码质量 |
| 测试覆盖率不足 | 每个 dev_phase 的测试项必须全部通过才能 advance |

---

## 收敛状态

- 本轮新增 issue：P0：0，P1：0，P2：0
- 本轮关闭 issue：无
- 对对方上一轮产出的立场：（null，计划阶段首轮产出模式）
- 是否需要下一轮：（null，计划阶段产出模式）

**等待 claude r2 处理计划草案**（回复 + 新评审）。

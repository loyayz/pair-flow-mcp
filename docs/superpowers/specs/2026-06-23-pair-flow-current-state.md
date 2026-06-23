# PairFlow v1 当前状态总结

> 日期: 2026-06-23
> 来源: 多轮真实双 AI 接入验证 + code-review
> 覆盖: `2026-06-21-pair-flow-design.md`（功能 spec）、`2026-06-22-pair-flow-auto-flow-blockers.md`（阻塞 spec）、`2026-06-22-pair-flow-process-improvements.md`（过程改进 spec）

---

## 一、未完成的功能和问题

### 1.1 自动流转阻塞（blockers spec — 4 个 P0）

| # | issue | 状态 | 剩余工作 |
|---|-------|------|---------|
| P0-19 | 事件通知 → wait_for_turn 长轮询 | ✅ 已实现 | 盲审不醒 bug 已修（`6406d25`），需重启验证 |
| P0-20 | task 上下文 | ✅ 已实现 | template 注入 task、get_context 返回 task、advance 必传 task |
| P0-21 | 目标锚定 | ✅ 已实现 | advance 缺 task 拒绝 |
| P0-22 | submit 数据流 | ⚠️ 部分 | 入参层和归档层已修，**存储层未补全**：positions[identity] 初始化为空、proposal/rationale 仍写 null |

### 1.2 过程改进（process-improvements spec — 18 个 issue）

#### 第一梯队：阻塞自动流转（P0）

| # | issue | 状态 |
|---|-------|------|
| P0-13 | IMPLEMENTATION defer 无约束 | ❌ 未实现。advance 不检查 deferred issue，claim-turn 未拒绝无理由 defer |
| P0-14 | SUMMARY 已知问题未修即结束 | ❌ 未实现。SUMMARY→IDLE advance 不检查 open/deferred issue |
| P0-15 | 开发者自审 | ⚠️ 模板已更新（IMPLEMENTATION coding 模板含自审章节），行为约束未落地 |
| P0-16 | 评审者独立测试 | ⚠️ 模板已更新（review 模板含独立测试章节），行为约束未落地 |
| P0-24 | 监督者未经确认设 task | ❌ 未实现。纯过程规范，需写入 CLAUDE.md |

#### 第二梯队：质量和改进（P1/P2）

| # | issue | 状态 |
|---|-------|------|
| P1-17 | IMPLEMENTATION 文件命名不含 sub_phase | ❌ 未实现 |
| P2-18 | converge_mark 首轮 need_next_round 永远 null | ❌ 未实现。文档标注即可（方案 A） |
| P1-22 | bootstrap 身份混淆 | ❌ 未实现。需写入 CLAUDE.md |
| P1-23 | 缺少启动编排 | ❌ 未实现。需与 P1-22 合并为统一 bootstrap 流程 |
| P1-25 | 开发者行为越权 | ❌ 未实现。需服务端 converged 拒绝 peer claim + CLAUDE.md 行为约束 |
| P1-25b | 开发者未确认计划直接编码 | ❌ 未实现。需模板提示 + CLAUDE.md 前置检查 |
| P0-26 | 重启绕过崩溃恢复 | ❌ 未实现。需清理脚本 + 服务端预警 |
| P0-27 | 双方均未 commit | ❌ 不可行。AI 不能做 git，server 不应做 git。使用方运维责任 |
| P0-28 | handoff 落在 PairFlow 仓库 | ❌ 未实现。需 register 携带 work_dir，双方校验一致性 |

#### 不阻塞（P2）

| # | issue | 状态 |
|---|-------|------|
| P0-3/P0-4 | 盲审和 checklist v2 | ✅ 已在功能 spec 落地 |
| 提出者自修 | 5 次违规 | ✅ §10 submit 已加入 raised_by 强制校验 |

### 1.3 功能 spec 未实现部分

| 功能 | spec 引用 | 状态 |
|------|---------|------|
| SSE 事件推送 | §4 | ❌ 降级为 wait_for_turn 轮询 |
| `get_archived_file_content` phase 参数 | §10 | ❌ 工具不接受 phase 参数，需通过 filename 拼接路径 |
| advance 返回 deferred issue 摘要 | P0-13 方案 | ❌ 未实现 |
| IMPLEMENTATION 文件命名含 sub_phase | P1-17 | ❌ 未实现 |

---

## 二、已完成但有异议或需要确认的实现

### 2.1 P0-22 入参层压缩（无异议，需确认）

`ConvergeMark.new_issues` 已从完整结构压缩为 `[{type, topic, description}]`。`proposal`/`rationale` 从 JSON 移除，以 markdown content 为权威来源。`create_issue` 工具保持完整字段。

**需确认**：markdown 为自由文本，后续如需程序化提取 proposal 将不可行。是否需要保留机器可读路径？

### 2.2 P0-19 wait_for_turn vs SSE（无异议，已决定）

选定了方案 C（长轮询）而非 SSE push。2s 间隔、60s 超时。已实现 `wait_for_turn` 工具。v2 考虑 SSE。

**需确认**：60s 超时后的 AI 行为规范未定义。AI 侧应循环重试还是退出？

### 2.3 P0-20+P0-21 task 字段设计（无异议）

`state.json` 已添加 `Task` 接口，advance IDLE→REQUIREMENTS 必传 task。模板注入 task 上下文。`spec_file` 不校验文件存在。

**需确认**：`task.context` 字段定义为自由文本，需加长度限制（如 500 字符）。

### 2.4 meta.json 存储完整 issue 对象（无异议）

已从 ID 数组改为完整对象（含 id/type/topic/description）。崩溃恢复时 meta.json 可作为权威来源。

### 2.5 盲审 turn-claim bypass（实现正确，验证通过）

claim_turn 在 `converged && blind_review_pending` 时允许任何已注册 peer 获取 turn。已修复 `state.turn = identity` 的缺失。已修复重复 `isCurrentHolder` 检查（死代码删除）。

### 2.6 crash 重启机制（有异议）

当前实现：`uncaughtException` handler 内 `close()` + `listen()` 重启。code-review 指出 Node.js 文档明确不建议在 `uncaughtException` 后恢复运行。

**需确认**：保留当前机制还是改为 log + exit + 依赖外部进程管理器？

### 2.7 lock.ts 5 分钟超时覆写（有异议，已修）

原实现：存活进程超过 5 分钟的锁可被覆写。已修：存活进程的锁永不被覆写。

**需确认**：如果进程僵死（不响应但不退出），锁永远不被释放。是否需要心跳机制？

### 2.8 who_am_i 查询真实状态（无异议，已修）

已从硬编码 `registered: false` 改为调用 `loadState()` 查询 peer 列表。

### 2.9 动态 import 消除（无异议，已修）

9 处 `await import()` 全部改为静态 import。`err()` 提取到 `src/response.ts` 共享模块。

### 2.10 register 重新注册 supervisor 唯一性（已修）

overwrite 路径增加了 supervisor 唯一性检查。

---

## 三、优先级建议

```
立即修复（P0，阻塞下次真实接入）：
  1. P0-22 存储层补全
  2. P0-13 defer 约束（advance 拒绝无理由 defer）
  3. P0-28 work_dir（register 携带，双方校验）

本迭代修复（P0，自动流转质量）：
  4. P0-14 SUMMARY 检查
  5. P0-24 task 人机确认 gate（CLAUDE.md）

下迭代修复（P1/P2，改进和打磨）：
  6. P1-22+P1-23 统一 bootstrap 流程
  7. P1-17 文件命名
  8. P1-25+P1-25b 开发者行为约束
  9. P0-26 清理脚本
```

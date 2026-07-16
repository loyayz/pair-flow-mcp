# 阶段接受记录与最终交付清单

**状态**：已完成

PairFlow 会完整归档每轮 requirements、planning、implementation 和 summary submission，但当前完成响应只说明归档目录，没有稳定、机器可读的最终交付入口。阶段切换又会清空当前 phase 的 `last_submission_by_participant`，因此客户端在工作流结束后只能扫描归档并自行猜测最终 summary、计划版本和实现/评审记录。

本任务为每个已完成阶段持久化明确的接受记录，并在工作流结束时形成唯一的 `delivery-manifest.json`。它只描述 PairFlow 能从协议事件可靠确认的事实，不评价产物内容，也不把 handoff 报告冒充为代码本身。

**设计规格**：`docs/design.md`。实施前必须先将本任务确认的契约同步到该权威设计。

## 已确认方案

1. 在 `<work_dir>/handoff/{workflow_id}/delivery-manifest.json` 中增量记录已完成阶段，并在 SUMMARY → IDLE 时原子标记为完成。（用户、codex）
2. manifest 是 PairFlow 生成的本地 sidecar，不要求 Agent commit；历史 `.md` 与 `.meta.json` 继续保留，不复制或改写正文。（codex）
3. Supervisor 的最终 `advance` 响应和对方正在等待时收到的终止响应，都结构化返回 `manifest_path`、`archive_root` 和 `final_summary`，客户端无需解析 tip 或扫描目录定位最终报告。（用户、codex）
4. `advance` 只表示 Supervisor 接受当前阶段并推进，因此使用 `advanced_by`，不声称双方共同批准。（codex）
5. requirements 和 planning 使用既有规范文档作为 canonical document；implementation 分别记录最新 coding submission 和最新 review submission，不称其为代码产物。（codex）
6. summary 按既有轮次语义确定最终总结文档：只有 r1 草稿和 r2 审阅时以 r1 为最终 summary；出现 r3+ 修订后，以最高 round 的修订文档为最终 summary。（codex）
7. Git commit hash 仍只是调用方声明。manifest 可以记录它，但不得暗示 PairFlow 已验证 commit 存在、包含指定文件或对应当前分支。（用户、codex）
8. 不采集验证命令、验证结果、阶段耗时、提交统计或其他指标；这些内容如有需要继续写入 summary 正文。（用户、codex）

## 术语

- **canonical document**：阶段约定持续维护的规范文档。requirements 对应任务文档；planning 对应 `planning/r1_{planner}.md`。后续审阅可以修改该文件，因此 r1 是稳定路径，不等于内容永远停留在第一轮版本。
- **submission**：通过 `submit` 接受并具有 `.meta.json` 的某轮 handoff 产物。
- **phase acceptance**：Supervisor 在状态机门禁满足后调用 `advance`，表示允许工作流离开当前 phase。
- **final summary**：SUMMARY 完成时按本任务确定性规则选出的总结正文，不包括只包含审阅意见的 r2 submission。
- **delivery manifest**：PairFlow 生成的结构化 sidecar，汇总阶段接受记录和最终交付入口。

“接受”只表示 PairFlow 观察到了合法 submission 和 Supervisor 的推进事件，不表示 Server 判断内容正确、测试通过或双方观点真实一致。

## 实施证据

- 2026-07-16：完成 manifest schema、归档校验目录、阶段接受持久化、完成快照、waiter 终态响应、恢复协调与协议能力发布。
- 验证：`vitest run` 通过 30 个测试文件、378 个测试；`tsc --noEmit`、生产构建与 `git diff --check` 均通过。
- 最终仓库级审查见 `docs/review/2026-07-16-delivery-manifest-review.md`。

## Manifest 契约

`delivery-manifest.json` 使用独立的 `manifest_version: 1`，至少包含：

- `status`：`in_progress` 或 `completed`；
- `workflow_id`、`task_type`、`archive_root` 和 Supervisor identity；
- 已完成 phase 的接受记录；跳过的 phase 不生成空对象；
- 完成后记录 `completed_at`、`completed_by` 和唯一 `final_summary`；
- 固定声明所有 commit hash 均由调用方提供且未经 PairFlow 验证。

每个 phase acceptance 至少包含：

- `phase`、`accepted_at`、`advanced_by`；
- 当前 phase 最后一份合法 submission 的 `acceptance_commit`，其语义是推进时调用方声明的仓库状态，不证明 canonical document 一定包含在该 commit；
- 该阶段适用的 canonical document 或 submission references；
- 每个 submission reference 的 `file_path`、`submitted_by`、`round`、`commit_hash`、`submitted_at`，implementation 额外包含 `sub_phase`。

各阶段记录规则如下：

| Phase | Manifest 记录 |
|---|---|
| requirements | 任务文档 canonical reference，以及当前阶段最高 round 的合法 submission |
| planning | `planning/r1_{planner}.md` canonical reference，以及当前阶段最高 round 的合法 submission |
| implementation | 最高 round 的 coding submission；存在 review 时同时记录最高 round 的 review submission，两者不得被合并成一个“实现产物” |
| summary | 按 summary 轮次规则选出的 `final_summary`，并单独保留 r2 审阅 submission（存在时） |

`task_type=requirements` 跳过 planning 和 implementation 时，manifest 只包含 requirements 与 summary，不返回 `null` 占位。

## 写入、完成与恢复

- 每次非 IDLE phase 的 `advance` 在线程内 workflow mutex 中计算 phase acceptance，并通过同目录临时文件 + rename 原子更新 manifest。
- manifest 更新失败时拒绝 `advance`，内存 phase、turn、round 和 claim 状态保持不变。
- phase acceptance 以 phase 为幂等键；重复请求或响应丢失不得生成重复记录，也不得覆盖已经接受的 phase 为不同产物。
- 最终 `advance` 中，将 `status="completed"` 的 manifest 原子写入成功作为工作流完成的持久化线性化点；随后解绑 token、删除内存状态和 mutex，并尝试清理 `.pid`。
- 终态 manifest 已写入后，即使响应丢失或清理过程中进程退出，该 workflow 仍视为已完成；恢复和 `confirm_task` 不得把它重建为活跃 SUMMARY。
- 最终 `advance` 在 `.pid` 清理失败时仍返回 `ok=true` 的完成结果，并携带结构化 `cleanup_pending` 与文件系统错误；不得在已完成后返回业务拒绝，也不得撤销已持久化的完成事实。
- `.pid` 若仍指向已有 completed manifest，应视为待清理的终态指针，不得恢复旧 workflow。后续 `confirm_task` 先执行幂等清理；删除失败时拒绝创建新 workflow，并返回 completed manifest 路径和明确文件系统错误。
- 非终态 manifest 与 `.meta.json` 一起参与恢复。若 manifest 已记录某 phase 被接受但下一 phase 尚无 submission，恢复到下一 phase 的 round 1 assigned 状态，而不是退回已接受 phase 重复推进。
- manifest、`.meta.json` 或其引用的必要 `.md` 出现矛盾时安全失败，不得静默挑选另一个“看起来最新”的文件。

## 下一阶段 References

- planning 继续把任务文档作为必读 canonical reference。
- implementation 的 plan reference 必须使用 manifest 中已接受的 planning canonical path，并携带 planning `acceptance_commit`；不得从当前 phase 已被清空的 submission 状态猜测 commit。
- summary 首轮必须结构化引用任务文档、已接受计划、最新 coding submission、最新 review submission 和 archive root；被 task type 跳过或实际不存在的项目省略。
- 历史 submission 可以作为可选 reference，但不得替代当前 canonical document 或最终 submission。
- `required` 语义继续由 Server 决定，客户端不得通过扫描目录重新选择权威输入。

## 范围

### 必须覆盖（P0）

- versioned `delivery-manifest.json` schema 与公开完成响应 schema。
- requirements、planning、implementation、summary 的确定性记录规则。
- phase advance 时 manifest 的原子、幂等增量更新。
- SUMMARY 完成时唯一 final summary 的选择和 completed manifest。
- 下一阶段 instruction references 使用已接受记录。
- completed manifest、残留 `.pid` 和下一阶段尚未提交时的崩溃恢复。
- 响应丢失、重复 advance、manifest 写入失败和清理失败的线性化行为。
- manifest 路径及其引用文件的既有归档边界、普通文件和禁止链接校验。
- 将 `delivery-manifest.json` 作为运行期 sidecar 加入默认 Git ignore 规则。
- manifest、`.meta.json`、完成响应和 instruction references 的一致性测试。

### 本任务不做

- 不读取、整理、合并或评价任何 handoff 正文。
- 不创建 `r_final.md`，也不复制 canonical document 或 summary 正文。
- 不把 coding handoff 当作代码仓库内容或最终代码清单。
- 不记录“双方批准”或推断 submission 作者同意其他人的全部内容。
- 不采集验证命令、测试结果、构建结果、覆盖率、阶段耗时、轮数统计或提交次数。
- 不执行任何 Git、测试、构建、静态检查或其他外部命令。
- 不验证 commit hash，不查询分支、工作区、PR 或远端状态。
- 不自动暂存、提交、建分支、合并、rebase、squash、push 或创建 PR。
- 不建设 dashboard、metrics、heartbeat、进度推断或通用事件日志。

## 质量与安全约束

- `docs/design.md` 仍是实现唯一权威；manifest 契约写入设计后才能修改代码。
- manifest 只能由 Server 根据已验证的 live state、合法 `.meta.json` 和 `advance` 事件生成，客户端不得提交或覆盖。
- 所有路径使用 POSIX 正斜杠；identity、commit 和归档路径继续沿用现有校验规则。
- manifest 文件及其临时文件必须位于当前 workflow archive 根的直属安全路径，不得跟随 symlink/junction。
- manifest 是恢复 sidecar，不要求进入 Git；是否被 fork 维护者选择提交不改变 PairFlow 的运行时语义。
- completed 是单调终态，不得回退为 `in_progress`，也不得因 `.pid` 清理失败撤销。
- PairFlow 的任何组件都不得为了构造 manifest 或 references 执行外部命令。

## 验收标准

- development 与 requirements 两种 task type 都能生成字段确定、无空 phase 占位的 completed manifest。
- 多轮 planning 后，implementation 收到 canonical r1 path 和推进时的声明 commit，而不是从新 phase 空状态得到缺失或错误 commit。
- implementation manifest 分别定位最终 coding 与最新 review submission，不声称 handoff 就是代码本身。
- 仅有 summary r1+r2 时 final summary 唯一指向 r1；存在后续修订时唯一指向最高 round 的修订文档。
- Supervisor 的 SUMMARY → IDLE 响应和另一参与者的 workflow completed 等待响应都直接提供 manifest path、archive root 和 final summary；客户端无需解析 tip 或扫描目录。
- manifest 完成响应丢失、服务崩溃或遗留 `.pid` 后仍保持 completed，且旧 workflow 不会被恢复为活跃状态。
- 任何 manifest 写入失败都不会推进 phase；终态后的清理失败返回成功完成结果与结构化 warning，不会产生第二份 manifest 或撤销完成事实。
- 自动化测试证明 manifest 生成和恢复不会执行 Git、测试、构建或其他外部命令。

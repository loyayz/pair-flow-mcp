const content = `## 独立盲审

逐节审视 spec 全文，不读对方盲审产出。

| § | 节名 | 审视结论 | 理由 |
|---|---|---|---|
| — | Cycle 0 设计方案 | 无新问题 | 4 项设计均有明确改动范围、影响文件和风险评估。P0-22 简化方案（topic+description → proposal/rationale）降低了实现复杂度 |
| — | Cycle 1 设计方案 | 无新问题 | CLAUDE.md 更新 + crash handler + 文档，范围清晰无歧义 |
| — | 状态校准表 | 无新问题 | 盲审中我独立抽查了 claim-turn.ts:193-203 和 claim-turn.ts:148-168，确认 P0-14 已实现、P0-13 部分实现 |
| — | 实施边界 | 发现 1 个遗漏 | 计划未覆盖「convergence 逻辑中 P0 阻塞非 IMPLEMENTATION 阶段」的问题——这是我在 REQUIREMENTS 盲审中发现的。虽然当时通过降级 issue #2 绕过了，但机制本身应入 issue 跟踪 |
| — | 文件冲突风险 | 无新问题 | Cycle 0 涉及的 submit.ts / issue-tools.ts / register.ts / lock.ts 改动独立，无交叉冲突 |
| — | 测试覆盖 | 发现 1 个遗漏 | 计划未提及测试——P0-28 work_dir 校验应加单元测试；#3 lock 心跳涉及 setInterval/clearInterval 应加集成测试。建议 Cycle 0 中包含对应测试 |

---

## 收敛状态
- 本轮新增 issue：P0：0，P1：2，P2：0
- 本轮关闭 issue：无
- 对对方上一轮产出的立场：null（盲审为发现导向）
- 是否需要下一轮：null`;

const body = JSON.stringify({
  jsonrpc: "2.0",
  id: 39,
  method: "tools/call",
  params: {
    name: "submit",
    arguments: {
      content,
      converge_mark: {
        stance: null,
        need_next_round: null,
        new_issues: [
          {
            type: "P1",
            topic: "convergence 逻辑：非 IMPLEMENTATION 阶段 P0 阻塞收敛的机制需文档化",
            description: "REQUIREMENTS 盲审发现：非 IMPLEMENTATION 阶段收敛要求 hasOpenP0=false，导致早期阶段发现的 P0 问题阻塞收敛。当前通过降级 issue #2 绕过，但机制本身应文档化或在 design.md 中明确规则——哪些 P0 阻塞哪些阶段的收敛。"
          },
          {
            type: "P1",
            topic: "Cycle 0 缺测试覆盖——work_dir 校验 + lock 心跳",
            description: "P0-28 work_dir 双方校验和 #3 lock 心跳 setInterval/clearInterval 涉及状态变更，应包含单元/集成测试。建议在 Cycle 0 实现中包含对应测试代码。"
          }
        ],
        resolved_issue_ids: []
      },
      commit_hash: "2e7b404b7d4becad4b864f791a80411d570ba8f6",
      blind_review: true
    }
  }
});

const res = await fetch("http://localhost:3100/mcp", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "X-AI-Identity": "claude"
  },
  body
});

const text = await res.text();
console.log(text);

/**
 * PairFlow E2E Demo — 双 AI 交替评审完整流程
 *
 * 用法: npx tsx scripts/demo.ts
 * 前置: PairFlow server 已在 localhost:3100 运行
 */

import http from "node:http";

const PORT = 3100;

// ── MCP 请求封装 ──

function mcpRequest(
  name: string,
  args: Record<string, unknown> = {},
  headers: Record<string, string> = {}
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: args },
    });
    const req = http.request({
      hostname: "localhost", port: PORT, path: "/mcp", method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const match = data.match(/data:\s*(\{.*\})/);
          if (match) {
            const parsed = JSON.parse(match[1]);
            resolve(JSON.parse(parsed.result.content[0].text));
          } else resolve(JSON.parse(data));
        } catch { resolve({ raw: data.slice(0, 200) }); }
      });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

// ── 角色 header ──

const C = { "x-ai-identity": "claude" };
const B = { "x-ai-identity": "codebuddy" };

// ── 输出 ──

function log(step: string, r: Record<string, unknown>) {
  const icon = r.ok ? "✅" : "❌";
  const info = r.error
    ? `error=${r.error}`
    : Object.entries(r).filter(([k]) => !["ok", "template", "rules_summary", "warnings"].includes(k))
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ");
  console.log(`  ${icon} ${step}: ${info || "(ok)"}`);
  if (r.warnings && (r.warnings as string[]).length > 0) {
    console.log(`     ⚠️  ${JSON.stringify(r.warnings)}`);
  }
  return r;
}

function assert(ok: unknown, msg: string) {
  if (!ok) { console.log(`\n  💥 FAIL: ${msg}`); process.exit(1); }
}

// ── 内容模板 ──

function reviewContent(section: string, p0: number, p1: number, p2: number, resolved: string, stance: string, needNext: string) {
  return [
    "## 本轮审阅范围",
    "- 重新通读了以下章节：§1-§17 全文",
    `- 本次修改涉及的章节：${section}`,
    "- 未重新审阅的章节：无",
    "",
    "## 审阅",
    "",
    "审阅意见内容。",
    "",
    "## 收敛状态",
    `- 本轮新增 issue：P0：${p0}，P1：${p1}，P2：${p2}`,
    `- 本轮关闭 issue：${resolved}`,
    `- 对对方上一轮产出的立场：${stance}`,
    `- 是否需要下一轮：${needNext}`,
  ].join("\n");
}

function blindContent() {
  return [
    "## 独立盲审",
    "",
    "逐节审视 spec 全文。",
    "",
    "| § | 节名 | 审视结论 | 理由 |",
    "|---|---|---|---|",
    "| 1 | 项目概述 | 无新问题 | 清晰 |",
    "| 2 | 核心概念 | 无新问题 | 一致 |",
    "| 5 | 状态机 | 无新问题 | 已覆盖 |",
    "| 10 | MCP 工具 | 无新问题 | 完整 |",
    "",
    "## 收敛状态",
    "- 本轮新增 issue：P0：0，P1：0，P2：0",
    "- 本轮关闭 issue：无",
  ].join("\n");
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// ── 主流程 ──

async function main() {
  console.log("═".repeat(60));
  console.log("  PairFlow v1 E2E Demo — 双 AI 结对编程");
  console.log("═".repeat(60));
  console.log("  claude = 监督者 + 审阅者");
  console.log("  codebuddy = 开发者 + 持笔者");
  console.log("═".repeat(60));
  console.log();

  // ── IDLE: 注册 ──
  console.log("▍ IDLE — 注册");
  assert((await mcpRequest("register", { supervisor: true, developer: false }, C)).ok, "claude register");
  assert((await mcpRequest("register", { supervisor: false, developer: true }, B)).ok, "codebuddy register");
  console.log("  claude=supervisor, codebuddy=developer ✅");
  console.log();

  // ── IDLE → REQUIREMENTS ──
  console.log("▍ IDLE → REQUIREMENTS (supervisor advance)");
  const adv1 = await mcpRequest("claim_turn", {
    mode: "advance",
    timeouts: { requirements: 10, planning: 10, implementation: 60, summary: 30 },
  }, C);
  assert(adv1.ok, "advance to requirements");
  console.log(`  phase=requirements, turn=codebuddy ✅`);
  console.log();

  // ── Round 1: codebuddy 持笔产出 ──
  console.log("▍ Round 1 — codebuddy 持笔产出");
  const cbTurn = await mcpRequest("claim_turn", { mode: "turn" }, B);
  assert(cbTurn.ok, "codebuddy claim turn");
  const cbR1 = await mcpRequest("submit", {
    content: reviewContent("§1,§5,§10", 0, 2, 0, "无", "null", "null"),
    converge_mark: {
      stance: null, need_next_round: null,
      new_issues: [
        { type: "P1", topic: "state.json schema 缺少字段", description: "pending_supervisor_review 在 JSON schema 缺失", proposal: "补充字段定义", rationale: "§5.1 完整性" },
        { type: "P1", topic: "submit 参数描述不一致", description: "§10 与 §5.3 参数列表有细微差异", proposal: "统一描述", rationale: "一致性" },
      ],
      resolved_issue_ids: [],
    },
    commit_hash: "abc1234",
  }, B);
  assert(cbR1.ok, "codebuddy submit r1");
  console.log(`  codebuddy → 2 个 P1 issue, turn → claude ✅`);
  console.log();

  // ── Round 1: claude 审阅 ──
  console.log("▍ Round 1 — claude 审阅回复");
  const clTurn1 = await mcpRequest("claim_turn", { mode: "turn" }, C);
  assert(clTurn1.ok, "claude claim turn");
  const clR1 = await mcpRequest("submit", {
    content: reviewContent("§1,§5,§10", 0, 0, 0, "1, 2", "agree", "false"),
    converge_mark: {
      stance: "agree", need_next_round: false,
      new_issues: [],
      resolved_issue_ids: [1, 2],
    },
    commit_hash: "def5678",
  }, C);
  assert(clR1.ok, "claude submit r1");
  console.log(`  claude → agree, 0 新 issue, resolve #1 #2`);
  console.log(`  round → 2 (双方均已提交，但 codebuddy 有 2 个 new_issues ≠ 0，不收敛)`);
  console.log();

  // ── Round 2: codebuddy 确认 (0 new issues) → 触发收敛 ──
  console.log("▍ Round 2 — codebuddy 确认收敛");
  const cbTurn2 = await mcpRequest("claim_turn", { mode: "turn" }, B);
  assert(cbTurn2.ok, "codebuddy claim turn r2");
  const cbR2 = await mcpRequest("submit", {
    content: reviewContent("§1,§5,§10", 0, 0, 0, "1, 2", "agree", "false"),
    converge_mark: {
      stance: "agree", need_next_round: false,
      new_issues: [],
      resolved_issue_ids: [1, 2],
    },
    commit_hash: "abc1235",
  }, B);
  assert(cbR2.ok, "codebuddy submit r2");
  console.log(`  codebuddy → agree, 0 新 issue`);
  console.log(`  claude(r1) + codebuddy(r2) 双方 new_issues=0 → converged ✅`);
  console.log();

  // ── 盲审 ──
  console.log("▍ 独立盲审 (blind_review_pending)");
  const st = await mcpRequest("get_state", {}, C) as { converged: boolean; blind_review_pending: boolean; turn: string };
  assert(st.converged, "converged");
  assert(st.blind_review_pending, "blind_review_pending");
  console.log(`  converged=true, blind_review_pending=true, turn=${st.turn}`);

  // 收敛后 turn 已在 claude —— 直接提交盲审，无需 claim_turn
  const clBlind = await mcpRequest("submit", {
    content: blindContent(),
    converge_mark: { stance: null, need_next_round: null, new_issues: [], resolved_issue_ids: [] },
    commit_hash: "def5680", blind_review: true,
  }, C);
  assert(clBlind.ok, "claude blind review");
  console.log(`  claude 盲审 → 0 新 issue, turn → codebuddy`);

  // codebuddy 通过盲审特例 claim turn
  const cbBlindTurn = await mcpRequest("claim_turn", { mode: "turn" }, B);
  assert(cbBlindTurn.ok, "codebuddy claim blind turn");
  const cbBlind = await mcpRequest("submit", {
    content: blindContent(),
    converge_mark: { stance: null, need_next_round: null, new_issues: [], resolved_issue_ids: [] },
    commit_hash: "abc1236", blind_review: true,
  }, B);
  assert(cbBlind.ok, "codebuddy blind review");
  console.log(`  codebuddy 盲审 → 0 新 issue ✅`);
  console.log(`  双方盲审均无新问题 → blind_review_pending=false ✅`);
  console.log();

  // ── Advance to PLANNING ──
  console.log("▍ REQUIREMENTS → PLANNING");
  const adv2 = await mcpRequest("claim_turn", { mode: "advance" }, C);
  assert(adv2.ok, "advance to planning");
  console.log(`  phase=planning, turn=claude ✅`);
  console.log();

  // ── 最终状态 ──
  console.log("═".repeat(60));
  const final = await mcpRequest("get_state", {}, C) as {
    phase: string; round: number; converged: boolean;
    issues: Array<{ id: number; type: string; topic: string; status: string }>;
  };
  const ctx = await mcpRequest("get_context", {}, C) as { phase: string; round: number; issues_open: number };
  const arch = await mcpRequest("get_archived_files", { phase: "requirements" }, C) as { files: string[] };

  console.log(`  phase:          ${final.phase}`);
  console.log(`  round:          ${final.round}`);
  console.log(`  converged:      ${final.converged}`);
  console.log(`  issues total:   ${final.issues.length}`);
  for (const i of final.issues) console.log(`    #${i.id} [${i.type}] ${i.topic} (${i.status})`);
  console.log(`  open issues:    ${ctx.issues_open}`);
  console.log(`  archived files: ${(arch.files ?? []).length}`);
  console.log();
  console.log("  🎉 完整流程验证通过！");
  console.log("═".repeat(60));
}

main().catch((e) => { console.error("Demo failed:", e); process.exit(1); });

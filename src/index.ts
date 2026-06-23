import { readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { acquireLock, releaseLock } from "./lock.js";
import { initializeRecovery } from "./crash-recovery.js";
import { ping } from "./tools/ping.js";
import { whoAmI } from "./tools/who-am-i.js";
import { register } from "./tools/register.js";
import { claimTurn } from "./tools/claim-turn.js";
import { getState } from "./tools/get-state.js";
import { getContext } from "./tools/get-context.js";
import { submit } from "./tools/submit.js";
import { createIssue, resolveIssue, escalate, deferIssue, listIssues } from "./tools/issue-tools.js";
import { getArchivedFiles, getArchivedFileContent, forceConverge } from "./tools/archive-tools.js";
import { resetState } from "./tools/reset.js";
import { waitForTurn } from "./tools/wait-for-turn.js";

const PORT = parseInt(process.env.PORT || "3100", 10);

// Gate: reject MCP requests until crash-recovery completes. Prevents phantom
// session creation during the listen→recovery race window.
let ready = false;

function createServerWithTools() {
  const mcp = new McpServer(
    { name: "pair-flow", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  mcp.registerTool("ping", { description: "连通性检查。匿名可用。" }, ping);
  mcp.registerTool("who_am_i", { description: "身份确认 + 注册信息。解析 X-AI-Identity header。" }, whoAmI);
  mcp.registerTool("register", { description: "IDLE 阶段注册身份和角色。仅通过 X-AI-Identity header 识别身份（不可通过 args 传递）。work_dir 用于双方校验同一仓库。", inputSchema: { supervisor: z.boolean(), developer: z.boolean(), work_dir: z.string().optional() } }, register);
  mcp.registerTool("claim_turn", {
    description: "获取 turn 或推进 phase。仅通过 X-AI-Identity header 识别身份。advance 模式 IDLE→REQUIREMENTS 时 task 必填。",
    inputSchema: { mode: z.enum(["turn", "advance"]), timeouts: z.object({ requirements: z.number(), planning: z.number(), implementation: z.number(), summary: z.number() }).optional(), task: z.object({ description: z.string(), spec_file: z.string().optional(), goals: z.array(z.string()).optional(), context: z.string().optional() }).optional() },
  }, claimTurn);
  mcp.registerTool("get_state", { description: "完整状态快照。匿名可用。" }, getState);
  mcp.registerTool("get_context", { description: "当前阶段上下文。" }, getContext);
  mcp.registerTool("create_issue", { description: "创建 issue。P0/P1 必填 proposal+rationale，P2 可选。fix sub_phase 禁 P0。", inputSchema: { type: z.enum(["P0","P1","P2"]), topic: z.string().max(200), description: z.string(), my_position: z.string().optional(), proposal: z.string().optional(), rationale: z.string().optional() } }, createIssue);
  mcp.registerTool("resolve_issue", { description: "关闭 issue。P0 仅监督者。", inputSchema: { issue_id: z.number(), resolution: z.string() } }, resolveIssue);
  mcp.registerTool("defer_issue", { description: "延迟 issue 到后续阶段处理。仅 issue 创建者或监督者可操作。", inputSchema: { issue_id: z.number(), reason: z.string() } }, deferIssue);
  mcp.registerTool("escalate", { description: "升级 P0 → escalated（仅监督者）。", inputSchema: { issue_id: z.number(), reason: z.string() } }, escalate);
  mcp.registerTool("list_issues", { description: "列出 issue。scope=current_phase/all。", inputSchema: { status: z.string().optional(), scope: z.string().optional() } }, listIssues);
  mcp.registerTool("get_archived_files", { description: "列出归档文件。phase/workflow_id 可选过滤。", inputSchema: { phase: z.string().optional(), workflow_id: z.string().optional() } }, getArchivedFiles);
  mcp.registerTool("get_archived_file_content", { description: "读取归档文件内容。phase 参数可选，用于指定子目录（requirements/planning/implementation/summary）。盲审模式下拒绝对方盲审文件。", inputSchema: { filename: z.string(), phase: z.string().optional() } }, getArchivedFileContent);
  mcp.registerTool("force_converge", { description: "强制收敛当前 dev_phase 循环（仅监督者，phase≠idle）。", inputSchema: {} }, forceConverge);
  mcp.registerTool("reset", { description: "重置运行时状态到 IDLE，保留 handoff 归档。仅监督者，仅 IDLE 阶段可用。", inputSchema: {} }, resetState);
  mcp.registerTool("wait_for_turn", { description: "长轮询等待 turn 切换到调用方。2s 间隔，60s 超时返回当前状态。phase 变更或 converged 时提前返回。" }, waitForTurn);
  mcp.registerTool(
    "submit",
    {
      description: "提交产出。converge_mark + commit_hash + handoff 落盘。500KB 上限。",
      inputSchema: {
        content: z.string(),
        converge_mark: z.object({
          stance: z.string().nullable(),
          need_next_round: z.boolean().nullable(),
          new_issues: z.array(z.object({
            type: z.string(),
            topic: z.string().max(200),
            description: z.string(),
          })).optional(),
          resolved_issue_ids: z.array(z.number()).optional(),
        }),
        commit_hash: z.string(),
        blind_review: z.boolean().optional(),
      },
    },
    submit
  );

  return mcp;
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    return;
  }

  if (req.url?.startsWith("/mcp") && req.method === "POST") {
    if (!ready) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Server starting — recovery in progress, retry shortly" }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString();

    try {
      const parsed = body ? JSON.parse(body) : undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      const mcp = createServerWithTools();
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
      await transport.close();
    } catch (err) {
      console.error("[pair-flow] request error:", err);
      if (!res.headersSent) {
        res.writeHead(500).end(JSON.stringify({ ok: false, error: "Invalid request" }));
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(PORT, async () => {
  try {
    await acquireLock();
    console.log(`[pair-flow] Lock acquired`);
    const recovered = await initializeRecovery();
    if (recovered.phase !== "idle") {
      console.log(`[pair-flow] Recovered state: phase=${recovered.phase}, workflow_id=${recovered.workflow_id}`);
    }
    // P0-26: orphan handoff warning at startup
    await warnOrphanHandoffs();
  } catch (err) {
    console.error(`[pair-flow] Startup failed:`, err);
    process.exit(1);
  }
  ready = true;
  console.log(`[pair-flow] HTTP MCP Server listening on http://localhost:${PORT}/mcp`);
  console.log(`[pair-flow] Health check: http://localhost:${PORT}/health`);
});

process.on("SIGTERM", async () => { await releaseLock(); process.exit(0); });
process.on("SIGINT", async () => { await releaseLock(); process.exit(0); });

// P0-26: orphan handoff warning — scan for incomplete workflows at startup
async function warnOrphanHandoffs() {
  const HANDOFF_DIR = process.env.HANDOFF_DIR || "handoff";
  try {
    const entries = await readdir(HANDOFF_DIR, { withFileTypes: true });
    const wfDirs = entries.filter((e) => e.isDirectory() && /^\d{14}$/.test(e.name));
    const orphans: string[] = [];
    for (const d of wfDirs) {
      try {
        const summaryDir = `${HANDOFF_DIR}/${d.name}/summary`;
        const summaryEntries = await readdir(summaryDir);
        if (!summaryEntries.some((e) => e.includes("_final.md"))) {
          orphans.push(d.name);
        }
      } catch {
        // No summary dir — orphan
        orphans.push(d.name);
      }
    }
    if (orphans.length > 0) {
      console.warn(`[pair-flow] ⚠ ${orphans.length} orphan handoff workflow(s) without _final.md: ${orphans.join(", ")}`);
      console.warn(`[pair-flow] ⚠ Run 'npx tsx scripts/clean.ts --dry-run' to review or 'npx tsx scripts/clean.ts --force' to remove.`);
    }
  } catch {
    // handoff dir doesn't exist yet, skip
  }
}

// Crash handling: log + cleanup + exit. External process manager (PM2/systemd/docker)
// is responsible for restart. crash-recovery.ts will restore state from handoff on next start.
// Per Node.js best practice: do not attempt in-process recovery after uncaughtException.
let crashCount = 0;
let lastCrashTime = 0;
process.on("uncaughtException", async (err) => {
  console.error("[pair-flow] Uncaught exception:", err);
  const now = Date.now();
  // Crash loop detection: 3 crashes within 30s → refuse to let PM restart us
  if (now - lastCrashTime < 30_000) {
    crashCount++;
  } else {
    crashCount = 1;
  }
  lastCrashTime = now;
  if (crashCount >= 3) {
    console.error("[pair-flow] Crash loop detected (3 crashes in 30s). Check environment.");
    await releaseLock();
    process.exit(1);
  }
  console.error("[pair-flow] Exiting — external process manager should restart. crash-recovery will restore state.");
  await releaseLock();
  setTimeout(() => process.exit(1), 100); // allow releaseLock to flush
});

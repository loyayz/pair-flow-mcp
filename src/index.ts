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
import { createIssue, resolveIssue, escalate, listIssues } from "./tools/issue-tools.js";
import { getArchivedFiles, getArchivedFileContent, forceConverge } from "./tools/archive-tools.js";

const PORT = parseInt(process.env.PORT || "3100", 10);

function createServerWithTools() {
  const mcp = new McpServer(
    { name: "pair-flow", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  mcp.registerTool("ping", { description: "连通性检查。匿名可用。" }, ping);
  mcp.registerTool("who_am_i", { description: "身份确认 + 注册信息。解析 X-AI-Identity header。" }, whoAmI);
  mcp.registerTool("register", { description: "IDLE 阶段注册身份和角色。仅通过 X-AI-Identity header 识别身份（不可通过 args 传递）。", inputSchema: { supervisor: z.boolean(), developer: z.boolean() } }, register);
  mcp.registerTool("claim_turn", {
    description: "获取 turn 或推进 phase。仅通过 X-AI-Identity header 识别身份。",
    inputSchema: { mode: z.enum(["turn", "advance"]), timeouts: z.object({ requirements: z.number(), planning: z.number(), implementation: z.number(), summary: z.number() }).optional() },
  }, claimTurn);
  mcp.registerTool("get_state", { description: "完整状态快照。匿名可用。" }, getState);
  mcp.registerTool("get_context", { description: "当前阶段上下文。" }, getContext);
  mcp.registerTool("create_issue", { description: "创建 issue。P0/P1 必填 proposal+rationale，P2 可选。fix sub_phase 禁 P0。", inputSchema: { type: z.enum(["P0","P1","P2"]), topic: z.string().max(200), description: z.string(), my_position: z.string().optional(), proposal: z.string().optional(), rationale: z.string().optional() } }, createIssue);
  mcp.registerTool("resolve_issue", { description: "关闭 issue。P0 仅监督者。", inputSchema: { issue_id: z.number(), resolution: z.string() } }, resolveIssue);
  mcp.registerTool("escalate", { description: "升级 P0 → escalated（仅监督者）。", inputSchema: { issue_id: z.number(), reason: z.string() } }, escalate);
  mcp.registerTool("list_issues", { description: "列出 issue。scope=current_phase/all。", inputSchema: { status: z.string().optional(), scope: z.string().optional() } }, listIssues);
  mcp.registerTool("get_archived_files", { description: "列出归档文件。phase/workflow_id 可选过滤。", inputSchema: { phase: z.string().optional(), workflow_id: z.string().optional() } }, getArchivedFiles);
  mcp.registerTool("get_archived_file_content", { description: "读取归档文件内容。盲审模式下拒绝对方盲审文件。", inputSchema: { filename: z.string() } }, getArchivedFileContent);
  mcp.registerTool("force_converge", { description: "强制收敛当前 dev_phase 循环（仅监督者，phase≠idle）。", inputSchema: {} }, forceConverge);
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
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString();
    const parsed = body ? JSON.parse(body) : undefined;

    // Extract session ID from request — stateless: use request correlation
    const sessionId = parsed?.params?._meta?.sessionId
      ?? req.headers["mcp-session-id"] as string | undefined
      ?? undefined;

    // Create a fresh transport per request in stateless mode
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    // Create a fresh MCP server for this transport
    const mcp = createServerWithTools();

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
      await transport.close();
    } catch (err) {
      console.error("[pair-flow] request error:", err);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal Server Error");
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
  } catch (err) {
    console.error(`[pair-flow] Startup failed:`, err);
    process.exit(1);
  }
  console.log(`[pair-flow] HTTP MCP Server listening on http://localhost:${PORT}/mcp`);
  console.log(`[pair-flow] Health check: http://localhost:${PORT}/health`);
});

process.on("SIGTERM", async () => { await releaseLock(); process.exit(0); });
process.on("SIGINT", async () => { await releaseLock(); process.exit(0); });

// §15 crash auto-restart
let crashCount = 0;
process.on("uncaughtException", async (err) => {
  console.error("[pair-flow] Uncaught exception:", err);
  crashCount++;
  if (crashCount >= 3) {
    console.error("[pair-flow] Crash loop detected (3 crashes), refusing to restart");
    await releaseLock();
    process.exit(1);
  }
  console.log("[pair-flow] Restarting in 1s...");
  setTimeout(() => {
    httpServer.listen(PORT, () => console.log(`[pair-flow] Re-listening on ${PORT}`));
  }, 1000);
});

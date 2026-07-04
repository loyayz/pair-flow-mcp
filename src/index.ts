import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ping } from "./tools/ping.js";
import { whoAmI } from "./tools/who-am-i.js";
import { register } from "./tools/register.js";
import { claimTurn } from "./tools/claim-turn.js";
import { advance } from "./tools/advance.js";
import { getStateTool } from "./tools/get-state.js";
import { submit } from "./tools/submit.js";
import { getArchivedFiles, getArchivedFileContent } from "./tools/archive-tools.js";
import { waitForTurn } from "./tools/wait-for-turn.js";
import { confirmTask } from "./tools/confirm-task.js";

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
  mcp.registerTool("register", { description: "IDLE 阶段注册身份。identity 从 body 取。角色声明移至 confirm_task。", inputSchema: { identity: z.string().optional(), work_dir: z.string().optional() } }, register);
  mcp.registerTool("confirm_task", { description: "确认任务文档路径，声明角色，两个 AI 以相同 task_path 成对。", inputSchema: { task_path: z.string(), task_type: z.enum(["requirements", "development"]).optional(), supervisor: z.boolean(), developer: z.boolean(), work_dir: z.string().optional() } }, confirmTask);
  mcp.registerTool("claim_turn", { description: "获取当前轮次的执行权。仅通过 X-AI-Identity header 识别身份。", inputSchema: {} }, claimTurn);
  mcp.registerTool("advance", { description: "推进到下一阶段。仅监督者可用。", inputSchema: {} }, advance);
  mcp.registerTool("get_state", { description: "返回当前执行指引（tip）。匿名可用。" }, getStateTool);
  mcp.registerTool("get_archived_files", { description: "列出归档文件。phase/workflow_id 可选过滤。", inputSchema: { phase: z.string().optional(), workflow_id: z.string().optional() } }, getArchivedFiles);
  mcp.registerTool("get_archived_file_content", { description: "读取归档文件内容。phase 参数可选，用于指定子目录（requirements/planning/implementation/summary）。", inputSchema: { filename: z.string(), phase: z.string().optional() } }, getArchivedFileContent);
  mcp.registerTool("wait_for_turn", { description: "长轮询等待 turn 切换到调用方。10s 间隔，600s 超时。turn=自己时返回。" }, waitForTurn);
  mcp.registerTool(
    "submit",
    {
      description: "提交产出。",
      inputSchema: {
        file_path: z.string(),
        git_commit_hash: z.string(),
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

httpServer.listen(PORT, () => {
  ready = true;
  console.log(`[pair-flow] HTTP MCP Server listening on http://localhost:${PORT}/mcp`);
  console.log(`[pair-flow] Health check: http://localhost:${PORT}/health`);
});

process.on("SIGTERM", () => { process.exit(0); });
process.on("SIGINT", () => { process.exit(0); });

// Crash handling: log + cleanup + exit. External process manager (PM2/systemd/docker)
// is responsible for restart. crash-recovery.ts will restore state from handoff on next start.
// Per Node.js best practice: do not attempt in-process recovery after uncaughtException.
let crashCount = 0;
let lastCrashTime = 0;
process.on("uncaughtException", (err) => {
  console.error("[pair-flow] Uncaught exception:", err);
  const now = Date.now();
  if (now - lastCrashTime < 30_000) {
    crashCount++;
  } else {
    crashCount = 1;
  }
  lastCrashTime = now;
  if (crashCount >= 3) {
    console.error("[pair-flow] Crash loop detected (3 crashes in 30s). Check environment.");
    process.exit(1);
  }
  console.error("[pair-flow] Exiting — external process manager should restart.");
  setTimeout(() => process.exit(1), 100);
});

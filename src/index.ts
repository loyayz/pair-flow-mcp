import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ping } from "./tools/ping.js";
import { whoAmI } from "./tools/who-am-i.js";
import { register } from "./tools/register.js";

import { advance } from "./tools/advance.js";
import { getStateTool } from "./tools/get-state.js";
import { submit } from "./tools/submit.js";
import { waitForTurn } from "./tools/wait-for-turn.js";
import { confirmTask } from "./tools/confirm-task.js";

const PORT = parseInt(process.env.PORT || "3100", 10);
const HOST = "127.0.0.1";

function createServerWithTools() {
  const mcp = new McpServer(
    { name: "pair-flow", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  mcp.registerTool("ping", { description: "连通性检查。匿名可用。" }, ping);
  mcp.registerTool("who_am_i", { description: "身份确认 + 注册/工作流加入状态。解析 X-AI-Identity token。" }, whoAmI);
  mcp.registerTool("register", { description: "注册身份并获取 token。identity 从 body 取，职责声明移至 confirm_task。", inputSchema: { identity: z.string() } }, register);
  mcp.registerTool("confirm_task", { description: "确认任务文档路径和 Git 仓库根目录，声明职责，两个 AI 以相同规范化绝对 task_path 成对。", inputSchema: { task_path: z.string(), task_type: z.enum(["requirements", "development"]).optional(), is_supervisor: z.boolean(), is_developer: z.boolean(), work_dir: z.string() } }, confirmTask);

  mcp.registerTool("advance", { description: "推进到下一阶段。仅监督者可用。", inputSchema: {} }, advance);
  mcp.registerTool("get_state", { description: "返回当前执行指引（tip）。需要有效注册 token。" }, getStateTool);
  mcp.registerTool("wait_for_turn", { description: "长轮询等待 turn 切换到调用方。10s 间隔，600s 超时。turn=自己时返回。" }, waitForTurn);
  mcp.registerTool(
    "submit",
    {
      description: "提交当前 turn 的 handoff 产出。file_path 必须是工具提示给出的绝对路径。",
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
  const pathname = new URL(req.url ?? "/", `http://${HOST}:${PORT}`).pathname;

  if (pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    return;
  }

  if (pathname === "/mcp" && req.method === "POST") {
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

httpServer.listen(PORT, HOST, () => {
  console.log(`[pair-flow] HTTP MCP Server listening on http://${HOST}:${PORT}/mcp`);
  console.log(`[pair-flow] Health check: http://${HOST}:${PORT}/health`);
});

process.on("SIGTERM", () => { process.exit(0); });
process.on("SIGINT", () => { process.exit(0); });

// Crash handling: log + exit. External process manager (PM2/systemd/docker)
// is responsible for restart. A later confirm_task can restore state from handoff.
// Per Node.js best practice: do not attempt in-process recovery after uncaughtException.
process.on("uncaughtException", (err) => {
  console.error("[pair-flow] Uncaught exception:", err);
  console.error("[pair-flow] Exiting — external process manager should restart.");
  setTimeout(() => process.exit(1), 100);
});

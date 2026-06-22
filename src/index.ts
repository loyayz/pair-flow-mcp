import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ping } from "./tools/ping.js";
import { whoAmI } from "./tools/who-am-i.js";
import { register } from "./tools/register.js";
import { claimTurn } from "./tools/claim-turn.js";
import { getState } from "./tools/get-state.js";
import { getContext } from "./tools/get-context.js";

const PORT = 3100;

function createServerWithTools() {
  const mcp = new McpServer(
    { name: "pair-flow", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  mcp.registerTool("ping", { description: "连通性检查。匿名可用。" }, ping);
  mcp.registerTool("who_am_i", { description: "身份确认 + 注册信息。解析 X-AI-Identity header。" }, whoAmI);
  mcp.registerTool("register", { description: "IDLE 阶段注册身份和角色。", inputSchema: { supervisor: z.boolean(), developer: z.boolean(), identity: z.string().optional() } }, register);
  mcp.registerTool("claim_turn", {
    description: "获取 turn 或推进 phase。",
    inputSchema: { mode: z.enum(["turn", "advance"]), identity: z.string().optional(), timeouts: z.object({ requirements: z.number(), planning: z.number(), implementation: z.number(), summary: z.number() }).optional() },
  }, claimTurn);
  mcp.registerTool("get_state", { description: "完整状态快照。" }, getState);
  mcp.registerTool("get_context", { description: "当前阶段上下文。" }, getContext);

  return mcp;
}

// Create the MCP server definition (tools only, transport created per-request)
const { McpServer: _McpServer, ...rest } = { McpServer };

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

httpServer.listen(PORT, () => {
  console.log(`[pair-flow] HTTP MCP Server listening on http://localhost:${PORT}/mcp`);
  console.log(`[pair-flow] Health check: http://localhost:${PORT}/health`);
});

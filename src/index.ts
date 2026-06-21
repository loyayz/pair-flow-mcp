import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ping } from "./tools/ping.js";
import { whoAmI } from "./tools/who-am-i.js";

const PORT = 3100;

const server = new McpServer(
  { name: "pair-flow", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// Register tools
server.registerTool("ping", { description: "连通性检查。匿名可用。" }, ping);
server.registerTool(
  "who_am_i",
  { description: "身份确认 + 注册信息。解析 X-AI-Identity header。" },
  whoAmI
);

// Create HTTP transport and connect
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // stateless — no session tracking needed for Phase 0
});

server.connect(transport).then(() => {
  console.log(`[pair-flow] MCP server connected to transport`);
});

// HTTP server
const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
    return;
  }

  if (req.url === "/mcp" && req.method === "POST") {
    // Collect body for transport
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString();
    try {
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch {
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

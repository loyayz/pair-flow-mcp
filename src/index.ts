import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeSync } from "node:fs";
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
import { claimTurn } from "./tools/claim-turn.js";
import { HTTP_SERVER_OPTIONS } from "./http-server-policy.js";
import { describeListenError, parseServerArgs, SERVER_HELP } from "./server-config.js";
import { runWithTransportCleanup } from "./transport-lifecycle.js";
import { initializeTipTemplates } from "./tip-template.js";
import {
  MCP_SERVER_INSTRUCTIONS,
  SERVER_INFO,
  createHealthPayload,
} from "./instruction-protocol.js";
import { TOOL_OUTPUT_SCHEMAS } from "./tool-output.js";
import { getWorkflowWaiterCount } from "./workflow-events.js";
import { sendDiagnosticReply } from "./diagnostic-ipc.js";

const cliConfig = (() => {
  try {
    return parseServerArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[pair-flow] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
})();
if (cliConfig.help) {
  console.log(SERVER_HELP);
  process.exit(0);
}

try {
  initializeTipTemplates();
} catch (error) {
  console.error(`[pair-flow] failed to load tip templates: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const PORT = cliConfig.port;
const HOST = "127.0.0.1";
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const INVALID_JSON = Symbol("invalid-json");

function createServerWithTools() {
  const mcp = new McpServer(
    SERVER_INFO,
    { capabilities: { tools: {} }, instructions: MCP_SERVER_INSTRUCTIONS }
  );

  mcp.registerTool("ping", { description: "连通性检查。匿名可用。", outputSchema: TOOL_OUTPUT_SCHEMAS.ping }, ping);
  mcp.registerTool("who_am_i", { description: "身份确认 + 注册/工作流加入状态。解析 X-AI-Identity token。", outputSchema: TOOL_OUTPUT_SCHEMAS.who_am_i }, whoAmI);
  mcp.registerTool("register", { description: "注册身份并获取 token。identity 从 body 取，职责声明移至 confirm_task。", inputSchema: { identity: z.string() }, outputSchema: TOOL_OUTPUT_SCHEMAS.register }, register);
  mcp.registerTool("confirm_task", { description: "确认任务文档和 Git 仓库根目录并声明职责。两个 AI 以相同规范化绝对 task_path 成对；进入流程后职责冻结。", inputSchema: { task_path: z.string(), task_type: z.enum(["requirements", "development"]), is_supervisor: z.boolean(), is_developer: z.boolean(), work_dir: z.string() }, outputSchema: TOOL_OUTPUT_SCHEMAS.confirm_task }, confirmTask);

  mcp.registerTool("advance", { description: "推进到下一阶段。仅监督者可用。", inputSchema: {}, outputSchema: TOOL_OUTPUT_SCHEMAS.advance }, advance);
  mcp.registerTool("get_state", { description: "返回当前执行指引（tip）。需要有效注册 token。", outputSchema: TOOL_OUTPUT_SCHEMAS.get_state }, getStateTool);
  mcp.registerTool("wait_for_turn", { description: "通过进程内 workflow 变化事件等待 roster、turn、提醒或工作流终止。单次请求最长 600s；事件触发后返回当前行动指引。", outputSchema: TOOL_OUTPUT_SCHEMAS.wait_for_turn }, waitForTurn);
  mcp.registerTool(
    "claim_turn",
    { description: "领取当前已分配给调用方的 turn，并取得完整行动指引。", inputSchema: {}, outputSchema: TOOL_OUTPUT_SCHEMAS.claim_turn },
    (_args, extra) => claimTurn(extra),
  );
  mcp.registerTool(
    "submit",
    {
      description: "提交当前 turn 的非空普通 handoff 文件。要求双方已就位，file_path 必须是工具提示给出的绝对路径。",
      inputSchema: {
        file_path: z.string(),
        git_commit_hash: z.string(),
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS.submit,
    },
    submit
  );

  return mcp;
}

async function readRequestBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<string | null> {
  const contentLength = req.headers["content-length"];
  if (typeof contentLength === "string") {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_REQUEST_BODY_BYTES) {
      respondPayloadTooLarge(res);
      return null;
    }
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.length;
    if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
      respondPayloadTooLarge(res);
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, receivedBytes).toString();
}

function respondPayloadTooLarge(res: ServerResponse): void {
  res.writeHead(413, {
    "Content-Type": "application/json",
    "Connection": "close",
  });
  res.end(JSON.stringify({ ok: false, error: "Payload Too Large" }));
}

function parseRequestBody(body: string, res: ServerResponse): unknown | typeof INVALID_JSON {
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
    return INVALID_JSON;
  }
}

const httpServer = createServer(HTTP_SERVER_OPTIONS, async (req: IncomingMessage, res: ServerResponse) => {
  const pathname = new URL(req.url ?? "/", `http://${HOST}:${PORT}`).pathname;

  if (pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(createHealthPayload(process.uptime())));
    return;
  }

  if (pathname === "/mcp" && req.method === "POST") {
    try {
      const body = await readRequestBody(req, res);
      if (body === null) return;
      const parsed = parseRequestBody(body, res);
      if (parsed === INVALID_JSON) return;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      const mcp = createServerWithTools();
      await runWithTransportCleanup(transport, async () => {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, parsed);
      });
    } catch (err) {
      console.error("[pair-flow] request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Internal Server Error" }));
      } else if (!res.writableEnded) {
        res.destroy(err instanceof Error ? err : undefined);
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.on("error", (error: NodeJS.ErrnoException) => {
  const message = describeListenError(error, PORT);
  if (message) {
    console.error(`[pair-flow] ${message}`);
    process.exit(1);
  }
  throw error;
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[pair-flow] HTTP MCP Server listening on http://${HOST}:${PORT}/mcp`);
  console.log(`[pair-flow] Health check: http://${HOST}:${PORT}/health`);
});

process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const request = message as Record<string, unknown>;
  if (request.type !== "pairflow:get-workflow-waiter-count"
    || typeof request.requestId !== "number"
    || typeof request.workflowId !== "string") return;
  sendDiagnosticReply(process, {
    type: "pairflow:workflow-waiter-count",
    requestId: request.requestId,
    workflowId: request.workflowId,
    count: getWorkflowWaiterCount(request.workflowId),
  });
});

process.on("SIGTERM", () => { process.exit(0); });
process.on("SIGINT", () => { process.exit(0); });

// Crash handling: log + exit. External process manager (PM2/systemd/docker)
// is responsible for restart. A later confirm_task can restore state from handoff.
// Per Node.js best practice: do not attempt in-process recovery after uncaughtException.
process.on("uncaughtException", (err) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  try {
    writeSync(process.stderr.fd, `[pair-flow] Uncaught exception: ${detail}\n[pair-flow] Exiting — external process manager should restart.\n`);
  } catch {
    // Exit even if stderr itself is unavailable.
  }
  process.exit(1);
});

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { get, request as httpRequest } from "node:http";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClientTransport } from "../client-transport.js";

const PORT = 3197;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
let server: ChildProcess;
let diagnosticRequestId = 0;

async function startServer() {
  server = spawn(process.execPath, ["--import", "tsx/esm", "src/index.ts", "--port", String(PORT)], {
    env: { ...process.env, PORT: "ignored" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  await new Promise((r) => setTimeout(r, 2000));
}

function getServerWorkflowWaiterCount(workflowId: string): Promise<number> {
  return new Promise((resolveCount, reject) => {
    const requestId = ++diagnosticRequestId;
    const timeout = setTimeout(() => {
      server.off("message", onMessage);
      reject(new Error("timed out waiting for workflow waiter diagnostic"));
    }, 250);
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const response = message as Record<string, unknown>;
      if (response.type !== "pairflow:workflow-waiter-count" || response.requestId !== requestId) return;
      clearTimeout(timeout);
      server.off("message", onMessage);
      resolveCount(response.count as number);
    };
    server.on("message", onMessage);
    server.send?.({
      type: "pairflow:get-workflow-waiter-count",
      requestId,
      workflowId,
    });
  });
}

async function stopServer() {
  if (server?.pid) {
    try {
      if (process.platform === "win32") {
        execSync(`taskkill //F //PID ${server.pid} //T 2>nul`, { stdio: "ignore" });
      } else {
        process.kill(-server.pid, "SIGKILL");
      }
    } catch { /* already dead */ }
  }
  await new Promise((r) => setTimeout(r, 500));
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const textPayload = JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text);
  expect(result.structuredContent).toEqual(textPayload);
  return textPayload;
}

function requestHealthPayload(): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const request = get({ host: "127.0.0.1", port: PORT, path: "/health", timeout: 1000 }, (response) => {
      let body = "";
      response.setEncoding("utf-8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve(JSON.parse(body)));
    });
    request.on("timeout", () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
  });
}

function requestHealth(host: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = get({ host, port: PORT, path: "/health", timeout: 1000 }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("timeout", () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
  });
}

function requestStatus(method: string, path: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: PORT, path, method }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
}

function postMcp(
  chunks: Buffer[],
  headers: Record<string, string | number> = {},
  timeoutMs = 1000,
): Promise<{ status: number | undefined; contentType: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: PORT,
      path: "/mcp",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        ...headers,
      },
    }, (response) => {
      let body = "";
      response.setEncoding("utf-8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        contentType: response.headers["content-type"],
        body,
      }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("request timed out")));
    request.on("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

function postJsonRpc(
  payload: Record<string, unknown>,
  headers: Record<string, string | number> = {},
  timeoutMs = 1000,
) {
  return postMcp([Buffer.from(JSON.stringify(payload))], headers, timeoutMs);
}

function expectSingleJsonResponse(response: Awaited<ReturnType<typeof postJsonRpc>>) {
  expect(response.status).toBe(200);
  expect(response.body).not.toMatch(/^(?:event|data):/m);
  expect(response.contentType).toContain("application/json");
  expect(response.contentType).not.toContain("text/event-stream");
  return JSON.parse(response.body) as Record<string, any>;
}

describe("Client transport with identity injection", () => {
  beforeAll(startServer, 15000);
  afterAll(stopServer);

  it("does not accept connections through a non-loopback interface", async () => {
    const nonLoopback = Object.values(networkInterfaces())
      .flat()
      .find((address) => address?.family === "IPv4" && !address.internal)?.address;
    if (!nonLoopback) return;

    await expect(requestHealth(nonLoopback)).rejects.toBeDefined();
  });

  it("exposes health checks only through GET", async () => {
    expect(await requestStatus("GET", "/health")).toBe(200);
    expect(await requestStatus("POST", "/health")).toBe(404);
  });

  it("exposes the instruction protocol through runtime discovery", async () => {
    const health = await requestHealthPayload();
    expect(health.server).toEqual({ name: "pair-flow", version: "0.1.0" });
    expect(health.protocol.version).toBe("1.1");
    expect(health.protocol.capabilities).toEqual([
      "instruction_v1",
      "structured_tool_output_v1",
      "json_response_v1",
      "delivery_manifest_v1",
    ]);

    const client = new Client({ name: "discovery-test", version: "1" }, {});
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
    expect(client.getServerVersion()).toEqual(health.server);
    expect(client.getInstructions()).toContain("GET /health");
    expect(client.getInstructions()).toContain("do not derive workflow control from tip");

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "advance",
      "claim_turn",
      "confirm_task",
      "get_state",
      "ping",
      "register",
      "submit",
      "wait_for_turn",
      "who_am_i",
    ]);
    for (const tool of tools.tools) expect(tool.outputSchema?.type).toBe("object");
    await client.close();
  });

  it("returns tools/list as one directly parseable JSON-RPC response", async () => {
    const response = await postJsonRpc({ jsonrpc: "2.0", id: 601, method: "tools/list", params: {} });
    const envelope = expectSingleJsonResponse(response);

    expect(envelope).toMatchObject({ jsonrpc: "2.0", id: 601 });
    expect(envelope.result.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "wait_for_turn",
        description: expect.stringContaining("事件"),
      }),
    ]));
  });

  it("returns a business rejection as one directly parseable JSON-RPC response", async () => {
    const response = await postJsonRpc({
      jsonrpc: "2.0",
      id: 602,
      method: "tools/call",
      params: { name: "advance", arguments: {} },
    });
    const envelope = expectSingleJsonResponse(response);

    expect(envelope).toMatchObject({
      jsonrpc: "2.0",
      id: 602,
      result: { structuredContent: { ok: false } },
    });
  });

  it("keeps a raw wait_for_turn pending until an event and then returns one JSON envelope", async () => {
    const taskPath = resolve(".pairflow-json-response-task.md");
    const anonymousClient = new Client({ name: "json-wait-register", version: "1" }, {});
    const supervisorClient = new Client({ name: "json-wait-supervisor", version: "1" }, {});
    const developerClient = new Client({ name: "json-wait-developer", version: "1" }, {});
    await writeFile(taskPath, "# JSON response transport test\n", "utf-8");

    try {
      await anonymousClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
      const supervisor = await call(anonymousClient, "register", { identity: "json-wait-supervisor" });
      const developer = await call(anonymousClient, "register", { identity: "json-wait-developer" });
      await anonymousClient.close();

      await supervisorClient.connect(createClientTransport(`http://127.0.0.1:${PORT}/mcp`, supervisor.token));
      await developerClient.connect(createClientTransport(`http://127.0.0.1:${PORT}/mcp`, developer.token));
      const confirmation = {
        task_path: taskPath,
        task_type: "development",
        work_dir: process.cwd(),
      };
      const supervisorConfirmation = await call(supervisorClient, "confirm_task", {
        ...confirmation,
        is_supervisor: true,
        is_developer: false,
      });

      let settled = false;
      const pendingWait = postJsonRpc({
        jsonrpc: "2.0",
        id: 603,
        method: "tools/call",
        params: { name: "wait_for_turn", arguments: {} },
      }, { "x-ai-identity": supervisor.token }, 5000).finally(() => { settled = true; });
      await vi.waitFor(async () => {
        expect(await getServerWorkflowWaiterCount(supervisorConfirmation.workflow_id)).toBeGreaterThan(0);
      }, { timeout: 2000, interval: 10 });
      expect(settled).toBe(false);

      await call(developerClient, "confirm_task", {
        ...confirmation,
        is_supervisor: false,
        is_developer: true,
      });
      const envelope = expectSingleJsonResponse(await pendingWait);

      expect(envelope).toMatchObject({
        jsonrpc: "2.0",
        id: 603,
        result: {
          structuredContent: {
            ok: true,
            turn: "json-wait-supervisor",
            instruction: { next_action: "claim_turn", reason_code: "TURN_ASSIGNED" },
          },
        },
      });
    } finally {
      await Promise.allSettled([
        anonymousClient.close(),
        supervisorClient.close(),
        developerClient.close(),
      ]);
      await rm(taskPath, { force: true });
      await rm(`${taskPath}.pid`, { force: true });
    }
  });

  it("does not treat MCP path prefixes as the MCP endpoint", async () => {
    expect(await requestStatus("POST", "/mcp-extra")).toBe(404);
  });

  it("reports how to resolve a port conflict", async () => {
    const competingServer = spawn(
      process.execPath,
      ["--import", "tsx/esm", "src/index.ts", "--port", String(PORT)],
      { env: { ...process.env, PORT: "ignored" }, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    competingServer.stderr?.setEncoding("utf-8");
    competingServer.stderr?.on("data", (chunk) => { stderr += chunk; });

    const exitCode = await new Promise<number | null>((resolve) => {
      competingServer.on("exit", resolve);
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain(`port ${PORT} is already in use`);
    expect(stderr).toContain("--port");
  });

  it("prints CLI help without starting a server", async () => {
    const helpProcess = spawn(
      process.execPath,
      ["--import", "tsx/esm", "src/index.ts", "--help"],
      { env: { ...process.env, PORT: "ignored" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    helpProcess.stdout?.setEncoding("utf-8");
    helpProcess.stderr?.setEncoding("utf-8");
    helpProcess.stdout?.on("data", (chunk) => { stdout += chunk; });
    helpProcess.stderr?.on("data", (chunk) => { stderr += chunk; });

    const exitCode = await new Promise<number | null>((resolve) => {
      helpProcess.on("exit", resolve);
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: npx tsx src/index.ts [--port <port>]");
    expect(stdout).toContain("default: 35690");
    expect(stderr).toBe("");
  });

  it("rejects an oversized declared Content-Length before reading the body", async () => {
    const response = await postMcp([], { "Content-Length": MAX_REQUEST_BODY_BYTES + 1 });

    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({ ok: false, error: "Payload Too Large" });
    expect(await requestStatus("GET", "/health")).toBe(200);
  });

  it("rejects a chunked body when received bytes exceed the limit", async () => {
    const response = await postMcp([
      Buffer.alloc(600 * 1024, 0x61),
      Buffer.alloc(600 * 1024, 0x62),
    ]);

    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toEqual({ ok: false, error: "Payload Too Large" });
    expect(await requestStatus("GET", "/health")).toBe(200);
  });

  it("accepts a valid request whose body is exactly the limit", async () => {
    const json = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ping", arguments: {} },
    });
    const body = Buffer.from(json + " ".repeat(MAX_REQUEST_BODY_BYTES - Buffer.byteLength(json)));

    const response = await postMcp([body], { "Content-Length": body.length });

    expect(response.status).toBe(200);
  });

  it("returns 400 for malformed JSON without disrupting the server", async () => {
    const response = await postMcp([Buffer.from("{")]);

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ ok: false, error: "Invalid JSON" });
    expect(await requestStatus("GET", "/health")).toBe(200);
  });

  it("delegates syntactically valid non-RPC JSON to the MCP transport", async () => {
    const response = await postMcp([Buffer.from("null")]);

    expect(response.status).toBe(400);
  });

  it("injects the registered token into subsequent requests", async () => {
    const url = `http://127.0.0.1:${PORT}/mcp`;
    const anonymousClient = new Client({ name: "register-test", version: "1" }, {});
    await anonymousClient.connect(new StreamableHTTPClientTransport(new URL(url)));
    const registration = await call(anonymousClient, "register", { identity: "claude" });
    await anonymousClient.close();

    const authenticatedClient = new Client({ name: "identity-test", version: "1" }, {});
    await authenticatedClient.connect(createClientTransport(url, registration.token));
    const identity = await call(authenticatedClient, "who_am_i");

    expect(identity.identity).toBe("claude");
    expect(identity.registered).toBe(true);
    await authenticatedClient.close();
  });

  it("who_am_i returns unknown before token registration", async () => {
    const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`));
    const c = new Client({ name: "test2", version: "1" }, {});
    await c.connect(t);
    const r = await call(c, "who_am_i", {});
    expect(r.identity).toBe("unknown");
    expect(r.registered).toBe(false);
    expect(r.joined_workflow).toBe(false);
    await c.close();
  });

  it("validates successful structured output and preserves business rejections", async () => {
    const url = `http://127.0.0.1:${PORT}/mcp`;
    const anonymousClient = new Client({ name: "output-validation-test", version: "1" }, {});
    await anonymousClient.connect(new StreamableHTTPClientTransport(new URL(url)));

    expect((await call(anonymousClient, "ping")).ok).toBe(true);
    expect((await call(anonymousClient, "who_am_i")).registered).toBe(false);
    const registration = await call(anonymousClient, "register", { identity: "schema-user" });
    await anonymousClient.close();

    const authenticatedClient = new Client({ name: "rejection-test", version: "1" }, {});
    await authenticatedClient.connect(createClientTransport(url, registration.token));
    await authenticatedClient.listTools();
    const rejection = await call(authenticatedClient, "advance");
    expect(rejection.ok).toBe(false);
    expect(rejection.instruction).toMatchObject({
      next_action: "fix_request",
      reason_code: "REQUEST_REJECTED",
    });
    await authenticatedClient.close();
  });
});

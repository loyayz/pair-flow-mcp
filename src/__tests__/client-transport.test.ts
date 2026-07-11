import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import { get, request as httpRequest } from "node:http";
import { networkInterfaces } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClientTransport } from "../client-transport.js";

const PORT = 3197;
let server: ChildProcess;

async function startServer() {
  server = spawn(process.execPath, ["--import", "tsx/esm", "src/index.ts"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "pipe",
  });
  await new Promise((r) => setTimeout(r, 2000));
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
  const r = await client.callTool({ name, arguments: args });
  return JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
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

  it("does not treat MCP path prefixes as the MCP endpoint", async () => {
    expect(await requestStatus("POST", "/mcp-extra")).toBe(404);
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
});

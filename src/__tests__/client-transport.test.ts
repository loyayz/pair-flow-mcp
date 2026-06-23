import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createClientTransport } from "../client-transport.js";

const PORT = 3197;
const TEST_HANDOFF = resolve(".pairflow-test-transport-handoff");
const TEST_STATE = resolve(".pairflow-test-transport");
let server: ChildProcess;

async function startServer() {
  await rm(TEST_STATE, { recursive: true }).catch(() => {});
  await rm(TEST_HANDOFF, { recursive: true }).catch(() => {});
  server = spawn(process.execPath, ["--import", "tsx/esm", "src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), STATE_DIR: TEST_STATE, HANDOFF_DIR: TEST_HANDOFF },
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
  await rm(TEST_HANDOFF, { recursive: true }).catch(() => {});
  await rm(TEST_STATE, { recursive: true }).catch(() => {});
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  return JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
}

describe("Client transport with identity injection", () => {
  beforeAll(startServer, 15000);
  afterAll(stopServer);

  it("registers with identity via header", async () => {
    const t = createClientTransport(`http://localhost:${PORT}/mcp`, "claude");
    const c = new Client({ name: "test", version: "1" }, {});
    await c.connect(t);
    const r = await call(c, "register", { supervisor: true, developer: false });
    expect(r.ok).toBe(true);
    expect(r.identity).toBe("claude");
    await c.close();
  });

  it("who_am_i returns correct identity", async () => {
    const t = createClientTransport(`http://localhost:${PORT}/mcp`, "codebuddy");
    const c = new Client({ name: "test2", version: "1" }, {});
    await c.connect(t);
    const r = await call(c, "who_am_i", {});
    expect(r.identity).toBe("codebuddy");
    await c.close();
  });
});

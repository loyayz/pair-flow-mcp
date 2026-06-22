import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createClientTransport } from "../client-transport.js";

const PORT = 3197;
let server: ChildProcess;

async function startServer() {
  await rm(".pairflow-test-transport", { recursive: true }).catch(() => {});
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  server = spawn(npxCmd, ["tsx", "src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), STATE_DIR: ".pairflow-test-transport" },
    stdio: "pipe", shell: true,
  });
  await new Promise((r) => setTimeout(r, 2000));
}

async function stopServer() {
  server?.kill();
  await new Promise((r) => setTimeout(r, 500));
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

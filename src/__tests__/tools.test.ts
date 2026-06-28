import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import http from "node:http";

const PORT = 3199;
const TEST_HANDOFF = resolve(".pairflow-test-handoff");
const TEST_STATE = resolve(".pairflow-test");
const TEST_TASK = resolve(tmpdir(), "pairflow-test-task.md");
let server: ChildProcess;

function mcpRequest(name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const req = http.request({
      hostname: "localhost", port: PORT, path: "/mcp", method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", ...headers },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const match = data.match(/data:\s*(\{.*\})/);
          resolve(match ? JSON.parse(JSON.parse(match[1]).result.content[0].text) : JSON.parse(data));
        } catch { resolve({ raw: data.slice(0, 100) }); }
      });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

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

async function setup() {
  await writeFile(TEST_TASK, "# test task", "utf-8").catch(() => {});
  const workDir = tmpdir();
  const r1 = await mcpRequest("register", { identity: "claude", supervisor: true, developer: false, work_dir: workDir });
  const r2 = await mcpRequest("register", { identity: "codebuddy", supervisor: false, developer: true, work_dir: workDir });
  if (!r1.ok || !r2.ok) throw new Error(`Setup failed: ${JSON.stringify(r1)} ${JSON.stringify(r2)}`);
  await mcpRequest("confirm_task", { task_path: TEST_TASK }, { "x-ai-identity": "claude" });
  const adv = await mcpRequest("advance", {}, { "x-ai-identity": "claude" });
  if (!adv.ok) throw new Error(`Advance failed: ${JSON.stringify(adv)}`);
}

describe("Register", () => {
  beforeAll(startServer, 15000);
  afterAll(stopServer);

  it("rejects without identity in body", async () => {
    const r = await mcpRequest("register", { supervisor: true, developer: false, work_dir: "/test" });
    expect(r.ok).toBe(false);
  });
  it("registers with identity in body", async () => {
    const r = await mcpRequest("register", { identity: "alice", supervisor: true, developer: false, work_dir: "/test" });
    expect(r.ok).toBe(true);
    expect(r.token).toBeDefined();
    expect(typeof r.token).toBe("string");
    expect(r.token.length).toBeGreaterThan(0);
  });
});

describe("Claim turn + submit", () => {
  beforeAll(async () => {
    await writeFile(TEST_TASK, "# test task", "utf-8");
    await startServer(); await setup();
  }, 20000);
  afterAll(async () => {
    stopServer();
    await rm(TEST_TASK, { force: true });
    await rm(TEST_TASK + ".pid", { force: true });
  });

  it("rejects non-supervisor advance", async () => {
    const r = await mcpRequest("advance", {}, { "x-ai-identity": "codebuddy" });
    expect(r.ok).toBe(false);
  });
  it("claim turn succeeds for current turn holder", async () => {
    const r = await mcpRequest("claim_turn", {}, { "x-ai-identity": "codebuddy" });
    expect(r.ok).toBe(true);
  });
  it("submit works", async () => {
    await mcpRequest("claim_turn", {}, { "x-ai-identity": "codebuddy" });
    const r = await mcpRequest("submit", {
      file_path: TEST_TASK,
      git_commit_hash: "def7654321",
    }, { "x-ai-identity": "codebuddy" });
    expect(r.ok).toBe(true);
  });
});

describe("Concurrent mutex", () => {
  beforeAll(startServer, 15000);
  afterAll(stopServer);

  it("serializes", async () => {
    const [r1, r2] = await Promise.all([
      mcpRequest("register", { identity: "a", supervisor: true, developer: false, work_dir: "/test" }),
      mcpRequest("register", { identity: "b", supervisor: false, developer: true, work_dir: "/test" }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import http from "node:http";

const PORT = 3199;
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
  await rm(".pairflow-test", { recursive: true }).catch(() => {});
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  server = spawn(npxCmd, ["tsx", "src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), STATE_DIR: ".pairflow-test" },
    stdio: "pipe", shell: true,
  });
  await new Promise((r) => setTimeout(r, 2000));
}

async function stopServer() {
  server?.kill();
  await new Promise((r) => setTimeout(r, 500));
}

async function setup() {
  const r1 = await mcpRequest("register", { supervisor: true, developer: false }, { "x-ai-identity": "claude" });
  const r2 = await mcpRequest("register", { supervisor: false, developer: true }, { "x-ai-identity": "codebuddy" });
  if (!r1.ok || !r2.ok) throw new Error(`Setup failed: ${JSON.stringify(r1)} ${JSON.stringify(r2)}`);
  const adv = await mcpRequest("claim_turn", { mode: "advance", timeouts: { requirements: 10, planning: 10, implementation: 60, summary: 30 } }, { "x-ai-identity": "claude" });
  if (!adv.ok) throw new Error(`Advance failed: ${JSON.stringify(adv)}`);
}

describe("Register", () => {
  beforeAll(startServer, 15000);
  afterAll(stopServer);

  it("rejects without header", async () => {
    const r = await mcpRequest("register", { supervisor: true, developer: false });
    expect(r.ok).toBe(false);
  });
  it("registers with header", async () => {
    const r = await mcpRequest("register", { supervisor: true, developer: false }, { "x-ai-identity": "alice" });
    expect(r.ok).toBe(true);
  });
});

describe("Claim turn + submit", () => {
  beforeAll(async () => { await startServer(); await setup(); }, 20000);
  afterAll(stopServer);

  it("rejects non-supervisor advance", async () => {
    const r = await mcpRequest("claim_turn", { mode: "advance" }, { "x-ai-identity": "codebuddy" });
    expect(r.ok).toBe(false);
  });
  it("returns lease token", async () => {
    const r = await mcpRequest("claim_turn", { mode: "turn" }, { "x-ai-identity": "codebuddy" });
    expect(r.ok).toBe(true);
    expect(r.lease_token).toBeTruthy();
  });
  it("submit works", async () => {
    await mcpRequest("claim_turn", { mode: "turn" }, { "x-ai-identity": "codebuddy" });
    const r = await mcpRequest("submit", {
      content: "## 本轮审阅范围\n\n- test\n\n## 收敛状态\n\n- 本轮新增 issue：P0：0，P1：0，P2：0\n- 本轮关闭 issue：无",
      converge_mark: { stance: null, need_next_round: null, new_issues: [], resolved_issue_ids: [] },
      commit_hash: "abc12345",
    }, { "x-ai-identity": "codebuddy" });
    expect(r.ok).toBe(true);
  });
});

describe("Issue CRUD", () => {
  beforeAll(async () => { await startServer(); await setup(); }, 20000);
  afterAll(stopServer);

  it("creates and lists", async () => {
    const r = await mcpRequest("create_issue", { type: "P1", topic: "test", description: "desc", proposal: "fix", rationale: "§5.3" }, { "x-ai-identity": "claude" });
    expect(r.ok).toBe(true);
    const list = await mcpRequest("list_issues", {}) as { issues: unknown[] };
    expect(list.issues).toBeDefined();
  });
  it("rejects P0 without proposal", async () => {
    const r = await mcpRequest("create_issue", { type: "P0", topic: "no proposal", description: "desc" }, { "x-ai-identity": "claude" });
    expect(r.ok).toBe(false);
  });
  it("resolve closes issue", async () => {
    const r = await mcpRequest("create_issue", { type: "P2", topic: "to close", description: "q" }, { "x-ai-identity": "claude" }) as { ok: boolean; issue_id: number };
    const res = await mcpRequest("resolve_issue", { issue_id: r.issue_id, resolution: "done" }, { "x-ai-identity": "claude" });
    expect(res.ok).toBe(true);
  });
});

describe("Force converge", () => {
  beforeAll(async () => { await startServer(); await setup(); }, 20000);
  afterAll(stopServer);

  it("only supervisor", async () => {
    const r = await mcpRequest("force_converge", {}, { "x-ai-identity": "codebuddy" });
    expect(r.ok).toBe(false);
    const r2 = await mcpRequest("force_converge", {}, { "x-ai-identity": "claude" });
    expect(r2.ok).toBe(true);
  });
});

describe("Concurrent mutex", () => {
  beforeAll(startServer, 15000);
  afterAll(stopServer);

  it("serializes", async () => {
    const [r1, r2] = await Promise.all([
      mcpRequest("register", { supervisor: true, developer: false }, { "x-ai-identity": "a" }),
      mcpRequest("register", { supervisor: false, developer: true }, { "x-ai-identity": "b" }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });
});

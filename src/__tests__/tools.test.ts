import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import http from "node:http";

const PORT = 3199;
const TEST_HANDOFF = resolve(".pairflow-test-handoff");
const TEST_STATE = resolve(".pairflow-test");
const TEST_TASK = resolve(tmpdir(), "pairflow-test-task.md");
let server: ChildProcess;
let claudeToken = "";
let codebuddyToken = "";
let workflowId = "";

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
  const r1 = await mcpRequest("register", { identity: "claude" });
  const r2 = await mcpRequest("register", { identity: "codebuddy" });
  if (!r1.ok || !r2.ok) throw new Error(`Setup failed: ${JSON.stringify(r1)} ${JSON.stringify(r2)}`);
  claudeToken = r1.token as string;
  codebuddyToken = r2.token as string;
  const workDir = resolve(tmpdir());
  const c1 = await mcpRequest("confirm_task", { task_path: TEST_TASK, supervisor: true, developer: false, work_dir: workDir }, { "x-ai-identity": claudeToken });
  if (!c1.ok) throw new Error(`confirm_task(claude) failed: ${JSON.stringify(c1)}`);
  workflowId = c1.workflow_id as string;
  const c2 = await mcpRequest("confirm_task", { task_path: TEST_TASK, supervisor: false, developer: true, work_dir: workDir }, { "x-ai-identity": codebuddyToken });
  if (!c2.ok) throw new Error(`confirm_task(codebuddy) failed: ${JSON.stringify(c2)}`);
  const adv = await mcpRequest("advance", {}, { "x-ai-identity": claudeToken });
  if (!adv.ok) throw new Error(`Advance failed: ${JSON.stringify(adv)}`);
}

describe("Register", () => {
  beforeAll(startServer, 15000);
  afterAll(stopServer);

  it("rejects without identity in body", async () => {
    const r = await mcpRequest("register", {});
    expect(r.ok).toBe(false);
    expect(r.tip).toContain("请求被拒绝");
    expect(r.tip).toContain("identity");
  });
  it("registers with identity in body", async () => {
    const r = await mcpRequest("register", { identity: "alice" });
    expect(r.ok).toBe(true);
    expect(r.token).toBeDefined();
    expect(typeof r.token).toBe("string");
    const token = r.token as string;
    expect(token.length).toBeGreaterThan(0);
    expect(r.phase).toBeUndefined();

    const who = await mcpRequest("who_am_i", {}, { "x-ai-identity": token });
    expect(who.registered).toBe(true);
    expect(who.joined_workflow).toBe(false);
  });
});

describe("Confirm task", () => {
  beforeAll(startServer, 15000);
  afterAll(stopServer);

  it("rejects relative task_path", async () => {
    const r = await mcpRequest("register", { identity: "rel-task" });
    const c = await mcpRequest("confirm_task", {
      task_path: "docs/task.md",
      supervisor: true,
      developer: false,
      work_dir: resolve(tmpdir()),
    }, { "x-ai-identity": r.token as string });
    expect(c.ok).toBe(false);
    expect(c.tip).toContain("task_path must be an absolute path");
  });

  it("rejects task_path with relative path segments", async () => {
    const task = resolve(tmpdir(), "pairflow-dot-task.md");
    await writeFile(task, "# dot task", "utf-8");
    const r = await mcpRequest("register", { identity: "dot-task" });
    const c = await mcpRequest("confirm_task", {
      task_path: `${resolve(tmpdir())}/./pairflow-dot-task.md`,
      supervisor: true,
      developer: false,
      work_dir: resolve(tmpdir()),
    }, { "x-ai-identity": r.token as string });
    expect(c.ok).toBe(false);
    expect(c.tip).toContain("task_path must not contain . or .. path segments");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("rejects relative work_dir", async () => {
    const task = resolve(tmpdir(), "pairflow-relative-workdir-task.md");
    await writeFile(task, "# relative workdir task", "utf-8");
    const r = await mcpRequest("register", { identity: "rel-workdir" });
    const c = await mcpRequest("confirm_task", {
      task_path: task,
      supervisor: true,
      developer: false,
      work_dir: ".",
    }, { "x-ai-identity": r.token as string });
    expect(c.ok).toBe(false);
    expect(c.tip).toContain("work_dir must be an absolute path");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("rejects work_dir with relative path segments", async () => {
    const task = resolve(tmpdir(), "pairflow-dot-workdir-task.md");
    await writeFile(task, "# dot workdir task", "utf-8");
    const r = await mcpRequest("register", { identity: "dot-workdir" });
    const c = await mcpRequest("confirm_task", {
      task_path: task,
      supervisor: true,
      developer: false,
      work_dir: `${resolve(tmpdir())}/./`,
    }, { "x-ai-identity": r.token as string });
    expect(c.ok).toBe(false);
    expect(c.tip).toContain("work_dir must not contain . or .. path segments");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("matches work_dir by resolved absolute path", async () => {
    const task = resolve(tmpdir(), "pairflow-workdir-task.md");
    await writeFile(task, "# workdir task", "utf-8");
    const r1 = await mcpRequest("register", { identity: "wd-a" });
    const r2 = await mcpRequest("register", { identity: "wd-b" });
    const c1 = await mcpRequest("confirm_task", {
      task_path: task,
      supervisor: true,
      developer: false,
      work_dir: resolve(tmpdir()),
    }, { "x-ai-identity": r1.token as string });
    const c2 = await mcpRequest("confirm_task", {
      task_path: task,
      supervisor: false,
      developer: true,
      work_dir: resolve(tmpdir()),
    }, { "x-ai-identity": r2.token as string });
    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(true);
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });
});

describe("Wait for turn + submit", () => {
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
    const r = await mcpRequest("advance", {}, { "x-ai-identity": codebuddyToken });
    expect(r.ok).toBe(false);
  });
  it("wait_for_turn returns immediately for current turn holder", async () => {
    const r = await mcpRequest("wait_for_turn", {}, { "x-ai-identity": codebuddyToken });
    expect(r.turn).toBe("codebuddy");
    expect(r.tip).toContain(resolve(TEST_HANDOFF, workflowId, "requirements", "r1_codebuddy.md").replace(/\\/g, "/"));
  });
  it("rejects role overwrite that would create duplicate supervisors", async () => {
    const r = await mcpRequest("confirm_task", {
      task_path: TEST_TASK,
      supervisor: true,
      developer: true,
      work_dir: resolve(tmpdir()),
    }, { "x-ai-identity": codebuddyToken });
    expect(r.ok).toBe(false);

    const who = await mcpRequest("who_am_i", {}, { "x-ai-identity": codebuddyToken });
    expect(who.is_supervisor).toBe(false);
    expect(who.is_developer).toBe(true);
  });
  it("rejects submit outside the workflow archive", async () => {
    const r = await mcpRequest("submit", {
      file_path: TEST_TASK,
      git_commit_hash: "def7654321",
    }, { "x-ai-identity": codebuddyToken });
    expect(r.ok).toBe(false);
  });
  it("rejects relative submit file_path", async () => {
    const r = await mcpRequest("submit", {
      file_path: "handoff/foo.md",
      git_commit_hash: "def7654321",
    }, { "x-ai-identity": codebuddyToken });
    expect(r.ok).toBe(false);
    expect(r.tip).toContain("file_path must be an absolute path");
  });
  it("rejects submit file_path with relative path segments", async () => {
    const archiveFile = resolve(TEST_HANDOFF, workflowId, "requirements", "r1_codebuddy.md");
    await mkdir(dirname(archiveFile), { recursive: true });
    await writeFile(archiveFile, "# requirements", "utf-8");
    const r = await mcpRequest("submit", {
      file_path: `${resolve(TEST_HANDOFF)}/./${workflowId}/requirements/r1_codebuddy.md`,
      git_commit_hash: "def7654321",
    }, { "x-ai-identity": codebuddyToken });
    expect(r.ok).toBe(false);
    expect(r.tip).toContain("file_path must not contain . or .. path segments");
  });
  it("submit works", async () => {
    const archiveFile = resolve(TEST_HANDOFF, workflowId, "requirements", "r1_codebuddy.md");
    await mkdir(dirname(archiveFile), { recursive: true });
    await writeFile(archiveFile, "# requirements", "utf-8");
    const r = await mcpRequest("submit", {
      file_path: archiveFile,
      git_commit_hash: "def7654321",
    }, { "x-ai-identity": codebuddyToken });
    expect(r.ok).toBe(true);
  });
  it("reads archived meta json content", async () => {
    const r = await mcpRequest("get_archived_file_content", {
      filename: "r1_codebuddy.meta.json",
      phase: "requirements",
    }, { "x-ai-identity": codebuddyToken });
    expect(r.ok).toBe(true);
    expect(r.content).toContain("def7654321");
  });
  it("rejects archived file content path traversal", async () => {
    const r = await mcpRequest("get_archived_file_content", {
      filename: "../r1_codebuddy.md",
      phase: "requirements",
    }, { "x-ai-identity": codebuddyToken });
    expect(r.ok).toBe(false);
    expect(r.tip).toContain("invalid filename");
  });
  it("rejects invalid archived workflow_id", async () => {
    const r = await mcpRequest("get_archived_files", {
      workflow_id: "../bad",
    }, { "x-ai-identity": codebuddyToken });
    expect(r.ok).toBe(false);
    expect(r.tip).toContain("invalid workflow_id");
  });
});

describe("Concurrent mutex", () => {
  beforeAll(startServer, 15000);
  afterAll(stopServer);

  it("serializes", async () => {
    const [r1, r2] = await Promise.all([
      mcpRequest("register", { identity: "a" }),
      mcpRequest("register", { identity: "b" }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });
});

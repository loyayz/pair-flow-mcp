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

function mcpListTools(): Promise<Array<{ name: string }>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const req = http.request({
      hostname: "localhost", port: PORT, path: "/mcp", method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const match = data.match(/data:\s*(\{.*\})/);
          const json = match ? JSON.parse(match[1]) : JSON.parse(data);
          resolve(json.result.tools);
        } catch (error) {
          reject(error);
        }
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

async function seedRecoveredWorkflow(task: string, wfId: string, identities: string[]) {
  const phaseDir = resolve(TEST_HANDOFF, wfId, "requirements");
  await mkdir(phaseDir, { recursive: true });
  await writeFile(`${task}.pid`, wfId, "utf-8");
  const taskMeta = { spec_file: task, task_type: "development" };
  for (const [index, identity] of identities.entries()) {
    await writeFile(resolve(phaseDir, `r${index + 1}_${identity}.meta.json`), JSON.stringify({
      submitted_at: `2026-07-09T10:0${index}:00.000Z`,
      commit_hash: index === 0 ? "abc1234" : "def5678",
      task: taskMeta,
    }), "utf-8");
  }
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
  it("does not expose archive content reads", async () => {
    const tools = await mcpListTools();
    expect(tools.map((tool) => tool.name)).not.toContain("get_archived_file_content");
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

  it("rejects explicit task_type mismatch and allows omitted task_type to inherit", async () => {
    const task = resolve(tmpdir(), "pairflow-task-type-task.md");
    await writeFile(task, "# task type task", "utf-8");
    const r1 = await mcpRequest("register", { identity: "tt-a" });
    const r2 = await mcpRequest("register", { identity: "tt-b" });
    const c1 = await mcpRequest("confirm_task", {
      task_path: task,
      task_type: "development",
      supervisor: true,
      developer: false,
      work_dir: resolve(tmpdir()),
    }, { "x-ai-identity": r1.token as string });
    const mismatch = await mcpRequest("confirm_task", {
      task_path: task,
      task_type: "requirements",
      supervisor: false,
      developer: true,
      work_dir: resolve(tmpdir()),
    }, { "x-ai-identity": r2.token as string });
    const inherited = await mcpRequest("confirm_task", {
      task_path: task,
      supervisor: false,
      developer: true,
      work_dir: resolve(tmpdir()),
    }, { "x-ai-identity": r2.token as string });

    expect(c1.ok).toBe(true);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.tip).toContain("task_type mismatch");
    expect(inherited.ok).toBe(true);
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("rejects a complete workflow without a supervisor", async () => {
    const task = resolve(tmpdir(), "pairflow-no-supervisor-task.md");
    await writeFile(task, "# no supervisor task", "utf-8");
    const r1 = await mcpRequest("register", { identity: "nosup-a" });
    const r2 = await mcpRequest("register", { identity: "nosup-b" });
    const c1 = await mcpRequest("confirm_task", {
      task_path: task,
      supervisor: false,
      developer: true,
      work_dir: resolve(tmpdir()),
    }, { "x-ai-identity": r1.token as string });
    const c2 = await mcpRequest("confirm_task", {
      task_path: task,
      supervisor: false,
      developer: false,
      work_dir: resolve(tmpdir()),
    }, { "x-ai-identity": r2.token as string });

    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(false);
    expect(c2.tip).toContain("exactly one supervisor");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("rejects a complete workflow without a developer", async () => {
    const task = resolve(tmpdir(), "pairflow-no-developer-task.md");
    await writeFile(task, "# no developer task", "utf-8");
    const r1 = await mcpRequest("register", { identity: "nodev-a" });
    const r2 = await mcpRequest("register", { identity: "nodev-b" });
    const c1 = await mcpRequest("confirm_task", {
      task_path: task,
      supervisor: true,
      developer: false,
      work_dir: resolve(tmpdir()),
    }, { "x-ai-identity": r1.token as string });
    const c2 = await mcpRequest("confirm_task", {
      task_path: task,
      supervisor: false,
      developer: false,
      work_dir: resolve(tmpdir()),
    }, { "x-ai-identity": r2.token as string });

    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(false);
    expect(c2.tip).toContain("exactly one developer");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("allows supervisor and developer responsibilities on the same participant", async () => {
    const task = resolve(tmpdir(), "pairflow-combined-role-task.md");
    await writeFile(task, "# combined role task", "utf-8");
    const r1 = await mcpRequest("register", { identity: "combo-a" });
    const r2 = await mcpRequest("register", { identity: "combo-b" });
    const c1 = await mcpRequest("confirm_task", {
      task_path: task,
      supervisor: true,
      developer: true,
      work_dir: resolve(tmpdir()),
    }, { "x-ai-identity": r1.token as string });
    const c2 = await mcpRequest("confirm_task", {
      task_path: task,
      supervisor: false,
      developer: false,
      work_dir: resolve(tmpdir()),
    }, { "x-ai-identity": r2.token as string });

    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(true);
    expect(c2.tip).toContain("combo-a（supervisor/developer）");
    expect(c2.tip).toContain("combo-b（reviewer）");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("blocks workflow actions until all recovered participants re-confirm", async () => {
    const task = resolve(tmpdir(), "pairflow-incomplete-recovery-task.md");
    const wfId = "20260709191959";
    await writeFile(task, "# incomplete recovery task", "utf-8");
    await seedRecoveredWorkflow(task, wfId, ["rec-a", "rec-b"]);

    const r1 = await mcpRequest("register", { identity: "rec-a" });
    const c1 = await mcpRequest("confirm_task", {
      task_path: task,
      supervisor: true,
      developer: false,
      work_dir: resolve(tmpdir()),
    }, { "x-ai-identity": r1.token as string });
    const adv = await mcpRequest("advance", {}, { "x-ai-identity": r1.token as string });
    const state = await mcpRequest("get_state", {}, { "x-ai-identity": r1.token as string });
    const wait = await mcpRequest("wait_for_turn", {}, { "x-ai-identity": r1.token as string });
    const submit = await mcpRequest("submit", {
      file_path: task,
      git_commit_hash: "fedcba9",
    }, { "x-ai-identity": r1.token as string });

    expect(c1.ok).toBe(true);
    expect(c1.recovered).toBe(true);
    expect(adv.ok).toBe(false);
    expect(adv.tip).toContain("workflow recovery incomplete");
    expect(state.ok).toBe(true);
    expect(state.tip).toContain("工作流恢复未完成");
    expect(wait.ok).toBe(false);
    expect(wait.tip).toContain("workflow recovery incomplete");
    expect(submit.ok).toBe(false);
    expect(submit.tip).toContain("workflow recovery incomplete");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("enforces role completeness when the final recovered participant re-confirms", async () => {
    const task = resolve(tmpdir(), "pairflow-recovery-role-task.md");
    const wfId = "20260709192000";
    await writeFile(task, "# recovery role task", "utf-8");
    await seedRecoveredWorkflow(task, wfId, ["rec-role-a", "rec-role-b"]);

    const r1 = await mcpRequest("register", { identity: "rec-role-a" });
    const r2 = await mcpRequest("register", { identity: "rec-role-b" });
    const c1 = await mcpRequest("confirm_task", {
      task_path: task,
      supervisor: false,
      developer: false,
      work_dir: resolve(tmpdir()),
    }, { "x-ai-identity": r1.token as string });
    const c2 = await mcpRequest("confirm_task", {
      task_path: task,
      supervisor: false,
      developer: false,
      work_dir: resolve(tmpdir()),
    }, { "x-ai-identity": r2.token as string });

    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(false);
    expect(c2.tip).toContain("exactly one supervisor");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("enforces work_dir consistency when recovered participants re-confirm", async () => {
    const root = resolve(tmpdir(), "pairflow-recovery-workdir-root");
    const nested = resolve(root, "nested");
    const task = resolve(nested, "task.md");
    const wfId = "20260709192001";
    await mkdir(nested, { recursive: true });
    await writeFile(task, "# recovery workdir task", "utf-8");
    await seedRecoveredWorkflow(task, wfId, ["rec-wd-a", "rec-wd-b"]);

    const r1 = await mcpRequest("register", { identity: "rec-wd-a" });
    const r2 = await mcpRequest("register", { identity: "rec-wd-b" });
    const c1 = await mcpRequest("confirm_task", {
      task_path: task,
      supervisor: true,
      developer: false,
      work_dir: root,
    }, { "x-ai-identity": r1.token as string });
    const c2 = await mcpRequest("confirm_task", {
      task_path: task,
      supervisor: false,
      developer: true,
      work_dir: nested,
    }, { "x-ai-identity": r2.token as string });

    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(false);
    expect(c2.tip).toContain("work_dir mismatch");
    await rm(root, { recursive: true, force: true });
  });

  it("skips planning and implementation for requirements-only workflows", async () => {
    const task = resolve(tmpdir(), "pairflow-requirements-only-task.md");
    await writeFile(task, "# requirements only task", "utf-8");
    const r1 = await mcpRequest("register", { identity: "req-sup" });
    const r2 = await mcpRequest("register", { identity: "req-dev" });
    const c1 = await mcpRequest("confirm_task", {
      task_path: task,
      task_type: "requirements",
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
    const started = await mcpRequest("advance", {}, { "x-ai-identity": r1.token as string });
    const wfId = c1.workflow_id as string;
    const devFile = resolve(TEST_HANDOFF, wfId, "requirements", "r1_req-dev.md");
    await mkdir(dirname(devFile), { recursive: true });
    await writeFile(devFile, "# req-dev requirements", "utf-8");
    const s1 = await mcpRequest("submit", {
      file_path: devFile,
      git_commit_hash: "a1b2c3d",
    }, { "x-ai-identity": r2.token as string });
    const supFile = resolve(TEST_HANDOFF, wfId, "requirements", "r2_req-sup.md");
    await writeFile(supFile, "# req-sup review", "utf-8");
    const s2 = await mcpRequest("submit", {
      file_path: supFile,
      git_commit_hash: "d4e5f6a",
    }, { "x-ai-identity": r1.token as string });
    const advanced = await mcpRequest("advance", {}, { "x-ai-identity": r1.token as string });
    const summarySupFile = resolve(TEST_HANDOFF, wfId, "summary", "r1_req-sup.md");
    await mkdir(dirname(summarySupFile), { recursive: true });
    await writeFile(summarySupFile, "# req-sup summary", "utf-8");
    const summary1 = await mcpRequest("submit", {
      file_path: summarySupFile,
      git_commit_hash: "abcdef1",
    }, { "x-ai-identity": r1.token as string });
    const summaryDevFile = resolve(TEST_HANDOFF, wfId, "summary", "r2_req-dev.md");
    await writeFile(summaryDevFile, "# req-dev summary review", "utf-8");
    const summary2 = await mcpRequest("submit", {
      file_path: summaryDevFile,
      git_commit_hash: "abcdef2",
    }, { "x-ai-identity": r2.token as string });
    const finished = await mcpRequest("advance", {}, { "x-ai-identity": r1.token as string });
    const finalState = await mcpRequest("get_state", {}, { "x-ai-identity": r1.token as string });

    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(true);
    expect(started.new_phase).toBe("requirements");
    expect(s1.ok).toBe(true);
    expect(s1.tip).toContain("当前是第 2 轮需求分析");
    expect(s2.ok).toBe(true);
    expect(s2.tip).toContain("双方已提交");
    expect(s2.tip).toContain("当前是第 3 轮需求分析");
    expect(s2.tip).toContain("advance");
    expect(advanced.ok).toBe(true);
    expect(advanced.new_phase).toBe("summary");
    expect(summary1.ok).toBe(true);
    expect(summary2.ok).toBe(true);
    expect(finished.ok).toBe(true);
    expect(finished.new_phase).toBe("idle");
    expect(finalState.tip).toContain("没有加入活跃工作流");
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
  it("lists only supported archive file types", async () => {
    const phaseDir = resolve(TEST_HANDOFF, workflowId, "requirements");
    await writeFile(resolve(phaseDir, "debug.json"), "{}", "utf-8");
    await writeFile(resolve(phaseDir, "events.jsonl"), "{}", "utf-8");
    const r = await mcpRequest("get_archived_files", {
      phase: "requirements",
    }, { "x-ai-identity": codebuddyToken });

    expect(r.ok).toBe(true);
    expect(r.files).toContain("r1_codebuddy.md");
    expect(r.files).toContain("r1_codebuddy.meta.json");
    expect(r.files).not.toContain("debug.json");
    expect(r.files).not.toContain("events.jsonl");
  });
  it("allows anonymous archive listing by explicit workflow_id", async () => {
    const r = await mcpRequest("get_archived_files", {
      workflow_id: workflowId,
      phase: "requirements",
    });
    expect(r.ok).toBe(true);
    expect(r.files).toContain("r1_codebuddy.md");
    expect(r.files).toContain("r1_codebuddy.meta.json");
  });
  it("returns POSIX paths when listing an entire workflow archive", async () => {
    const r = await mcpRequest("get_archived_files", {
      workflow_id: workflowId,
    });
    expect(r.ok).toBe(true);
    expect(r.files).toContain("requirements/r1_codebuddy.md");
    expect((r.files as string[]).every((file) => !file.includes("\\"))).toBe(true);
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

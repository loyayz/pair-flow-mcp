import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execSync } from "node:child_process";
import http from "node:http";

const PORT = 3199;
const TEST_WORK_DIR = resolve(".pairflow-test-workdir");
const TEST_HANDOFF = resolve(TEST_WORK_DIR, "handoff");
const TEST_STATE = resolve(".pairflow-test");
const TEST_TASK = resolve(TEST_WORK_DIR, "pairflow-test-task.md");
let server: ChildProcess;
let claudeToken = "";
let codebuddyToken = "";
let workflowId = "";

function mcpRequest(name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const req = http.request({
      hostname: "127.0.0.1", port: PORT, path: "/mcp", method: "POST",
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

function mcpListTools(): Promise<Array<{ name: string; inputSchema?: { required?: string[] } }>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const req = http.request({
      hostname: "127.0.0.1", port: PORT, path: "/mcp", method: "POST",
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
  await rm(TEST_WORK_DIR, { recursive: true }).catch(() => {});
  await createGitWorkDir(TEST_WORK_DIR);
  server = spawn(process.execPath, ["--import", "tsx/esm", "src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), STATE_DIR: TEST_STATE },
    stdio: "pipe",
  });
  await new Promise((r) => setTimeout(r, 2000));
}

async function createGitWorkDir(path: string, marker: "directory" | "file" = "directory") {
  await mkdir(path, { recursive: true });
  const gitMarker = resolve(path, ".git");
  if (marker === "file") {
    await writeFile(gitMarker, "gitdir: ../linked-git-dir\n", "utf-8");
  } else {
    await mkdir(gitMarker, { recursive: true });
  }
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
  await rm(TEST_WORK_DIR, { recursive: true }).catch(() => {});
  await rm(TEST_STATE, { recursive: true }).catch(() => {});
}

async function setup() {
  await writeFile(TEST_TASK, "# test task", "utf-8").catch(() => {});
  const r1 = await mcpRequest("register", { identity: "claude" });
  const r2 = await mcpRequest("register", { identity: "codebuddy" });
  if (!r1.ok || !r2.ok) throw new Error(`Setup failed: ${JSON.stringify(r1)} ${JSON.stringify(r2)}`);
  claudeToken = r1.token as string;
  codebuddyToken = r2.token as string;
  const c1 = await mcpRequest("confirm_task", { task_path: TEST_TASK, is_supervisor: true, is_developer: false, work_dir: TEST_WORK_DIR }, { "x-ai-identity": claudeToken });
  if (!c1.ok) throw new Error(`confirm_task(claude) failed: ${JSON.stringify(c1)}`);
  workflowId = c1.workflow_id as string;
  const c2 = await mcpRequest("confirm_task", { task_path: TEST_TASK, is_supervisor: false, is_developer: true, work_dir: TEST_WORK_DIR }, { "x-ai-identity": codebuddyToken });
  if (!c2.ok) throw new Error(`confirm_task(codebuddy) failed: ${JSON.stringify(c2)}`);
  const adv = await mcpRequest("advance", {}, { "x-ai-identity": claudeToken });
  if (!adv.ok) throw new Error(`Advance failed: ${JSON.stringify(adv)}`);
}

async function seedRecoveredWorkflow(workDir: string, task: string, wfId: string, identities: string[]) {
  const phaseDir = resolve(workDir, "handoff", wfId, "requirements");
  await mkdir(phaseDir, { recursive: true });
  await writeFile(`${task}.pid`, wfId, "utf-8");
  const taskMeta = { spec_file: task, task_type: "development" };
  for (const [index, identity] of identities.entries()) {
    await writeFile(resolve(phaseDir, `r${index + 1}_${identity}.meta.json`), JSON.stringify({
      submitted_at: `2026-07-09T10:0${index}:00.000Z`,
      commit_hash: index === 0 ? "abc1234" : "def5678",
      sub_phase: null,
      task: taskMeta,
    }), "utf-8");
  }
}

describe("Register", () => {
  beforeAll(startServer, 15000);
  afterAll(stopServer);

  it("rejects without identity in body at the MCP schema layer", async () => {
    const r = await mcpRequest("register", {});
    expect(r.ok).not.toBe(true);
    expect(JSON.stringify(r)).toContain("Input validation");
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
  it("requires a valid registered token for every protected tool", async () => {
    const protectedCalls: Array<[string, Record<string, unknown>]> = [
      ["confirm_task", { task_path: TEST_TASK, is_supervisor: true, is_developer: false, work_dir: TEST_WORK_DIR }],
      ["advance", {}],
      ["get_state", {}],
      ["wait_for_turn", {}],
      ["submit", { file_path: TEST_TASK, git_commit_hash: "abc1234" }],
    ];

    for (const [name, args] of protectedCalls) {
      const r = await mcpRequest(name, args);
      expect(r.ok, name).toBe(false);
      expect(r.tip, name).toContain("valid registered token is required");
    }
  });
  it("does not expose archive query tools", async () => {
    const tools = await mcpListTools();
    expect(tools.map((tool) => tool.name)).not.toContain("get_archived_file_content");
    expect(tools.map((tool) => tool.name)).not.toContain("get_archived_files");
  });
  it("advertises required MCP input fields", async () => {
    const tools = await mcpListTools();
    const registerTool = tools.find((tool) => tool.name === "register");
    const confirmTaskTool = tools.find((tool) => tool.name === "confirm_task");

    expect(registerTool?.inputSchema?.required ?? []).toContain("identity");
    expect(confirmTaskTool?.inputSchema?.required ?? []).toContain("task_path");
    expect(confirmTaskTool?.inputSchema?.required ?? []).toContain("is_supervisor");
    expect(confirmTaskTool?.inputSchema?.required ?? []).toContain("is_developer");
    expect(confirmTaskTool?.inputSchema?.required ?? []).toContain("work_dir");
  });
});

describe("Confirm task", () => {
  beforeAll(startServer, 15000);
  afterAll(stopServer);

  it("rejects relative task_path", async () => {
    const r = await mcpRequest("register", { identity: "rel-task" });
    const c = await mcpRequest("confirm_task", {
      task_path: "docs/task.md",
      is_supervisor: true,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": r.token as string });
    expect(c.ok).toBe(false);
    expect(c.tip).toContain("task_path must be an absolute path");
  });

  it("rejects task_path with relative path segments", async () => {
    const task = resolve(TEST_WORK_DIR, "pairflow-dot-task.md");
    await writeFile(task, "# dot task", "utf-8");
    const r = await mcpRequest("register", { identity: "dot-task" });
    const c = await mcpRequest("confirm_task", {
      task_path: `${TEST_WORK_DIR}/./pairflow-dot-task.md`,
      is_supervisor: true,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": r.token as string });
    expect(c.ok).toBe(false);
    expect(c.tip).toContain("task_path must not contain . or .. path segments");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("rejects relative work_dir", async () => {
    const task = resolve(TEST_WORK_DIR, "pairflow-relative-workdir-task.md");
    await writeFile(task, "# relative workdir task", "utf-8");
    const r = await mcpRequest("register", { identity: "rel-workdir" });
    const c = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: true,
      is_developer: false,
      work_dir: ".",
    }, { "x-ai-identity": r.token as string });
    expect(c.ok).toBe(false);
    expect(c.tip).toContain("work_dir must be an absolute path");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("rejects a file used as work_dir", async () => {
    const file = resolve(TEST_WORK_DIR, "pairflow-file-workdir.md");
    await writeFile(file, "# not a directory", "utf-8");
    const registered = await mcpRequest("register", { identity: "file-workdir" });
    const confirmed = await mcpRequest("confirm_task", {
      task_path: file,
      is_supervisor: true,
      is_developer: false,
      work_dir: file,
    }, { "x-ai-identity": registered.token as string });

    expect(confirmed.ok).toBe(false);
    expect(confirmed.tip).toContain("work_dir must be a directory");
    await rm(file, { force: true });
    await rm(`${file}.pid`, { force: true });
  });

  it("rejects a work_dir without a .git marker", async () => {
    const workDir = resolve(TEST_WORK_DIR, "not-a-git-root");
    const task = resolve(workDir, "task.md");
    await mkdir(workDir, { recursive: true });
    await writeFile(task, "# not a git root", "utf-8");
    const registered = await mcpRequest("register", { identity: "non-git-root" });
    const confirmed = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: true,
      is_developer: false,
      work_dir: workDir,
    }, { "x-ai-identity": registered.token as string });

    expect(confirmed.ok).toBe(false);
    expect(confirmed.tip).toContain("work_dir must be a Git repository root");
    await rm(workDir, { recursive: true, force: true });
  });

  it("accepts a .git file for a linked worktree root", async () => {
    const workDir = resolve(TEST_WORK_DIR, "linked-worktree-root");
    const task = resolve(workDir, "task.md");
    await createGitWorkDir(workDir, "file");
    await writeFile(task, "# linked worktree task", "utf-8");
    const registered = await mcpRequest("register", { identity: "linked-worktree" });
    const confirmed = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: true,
      is_developer: false,
      work_dir: workDir,
    }, { "x-ai-identity": registered.token as string });

    expect(confirmed.ok).toBe(true);
    await rm(workDir, { recursive: true, force: true });
  });

  it("rejects a directory used as task_path", async () => {
    const taskDirectory = resolve(TEST_WORK_DIR, "pairflow-task-directory");
    await mkdir(taskDirectory, { recursive: true });
    const registered = await mcpRequest("register", { identity: "directory-task" });
    const confirmed = await mcpRequest("confirm_task", {
      task_path: taskDirectory,
      is_supervisor: true,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": registered.token as string });

    expect(confirmed.ok).toBe(false);
    expect(confirmed.tip).toContain("task_path must be a file");
    await rm(taskDirectory, { recursive: true, force: true });
    await rm(`${taskDirectory}.pid`, { force: true });
  });

  it("rejects work_dir with relative path segments", async () => {
    const task = resolve(TEST_WORK_DIR, "pairflow-dot-workdir-task.md");
    await writeFile(task, "# dot workdir task", "utf-8");
    const r = await mcpRequest("register", { identity: "dot-workdir" });
    const c = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: true,
      is_developer: false,
      work_dir: `${TEST_WORK_DIR}/./`,
    }, { "x-ai-identity": r.token as string });
    expect(c.ok).toBe(false);
    expect(c.tip).toContain("work_dir must not contain . or .. path segments");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("matches work_dir by resolved absolute path", async () => {
    const task = resolve(TEST_WORK_DIR, "pairflow-workdir-task.md");
    await writeFile(task, "# workdir task", "utf-8");
    const r1 = await mcpRequest("register", { identity: "wd-a" });
    const r2 = await mcpRequest("register", { identity: "wd-b" });
    const c1 = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: true,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": r1.token as string });
    const c2 = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: false,
      is_developer: true,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": r2.token as string });
    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(true);
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("matches task_path containment case-insensitively on Windows", async () => {
    if (process.platform !== "win32") return;

    const task = resolve(TEST_WORK_DIR, "pairflow-workdir-case-task.md");
    const workDir = TEST_WORK_DIR;
    const caseVariantWorkDir = workDir === workDir.toUpperCase()
      ? workDir.toLowerCase()
      : workDir.toUpperCase();
    await writeFile(task, "# workdir case task", "utf-8");
    const r = await mcpRequest("register", { identity: "wd-case" });
    const c = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: true,
      is_developer: false,
      work_dir: caseVariantWorkDir,
    }, { "x-ai-identity": r.token as string });

    expect(c.ok).toBe(true);
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("pairs task paths case-insensitively on Windows", async () => {
    if (process.platform !== "win32") return;

    const task = resolve(TEST_WORK_DIR, "pairflow-task-path-case.md");
    const caseVariantTask = task === task.toUpperCase() ? task.toLowerCase() : task.toUpperCase();
    await writeFile(task, "# task path case", "utf-8");
    const r1 = await mcpRequest("register", { identity: "task-case-a" });
    const r2 = await mcpRequest("register", { identity: "task-case-b" });
    const c1 = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: true,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": r1.token as string });
    const c2 = await mcpRequest("confirm_task", {
      task_path: caseVariantTask,
      is_supervisor: false,
      is_developer: true,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": r2.token as string });

    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(true);
    expect(c2.tip).toContain("双方已就位");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("pairs concurrent confirm_task calls for the same task_path into one workflow", async () => {
    const task = resolve(TEST_WORK_DIR, "pairflow-concurrent-confirm-task.md");
    await writeFile(task, "# concurrent confirm task", "utf-8");
    const [r1, r2] = await Promise.all([
      mcpRequest("register", { identity: "concurrent-a" }),
      mcpRequest("register", { identity: "concurrent-b" }),
    ]);

    const [c1, c2] = await Promise.all([
      mcpRequest("confirm_task", {
        task_path: task,
        is_supervisor: true,
        is_developer: false,
        work_dir: TEST_WORK_DIR,
      }, { "x-ai-identity": r1.token as string }),
      mcpRequest("confirm_task", {
        task_path: task,
        is_supervisor: false,
        is_developer: true,
        work_dir: TEST_WORK_DIR,
      }, { "x-ai-identity": r2.token as string }),
    ]);

    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(true);
    expect(c1.workflow_id).toBe(c2.workflow_id);
    expect(`${c1.tip}\n${c2.tip}`).toContain("双方已就位");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("rejects rebinding an active token to a different task", async () => {
    const firstTask = resolve(TEST_WORK_DIR, "pairflow-active-token-first.md");
    const secondTask = resolve(TEST_WORK_DIR, "pairflow-active-token-second.md");
    await writeFile(firstTask, "# first task", "utf-8");
    await writeFile(secondTask, "# second task", "utf-8");
    const registered = await mcpRequest("register", { identity: "active-token" });
    const headers = { "x-ai-identity": registered.token as string };
    const first = await mcpRequest("confirm_task", {
      task_path: firstTask,
      is_supervisor: true,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, headers);
    const second = await mcpRequest("confirm_task", {
      task_path: secondTask,
      is_supervisor: true,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, headers);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.tip).toContain("token is already joined to active workflow");
    expect(second.tip).toContain("register a new token for parallel work");
    await rm(firstTask, { force: true });
    await rm(secondTask, { force: true });
    await rm(`${firstTask}.pid`, { force: true });
    await rm(`${secondTask}.pid`, { force: true });
  });

  it("rejects explicit task_type mismatch and allows omitted task_type to inherit", async () => {
    const task = resolve(TEST_WORK_DIR, "pairflow-task-type-task.md");
    await writeFile(task, "# task type task", "utf-8");
    const r1 = await mcpRequest("register", { identity: "tt-a" });
    const r2 = await mcpRequest("register", { identity: "tt-b" });
    const c1 = await mcpRequest("confirm_task", {
      task_path: task,
      task_type: "development",
      is_supervisor: true,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": r1.token as string });
    const mismatch = await mcpRequest("confirm_task", {
      task_path: task,
      task_type: "requirements",
      is_supervisor: false,
      is_developer: true,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": r2.token as string });
    const inherited = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: false,
      is_developer: true,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": r2.token as string });

    expect(c1.ok).toBe(true);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.tip).toContain("task_type mismatch");
    expect(inherited.ok).toBe(true);
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("rejects a complete workflow without a supervisor", async () => {
    const task = resolve(TEST_WORK_DIR, "pairflow-no-supervisor-task.md");
    await writeFile(task, "# no supervisor task", "utf-8");
    const r1 = await mcpRequest("register", { identity: "nosup-a" });
    const r2 = await mcpRequest("register", { identity: "nosup-b" });
    const c1 = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: false,
      is_developer: true,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": r1.token as string });
    const c2 = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: false,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": r2.token as string });

    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(false);
    expect(c2.tip).toContain("exactly one supervisor");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("rejects a complete workflow without a developer", async () => {
    const task = resolve(TEST_WORK_DIR, "pairflow-no-developer-task.md");
    await writeFile(task, "# no developer task", "utf-8");
    const r1 = await mcpRequest("register", { identity: "nodev-a" });
    const r2 = await mcpRequest("register", { identity: "nodev-b" });
    const c1 = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: true,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": r1.token as string });
    const c2 = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: false,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": r2.token as string });

    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(false);
    expect(c2.tip).toContain("exactly one developer");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("allows supervisor and developer responsibilities on the same participant", async () => {
    const task = resolve(TEST_WORK_DIR, "pairflow-combined-role-task.md");
    await writeFile(task, "# combined role task", "utf-8");
    const r1 = await mcpRequest("register", { identity: "combo-a" });
    const r2 = await mcpRequest("register", { identity: "combo-b" });
    const c1 = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: true,
      is_developer: true,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": r1.token as string });
    const c2 = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: false,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": r2.token as string });

    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(true);
    expect(c2.tip).toContain("combo-a（supervisor/developer）");
    expect(c2.tip).toContain("combo-b（reviewer）");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("blocks workflow actions until all recovered participants re-confirm", async () => {
    const task = resolve(TEST_WORK_DIR, "pairflow-incomplete-recovery-task.md");
    const wfId = "20260709191959";
    await writeFile(task, "# incomplete recovery task", "utf-8");
    await seedRecoveredWorkflow(TEST_WORK_DIR, task, wfId, ["rec-a", "rec-b"]);

    const r1 = await mcpRequest("register", { identity: "rec-a" });
    const c1 = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: true,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
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

  it("assigns turn to the new participant after recovering a single submitted identity", async () => {
    const task = resolve(TEST_WORK_DIR, "pairflow-single-participant-recovery-task.md");
    const wfId = "20260709192002";
    await writeFile(task, "# single participant recovery task", "utf-8");
    await seedRecoveredWorkflow(TEST_WORK_DIR, task, wfId, ["recover-old"]);

    const oldIdentity = await mcpRequest("register", { identity: "recover-old" });
    const newIdentity = await mcpRequest("register", { identity: "recover-new" });
    const oldConfirmed = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: true,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": oldIdentity.token as string });
    const newConfirmed = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: false,
      is_developer: true,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": newIdentity.token as string });
    const state = await mcpRequest("get_state", {}, { "x-ai-identity": oldIdentity.token as string });

    expect(oldConfirmed.ok).toBe(true);
    expect(oldConfirmed.recovered).toBe(true);
    expect(newConfirmed.ok).toBe(true);
    expect(state.tip).toContain("等待 recover-new");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("reports unreadable pid files instead of overwriting them", async () => {
    const task = resolve(TEST_WORK_DIR, "pairflow-unreadable-pid-task.md");
    await writeFile(task, "# unreadable pid task", "utf-8");
    await mkdir(`${task}.pid`, { recursive: true });
    const registered = await mcpRequest("register", { identity: "pid-reader" });

    const confirmed = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: true,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": registered.token as string });

    expect(confirmed.ok).toBe(false);
    expect(confirmed.tip).toContain("failed to read pid file");
    await rm(`${task}.pid`, { recursive: true, force: true });
    await rm(task, { force: true });
  });

  it("replaces a readable pid file with an invalid workflow id", async () => {
    const task = resolve(TEST_WORK_DIR, "pairflow-invalid-pid-task.md");
    await writeFile(task, "# invalid pid task", "utf-8");
    await writeFile(`${task}.pid`, "legacy-workflow-id", "utf-8");
    const registered = await mcpRequest("register", { identity: "invalid-pid" });

    const confirmed = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: true,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": registered.token as string });

    expect(confirmed.ok).toBe(true);
    expect(confirmed.recovered).toBe(false);
    expect(confirmed.workflow_id).toMatch(/^\d{14}$/);
    expect(await readFile(`${task}.pid`, "utf-8")).toBe(confirmed.workflow_id);
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("reports recovery archive read errors without creating a new workflow", async () => {
    const task = resolve(TEST_WORK_DIR, "pairflow-invalid-recovery-archive-task.md");
    const wfId = "20260709192003";
    const workflowDir = resolve(TEST_HANDOFF, wfId);
    await writeFile(task, "# invalid recovery archive task", "utf-8");
    await writeFile(`${task}.pid`, wfId, "utf-8");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(resolve(workflowDir, "requirements"), "not a directory", "utf-8");
    const registered = await mcpRequest("register", { identity: "archive-reader" });

    const confirmed = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: true,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": registered.token as string });

    expect(confirmed.ok).toBe(false);
    expect(confirmed.tip).toContain("failed to read recovery archive");
    expect(await readFile(`${task}.pid`, "utf-8")).toBe(wfId);
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
    await rm(workflowDir, { recursive: true, force: true });
  });

  it("enforces role completeness when the final recovered participant re-confirms", async () => {
    const task = resolve(TEST_WORK_DIR, "pairflow-recovery-role-task.md");
    const wfId = "20260709192000";
    await writeFile(task, "# recovery role task", "utf-8");
    await seedRecoveredWorkflow(TEST_WORK_DIR, task, wfId, ["rec-role-a", "rec-role-b"]);

    const r1 = await mcpRequest("register", { identity: "rec-role-a" });
    const r2 = await mcpRequest("register", { identity: "rec-role-b" });
    const c1 = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: false,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": r1.token as string });
    const c2 = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: false,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": r2.token as string });

    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(false);
    expect(c2.tip).toContain("exactly one supervisor");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("enforces work_dir consistency when recovered participants re-confirm", async () => {
    const root = resolve(TEST_WORK_DIR, "pairflow-recovery-workdir-root");
    const nested = resolve(root, "nested");
    const task = resolve(nested, "task.md");
    const wfId = "20260709192001";
    await createGitWorkDir(root);
    await createGitWorkDir(nested);
    await writeFile(task, "# recovery workdir task", "utf-8");
    await seedRecoveredWorkflow(root, task, wfId, ["rec-wd-a", "rec-wd-b"]);

    const r1 = await mcpRequest("register", { identity: "rec-wd-a" });
    const r2 = await mcpRequest("register", { identity: "rec-wd-b" });
    const c1 = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: true,
      is_developer: false,
      work_dir: root,
    }, { "x-ai-identity": r1.token as string });
    const c2 = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: false,
      is_developer: true,
      work_dir: nested,
    }, { "x-ai-identity": r2.token as string });

    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(false);
    expect(c2.tip).toContain("work_dir mismatch");
    await rm(root, { recursive: true, force: true });
  });

  it("starts a new workflow when confirm_task points recovery at a new work_dir", async () => {
    const oldWorkDir = resolve(TEST_WORK_DIR, "pid-workdir-root");
    const newWorkDir = resolve(oldWorkDir, "nested");
    const task = resolve(newWorkDir, "task.md");
    const oldWorkflowId = "20000101000000";
    await createGitWorkDir(oldWorkDir);
    await createGitWorkDir(newWorkDir);
    await writeFile(task, "# moved workdir task", "utf-8");
    await seedRecoveredWorkflow(oldWorkDir, task, oldWorkflowId, ["old-participant"]);

    const registered = await mcpRequest("register", { identity: "new-workdir" });
    const confirmed = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: true,
      is_developer: false,
      work_dir: newWorkDir,
    }, { "x-ai-identity": registered.token as string });

    expect(confirmed.ok).toBe(true);
    expect(confirmed.recovered).toBe(false);
    expect(confirmed.workflow_id).not.toBe(oldWorkflowId);
    expect(await readFile(`${task}.pid`, "utf-8")).toBe(confirmed.workflow_id);
    await rm(oldWorkDir, { recursive: true, force: true });
  });

  it("starts a new workflow when archived task types conflict", async () => {
    const task = resolve(TEST_WORK_DIR, "conflicting-task-type.md");
    const oldWorkflowId = "20000101000001";
    const phaseDir = resolve(TEST_HANDOFF, oldWorkflowId, "requirements");
    await mkdir(phaseDir, { recursive: true });
    await writeFile(task, "# conflicting task type", "utf-8");
    await writeFile(`${task}.pid`, oldWorkflowId, "utf-8");
    await writeFile(resolve(phaseDir, "r1_old-a.meta.json"), JSON.stringify({
      submitted_at: "2026-07-09T10:00:00.000Z",
      commit_hash: "abc1234",
      sub_phase: null,
      task: { spec_file: task, task_type: "requirements" },
    }));
    await writeFile(resolve(phaseDir, "r2_old-b.meta.json"), JSON.stringify({
      submitted_at: "2026-07-09T10:01:00.000Z",
      commit_hash: "def5678",
      sub_phase: null,
      task: { spec_file: task, task_type: "development" },
    }));

    const registered = await mcpRequest("register", { identity: "task-type-conflict" });
    const confirmed = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: true,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": registered.token as string });

    expect(confirmed.ok).toBe(true);
    expect(confirmed.recovered).toBe(false);
    expect(confirmed.workflow_id).not.toBe(oldWorkflowId);
    expect(await readFile(`${task}.pid`, "utf-8")).toBe(confirmed.workflow_id);
    expect(await readFile(resolve(phaseDir, "r1_old-a.meta.json"), "utf-8")).toContain("requirements");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });

  it("skips planning and implementation for requirements-only workflows", async () => {
    const task = resolve(TEST_WORK_DIR, "pairflow-requirements-only-task.md");
    await writeFile(task, "# requirements only task", "utf-8");
    const r1 = await mcpRequest("register", { identity: "req-sup" });
    const r2 = await mcpRequest("register", { identity: "req-dev" });
    const c1 = await mcpRequest("confirm_task", {
      task_path: task,
      task_type: "requirements",
      is_supervisor: true,
      is_developer: false,
      work_dir: TEST_WORK_DIR,
    }, { "x-ai-identity": r1.token as string });
    const c2 = await mcpRequest("confirm_task", {
      task_path: task,
      is_supervisor: false,
      is_developer: true,
      work_dir: TEST_WORK_DIR,
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
    const blockedAdvance = await mcpRequest("advance", {}, { "x-ai-identity": r1.token as string });
    const devConfirmFile = resolve(TEST_HANDOFF, wfId, "requirements", "r3_req-dev.md");
    await writeFile(devConfirmFile, "# req-dev final confirmation", "utf-8");
    const s3 = await mcpRequest("submit", {
      file_path: devConfirmFile,
      git_commit_hash: "f1e2d3c",
    }, { "x-ai-identity": r2.token as string });
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
    expect(s2.tip).toContain("等待 req-dev");
    expect(blockedAdvance.ok).toBe(false);
    expect(blockedAdvance.tip).toContain("turn 尚未回到监督者");
    expect(s3.ok).toBe(true);
    expect(advanced.ok).toBe(true);
    expect(advanced.new_phase).toBe("summary");
    expect(summary1.ok).toBe(true);
    expect(summary2.ok).toBe(true);
    expect(finished.ok).toBe(true);
    expect(finished.new_phase).toBe("idle");
    expect(finalState.tip).toContain("还未绑定到任何工作流");
    await rm(task, { force: true });
    await rm(`${task}.pid`, { force: true });
  });
});

describe("Wait for turn + submit", () => {
  beforeAll(async () => {
    await startServer();
    await setup();
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
      is_supervisor: true,
      is_developer: true,
      work_dir: TEST_WORK_DIR,
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
  it("explains the accepted git_commit_hash format", async () => {
    const r = await mcpRequest("submit", {
      file_path: resolve(TEST_HANDOFF, workflowId, "requirements", "r1_codebuddy.md"),
      git_commit_hash: "abc123",
    }, { "x-ai-identity": codebuddyToken });
    expect(r.ok).toBe(false);
    expect(r.tip).toContain("7 to 40 hexadecimal characters");
  });
  it("rejects a directory used as the submission file", async () => {
    const archiveFile = resolve(TEST_HANDOFF, workflowId, "requirements", "r1_codebuddy.md");
    await rm(archiveFile, { recursive: true, force: true });
    await mkdir(archiveFile, { recursive: true });
    const r = await mcpRequest("submit", {
      file_path: archiveFile,
      git_commit_hash: "def7654321",
    }, { "x-ai-identity": codebuddyToken });

    expect(r.ok).toBe(false);
    expect(r.tip).toContain("file_path must be a file");
    await rm(archiveFile, { recursive: true, force: true });
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

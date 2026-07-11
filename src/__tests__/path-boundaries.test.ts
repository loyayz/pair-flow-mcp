import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { confirmTask } from "../tools/confirm-task.js";
import { deleteState } from "../state.js";
import { registerToken } from "../token-map.js";

const TEST_ROOT = join(tmpdir(), `pairflow-path-boundaries-${randomUUID()}`);
const WORK_DIR = join(TEST_ROOT, "repo");
const TASK_PATH = join(WORK_DIR, "task.md");

function extra(token: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  return {
    signal: new AbortController().signal,
    requestInfo: { headers: { "x-ai-identity": token } },
  } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

async function confirm(taskPath: string, workDir: string): Promise<Record<string, unknown>> {
  const token = registerToken(`path-${randomUUID()}`);
  const result = await confirmTask({
    task_path: taskPath,
    is_supervisor: true,
    is_developer: false,
    work_dir: workDir,
  }, extra(token));
  const payload = JSON.parse((result.content[0] as { text: string }).text);
  if (typeof payload.workflow_id === "string") deleteState(payload.workflow_id);
  return payload;
}

beforeEach(async () => {
  await mkdir(join(WORK_DIR, ".git"), { recursive: true });
  await writeFile(TASK_PATH, "# task", "utf-8");
});

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("filesystem path boundaries", () => {
  it("rejects a work_dir that is a symbolic link", async () => {
    const linkedWorkDir = join(TEST_ROOT, "linked-repo");
    await symlink(WORK_DIR, linkedWorkDir, process.platform === "win32" ? "junction" : "dir");

    const result = await confirm(join(linkedWorkDir, "task.md"), linkedWorkDir);

    expect(result.ok).toBe(false);
    expect(result.tip).toContain("work_dir must not contain symbolic links");
  });

  it("rejects symbolic links in parent components of work_dir", async () => {
    const actualParent = join(TEST_ROOT, "actual-parent");
    const actualWorkDir = join(actualParent, "nested-repo");
    const linkedParent = join(TEST_ROOT, "linked-parent");
    const linkedWorkDir = join(linkedParent, "nested-repo");
    await mkdir(join(actualWorkDir, ".git"), { recursive: true });
    await writeFile(join(actualWorkDir, "task.md"), "# linked parent task", "utf-8");
    await symlink(actualParent, linkedParent, process.platform === "win32" ? "junction" : "dir");

    const result = await confirm(join(linkedWorkDir, "task.md"), linkedWorkDir);

    expect(result.ok).toBe(false);
    expect(result.tip).toContain("work_dir must not contain symbolic links");
    expect(result.tip).toContain(linkedParent.replace(/\\/g, "/"));
  });

  it("rejects a symbolic .git marker", async () => {
    const gitTarget = join(TEST_ROOT, "git-target");
    await rm(join(WORK_DIR, ".git"), { recursive: true, force: true });
    await mkdir(gitTarget, { recursive: true });
    await symlink(gitTarget, join(WORK_DIR, ".git"), process.platform === "win32" ? "junction" : "dir");

    const result = await confirm(TASK_PATH, WORK_DIR);

    expect(result.ok).toBe(false);
    expect(result.tip).toContain("Git marker must not be a symbolic link");
  });

  it("rejects symbolic links in the task_path below work_dir", async () => {
    const outsideDirectory = join(TEST_ROOT, "outside");
    const linkedDirectory = join(WORK_DIR, "linked");
    const linkedTask = join(linkedDirectory, "task.md");
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(join(outsideDirectory, "task.md"), "# outside task", "utf-8");
    await symlink(outsideDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");

    const result = await confirm(linkedTask, WORK_DIR);

    expect(result.ok).toBe(false);
    expect(result.tip).toContain("symbolic links are not allowed in task_path");
    expect(result.tip).toContain(linkedDirectory.replace(/\\/g, "/"));
  });

  it("rejects a symbolic pid path instead of reading through it", async () => {
    const pidTarget = join(TEST_ROOT, "pid-target");
    await mkdir(pidTarget, { recursive: true });
    await symlink(pidTarget, `${TASK_PATH}.pid`, process.platform === "win32" ? "junction" : "dir");

    const result = await confirm(TASK_PATH, WORK_DIR);

    expect(result.ok).toBe(false);
    expect(result.tip).toContain("pid file must not be a symbolic link");
  });
});

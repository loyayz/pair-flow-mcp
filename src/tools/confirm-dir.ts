import { readdir, readFile } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseIdentity } from "../identity.js";
import { loadState, isSupervisor } from "../state.js";
import { err, ok } from "../response.js";
import { isWorkflowComplete } from "../crash-recovery.js";

export async function confirmDir(
  args: Record<string, unknown>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): Promise<CallToolResult> {
  const identity = parseIdentity(extra.requestInfo?.headers);
  if (identity === "unknown") return err("identity required");

  const workDir = args.work_dir as string;
  if (!workDir) return err("work_dir is required");

  const state = await loadState();
  if (!isSupervisor(state, identity)) return err("only supervisor can confirm directory");
  if (state.phase !== "idle") return err("confirm_dir only allowed in IDLE phase");

  const incomplete = await scanIncompleteWorkflows(workDir);
  const statusLine = `[当前] 你是 ${identity}（supervisor）。`;
  const MAX_SHOW = 5;

  if (incomplete.length > 0) {
    const shown = incomplete.slice(0, MAX_SHOW);
    const more = incomplete.length > MAX_SHOW ? ` ...等 ${incomplete.length} 个` : "";
    const idList = shown.map((w) => {
      const taskHint = w.task_path ? ` (任务: ${w.task_path})` : "";
      return `${w.id}${taskHint}`;
    }).join(", ");
    const tip = `[行动] 发现 ${incomplete.length} 个未完成工作流: ${idList}${more}。请询问用户选择: A) 恢复某个未完成工作流 → 以对应的任务文档绝对路径调用 confirm_task；B) 新建工作流 → 以新任务文档绝对路径调用 confirm_task。\n\n${statusLine}`;
    return ok({ work_dir: workDir, incomplete_workflows: incomplete }, tip);
  }

  const tip = `[行动] 无未完成工作流。请询问用户要处理的任务文档路径（绝对路径），拿到后调用 confirm_task。\n\n${statusLine}`;
  return ok({ work_dir: workDir, incomplete_workflows: incomplete }, tip);
}

async function scanIncompleteWorkflows(workDir: string): Promise<Array<{id: string, task_path: string | null}>> {
  const incomplete: Array<{id: string, task_path: string | null}> = [];
  const handoffDir = process.env.HANDOFF_DIR || "handoff";
  try {
    const entries = await readdir(handoffDir, { withFileTypes: true });
    const wfDirs = entries.filter((e) => e.isDirectory() && /^\d{14}$/.test(e.name));
    for (const d of wfDirs) {
      // Complete = summary/ directory exists with files
      if (await isWorkflowComplete(d.name)) continue;

      // Try to extract task_path from meta.json in any phase subdirectory
      let taskPath: string | null = null;
      for (const phase of ["requirements", "planning", "implementation", "summary"]) {
        try {
          const phaseDir = `${handoffDir}/${d.name}/${phase}`;
          const pEntries = await readdir(phaseDir, { withFileTypes: true });
          const metaFile = pEntries.find((e) => e.isFile() && e.name.endsWith(".meta.json"));
          if (metaFile) {
            const metaRaw = await readFile(`${phaseDir}/${metaFile.name}`, "utf-8");
            const meta = JSON.parse(metaRaw);
            if (meta.task?.spec_file) {
              taskPath = meta.task.spec_file;
              break;
            }
          }
        } catch { /* phase dir may not exist */ }
      }

      // Only report as incomplete if .pid file still exists and matches this workflow
      if (taskPath) {
        // Defense-in-depth: taskPath comes from meta.json on disk, guard against traversal
        if (taskPath.includes("..")) continue;
        try {
          const pidRaw = (await readFile(`${taskPath}.pid`, "utf-8")).trim();
          if (pidRaw !== d.name) continue; // .pid points to a different workflow
        } catch {
          continue; // .pid does not exist — task already unbound
        }
      }

      incomplete.push({ id: d.name, task_path: taskPath });
    }
  } catch { /* handoff dir doesn't exist */ }
  return incomplete;
}

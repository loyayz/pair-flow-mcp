import { readdir, readFile } from "node:fs/promises";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { parseIdentity } from "../identity.js";
import { loadState, isSupervisor } from "../state.js";
import { err, ok } from "../response.js";

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
  const identityInfo = `当前身份: ${identity}(supervisor)`;
  const MAX_SHOW = 5;

  if (incomplete.length > 0) {
    const shown = incomplete.slice(0, MAX_SHOW);
    const more = incomplete.length > MAX_SHOW ? ` ...等 ${incomplete.length} 个` : "";
    const idList = shown.map((w) => {
      const taskHint = w.task_path ? ` (任务: ${w.task_path})` : "";
      return `${w.id}${taskHint}`;
    }).join(", ");
    const tip = `${identityInfo}。发现 ${incomplete.length} 个未完成工作流: ${idList}${more}。请询问用户选择: A) 恢复某个未完成工作流 → 以对应的任务文档路径调用 confirm_task；B) 新建工作流 → 以新任务文档路径调用 confirm_task。`;
    return ok({ work_dir: workDir, incomplete_workflows: incomplete }, tip);
  }

  const tip = `${identityInfo}。无未完成工作流。下一步调用 confirm_task 确认任务文档。`;
  return ok({ work_dir: workDir, incomplete_workflows: incomplete }, tip);
}

async function scanIncompleteWorkflows(workDir: string): Promise<Array<{id: string, task_path: string | null}>> {
  const incomplete: Array<{id: string, task_path: string | null}> = [];
  const handoffDir = process.env.HANDOFF_DIR || "handoff";
  try {
    const entries = await readdir(handoffDir, { withFileTypes: true });
    const wfDirs = entries.filter((e) => e.isDirectory() && /^\d{14}$/.test(e.name));
    for (const d of wfDirs) {
      try {
        const summaryDir = `${handoffDir}/${d.name}/summary`;
        const sEntries = await readdir(summaryDir);
        if (sEntries.some((e) => e.includes("_final.md"))) {
          continue; // completed workflow
        }
      } catch { /* no summary dir → incomplete */ }
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
      incomplete.push({ id: d.name, task_path: taskPath });
    }
  } catch { /* handoff dir doesn't exist */ }
  return incomplete;
}

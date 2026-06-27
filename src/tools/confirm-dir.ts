import { readdir } from "node:fs/promises";
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

  const tip = incomplete.length > 0
    ? `下一步调用 confirm_task 确认任务文档。未完成的工作流: ${incomplete.join(", ")}`
    : "下一步调用 confirm_task 确认任务文档";

  return ok({ work_dir: workDir, incomplete_workflows: incomplete }, tip);
}

async function scanIncompleteWorkflows(workDir: string): Promise<string[]> {
  const incomplete: string[] = [];
  const handoffDir = process.env.HANDOFF_DIR || "handoff";
  try {
    const entries = await readdir(handoffDir, { withFileTypes: true });
    const wfDirs = entries.filter((e) => e.isDirectory() && /^\d{14}$/.test(e.name));
    for (const d of wfDirs) {
      try {
        const summaryDir = `${handoffDir}/${d.name}/summary`;
        const sEntries = await readdir(summaryDir);
        if (!sEntries.some((e) => e.includes("_final.md"))) {
          incomplete.push(d.name);
        }
      } catch {
        incomplete.push(d.name);
      }
    }
  } catch { /* handoff dir doesn't exist */ }
  return incomplete;
}

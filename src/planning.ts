import { readFile } from "node:fs/promises";
import { join } from "node:path";

const HANDOFF_DIR = "handoff";

/**
 * Extract cycle count from planning draft.
 * Searches handoff/{workflow_id}/planning/ for the r1 review document
 * and parses the '## 实施里程碑' section for '循环总数: N'.
 * Returns the count or null if not found.
 */
export async function extractCycleCount(workflowId: string): Promise<number | null> {
  try {
    const planningDir = join(HANDOFF_DIR, workflowId, "planning");
    const entries = await import("node:fs/promises").then(fs => fs.readdir(planningDir));
    // Find r1 document (first planning round)
    const r1File = entries.find((e) => e.startsWith("r1_") && e.endsWith(".md") && !e.includes(".meta"));
    if (!r1File) return null;

    const content = await readFile(join(planningDir, r1File), "utf-8");
    // Parse "## 实施里程碑" section for "循环总数: N"
    const match = content.match(/循环总数[：:]\s*(\d+)/i);
    if (match) {
      return parseInt(match[1], 10);
    }
    return null;
  } catch {
    return null;
  }
}

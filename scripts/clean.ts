/**
 * PairFlow handoff cleanup script.
 *
 * Scans handoff/ for orphan workflow directories lacking summary/_final.md,
 * reports on them, and optionally removes them.
 *
 * Usage:
 *   npx tsx scripts/clean.ts --dry-run    # Scan and report only
 *   npx tsx scripts/clean.ts --force      # Delete orphan workflows
 */

import { readdir, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { resolve, join } from "node:path";

const HANDOFF_DIR = process.env.HANDOFF_DIR || "handoff";

interface WorkflowInfo {
  name: string;
  phaseCount: number;
  fileCount: number;
  totalBytes: number;
  hasSummary: boolean;
  hasFinal: boolean;
}

async function scanWorkflows(): Promise<WorkflowInfo[]> {
  const results: WorkflowInfo[] = [];
  try {
    const entries = await readdir(HANDOFF_DIR, { withFileTypes: true });
    const wfDirs = entries.filter((e) => e.isDirectory() && /^\d{14}$/.test(e.name));

    for (const d of wfDirs) {
      const wfPath = join(HANDOFF_DIR, d.name);
      let phaseCount = 0;
      let fileCount = 0;
      let totalBytes = 0;
      let hasSummary = false;
      let hasFinal = false;

      try {
        // Node.js 24: readdir({recursive:true}) returns parentPath as absolute — use it correctly
        const allEntries = await readdir(wfPath, { withFileTypes: true, recursive: true });
        const phaseDirs = new Set<string>();

        for (const e of allEntries) {
          if (e.isFile()) {
            fileCount++;
            const parentPath = (e as { parentPath?: string }).parentPath;
            // parentPath is absolute on Node 24 — extract relative dir from wfPath
            if (parentPath) {
              const relDir = parentPath.startsWith(resolve(wfPath))
                ? parentPath.slice(resolve(wfPath).length).replace(/^[\\/]/, "")
                : parentPath;
              if (relDir) phaseDirs.add(relDir.split(/[\\/]/)[0]);
            }
            try {
              const filePath = parentPath ? join(parentPath, e.name) : join(wfPath, e.name);
              totalBytes += statSync(filePath).size;
            } catch { /* skip stat failures */ }
          }
        }

        phaseCount = phaseDirs.size;
        hasSummary = phaseDirs.has("summary");

        // Check for _final.md in summary
        if (hasSummary) {
          const summaryEntries = await readdir(join(wfPath, "summary")).catch(() => [] as string[]);
          hasFinal = summaryEntries.some((e) => e.includes("_final.md"));
        }

        results.push({ name: d.name, phaseCount, fileCount, totalBytes, hasSummary, hasFinal });
      } catch {
        // Can't read workflow dir — skip
      }
    }
  } catch {
    console.log("No handoff directory found.");
  }

  // Sort by name (newest first)
  results.sort((a, b) => b.name.localeCompare(a.name));
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");

  if (!dryRun && !force) {
    console.log("Usage: npx tsx scripts/clean.ts [--dry-run | --force]");
    console.log("  --dry-run   Scan and report orphan workflows (no deletion)");
    console.log("  --force     Delete orphan workflows");
    process.exit(1);
  }

  const workflows = await scanWorkflows();

  if (workflows.length === 0) {
    console.log("No handoff workflows found.");
    return;
  }

  const complete = workflows.filter((w) => w.hasFinal);
  const orphans = workflows.filter((w) => !w.hasFinal);
  const totalOrphanBytes = orphans.reduce((sum, w) => sum + w.totalBytes, 0);

  console.log(`\n=== PairFlow Handoff Scan ===`);
  console.log(`Total workflows: ${workflows.length} | Complete: ${complete.length} | Orphan: ${orphans.length}`);
  if (orphans.length === 0) {
    console.log("No orphan workflows to clean.");
    return;
  }

  console.log(`\nOrphan workflows (no summary/_final.md):`);
  for (const w of orphans) {
    const kb = (w.totalBytes / 1024).toFixed(1);
    console.log(`  ${w.name} — ${w.phaseCount} phases, ${w.fileCount} files, ${kb} KB`);
  }
  console.log(`\nTotal orphan size: ${(totalOrphanBytes / 1024).toFixed(1)} KB`);

  if (dryRun) {
    console.log("\n[DRY-RUN] No files deleted. Run with --force to delete.");
    return;
  }

  if (force) {
    console.log("\nDeleting orphan workflows...");
    for (const w of orphans) {
      try {
        await rm(join(HANDOFF_DIR, w.name), { recursive: true, force: true });
        console.log(`  ✓ Deleted: ${w.name}`);
      } catch (err) {
        console.error(`  ✗ Failed to delete ${w.name}:`, err);
      }
    }
    console.log("\nCleanup complete.");
  }
}

main().catch((err) => {
  console.error("Clean script error:", err);
  process.exit(1);
});

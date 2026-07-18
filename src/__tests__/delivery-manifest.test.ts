import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { deliveryManifestSchema, type DeliveryManifest } from "../delivery-manifest-schema.js";
import { readDeliveryManifest, validateInProgressManifestArtifacts } from "../delivery-manifest.js";

const roots: string[] = [];

function posix(path: string): string {
  return path.replace(/\\/g, "/");
}

function testRoot(): string {
  const root = join(tmpdir(), `pairflow-manifest-${randomUUID()}`);
  roots.push(root);
  return root;
}

function inProgressManifest(root: string, workflowId = "20260719010000"): DeliveryManifest {
  const archiveRoot = posix(join(root, "handoff", workflowId));
  return {
    manifest_version: 1,
    status: "in_progress",
    workflow_id: workflowId,
    task_type: "development",
    archive_root: archiveRoot,
    supervisor: "alice",
    phases: {
      requirements: {
        phase: "requirements",
        advanced_by: "alice",
        accepted_at: "2026-07-19T01:00:00.000Z",
        acceptance_commit: "abc1234",
        final_submission: {
          round: 2,
          submitted_by: "alice",
          commit_hash: "abc1234",
          file_path: `${archiveRoot}/requirements/r2_alice.md`,
        },
      },
    },
    commit_verification: "caller_declared_unverified",
  };
}

function completedRequirementsManifest(root: string, workflowId = "20260719010001"): DeliveryManifest {
  const archiveRoot = posix(join(root, "handoff", workflowId));
  const finalSummary = {
    round: 1,
    submitted_by: "alice",
    commit_hash: "def5678",
    file_path: `${archiveRoot}/summary/r1_alice.md`,
  };
  return {
    manifest_version: 1,
    status: "completed",
    workflow_id: workflowId,
    task_type: "requirements",
    archive_root: archiveRoot,
    supervisor: "alice",
    phases: {
      requirements: {
        phase: "requirements",
        advanced_by: "alice",
        accepted_at: "2026-07-19T01:00:00.000Z",
        acceptance_commit: "abc1234",
        final_submission: {
          round: 2,
          submitted_by: "alice",
          commit_hash: "abc1234",
          file_path: `${archiveRoot}/requirements/r2_alice.md`,
        },
      },
      summary: {
        phase: "summary",
        advanced_by: "alice",
        accepted_at: "2026-07-19T01:10:00.000Z",
        acceptance_commit: "def5678",
        final_summary: finalSummary,
      },
    },
    completed_at: "2026-07-19T01:10:00.000Z",
    completed_by: "alice",
    final_summary: finalSummary,
    commit_verification: "caller_declared_unverified",
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("delivery manifest v1 invariants", () => {
  it("rejects an in-progress summary acceptance", () => {
    const root = testRoot();
    const manifest = completedRequirementsManifest(root);
    expect(() => deliveryManifestSchema.parse({
      ...manifest,
      status: "in_progress",
      completed_at: undefined,
      completed_by: undefined,
      final_summary: undefined,
    })).toThrow(/in-progress manifest cannot contain summary/i);
  });

  it("rejects invalid reference semantics and non-POSIX paths", () => {
    const manifest = inProgressManifest(testRoot());
    expect(() => deliveryManifestSchema.parse({
      ...manifest,
      phases: {
        ...manifest.phases,
        planning: {
          phase: "planning",
          advanced_by: "alice",
          accepted_at: "2026-07-19T01:05:00.000Z",
          acceptance_commit: "def5678",
          canonical_plan: {
            round: 2,
            submitted_by: "bob",
            commit_hash: "def5678",
            file_path: "C:\\project\\handoff\\plan.md",
          },
        },
      },
    })).toThrow();
  });

  it("rejects an in-progress planning record without accepted requirements", () => {
    const manifest = inProgressManifest(testRoot());
    expect(() => deliveryManifestSchema.parse({
      ...manifest,
      phases: {
        requirements: undefined,
        planning: {
          phase: "planning",
          advanced_by: "alice",
          accepted_at: "2026-07-19T01:05:00.000Z",
          acceptance_commit: "def5678",
          canonical_plan: {
            round: 1,
            submitted_by: "alice",
            commit_hash: "def5678",
            file_path: "C:/repo/handoff/20260719010000/planning/r1_alice.md",
          },
        },
      },
    })).toThrow(/requires requirements acceptance/i);
  });
});

describe("delivery manifest recovery validation", () => {
  it("accepts an in-progress accepted artifact without requiring its meta sidecar", async () => {
    const root = testRoot();
    const manifest = inProgressManifest(root);
    const artifact = join(root, "handoff", manifest.workflow_id, "requirements", "r2_alice.md");
    await mkdir(join(root, "handoff", manifest.workflow_id, "requirements"), { recursive: true });
    await writeFile(artifact, "# accepted requirements\n", "utf-8");

    await expect(validateInProgressManifestArtifacts(root, manifest.workflow_id, manifest)).resolves.toBeUndefined();
  });

  it("rejects a missing accepted artifact and a cross-workflow reference", async () => {
    const root = testRoot();
    const manifest = inProgressManifest(root);
    await mkdir(join(root, "handoff", manifest.workflow_id), { recursive: true });

    await expect(validateInProgressManifestArtifacts(root, manifest.workflow_id, manifest))
      .rejects.toThrow(/failed to validate accepted requirements artifact/i);

    const conflicting = structuredClone(manifest);
    conflicting.phases.requirements!.final_submission.file_path = posix(join(root, "handoff", "20260719019999", "requirements", "r2_alice.md"));
    await expect(validateInProgressManifestArtifacts(root, manifest.workflow_id, conflicting))
      .rejects.toThrow(/conflicts with its submission reference/i);
  });

  it("reads a completed manifest even when all referenced external artifacts are absent", async () => {
    const root = testRoot();
    const manifest = completedRequirementsManifest(root);
    const workflowRoot = join(root, "handoff", manifest.workflow_id);
    await mkdir(workflowRoot, { recursive: true });
    await writeFile(join(workflowRoot, "delivery-manifest.json"), JSON.stringify(manifest), "utf-8");

    const persisted = await readDeliveryManifest(root, manifest.workflow_id, "development");

    expect(persisted?.manifest.status).toBe("completed");
    expect(persisted?.manifest.final_summary).toEqual(manifest.final_summary);
  });

  it("compares manifest archive paths using host case semantics without rewriting stored paths", async () => {
    const root = testRoot();
    const manifest = completedRequirementsManifest(root);
    const workflowRoot = join(root, "handoff", manifest.workflow_id);
    manifest.archive_root = manifest.archive_root.toUpperCase();
    manifest.phases.requirements!.final_submission.file_path = manifest.phases.requirements!.final_submission.file_path.toUpperCase();
    manifest.phases.summary!.final_summary.file_path = manifest.phases.summary!.final_summary.file_path.toUpperCase();
    manifest.final_summary = manifest.phases.summary!.final_summary;
    await mkdir(workflowRoot, { recursive: true });
    await writeFile(join(workflowRoot, "delivery-manifest.json"), JSON.stringify(manifest), "utf-8");

    if (process.platform === "win32") {
      const persisted = await readDeliveryManifest(root, manifest.workflow_id);
      expect(persisted?.manifest.archive_root).toBe(manifest.archive_root);
      expect(persisted?.manifest.final_summary?.file_path).toBe(manifest.final_summary.file_path);
    } else {
      await expect(readDeliveryManifest(root, manifest.workflow_id))
        .rejects.toThrow(/delivery manifest archive_root mismatch/i);
    }
  });

  it("rejects a completed manifest whose self-contained reference escapes its archive path", async () => {
    const root = testRoot();
    const manifest = completedRequirementsManifest(root);
    const workflowRoot = join(root, "handoff", manifest.workflow_id);
    manifest.final_summary!.file_path = posix(join(root, "outside", "summary.md"));
    await mkdir(workflowRoot, { recursive: true });
    await writeFile(join(workflowRoot, "delivery-manifest.json"), JSON.stringify(manifest), "utf-8");

    await expect(readDeliveryManifest(root, manifest.workflow_id, "requirements"))
      .rejects.toThrow(/manifest summary file_path conflicts with its submission reference/i);
  });

  it("rejects a manifest reached through a linked archive ancestor", async () => {
    const root = testRoot();
    const outside = testRoot();
    const manifest = completedRequirementsManifest(root);
    const outsideWorkflow = join(outside, manifest.workflow_id);
    await mkdir(outsideWorkflow, { recursive: true });
    await writeFile(join(outsideWorkflow, "delivery-manifest.json"), JSON.stringify(manifest), "utf-8");
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, "handoff"), process.platform === "win32" ? "junction" : "dir");

    await expect(readDeliveryManifest(root, manifest.workflow_id, "requirements"))
      .rejects.toThrow(/symbolic links are not allowed in delivery manifest path/i);
  });
});

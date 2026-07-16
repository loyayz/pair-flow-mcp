import { z } from "zod";

export const submissionReferenceSchema = z.object({
  round: z.number().int().positive(),
  submitted_by: z.string().min(1),
  commit_hash: z.string().regex(/^[0-9a-f]{7,40}$/),
  file_path: z.string().min(1),
  sub_phase: z.enum(["coding", "review"]).optional(),
}).strict();

const acceptanceBase = {
  phase: z.enum(["requirements", "planning", "implementation", "summary"]),
  advanced_by: z.string().min(1),
  accepted_at: z.iso.datetime(),
  acceptance_commit: z.string().regex(/^[0-9a-f]{7,40}$/),
};

export const requirementsAcceptanceSchema = z.object({
  ...acceptanceBase,
  phase: z.literal("requirements"),
  final_submission: submissionReferenceSchema,
}).strict();
export const planningAcceptanceSchema = z.object({
  ...acceptanceBase,
  phase: z.literal("planning"),
  canonical_plan: submissionReferenceSchema,
}).strict();
export const implementationAcceptanceSchema = z.object({
  ...acceptanceBase,
  phase: z.literal("implementation"),
  coding_submission: submissionReferenceSchema,
  review_submission: submissionReferenceSchema,
}).strict();
export const summaryAcceptanceSchema = z.object({
  ...acceptanceBase,
  phase: z.literal("summary"),
  final_summary: submissionReferenceSchema,
  review_submission: submissionReferenceSchema.optional(),
}).strict();

export const workflowCompletionSnapshotSchema = z.object({
  manifest_path: z.string().min(1),
  archive_root: z.string().min(1),
  final_summary: submissionReferenceSchema,
}).strict();

export const deliveryManifestSchema = z.object({
  manifest_version: z.literal(1),
  status: z.enum(["in_progress", "completed"]),
  workflow_id: z.string().min(1),
  task_type: z.enum(["requirements", "development"]),
  archive_root: z.string().min(1),
  supervisor: z.string().min(1),
  phases: z.object({
    requirements: requirementsAcceptanceSchema.optional(),
    planning: planningAcceptanceSchema.optional(),
    implementation: implementationAcceptanceSchema.optional(),
    summary: summaryAcceptanceSchema.optional(),
  }).strict(),
  completed_at: z.iso.datetime().optional(),
  completed_by: z.string().min(1).optional(),
  final_summary: submissionReferenceSchema.optional(),
  commit_verification: z.literal("caller_declared_unverified"),
}).strict().superRefine((manifest, ctx) => {
  if (manifest.task_type === "requirements" && (manifest.phases.planning || manifest.phases.implementation)) {
    ctx.addIssue({ code: "custom", message: "requirements tasks cannot contain planning or implementation" });
  }
  if (manifest.status === "completed") {
    if (!manifest.completed_at || !manifest.completed_by || !manifest.final_summary || !manifest.phases.summary) {
      ctx.addIssue({ code: "custom", message: "completed manifest requires completion fields and summary" });
      return;
    }
    if (JSON.stringify(manifest.final_summary) !== JSON.stringify(manifest.phases.summary.final_summary)) {
      ctx.addIssue({ code: "custom", message: "final_summary must equal summary final_summary" });
    }
    if (!manifest.phases.requirements) ctx.addIssue({ code: "custom", message: "completed manifest requires requirements" });
    if (manifest.task_type === "development" && (!manifest.phases.planning || !manifest.phases.implementation)) {
      ctx.addIssue({ code: "custom", message: "completed development manifest requires all phases" });
    }
  } else if (manifest.completed_at || manifest.completed_by || manifest.final_summary) {
    ctx.addIssue({ code: "custom", message: "in-progress manifest cannot contain completion fields" });
  }
});

export type DeliveryManifest = z.infer<typeof deliveryManifestSchema>;
export type SubmissionReference = z.infer<typeof submissionReferenceSchema>;
export type WorkflowCompletionSnapshot = z.infer<typeof workflowCompletionSnapshotSchema>;

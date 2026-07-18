import { z } from "zod";
import { isAbsolute } from "node:path";
import { isValidIdentity } from "./identity.js";

const identitySchema = z.string().refine(isValidIdentity, "identity must be canonical lowercase");
const posixAbsolutePathSchema = z.string().min(1).refine(
  (value) => !value.includes("\\") && isAbsolute(value),
  "path must be an absolute POSIX path",
);

export const submissionReferenceSchema = z.object({
  round: z.number().int().positive(),
  submitted_by: identitySchema,
  commit_hash: z.string().regex(/^[0-9a-f]{7,40}$/),
  file_path: posixAbsolutePathSchema,
  sub_phase: z.enum(["coding", "review"]).optional(),
}).strict();

const acceptanceBase = {
  phase: z.enum(["requirements", "planning", "implementation", "summary"]),
  advanced_by: identitySchema,
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
  manifest_path: posixAbsolutePathSchema,
  archive_root: posixAbsolutePathSchema,
  final_summary: submissionReferenceSchema,
}).strict();

export const deliveryManifestSchema = z.object({
  manifest_version: z.literal(1),
  status: z.enum(["in_progress", "completed"]),
  workflow_id: z.string().regex(/^\d{14}$/),
  task_type: z.enum(["requirements", "development"]),
  archive_root: posixAbsolutePathSchema,
  supervisor: identitySchema,
  phases: z.object({
    requirements: requirementsAcceptanceSchema.optional(),
    planning: planningAcceptanceSchema.optional(),
    implementation: implementationAcceptanceSchema.optional(),
    summary: summaryAcceptanceSchema.optional(),
  }).strict(),
  completed_at: z.iso.datetime().optional(),
  completed_by: identitySchema.optional(),
  final_summary: submissionReferenceSchema.optional(),
  commit_verification: z.literal("caller_declared_unverified"),
}).strict().superRefine((manifest, ctx) => {
  const issue = (message: string, path: PropertyKey[] = []) => ctx.addIssue({ code: "custom", message, path });
  const records = Object.values(manifest.phases).filter((record) => record !== undefined);
  for (const record of records) {
    if (record.advanced_by !== manifest.supervisor) {
      issue(`${record.phase} advanced_by must equal supervisor`, ["phases", record.phase, "advanced_by"]);
    }
  }

  const requirements = manifest.phases.requirements;
  if (requirements?.final_submission.sub_phase !== undefined) {
    issue("requirements reference cannot contain sub_phase", ["phases", "requirements", "final_submission", "sub_phase"]);
  }
  const planning = manifest.phases.planning;
  if (planning) {
    if (planning.canonical_plan.round !== 1) {
      issue("canonical_plan must reference round 1", ["phases", "planning", "canonical_plan", "round"]);
    }
    if (planning.canonical_plan.sub_phase !== undefined) {
      issue("planning reference cannot contain sub_phase", ["phases", "planning", "canonical_plan", "sub_phase"]);
    }
  }
  const implementation = manifest.phases.implementation;
  if (implementation) {
    if (implementation.coding_submission.sub_phase !== "coding" || implementation.coding_submission.round % 2 !== 1) {
      issue("coding_submission must reference an odd coding round", ["phases", "implementation", "coding_submission"]);
    }
    if (implementation.review_submission.sub_phase !== "review" || implementation.review_submission.round % 2 !== 0) {
      issue("review_submission must reference an even review round", ["phases", "implementation", "review_submission"]);
    }
    if (implementation.coding_submission.submitted_by === implementation.review_submission.submitted_by) {
      issue("implementation coding and review must be submitted by different identities", ["phases", "implementation"]);
    }
  }
  const summary = manifest.phases.summary;
  if (summary) {
    if (summary.final_summary.sub_phase !== undefined) {
      issue("summary final reference cannot contain sub_phase", ["phases", "summary", "final_summary", "sub_phase"]);
    }
    if (summary.final_summary.round === 2) {
      issue("summary round 2 is review-only", ["phases", "summary", "final_summary", "round"]);
    }
    if (summary.review_submission) {
      if (summary.review_submission.round !== 2) {
        issue("summary review_submission must reference round 2", ["phases", "summary", "review_submission", "round"]);
      }
      if (summary.review_submission.sub_phase !== undefined) {
        issue("summary review reference cannot contain sub_phase", ["phases", "summary", "review_submission", "sub_phase"]);
      }
    }
  }

  if (manifest.task_type === "requirements" && (manifest.phases.planning || manifest.phases.implementation)) {
    issue("requirements tasks cannot contain planning or implementation", ["phases"]);
  }
  if (manifest.status === "completed") {
    if (!manifest.completed_at || !manifest.completed_by || !manifest.final_summary || !manifest.phases.summary) {
      issue("completed manifest requires completion fields and summary");
      return;
    }
    if (JSON.stringify(manifest.final_summary) !== JSON.stringify(manifest.phases.summary.final_summary)) {
      issue("final_summary must equal summary final_summary", ["final_summary"]);
    }
    if (manifest.completed_by !== manifest.supervisor) issue("completed_by must equal supervisor", ["completed_by"]);
    if (!manifest.phases.requirements) issue("completed manifest requires requirements", ["phases", "requirements"]);
    if (manifest.task_type === "development" && (!manifest.phases.planning || !manifest.phases.implementation)) {
      issue("completed development manifest requires all phases", ["phases"]);
    }
  } else {
    if (manifest.completed_at || manifest.completed_by || manifest.final_summary) {
      issue("in-progress manifest cannot contain completion fields");
    }
    if (manifest.phases.summary) issue("in-progress manifest cannot contain summary", ["phases", "summary"]);
    if (!manifest.phases.requirements) issue("in-progress manifest requires requirements acceptance", ["phases", "requirements"]);
    if (manifest.phases.planning && !manifest.phases.requirements) {
      issue("planning acceptance requires requirements acceptance", ["phases", "planning"]);
    }
    if (manifest.task_type === "development" && manifest.phases.implementation && !manifest.phases.planning) {
      issue("implementation acceptance requires planning acceptance", ["phases", "implementation"]);
    }
  }
});

export type DeliveryManifest = z.infer<typeof deliveryManifestSchema>;
export type SubmissionReference = z.infer<typeof submissionReferenceSchema>;
export type WorkflowCompletionSnapshot = z.infer<typeof workflowCompletionSnapshotSchema>;

import { z } from "zod";
import {
  pairFlowInstructionSchema,
  phaseSchema,
  subPhaseSchema,
} from "./instruction-protocol.js";
import { submissionReferenceSchema } from "./delivery-manifest-schema.js";

const reminderSchema = z.literal("质量优先，完整完成任务目标。");
const guidanceShape = {
  reminder: reminderSchema,
  tip: z.string(),
  instruction: pairFlowInstructionSchema,
};
const rejectionInstructionSchema = pairFlowInstructionSchema.safeExtend({
  next_action: z.literal("fix_request"),
  reason_code: z.literal("REQUEST_REJECTED"),
});
export const businessRejectionSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  reminder: reminderSchema,
  tip: z.string(),
  instruction: rejectionInstructionSchema,
}).strict();

function actionableToolOutputSchema<SuccessShape extends z.ZodRawShape>(
  successShape: SuccessShape,
  validateSuccess?: (payload: z.infer<ReturnType<typeof z.object<SuccessShape>>>, context: z.RefinementCtx) => void,
) {
  const successSchema = z.object({
    ok: z.literal(true),
    ...successShape,
    ...guidanceShape,
  }).strict();

  return z.object({
    ok: z.boolean(),
    error: z.string().optional(),
    ...z.object(successShape).partial().shape,
    ...guidanceShape,
  }).strict().superRefine((payload, context) => {
    const selectedSchema = "ok" in payload && payload.ok === true
      ? successSchema
      : businessRejectionSchema;
    const result = selectedSchema.safeParse(payload);
    if (!result.success) {
      for (const issue of result.error.issues) {
        context.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path,
        });
      }
    }
    const successPayload = payload as Record<string, unknown>;
    if (successPayload.ok === true && validateSuccess) validateSuccess(successPayload as z.infer<ReturnType<typeof z.object<SuccessShape>>>, context);
  });
}

const completionShape = {
  manifest_path: z.string().min(1).optional(),
  archive_root: z.string().min(1).optional(),
  final_summary: submissionReferenceSchema.optional(),
  cleanup_pending: z.boolean().optional(),
  cleanup_error: z.string().min(1).optional(),
};

function completionFieldsForIdle(
  payload: Record<string, unknown>,
  context: z.RefinementCtx,
  phaseField: "new_phase" | "phase",
): void {
  const completed = payload[phaseField] === "idle" && payload.turn === "idle";
  for (const field of ["manifest_path", "archive_root", "final_summary"] as const) {
    if ((payload[field] !== undefined) !== completed) {
      context.addIssue({ code: "custom", path: [field], message: `${field} must be present exactly for idle completion` });
    }
  }
  if ((payload.cleanup_error !== undefined) !== (payload.cleanup_pending === true)) {
    context.addIssue({ code: "custom", path: ["cleanup_error"], message: "cleanup_error must be present exactly when cleanup_pending is true" });
  }
  if (!completed && payload.cleanup_pending !== undefined) {
    context.addIssue({ code: "custom", path: ["cleanup_pending"], message: "cleanup warning is only valid for idle completion" });
  }
}

export const TOOL_OUTPUT_SCHEMAS = {
  ping: z.object({
    ok: z.literal(true),
    uptime: z.number(),
    reminder: reminderSchema,
  }),
  who_am_i: z.object({
    ok: z.literal(true),
    identity: z.string(),
    registered: z.boolean(),
    joined_workflow: z.boolean(),
    is_supervisor: z.boolean().optional(),
    is_developer: z.boolean().optional(),
    workflow_id: z.string().nullable().optional(),
    reminder: reminderSchema,
  }),
  register: actionableToolOutputSchema({
    identity: z.string(),
    token: z.string(),
  }),
  confirm_task: actionableToolOutputSchema({
    task_path: z.string(),
    workflow_id: z.string(),
    phase: phaseSchema,
    recovered: z.boolean(),
  }),
  advance: actionableToolOutputSchema({
    new_phase: phaseSchema,
    turn: z.string(),
    sub_phase: subPhaseSchema.optional(),
    ...completionShape,
  }, (payload, context) => completionFieldsForIdle(payload, context, "new_phase")),
  get_state: actionableToolOutputSchema({
    workflow_id: z.string().optional(),
    phase: phaseSchema.optional(),
    sub_phase: subPhaseSchema.optional(),
    round: z.number().int().optional(),
    turn: z.string().optional(),
  }),
  wait_for_turn: actionableToolOutputSchema({
    turn: z.string(),
    phase: phaseSchema.optional(),
    round: z.number().int().optional(),
    warning: z.string().optional(),
    ...completionShape,
  }, (payload, context) => completionFieldsForIdle(payload, context, "phase")),
  claim_turn: actionableToolOutputSchema({
    turn: z.string(),
    phase: phaseSchema,
    round: z.number().int(),
  }),
  submit: actionableToolOutputSchema({
    next_turn: z.string(),
  }),
} as const;

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
  allowed_tools: z.tuple([]),
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

type InstructionBranch = {
  reason: string;
  action: string;
  allowedTools: readonly string[];
};

function validateInstructionBranch(
  payload: Record<string, unknown>,
  context: z.RefinementCtx,
  branches: readonly InstructionBranch[],
): Record<string, unknown> | null {
  const instruction = payload.instruction as Record<string, unknown>;
  const branch = branches.find((candidate) => candidate.reason === instruction.reason_code
    && candidate.action === instruction.next_action);
  if (!branch) {
    context.addIssue({
      code: "custom",
      path: ["instruction"],
      message: "instruction reason_code and next_action are not valid for this tool success",
    });
    return instruction;
  }
  const allowedTools = instruction.allowed_tools;
  if (!Array.isArray(allowedTools)
    || allowedTools.length !== branch.allowedTools.length
    || allowedTools.some((tool, index) => tool !== branch.allowedTools[index])) {
    context.addIssue({
      code: "custom",
      path: ["instruction", "allowed_tools"],
      message: "instruction allowed_tools do not match this tool success branch",
    });
  }
  return instruction;
}

function validateContextMatches(
  payload: Record<string, unknown>,
  context: z.RefinementCtx,
  mappings: readonly (readonly [topLevel: string, instructionContext: string])[],
  requireContext = true,
): void {
  const instruction = payload.instruction as Record<string, unknown>;
  const workflow = instruction.context;
  if (!workflow || typeof workflow !== "object") {
    if (requireContext) {
      context.addIssue({ code: "custom", path: ["instruction", "context"], message: "instruction context is required for this tool success" });
    }
    return;
  }
  const workflowContext = workflow as Record<string, unknown>;
  for (const [topLevelField, contextField] of mappings) {
    const topLevelValue = payload[topLevelField];
    const contextValue = workflowContext[contextField];
    const equal = topLevelField === "sub_phase"
      ? (topLevelValue ?? null) === (contextValue ?? null)
      : topLevelValue === contextValue;
    if (!equal) {
      context.addIssue({
        code: "custom",
        path: ["instruction", "context", contextField],
        message: `instruction context.${contextField} must match ${topLevelField}`,
      });
    }
  }
}

const WAIT_BRANCHES = [
  { reason: "ROSTER_INCOMPLETE", action: "wait_for_turn", allowedTools: ["wait_for_turn"] },
  { reason: "WAITING_FOR_TURN", action: "wait_for_turn", allowedTools: ["wait_for_turn"] },
  { reason: "TURN_ASSIGNED", action: "claim_turn", allowedTools: ["claim_turn"] },
  { reason: "TURN_READY", action: "advance", allowedTools: ["advance"] },
  { reason: "TURN_READY", action: "produce_and_submit", allowedTools: ["submit"] },
  { reason: "PHASE_READY_FOR_CONVERGENCE_DECISION", action: "decide_convergence", allowedTools: ["advance", "submit"] },
  { reason: "WAIT_TIMEOUT", action: "wait_for_turn", allowedTools: ["wait_for_turn"] },
  { reason: "PARTICIPANT_CONFIRMATION_STALE", action: "report_user", allowedTools: [] },
  { reason: "TURN_UNCLAIMED_STALE", action: "report_user", allowedTools: [] },
  { reason: "WORKFLOW_COMPLETED", action: "stop", allowedTools: [] },
  { reason: "UNSUPPORTED_WORKFLOW_STATE", action: "report_user", allowedTools: [] },
] as const;

const ACTIONABLE_TURN_BRANCHES = WAIT_BRANCHES.filter((branch) =>
  branch.reason === "TURN_READY" || branch.reason === "PHASE_READY_FOR_CONVERGENCE_DECISION");

function validateRegister(payload: Record<string, unknown>, context: z.RefinementCtx): void {
  const instruction = validateInstructionBranch(payload, context, [{
    reason: "REGISTERED_NEEDS_CONFIRMATION",
    action: "confirm_task",
    allowedTools: ["confirm_task"],
  }]);
  if (instruction?.context !== undefined) {
    context.addIssue({ code: "custom", path: ["instruction", "context"], message: "register success must not include workflow context" });
  }
}

function validateConfirmTask(payload: Record<string, unknown>, context: z.RefinementCtx): void {
  validateInstructionBranch(payload, context, [
    { reason: "ROSTER_INCOMPLETE", action: "wait_for_turn", allowedTools: ["wait_for_turn"] },
    { reason: "CONFIRMED_NEEDS_TURN_CLAIM", action: "wait_for_turn", allowedTools: ["wait_for_turn"] },
  ]);
  validateContextMatches(payload, context, [
    ["workflow_id", "workflow_id"],
    ["phase", "phase"],
  ]);
}

function validateClaimTurn(payload: Record<string, unknown>, context: z.RefinementCtx): void {
  validateInstructionBranch(payload, context, ACTIONABLE_TURN_BRANCHES);
  validateContextMatches(payload, context, [
    ["turn", "turn"],
    ["phase", "phase"],
    ["round", "round"],
  ]);
}

function validateSubmit(payload: Record<string, unknown>, context: z.RefinementCtx): void {
  validateInstructionBranch(payload, context, [{
    reason: "SUBMISSION_ACCEPTED",
    action: "wait_for_turn",
    allowedTools: ["wait_for_turn"],
  }]);
  validateContextMatches(payload, context, [["next_turn", "turn"]]);
}

const completionShape = {
  manifest_path: z.string().min(1).optional(),
  archive_root: z.string().min(1).optional(),
  final_summary: submissionReferenceSchema.optional(),
};

const advanceCleanupShape = {
  cleanup_pending: z.boolean().optional(),
  cleanup_error: z.string().min(1).optional(),
};

function completionFieldsForAdvance(
  payload: Record<string, unknown>,
  context: z.RefinementCtx,
): void {
  validateInstructionBranch(payload, context, [
    { reason: "PHASE_ADVANCED", action: "wait_for_turn", allowedTools: ["wait_for_turn"] },
    { reason: "WORKFLOW_COMPLETED", action: "stop", allowedTools: [] },
  ]);
  const completed = payload.instruction !== undefined
    && typeof payload.instruction === "object"
    && (payload.instruction as { reason_code?: unknown }).reason_code === "WORKFLOW_COMPLETED";
  const reason = (payload.instruction as { reason_code?: unknown }).reason_code;
  if (reason !== "PHASE_ADVANCED" && reason !== "WORKFLOW_COMPLETED") {
    context.addIssue({ code: "custom", path: ["instruction", "reason_code"], message: "advance success must report PHASE_ADVANCED or WORKFLOW_COMPLETED" });
  }
  for (const field of ["manifest_path", "archive_root", "final_summary"] as const) {
    if ((payload[field] !== undefined) !== completed) {
      context.addIssue({ code: "custom", path: [field], message: `${field} must be present exactly for WORKFLOW_COMPLETED` });
    }
  }
  if (completed && (payload.new_phase !== "idle" || payload.turn !== "idle")) {
    context.addIssue({ code: "custom", path: ["new_phase"], message: "WORKFLOW_COMPLETED requires idle phase and turn" });
  }
  if (!completed && (payload.new_phase === "idle" || payload.turn === "idle")) {
    context.addIssue({ code: "custom", path: ["new_phase"], message: "only WORKFLOW_COMPLETED may enter idle" });
  }
  if ((payload.cleanup_error !== undefined) !== (payload.cleanup_pending === true)) {
    context.addIssue({ code: "custom", path: ["cleanup_error"], message: "cleanup_error must be present exactly when cleanup_pending is true" });
  }
  if (!completed && (payload.cleanup_pending !== undefined || payload.cleanup_error !== undefined)) {
    context.addIssue({ code: "custom", path: ["cleanup_pending"], message: "cleanup warning is only valid for WORKFLOW_COMPLETED" });
  }
  if (completed) {
    const instruction = payload.instruction as Record<string, unknown>;
    if (instruction.context !== undefined) {
      context.addIssue({ code: "custom", path: ["instruction", "context"], message: "completed advance must not include workflow context" });
    }
  } else {
    validateContextMatches(payload, context, [
      ["new_phase", "phase"],
      ["sub_phase", "sub_phase"],
      ["turn", "turn"],
    ]);
  }
  const implementation = payload.new_phase === "implementation";
  if ((payload.sub_phase !== undefined) !== implementation) {
    context.addIssue({ code: "custom", path: ["sub_phase"], message: "sub_phase must be present exactly when entering implementation" });
  } else if (implementation && payload.sub_phase !== "coding") {
    context.addIssue({ code: "custom", path: ["sub_phase"], message: "implementation advance must enter coding" });
  }
}

function completionFieldsForWait(
  payload: Record<string, unknown>,
  context: z.RefinementCtx,
): void {
  validateInstructionBranch(payload, context, WAIT_BRANCHES);
  const reason = (payload.instruction as { reason_code?: unknown }).reason_code;
  const supportedReasons = new Set([
    "ROSTER_INCOMPLETE",
    "WAITING_FOR_TURN",
    "TURN_ASSIGNED",
    "TURN_READY",
    "PHASE_READY_FOR_CONVERGENCE_DECISION",
    "WAIT_TIMEOUT",
    "PARTICIPANT_CONFIRMATION_STALE",
    "TURN_UNCLAIMED_STALE",
    "WORKFLOW_COMPLETED",
    "UNSUPPORTED_WORKFLOW_STATE",
  ]);
  if (!supportedReasons.has(String(reason))) {
    context.addIssue({ code: "custom", path: ["instruction", "reason_code"], message: "reason_code is not valid for wait_for_turn success" });
  }
  const completed = reason === "WORKFLOW_COMPLETED";
  for (const field of ["manifest_path", "archive_root", "final_summary"] as const) {
    if ((payload[field] !== undefined) !== completed) {
      context.addIssue({ code: "custom", path: [field], message: `${field} must be present exactly for WORKFLOW_COMPLETED` });
    }
  }
  if (completed) {
    if (payload.phase !== "idle" || payload.turn !== "idle") {
      context.addIssue({ code: "custom", path: ["phase"], message: "WORKFLOW_COMPLETED requires idle phase and turn" });
    }
    if (payload.round !== undefined || payload.warning !== undefined) {
      context.addIssue({ code: "custom", path: ["round"], message: "WORKFLOW_COMPLETED must not include round or warning" });
    }
    const instruction = payload.instruction as Record<string, unknown>;
    if (instruction.context !== undefined) {
      context.addIssue({ code: "custom", path: ["instruction", "context"], message: "completed wait must not include workflow context" });
    }
    return;
  }

  if (payload.round === undefined) {
    context.addIssue({ code: "custom", path: ["round"], message: "non-completed wait responses require round" });
  }
  if (reason === "UNSUPPORTED_WORKFLOW_STATE") {
    if (payload.phase !== undefined) {
      context.addIssue({ code: "custom", path: ["phase"], message: "unsupported workflow state must omit phase" });
    }
  } else if (payload.phase === undefined) {
    context.addIssue({ code: "custom", path: ["phase"], message: "wait responses require phase unless workflow state is unsupported" });
  }
  const staleWarning = reason === "PARTICIPANT_CONFIRMATION_STALE" || reason === "TURN_UNCLAIMED_STALE";
  if ((payload.warning !== undefined) !== staleWarning) {
    context.addIssue({ code: "custom", path: ["warning"], message: "warning must be present exactly for stale wait reasons" });
  }
  validateContextMatches(payload, context, [
    ["phase", "phase"],
    ["round", "round"],
    ["turn", "turn"],
  ]);
}

function validateWhoAmI(payload: Record<string, unknown>, context: z.RefinementCtx): void {
  const issue = (field: string, message: string): void => context.addIssue({ code: "custom", path: [field], message });
  if (payload.identity === "unknown") {
    if (payload.registered !== false || payload.joined_workflow !== false) issue("registered", "anonymous identity must be unregistered and unbound");
    for (const field of ["is_supervisor", "is_developer", "workflow_id"] as const) {
      if (payload[field] !== undefined) issue(field, "anonymous identity must not include workflow fields");
    }
    return;
  }
  if (payload.registered !== true) {
    issue("registered", "non-anonymous identity must be registered");
    return;
  }
  if (payload.joined_workflow === false) {
    if (payload.is_supervisor !== false || payload.is_developer !== false || payload.workflow_id !== null) {
      issue("joined_workflow", "registered unbound identity must have false responsibilities and null workflow_id");
    }
    return;
  }
  if (payload.joined_workflow !== true || typeof payload.is_supervisor !== "boolean" || typeof payload.is_developer !== "boolean" || typeof payload.workflow_id !== "string") {
    issue("joined_workflow", "joined identity requires responsibilities and workflow_id");
  }
}

function validateGetState(payload: Record<string, unknown>, context: z.RefinementCtx): void {
  const reason = (payload.instruction as { reason_code?: unknown }).reason_code;
  const hasBoundState = ["workflow_id", "round", "turn"].every((field) => payload[field] !== undefined);
  if (reason === "WORKFLOW_UNBOUND") {
    validateInstructionBranch(payload, context, [{
      reason: "WORKFLOW_UNBOUND",
      action: "confirm_task",
      allowedTools: ["confirm_task"],
    }]);
    for (const field of ["workflow_id", "phase", "sub_phase", "round", "turn"] as const) {
      if (payload[field] !== undefined) context.addIssue({ code: "custom", path: [field], message: "unbound get_state must not include workflow fields" });
    }
    const instruction = payload.instruction as Record<string, unknown>;
    if (instruction.context !== undefined) {
      context.addIssue({ code: "custom", path: ["instruction", "context"], message: "unbound get_state must not include workflow context" });
    }
    return;
  }
  if (!hasBoundState) {
    context.addIssue({ code: "custom", path: ["workflow_id"], message: "bound get_state requires workflow_id, round, and turn" });
  }
  if (reason === "UNSUPPORTED_WORKFLOW_STATE") {
    validateInstructionBranch(payload, context, WAIT_BRANCHES.filter((branch) => branch.reason === "UNSUPPORTED_WORKFLOW_STATE"));
    for (const field of ["phase", "sub_phase"] as const) {
      if (payload[field] !== undefined) context.addIssue({ code: "custom", path: [field], message: "unsupported get_state must omit phase fields" });
    }
    validateContextMatches(payload, context, [
      ["workflow_id", "workflow_id"],
      ["round", "round"],
      ["turn", "turn"],
    ]);
    return;
  }
  const supportedReasons = new Set([
    "ROSTER_INCOMPLETE",
    "WAITING_FOR_TURN",
    "TURN_ASSIGNED",
    "TURN_READY",
    "PHASE_READY_FOR_CONVERGENCE_DECISION",
  ]);
  if (!supportedReasons.has(String(reason))) {
    context.addIssue({ code: "custom", path: ["instruction", "reason_code"], message: "reason_code is not valid for bound get_state success" });
  }
  validateInstructionBranch(payload, context, WAIT_BRANCHES.filter((branch) => supportedReasons.has(branch.reason)));
  if (payload.phase === undefined || payload.sub_phase === undefined) {
    context.addIssue({ code: "custom", path: ["phase"], message: "supported bound get_state requires phase and sub_phase" });
    return;
  }
  const implementation = payload.phase === "implementation";
  if ((payload.sub_phase !== null) !== implementation) {
    context.addIssue({ code: "custom", path: ["sub_phase"], message: "get_state sub_phase must be non-null exactly for implementation" });
  }
  validateContextMatches(payload, context, [
    ["workflow_id", "workflow_id"],
    ["phase", "phase"],
    ["sub_phase", "sub_phase"],
    ["round", "round"],
    ["turn", "turn"],
  ]);
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
  }).strict().superRefine(validateWhoAmI),
  register: actionableToolOutputSchema({
    identity: z.string(),
    token: z.string(),
  }, validateRegister),
  confirm_task: actionableToolOutputSchema({
    task_path: z.string(),
    workflow_id: z.string(),
    phase: phaseSchema,
    recovered: z.boolean(),
  }, validateConfirmTask),
  advance: actionableToolOutputSchema({
    new_phase: phaseSchema,
    turn: z.string(),
    sub_phase: subPhaseSchema.optional(),
    ...completionShape,
    ...advanceCleanupShape,
  }, completionFieldsForAdvance),
  get_state: actionableToolOutputSchema({
    workflow_id: z.string().optional(),
    phase: phaseSchema.optional(),
    sub_phase: subPhaseSchema.optional(),
    round: z.number().int().positive().optional(),
    turn: z.string().optional(),
  }, validateGetState),
  wait_for_turn: actionableToolOutputSchema({
    turn: z.string(),
    phase: phaseSchema.optional(),
    round: z.number().int().positive().optional(),
    warning: z.string().optional(),
    ...completionShape,
  }, completionFieldsForWait),
  claim_turn: actionableToolOutputSchema({
    turn: z.string(),
    phase: phaseSchema,
    round: z.number().int(),
  }, validateClaimTurn),
  submit: actionableToolOutputSchema({
    next_turn: z.string(),
  }, validateSubmit),
} as const;

import { readFileSync } from "node:fs";
import { z } from "zod";

export function loadServerInfo(moduleUrl: string | URL = import.meta.url): {
  name: "pair-flow";
  version: string;
} {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", moduleUrl), "utf8"),
  ) as unknown;
  const version = packageJson && typeof packageJson === "object"
    ? (packageJson as { version?: unknown }).version
    : undefined;
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error("package.json version must be a non-empty string");
  }
  return { name: "pair-flow", version };
}

export const SERVER_INFO = loadServerInfo();
export const INSTRUCTION_PROTOCOL_VERSION = "1.1" as const;
export const PROTOCOL_HELP = {
  method: "GET",
  path: "/health",
  section: "protocol",
  purpose: "Re-read the instruction protocol when any field or value is unclear",
} as const;

export const instructionActionSchema = z.enum([
  "confirm_task",
  "wait_for_turn",
  "claim_turn",
  "produce_and_submit",
  "decide_convergence",
  "advance",
  "report_user",
  "fix_request",
  "stop",
]);
export const pairFlowToolSchema = z.enum([
  "confirm_task",
  "wait_for_turn",
  "claim_turn",
  "submit",
  "advance",
  "get_state",
]);
export const instructionReasonCodeSchema = z.enum([
  "REGISTERED_NEEDS_CONFIRMATION",
  "WORKFLOW_UNBOUND",
  "ROSTER_INCOMPLETE",
  "CONFIRMED_NEEDS_TURN_CLAIM",
  "WAITING_FOR_TURN",
  "TURN_ASSIGNED",
  "TURN_READY",
  "PHASE_READY_FOR_CONVERGENCE_DECISION",
  "WAIT_TIMEOUT",
  "PARTICIPANT_CONFIRMATION_STALE",
  "TURN_UNCLAIMED_STALE",
  "SUBMISSION_ACCEPTED",
  "PHASE_ADVANCED",
  "WORKFLOW_COMPLETED",
  "UNSUPPORTED_WORKFLOW_STATE",
  "REQUEST_REJECTED",
]);
export const referenceKindSchema = z.enum([
  "task",
  "requirements",
  "plan",
  "previous_output",
  "previous_review",
  "archive",
]);
export const phaseSchema = z.enum([
  "idle",
  "requirements",
  "planning",
  "implementation",
  "summary",
]);
export const subPhaseSchema = z.enum(["coding", "review"]).nullable();

export const protocolHelpSchema = z.object({
  method: z.literal("GET"),
  path: z.literal("/health"),
  section: z.literal("protocol"),
  purpose: z.literal("Re-read the instruction protocol when any field or value is unclear"),
}).strict();

export const instructionReferenceSchema = z.object({
  kind: referenceKindSchema,
  file_path: z.string().min(1),
  required: z.boolean(),
  commit: z.string().optional(),
}).strict();

export const requiredOutputSchema = z.object({
  file_path: z.string().min(1),
  commit_required: z.literal(true),
  submit_tool: z.literal("submit"),
}).strict();

export const instructionContextSchema = z.object({
  workflow_id: z.string().min(1).optional(),
  phase: phaseSchema.optional(),
  sub_phase: subPhaseSchema.optional(),
  round: z.number().int().positive().optional(),
  turn: z.string().min(1).optional(),
  holds_turn: z.boolean().optional(),
  can_advance: z.boolean().optional(),
}).strict();

export const instructionDecisionSchema = z.discriminatedUnion("criterion", [
  z.object({
    criterion: z.literal("phase_goal_met"),
    when_true: z.literal("advance"),
    when_false: z.literal("produce_and_submit"),
  }).strict(),
  z.object({
    criterion: z.literal("user_wants_to_continue_waiting"),
    when_true: z.literal("wait_for_turn"),
    when_false: z.literal("stop"),
  }).strict(),
]);

const instructionCoreSchema = z.object({
  next_action: instructionActionSchema,
  allowed_tools: z.array(pairFlowToolSchema),
  reason_code: instructionReasonCodeSchema,
  context: instructionContextSchema.optional(),
  required_output: requiredOutputSchema.optional(),
  references: z.array(instructionReferenceSchema).optional(),
  decision: instructionDecisionSchema.optional(),
}).strict();

type InstructionCatalogValue = z.infer<typeof instructionCoreSchema>;

function enforceInstructionCatalogRelationships(
  instruction: InstructionCatalogValue,
  context: z.RefinementCtx,
): void {
  const addIssue = (path: PropertyKey[], message: string): void => {
    context.addIssue({ code: "custom", path, message });
  };
  const requiresOutput = instruction.next_action === "produce_and_submit"
    || instruction.next_action === "decide_convergence";
  if ((instruction.required_output !== undefined) !== requiresOutput) {
    addIssue(["required_output"], "required_output must be present exactly for produce_and_submit or decide_convergence");
  }
  const isConvergence = instruction.next_action === "decide_convergence";
  const isStaleReason = instruction.reason_code === "PARTICIPANT_CONFIRMATION_STALE"
    || instruction.reason_code === "TURN_UNCLAIMED_STALE";
  if (isStaleReason && instruction.next_action !== "report_user") {
    addIssue(["next_action"], "stale warning reasons require the report_user action");
  }
  if ((instruction.decision !== undefined) !== (isConvergence || isStaleReason)) {
    addIssue(["decision"], "decision must be present exactly for decide_convergence or a stale warning");
  } else if (isConvergence && instruction.decision?.criterion !== "phase_goal_met") {
    addIssue(["decision", "criterion"], "decide_convergence requires the phase_goal_met decision");
  } else if (isStaleReason && instruction.decision?.criterion !== "user_wants_to_continue_waiting") {
    addIssue(["decision", "criterion"], "stale warnings require the user_wants_to_continue_waiting decision");
  }
  if (instruction.references !== undefined && instruction.references.length === 0) {
    addIssue(["references"], "references must be omitted or non-empty");
  }
  if (instruction.required_output?.file_path.includes("\\")) {
    addIssue(["required_output", "file_path"], "required output paths must use POSIX separators");
  }
  instruction.references?.forEach((reference, index) => {
    if (reference.file_path.includes("\\")) {
      addIssue(["references", index, "file_path"], "reference paths must use POSIX separators");
    }
    if (reference.commit !== undefined && reference.commit !== reference.commit.toLowerCase()) {
      addIssue(["references", index, "commit"], "reference commits must be lowercase");
    }
  });

  const workflow = instruction.context;
  if (!workflow) return;
  for (const field of ["workflow_id", "round", "turn", "holds_turn", "can_advance"] as const) {
    if (workflow[field] === undefined) {
      addIssue(["context", field], `context.${field} is required in a reliable workflow snapshot`);
    }
  }
  if (
    workflow.phase === undefined
    && !(instruction.next_action === "report_user" && instruction.reason_code === "UNSUPPORTED_WORKFLOW_STATE")
  ) {
    addIssue(["context", "phase"], "context.phase may be omitted only for an unsupported workflow state");
  }
  const implementation = workflow.phase === "implementation";
  if ((workflow.sub_phase !== undefined && workflow.sub_phase !== null) !== implementation) {
    addIssue(["context", "sub_phase"], "context.sub_phase must be present exactly for implementation");
  }
  const canAdvance = instruction.next_action === "decide_convergence"
    || (instruction.next_action === "advance" && workflow.phase === "idle");
  if (workflow.can_advance !== canAdvance) {
    addIssue(["context", "can_advance"], "context.can_advance does not match the selected action and phase");
  }
  if (
    (instruction.next_action === "produce_and_submit"
      || instruction.next_action === "decide_convergence"
      || instruction.next_action === "claim_turn"
      || instruction.next_action === "advance")
    && workflow.holds_turn !== true
  ) {
    addIssue(["context", "holds_turn"], "the selected action requires the instruction recipient to hold the turn");
  }
}

export const pairFlowInstructionSchema = instructionCoreSchema.extend({
  protocol_version: z.literal(INSTRUCTION_PROTOCOL_VERSION),
  protocol_help: protocolHelpSchema,
}).superRefine(enforceInstructionCatalogRelationships);

export const instructionInputSchema = instructionCoreSchema
  .superRefine(enforceInstructionCatalogRelationships);

export const guidanceSchema = z.object({
  tip: z.string(),
  instruction: pairFlowInstructionSchema,
}).strict();

export type InstructionAction = z.infer<typeof instructionActionSchema>;
export type PairFlowTool = z.infer<typeof pairFlowToolSchema>;
export type InstructionReasonCode = z.infer<typeof instructionReasonCodeSchema>;
export type ReferenceKind = z.infer<typeof referenceKindSchema>;
export type Phase = z.infer<typeof phaseSchema>;
export type SubPhase = z.infer<typeof subPhaseSchema>;
export type ProtocolHelp = z.infer<typeof protocolHelpSchema>;
export type InstructionReference = z.infer<typeof instructionReferenceSchema>;
export type RequiredOutput = z.infer<typeof requiredOutputSchema>;
export type InstructionContext = z.infer<typeof instructionContextSchema>;
export type InstructionDecision = z.infer<typeof instructionDecisionSchema>;
export type PairFlowInstruction = z.infer<typeof pairFlowInstructionSchema>;
export type InstructionInput = z.infer<typeof instructionInputSchema>;
export type Guidance = z.infer<typeof guidanceSchema>;

type ActionEntry = {
  meaning: string;
  procedure: readonly string[];
};
type ReasonEntry = {
  meaning: string;
  actions: readonly InstructionAction[];
  automatic: boolean;
  report_user: boolean;
};

const actions = {
  confirm_task: {
    meaning: "Confirm the task, repository root, task type, and participant responsibilities.",
    procedure: [
      "Collect task_path, task_type, responsibilities and work_dir from the user.",
      "Always pass task_type; it is required for every confirm_task call.",
      "Call confirm_task with its input schema.",
    ],
  },
  wait_for_turn: {
    meaning: "Synchronize with the assigned turn and receive its actionable instruction; the call returns immediately when this participant already owns the turn.",
    procedure: [
      "Call wait_for_turn even when context.holds_turn is true if the returned instruction selects this action.",
      "On WAIT_TIMEOUT, call wait_for_turn again.",
    ],
  },
  claim_turn: {
    meaning: "Claim the currently assigned turn and receive its complete actionable instruction.",
    procedure: [
      "Call the no-argument claim_turn tool.",
      "Use the complete instruction returned by claim_turn as the authority for the current turn.",
    ],
  },
  produce_and_submit: {
    meaning: "Read required references, produce the required artifact, commit it, and submit it.",
    procedure: [
      "Read references marked required.",
      "Write required_output.file_path.",
      "Commit the artifact.",
      "Call submit using its input schema.",
    ],
  },
  decide_convergence: {
    meaning: "Judge whether the current phase goal is met; the server does not make this content decision.",
    procedure: ["Evaluate decision.criterion.", "Use decision.when_true or decision.when_false."],
  },
  advance: {
    meaning: "Advance the workflow to the next phase.",
    procedure: ["Call advance only when the instruction selects this action."],
  },
  report_user: {
    meaning: "Report the current warning or unsupported state to the user and wait for direction.",
    procedure: [
      "Do not call a workflow action tool automatically.",
      "Show the reason and reliable context to the user.",
    ],
  },
  fix_request: {
    meaning: "Correct a rejected tool request before retrying it.",
    procedure: [
      "Read the business error and the original tool input schema.",
      "Change only arguments proven invalid by the error; do not infer that other arguments are invalid.",
      "Preserve or independently verify remaining arguments, especially values tied to a corrected artifact.",
      "Retry the original tool only after the corrected request satisfies its schema and the current instruction.",
    ],
  },
  stop: {
    meaning: "Stop automatic workflow execution.",
    procedure: [
      "Do not call another workflow action tool.",
      "Report completion or incompatibility when relevant.",
    ],
  },
} satisfies Record<InstructionAction, ActionEntry>;

const reasonCodes = {
  REGISTERED_NEEDS_CONFIRMATION: {
    meaning: "Registration succeeded and task confirmation is required.",
    actions: ["confirm_task"], automatic: true, report_user: false,
  },
  WORKFLOW_UNBOUND: {
    meaning: "The participant token is not bound to a workflow.",
    actions: ["confirm_task"], automatic: true, report_user: false,
  },
  ROSTER_INCOMPLETE: {
    meaning: "The workflow is waiting for the second participant to join.",
    actions: ["wait_for_turn"], automatic: true, report_user: false,
  },
  CONFIRMED_NEEDS_TURN_CLAIM: {
    meaning: "Task confirmation succeeded and the participant must claim its first turn.",
    actions: ["wait_for_turn"], automatic: true, report_user: false,
  },
  WAITING_FOR_TURN: {
    meaning: "The other participant owns the current turn.",
    actions: ["wait_for_turn"], automatic: true, report_user: false,
  },
  TURN_ASSIGNED: {
    meaning: "This participant is assigned the turn and must claim it before acting.",
    actions: ["claim_turn"], automatic: true, report_user: false,
  },
  TURN_READY: {
    meaning: "This participant owns the turn and can perform the instructed current action.",
    actions: ["advance", "produce_and_submit"], automatic: true, report_user: false,
  },
  PHASE_READY_FOR_CONVERGENCE_DECISION: {
    meaning: "Both participants submitted and the supervisor must decide whether the phase goal is met.",
    actions: ["decide_convergence"], automatic: true, report_user: false,
  },
  WAIT_TIMEOUT: {
    meaning: "The current wait_for_turn call reached its timeout without a state transition.",
    actions: ["wait_for_turn"], automatic: true, report_user: false,
  },
  PARTICIPANT_CONFIRMATION_STALE: {
    meaning: "The other participant has not confirmed the task within the warning interval.",
    actions: ["report_user"], automatic: false, report_user: true,
  },
  TURN_UNCLAIMED_STALE: {
    meaning: "The other participant has not claimed its assigned turn within the warning interval.",
    actions: ["report_user"], automatic: false, report_user: true,
  },
  SUBMISSION_ACCEPTED: {
    meaning: "The submission was accepted and the turn was reassigned.",
    actions: ["wait_for_turn"], automatic: true, report_user: false,
  },
  PHASE_ADVANCED: {
    meaning: "The workflow advanced to the next phase; call wait_for_turn to receive the actionable instruction for the assigned turn, whether or not this participant already owns it.",
    actions: ["wait_for_turn"], automatic: true, report_user: false,
  },
  WORKFLOW_COMPLETED: {
    meaning: "The workflow completed normally.",
    actions: ["stop"], automatic: false, report_user: true,
  },
  UNSUPPORTED_WORKFLOW_STATE: {
    meaning: "The server encountered a workflow state that the instruction protocol cannot safely direct.",
    actions: ["report_user"], automatic: false, report_user: true,
  },
  REQUEST_REJECTED: {
    meaning: "A workflow tool request was rejected by business validation.",
    actions: ["fix_request"], automatic: true, report_user: false,
  },
} satisfies Record<InstructionReasonCode, ReasonEntry>;

const fields = {
  protocol_version: "The instruction protocol version used to interpret every field and closed value.",
  protocol_help: "The anonymous HTTP location for re-reading this protocol catalog.",
  "protocol_help.method": "The HTTP method used to re-read the protocol catalog.",
  "protocol_help.path": "The anonymous HTTP path used to re-read the protocol catalog.",
  "protocol_help.section": "The health payload section containing the protocol catalog.",
  "protocol_help.purpose": "The condition under which the protocol catalog must be re-read.",
  next_action: "The authoritative action to perform next.",
  allowed_tools: "The direct MCP tools for the current action, not a complete access-control list.",
  reason_code: "The stable reason that explains why the current action was selected.",
  context: "Reliable workflow state relevant to the current action.",
  "context.workflow_id": "The active workflow identifier when the participant is bound to a workflow.",
  "context.phase": "The current workflow phase.",
  "context.sub_phase": "The current implementation sub-phase when the phase is implementation.",
  "context.round": "The current round number.",
  "context.turn": "The participant identity currently assigned the turn.",
  "context.holds_turn": "Whether the instruction recipient currently owns the turn.",
  "context.can_advance": "Whether state-machine gates permit advance, not whether content has converged.",
  required_output: "The required artifact path and commit requirement; submit parameters still follow the submit input schema.",
  "required_output.file_path": "The exact POSIX-style path where the required artifact must be written.",
  "required_output.commit_required": "Whether the required artifact must be committed before submission.",
  "required_output.submit_tool": "The tool used to submit the required artifact.",
  references: "The available input artifacts relevant to the current action.",
  "references[].kind": "The stable role of a referenced artifact.",
  "references[].file_path": "The POSIX-style path of a referenced artifact.",
  "references[].required": "When true, the referenced input must be read during this turn.",
  "references[].commit": "The lowercase commit hash associated with the referenced artifact when available.",
  decision: "A convergence or wait-continuation decision made by the participant or user; the server does not make this judgment.",
  "decision.criterion": "The criterion the participant or user must evaluate.",
  "decision.when_true": "The legal action when the decision criterion is satisfied.",
  "decision.when_false": "The legal action when the decision criterion is not satisfied.",
} as const;

export const INSTRUCTION_PROTOCOL = Object.freeze({
  name: "pairflow-instruction",
  version: INSTRUCTION_PROTOCOL_VERSION,
  capabilities: ["instruction_v1", "structured_tool_output_v1", "json_response_v1", "delivery_manifest_v1"] as const,
  authority: {
    instruction: "Actions, workflow state, permissions, paths and decision branches",
    tip: "Natural-language thinking, content and quality guidance; do not derive workflow control from tip",
    conflict: "If tip and instruction visibly conflict, stop automatic execution and report a protocol consistency error",
  },
  bootstrap: [
    "Read and validate this protocol declaration",
    "Discover MCP tools and their input/output schemas",
    "Collect identity, task path, task type, responsibilities and work directory from the user; all confirm_task inputs are required",
    "Call register",
    "Use instruction for workflow control and tip for thinking and quality guidance",
  ] as const,
  fields,
  actions,
  reason_codes: reasonCodes,
  unknown_value_policy: {
    reread_health: true,
    tip_control_fallback: false,
    unresolved: "Stop automatic execution and report an incompatible protocol value",
  },
});

type InitializationProtocolProjection = {
  authority: {
    instruction: string;
    tip: string;
    conflict: string;
  };
  unknown_value_policy: {
    reread_health: boolean;
    tip_control_fallback: boolean;
    unresolved: string;
  };
};

type InitializationHelpProjection = {
  method: string;
  path: string;
  section: string;
  purpose: string;
};

export function renderMcpServerInstructions(
  protocol: InitializationProtocolProjection,
  help: InitializationHelpProjection,
): string {
  return [
    `Instruction authority: ${protocol.authority.instruction}.`,
    `Tip authority: ${protocol.authority.tip}.`,
    `Conflict policy: ${protocol.authority.conflict}.`,
    `Protocol help: ${help.method} ${help.path}; read section ${help.section}; purpose: ${help.purpose}.`,
    `Unknown-value policy: reread health=${protocol.unknown_value_policy.reread_health}; tip control fallback=${protocol.unknown_value_policy.tip_control_fallback}; unresolved: ${protocol.unknown_value_policy.unresolved}.`,
  ].join("\n");
}

export function createHealthPayload(uptime: number) {
  return {
    ok: true as const,
    uptime,
    server: SERVER_INFO,
    protocol: INSTRUCTION_PROTOCOL,
  };
}

export const MCP_SERVER_INSTRUCTIONS = renderMcpServerInstructions(INSTRUCTION_PROTOCOL, PROTOCOL_HELP);

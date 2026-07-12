import { renderTip, type TemplateKey } from "./tip-template.js";

// ── Enums ──────────────────────────────────────────────────────────

export type InstructionAction =
  | "confirm_task"
  | "wait_for_turn"
  | "produce_and_submit"
  | "decide_convergence"
  | "advance"
  | "report_user"
  | "fix_request"
  | "stop";

export type PairFlowTool =
  | "confirm_task"
  | "wait_for_turn"
  | "submit"
  | "advance"
  | "get_state";

export type InstructionReasonCode =
  | "REGISTERED_NEEDS_CONFIRMATION"
  | "WORKFLOW_UNBOUND"
  | "ROSTER_INCOMPLETE"
  | "CONFIRMED_NEEDS_TURN_CLAIM"
  | "WAITING_FOR_TURN"
  | "TURN_READY"
  | "PHASE_READY_FOR_CONVERGENCE_DECISION"
  | "WAIT_TIMEOUT"
  | "PARTICIPANT_CONFIRMATION_STALE"
  | "TURN_UNCLAIMED_STALE"
  | "SUBMISSION_ACCEPTED"
  | "PHASE_ADVANCED"
  | "WORKFLOW_COMPLETED"
  | "UNSUPPORTED_WORKFLOW_STATE"
  | "REQUEST_REJECTED";

// ── Instruction types ──────────────────────────────────────────────

export type ReferenceKind =
  | "task"
  | "requirements"
  | "plan"
  | "previous_output"
  | "previous_review"
  | "archive";

export interface InstructionReference {
  kind: ReferenceKind;
  file_path: string;
  required: boolean;
  commit?: string;
}

export interface RequiredOutput {
  file_path: string;
  commit_required: true;
  submit_tool: "submit";
}

export interface InstructionContext {
  workflow_id?: string;
  phase?: "idle" | "requirements" | "planning" | "implementation" | "summary";
  sub_phase?: "coding" | "review" | null;
  round?: number;
  turn?: string;
  holds_turn?: boolean;
  can_advance?: boolean;
}

export interface PairFlowInstruction {
  next_action: InstructionAction;
  allowed_tools: PairFlowTool[];
  reason_code: InstructionReasonCode;
  context?: InstructionContext;
  required_output?: RequiredOutput;
  references?: InstructionReference[];
  decision?: {
    criterion: "phase_goal_met";
    when_true: "advance";
    when_false: "produce_and_submit";
  };
}

// ── Guidance ───────────────────────────────────────────────────────

export interface Guidance {
  tip: string;
  instruction: PairFlowInstruction;
}

export function guidance(
  key: TemplateKey,
  variables: Record<string, string | number>,
  instruction: PairFlowInstruction,
): Guidance {
  return { tip: renderTip(key, variables), instruction };
}

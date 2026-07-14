import {
  INSTRUCTION_PROTOCOL_VERSION,
  PROTOCOL_HELP,
  pairFlowInstructionSchema,
  type Guidance,
  type InstructionInput,
  type PairFlowInstruction,
} from "./instruction-protocol.js";
import { renderTip, type TemplateKey } from "./tip-template.js";

export type {
  Guidance,
  InstructionAction,
  InstructionContext,
  InstructionDecision,
  InstructionInput,
  InstructionReasonCode,
  InstructionReference,
  PairFlowInstruction,
  PairFlowTool,
  Phase,
  ProtocolHelp,
  ReferenceKind,
  RequiredOutput,
  SubPhase,
} from "./instruction-protocol.js";

export function withInstructionProtocol(instruction: InstructionInput): PairFlowInstruction {
  return pairFlowInstructionSchema.parse({
    ...instruction,
    protocol_version: INSTRUCTION_PROTOCOL_VERSION,
    protocol_help: PROTOCOL_HELP,
  });
}

export function guidance(
  key: TemplateKey,
  variables: Record<string, string | number>,
  instruction: InstructionInput,
): Guidance {
  return {
    tip: renderTip(key, variables),
    instruction: withInstructionProtocol(instruction),
  };
}

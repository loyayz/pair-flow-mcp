import { expect } from "vitest";
import type { PairFlowInstruction } from "../instruction.js";
import {
  INSTRUCTION_PROTOCOL_VERSION,
  PROTOCOL_HELP,
  instructionActionSchema,
  instructionReasonCodeSchema,
  pairFlowToolSchema,
} from "../instruction-protocol.js";

export function expectProtocolInstruction(instruction: PairFlowInstruction): PairFlowInstruction {
  expect(instruction.protocol_version).toBe(INSTRUCTION_PROTOCOL_VERSION);
  expect(instruction.protocol_help).toEqual(PROTOCOL_HELP);
  expect(instructionActionSchema.safeParse(instruction.next_action).success).toBe(true);
  expect(instructionReasonCodeSchema.safeParse(instruction.reason_code).success).toBe(true);
  for (const tool of instruction.allowed_tools) {
    expect(pairFlowToolSchema.safeParse(tool).success).toBe(true);
  }
  expect(Object.hasOwn(instruction, "required_output")).toBe(
    instruction.next_action === "produce_and_submit" || instruction.next_action === "decide_convergence",
  );
  expect(Object.hasOwn(instruction, "decision")).toBe(instruction.next_action === "decide_convergence");
  if (instruction.context) {
    expect(Object.hasOwn(instruction.context, "sub_phase")).toBe(
      instruction.context.phase === "implementation",
    );
    expect(instruction.context.can_advance).toBe(
      instruction.next_action === "decide_convergence"
        || (instruction.next_action === "advance" && instruction.context.phase === "idle"),
    );
  }
  if (Object.hasOwn(instruction, "references")) {
    expect(Array.isArray(instruction.references)).toBe(true);
    expect(instruction.references!.length).toBeGreaterThan(0);
  }
  return instruction;
}

export function instructionOf(payload: Record<string, unknown>): PairFlowInstruction {
  expect(payload.instruction).toBeDefined();
  return expectProtocolInstruction(payload.instruction as PairFlowInstruction);
}

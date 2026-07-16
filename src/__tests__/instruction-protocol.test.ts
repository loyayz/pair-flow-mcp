import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  INSTRUCTION_PROTOCOL,
  INSTRUCTION_PROTOCOL_VERSION,
  MCP_SERVER_INSTRUCTIONS,
  PROTOCOL_HELP,
  SERVER_INFO,
  createHealthPayload,
  instructionActionSchema,
  instructionDecisionSchema,
  instructionInputSchema,
  instructionReasonCodeSchema,
  pairFlowToolSchema,
  pairFlowInstructionSchema,
} from "../instruction-protocol.js";

declare global {
  interface Array<T> {
    toSorted(compareFn?: (a: T, b: T) => number): T[];
  }
}

const ENGLISH_TEXT = /^[\x20-\x7E]+$/;

function expectEnglishText(value: string): void {
  expect(value.trim()).not.toBe("");
  expect(value).toMatch(ENGLISH_TEXT);
}

describe("instruction protocol catalog", () => {
  it("declares the fixed version and health help location", () => {
    expect(INSTRUCTION_PROTOCOL_VERSION).toBe("1.1");
    expect(PROTOCOL_HELP).toEqual({
      method: "GET",
      path: "/health",
      section: "protocol",
      purpose: "Re-read the instruction protocol when any field or value is unclear",
    });
  });

  it("publishes claim_turn and JSON response support from the runtime catalog", () => {
    expect(instructionActionSchema.options).toContain("claim_turn");
    expect(pairFlowToolSchema.options).toContain("claim_turn");
    expect(instructionReasonCodeSchema.options).toContain("TURN_ASSIGNED");
    expect(INSTRUCTION_PROTOCOL.actions.claim_turn).toEqual({
      meaning: "Claim the currently assigned turn and receive its complete actionable instruction.",
      procedure: [
        "Call the no-argument claim_turn tool.",
        "Use the complete instruction returned by claim_turn as the authority for the current turn.",
      ],
    });
    expect(INSTRUCTION_PROTOCOL.reason_codes.TURN_ASSIGNED).toEqual({
      meaning: "This participant is assigned the turn and must claim it before acting.",
      actions: ["claim_turn"],
      automatic: true,
      report_user: false,
    });
    expect(INSTRUCTION_PROTOCOL.capabilities).toContain("json_response_v1");
    expect(createHealthPayload(12).protocol).toBe(INSTRUCTION_PROTOCOL);
  });

  it("models convergence and stale-warning decisions as a closed discriminated union", () => {
    expect(instructionDecisionSchema.parse({
      criterion: "phase_goal_met",
      when_true: "advance",
      when_false: "produce_and_submit",
    })).toEqual({
      criterion: "phase_goal_met",
      when_true: "advance",
      when_false: "produce_and_submit",
    });
    expect(instructionDecisionSchema.parse({
      criterion: "user_wants_to_continue_waiting",
      when_true: "wait_for_turn",
      when_false: "stop",
    })).toEqual({
      criterion: "user_wants_to_continue_waiting",
      when_true: "wait_for_turn",
      when_false: "stop",
    });
    expect(instructionDecisionSchema.safeParse({
      criterion: "user_wants_to_continue_waiting",
      when_true: "advance",
      when_false: "stop",
    }).success).toBe(false);
  });

  it("reads the runtime server version from the root package", async () => {
    const rootPackage = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: unknown };
    expect(SERVER_INFO.version).toBe(rootPackage.version);

    const protocolModule = await import("../instruction-protocol.js");
    const loadServerInfo = (protocolModule as unknown as {
      loadServerInfo?: (moduleUrl: string) => { name: string; version: string };
    }).loadServerInfo;
    expect(loadServerInfo).toBeTypeOf("function");
    if (!loadServerInfo) return;

    const root = mkdtempSync(join(tmpdir(), "pairflow-package-version-"));
    try {
      mkdirSync(join(root, "src"));
      mkdirSync(join(root, "dist"));
      writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.8.7" }));

      const sourceModuleUrl = pathToFileURL(join(root, "src", "instruction-protocol.ts")).href;
      const compiledModuleUrl = pathToFileURL(join(root, "dist", "instruction-protocol.js")).href;
      expect(loadServerInfo(sourceModuleUrl)).toEqual({ name: "pair-flow", version: "9.8.7" });
      expect(loadServerInfo(compiledModuleUrl)).toEqual({ name: "pair-flow", version: "9.8.7" });

      writeFileSync(join(root, "package.json"), JSON.stringify({ version: 987 }));
      expect(() => loadServerInfo(compiledModuleUrl)).toThrow("package.json version must be a non-empty string");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("covers every closed action and reason code", () => {
    expect(Object.keys(INSTRUCTION_PROTOCOL.actions).sort()).toEqual(
      instructionActionSchema.options.toSorted(),
    );
    expect(Object.keys(INSTRUCTION_PROTOCOL.reason_codes).sort()).toEqual(
      instructionReasonCodeSchema.options.toSorted(),
    );
  });

  it("declares the safe unknown-value policy", () => {
    expect(INSTRUCTION_PROTOCOL.unknown_value_policy).toEqual({
      reread_health: true,
      tip_control_fallback: false,
      unresolved: "Stop automatic execution and report an incompatible protocol value",
    });
  });

  it("publishes the tip/instruction conflict policy in the runtime catalog", () => {
    const authority = INSTRUCTION_PROTOCOL.authority as Record<string, string>;
    expect(authority.conflict).toBe(
      "If tip and instruction visibly conflict, stop automatic execution and report a protocol consistency error",
    );
  });

  it("explains wait_for_turn as synchronization even when the caller already owns the turn", () => {
    expect(INSTRUCTION_PROTOCOL.actions.wait_for_turn).toEqual({
      meaning: "Synchronize with the assigned turn and receive its actionable instruction; the call returns immediately when this participant already owns the turn.",
      procedure: [
        "Call wait_for_turn even when context.holds_turn is true if the returned instruction selects this action.",
        "On WAIT_TIMEOUT, call wait_for_turn again.",
      ],
    });
    expect(INSTRUCTION_PROTOCOL.reason_codes.PHASE_ADVANCED.meaning).toBe(
      "The workflow advanced to the next phase; call wait_for_turn to receive the actionable instruction for the assigned turn, whether or not this participant already owns it.",
    );
  });

  it("requires task_type for every confirm_task call", () => {
    expect(INSTRUCTION_PROTOCOL.bootstrap).toContain(
      "Collect identity, task path, task type, responsibilities and work directory from the user; all confirm_task inputs are required",
    );
    expect(INSTRUCTION_PROTOCOL.actions.confirm_task.procedure).toEqual([
      "Collect task_path, task_type, responsibilities and work_dir from the user.",
      "Always pass task_type; it is required for every confirm_task call.",
      "Call confirm_task with its input schema.",
    ]);
  });

  it("limits fix_request to arguments proven invalid by the rejection", () => {
    expect(INSTRUCTION_PROTOCOL.actions.fix_request.procedure).toEqual([
      "Read the business error and the original tool input schema.",
      "Change only arguments proven invalid by the error; do not infer that other arguments are invalid.",
      "Preserve or independently verify remaining arguments, especially values tied to a corrected artifact.",
      "Retry the original tool only after the corrected request satisfies its schema and the current instruction.",
    ]);
  });

  it("renders initialization instructions from alternate catalog and help semantics", async () => {
    const protocolModule = await import("../instruction-protocol.js");
    const render = (protocolModule as unknown as {
      renderMcpServerInstructions?: (
        protocol: {
          authority: { instruction: string; tip: string; conflict: string };
          unknown_value_policy: {
            reread_health: boolean;
            tip_control_fallback: boolean;
            unresolved: string;
          };
        },
        help: { method: string; path: string; section: string; purpose: string },
      ) => string;
    }).renderMcpServerInstructions;

    expect(render).toBeTypeOf("function");
    if (!render) return;

    const semantics = {
      authority: {
        instruction: "ALT instruction authority",
        tip: "ALT tip authority",
        conflict: "ALT visible conflict policy",
      },
      unknown_value_policy: {
        reread_health: false,
        tip_control_fallback: true,
        unresolved: "ALT unresolved unknown policy",
      },
    };
    const help = {
      method: "POST",
      path: "/alternate-health",
      section: "alternate-protocol",
      purpose: "ALT protocol help purpose",
    };

    const projection = render(semantics, help);
    for (const value of Object.values(semantics.authority)) expect(projection).toContain(value);
    expect(projection).toContain("reread health=false");
    expect(projection).toContain("tip control fallback=true");
    expect(projection).toContain(semantics.unknown_value_policy.unresolved);
    for (const value of Object.values(help)) expect(projection).toContain(String(value));
    for (const value of Object.values(INSTRUCTION_PROTOCOL.authority)) {
      expect(projection).not.toContain(value);
    }
    expect(projection).not.toContain("do not derive workflow control from tip");
  });

  it("describes every top-level and nested instruction field", () => {
    expect(Object.keys(INSTRUCTION_PROTOCOL.fields).sort()).toEqual([
      "allowed_tools",
      "context",
      "context.can_advance",
      "context.holds_turn",
      "context.phase",
      "context.round",
      "context.sub_phase",
      "context.turn",
      "context.workflow_id",
      "decision",
      "decision.criterion",
      "decision.when_false",
      "decision.when_true",
      "next_action",
      "protocol_help",
      "protocol_help.method",
      "protocol_help.path",
      "protocol_help.purpose",
      "protocol_help.section",
      "protocol_version",
      "reason_code",
      "references",
      "references[].commit",
      "references[].file_path",
      "references[].kind",
      "references[].required",
      "required_output",
      "required_output.commit_required",
      "required_output.file_path",
      "required_output.submit_tool",
    ]);
  });

  it("uses non-empty English descriptions throughout the consumer catalog", () => {
    for (const description of Object.values(INSTRUCTION_PROTOCOL.fields)) {
      expectEnglishText(description);
    }
    for (const entry of Object.values(INSTRUCTION_PROTOCOL.actions)) {
      expectEnglishText(entry.meaning);
      expect(entry.procedure).not.toHaveLength(0);
      entry.procedure.forEach(expectEnglishText);
    }
    for (const entry of Object.values(INSTRUCTION_PROTOCOL.reason_codes)) {
      expectEnglishText(entry.meaning);
    }
    Object.values(INSTRUCTION_PROTOCOL.authority).forEach(expectEnglishText);
    INSTRUCTION_PROTOCOL.bootstrap.forEach(expectEnglishText);
    expectEnglishText(INSTRUCTION_PROTOCOL.unknown_value_policy.unresolved);
    MCP_SERVER_INSTRUCTIONS.split("\n").forEach(expectEnglishText);
  });

  it("enforces instruction cross-field relationships in both production schemas", () => {
    const input = {
      next_action: "produce_and_submit" as const,
      allowed_tools: ["submit" as const],
      reason_code: "TURN_READY" as const,
      context: {
        workflow_id: "workflow-1",
        phase: "requirements" as const,
        round: 1,
        turn: "developer",
        holds_turn: true,
        can_advance: false,
      },
      required_output: {
        file_path: "C:/repo/handoff/workflow-1/requirements/r1_developer.md",
        commit_required: true as const,
        submit_tool: "submit" as const,
      },
      references: [{
        kind: "task" as const,
        file_path: "C:/repo/task.md",
        required: true,
        commit: "abc1234",
      }],
    };
    const full = {
      protocol_version: INSTRUCTION_PROTOCOL_VERSION,
      protocol_help: PROTOCOL_HELP,
      ...input,
    };
    const convergence = {
      ...input,
      next_action: "decide_convergence" as const,
      allowed_tools: ["advance" as const, "submit" as const],
      reason_code: "PHASE_READY_FOR_CONVERGENCE_DECISION" as const,
      context: { ...input.context, turn: "supervisor", can_advance: true },
      decision: {
        criterion: "phase_goal_met" as const,
        when_true: "advance" as const,
        when_false: "produce_and_submit" as const,
      },
    };
    const waiting = {
      next_action: "wait_for_turn" as const,
      allowed_tools: ["wait_for_turn" as const],
      reason_code: "WAITING_FOR_TURN" as const,
      context: { ...input.context, holds_turn: false },
    };
    const implementation = {
      ...input,
      context: { ...input.context, phase: "implementation" as const, sub_phase: "coding" as const },
    };
    const warningDecision = {
      criterion: "user_wants_to_continue_waiting" as const,
      when_true: "wait_for_turn" as const,
      when_false: "stop" as const,
    };
    const staleWarning = {
      next_action: "report_user" as const,
      allowed_tools: [],
      reason_code: "PARTICIPANT_CONFIRMATION_STALE" as const,
      decision: warningDecision,
    };

    expect(instructionInputSchema.safeParse(input).success).toBe(true);
    expect(pairFlowInstructionSchema.safeParse(full).success).toBe(true);
    expect(instructionInputSchema.safeParse(staleWarning).success).toBe(true);
    expect(instructionInputSchema.safeParse({
      ...staleWarning,
      reason_code: "TURN_UNCLAIMED_STALE",
    }).success).toBe(true);

    const inputMutants: unknown[] = [
      { ...input, required_output: undefined },
      { ...waiting, required_output: input.required_output },
      { ...convergence, decision: undefined },
      { ...waiting, decision: convergence.decision },
      { ...waiting, references: [] },
      { ...waiting, context: { ...waiting.context, sub_phase: "coding" } },
      { ...implementation, context: { ...implementation.context, sub_phase: undefined } },
      { ...waiting, context: { ...waiting.context, can_advance: true } },
      { ...convergence, context: { ...convergence.context, can_advance: false } },
      { ...input, required_output: { ...input.required_output, file_path: "C:\\repo\\output.md" } },
      { ...input, references: [{ ...input.references[0], file_path: "C:\\repo\\task.md" }] },
      { ...input, references: [{ ...input.references[0], commit: "ABC1234" }] },
      { ...input, context: { ...input.context, workflow_id: undefined } },
      { ...input, context: { ...input.context, holds_turn: false } },
      { ...staleWarning, decision: undefined },
      { ...staleWarning, decision: convergence.decision },
      {
        ...staleWarning,
        next_action: "wait_for_turn",
        allowed_tools: ["wait_for_turn"],
        decision: undefined,
      },
      {
        ...staleWarning,
        next_action: "wait_for_turn",
        allowed_tools: ["wait_for_turn"],
      },
      { ...staleWarning, reason_code: "UNSUPPORTED_WORKFLOW_STATE" },
      { ...waiting, decision: warningDecision },
      { ...convergence, decision: warningDecision },
    ];

    for (const mutant of inputMutants) {
      expect(instructionInputSchema.safeParse(mutant).success).toBe(false);
      expect(pairFlowInstructionSchema.safeParse({
        protocol_version: INSTRUCTION_PROTOCOL_VERSION,
        protocol_help: PROTOCOL_HELP,
        ...(mutant as Record<string, unknown>),
      }).success).toBe(false);
    }
  });
});

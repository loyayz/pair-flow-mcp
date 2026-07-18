import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { describe, expect, it } from "vitest";
import { INSTRUCTION_PROTOCOL_VERSION, PROTOCOL_HELP } from "../instruction-protocol.js";
import { TOOL_OUTPUT_SCHEMAS } from "../tool-output.js";

const REMINDER = "质量优先，完整完成任务目标。";
const instruction = {
  protocol_version: INSTRUCTION_PROTOCOL_VERSION,
  protocol_help: PROTOCOL_HELP,
  next_action: "wait_for_turn" as const,
  allowed_tools: ["wait_for_turn" as const],
  reason_code: "WAITING_FOR_TURN" as const,
};
const requirementsContext = {
  workflow_id: "workflow-1",
  phase: "requirements" as const,
  round: 1,
  turn: "claude",
  holds_turn: false,
  can_advance: false,
};
const guidance = {
  reminder: REMINDER,
  tip: "[行动] 等待轮到自己。",
  instruction: { ...instruction, context: requirementsContext },
};
const advancedGuidance = {
  ...guidance,
  instruction: {
    ...instruction,
    reason_code: "PHASE_ADVANCED" as const,
    context: { ...requirementsContext, phase: "planning" as const },
  },
};
const rejectionInstruction = {
  ...instruction,
  next_action: "fix_request" as const,
  allowed_tools: [],
  reason_code: "REQUEST_REJECTED" as const,
};
const rejection = {
  ok: false as const,
  error: "request rejected",
  reminder: REMINDER,
  tip: "[行动] 请求被拒绝：request rejected",
  instruction: rejectionInstruction,
};
const staleInstruction = {
  ...instruction,
  next_action: "report_user" as const,
  allowed_tools: [],
  reason_code: "PARTICIPANT_CONFIRMATION_STALE" as const,
  context: requirementsContext,
  decision: {
    criterion: "user_wants_to_continue_waiting" as const,
    when_true: "wait_for_turn" as const,
    when_false: "stop" as const,
  },
};
const completedInstruction = {
  ...instruction,
  next_action: "stop" as const,
  allowed_tools: [],
  reason_code: "WORKFLOW_COMPLETED" as const,
};
const unboundInstruction = {
  ...instruction,
  next_action: "confirm_task" as const,
  allowed_tools: ["confirm_task" as const],
  reason_code: "WORKFLOW_UNBOUND" as const,
};
const unsupportedInstruction = {
  ...instruction,
  next_action: "report_user" as const,
  allowed_tools: [],
  reason_code: "UNSUPPORTED_WORKFLOW_STATE" as const,
  context: {
    workflow_id: "workflow-1",
    round: 1,
    turn: "claude",
    holds_turn: false,
    can_advance: false,
  },
};
const finalSummary = {
  round: 1,
  submitted_by: "claude",
  commit_hash: "abc1234",
  file_path: "C:/project/handoff/workflow-1/summary/r1_claude.md",
};
const actionableToolNames = [
  "register",
  "confirm_task",
  "advance",
  "get_state",
  "wait_for_turn",
  "claim_turn",
  "submit",
] as const;

describe("tool output schemas", () => {
  it("projects every output schema as a top-level object", () => {
    for (const schema of Object.values(TOOL_OUTPUT_SCHEMAS)) {
      const publicSchema = toJsonSchemaCompat(schema, {
        strictUnions: true,
        pipeStrategy: "output",
      });
      expect(publicSchema.type).toBe("object");
    }
  });

  it("defines a successful schema for every registered tool", () => {
    const payloads = {
      ping: { ok: true, uptime: 12.5, reminder: REMINDER },
      who_am_i: {
        ok: true,
        identity: "claude",
        registered: true,
        joined_workflow: true,
        is_supervisor: true,
        is_developer: false,
        workflow_id: "workflow-1",
        reminder: REMINDER,
      },
      register: {
        ok: true,
        identity: "claude",
        token: "token-1",
        reminder: REMINDER,
        tip: "confirm",
        instruction: {
          ...instruction,
          next_action: "confirm_task" as const,
          allowed_tools: ["confirm_task" as const],
          reason_code: "REGISTERED_NEEDS_CONFIRMATION" as const,
        },
      },
      confirm_task: {
        ok: true,
        task_path: "C:/repo/docs/task.md",
        workflow_id: "workflow-1",
        phase: "requirements",
        recovered: false,
        ...guidance,
        instruction: { ...guidance.instruction, reason_code: "ROSTER_INCOMPLETE" as const },
      },
      advance: {
        ok: true,
        new_phase: "implementation",
        turn: "claude",
        sub_phase: "coding",
        ...advancedGuidance,
        instruction: {
          ...advancedGuidance.instruction,
          context: {
            ...advancedGuidance.instruction.context,
            phase: "implementation" as const,
            sub_phase: "coding" as const,
          },
        },
      },
      get_state: {
        ok: true,
        workflow_id: "workflow-1",
        phase: "requirements",
        sub_phase: null,
        round: 2,
        turn: "codex",
        ...guidance,
        instruction: {
          ...guidance.instruction,
          context: { ...requirementsContext, round: 2, turn: "codex" },
        },
      },
      wait_for_turn: {
        ok: true,
        turn: "claude",
        phase: "requirements",
        round: 1,
        ...guidance,
      },
      claim_turn: {
        ok: true,
        turn: "claude",
        phase: "requirements",
        round: 1,
        ...guidance,
        instruction: {
          ...guidance.instruction,
          next_action: "produce_and_submit" as const,
          allowed_tools: ["submit" as const],
          reason_code: "TURN_READY" as const,
          context: { ...requirementsContext, holds_turn: true },
          required_output: {
            file_path: "C:/repo/handoff/workflow-1/requirements/r1_claude.md",
            commit_required: true as const,
            submit_tool: "submit" as const,
          },
        },
      },
      submit: {
        ok: true,
        next_turn: "codex",
        ...guidance,
        instruction: {
          ...guidance.instruction,
          reason_code: "SUBMISSION_ACCEPTED" as const,
          context: { ...requirementsContext, turn: "codex" },
        },
      },
    } as const;

    expect(Object.keys(TOOL_OUTPUT_SCHEMAS).sort()).toEqual(Object.keys(payloads).sort());
    for (const name of Object.keys(payloads) as Array<keyof typeof payloads>) {
      expect(TOOL_OUTPUT_SCHEMAS[name].safeParse(payloads[name]).success, name).toBe(true);
    }
  });

  it("rejects incomplete ok=true actionable responses", () => {
    const payloadsWithoutInstruction = {
      register: { ok: true, identity: "claude", token: "token-1", reminder: REMINDER, tip: "act" },
      confirm_task: {
        ok: true,
        task_path: "C:/repo/docs/task.md",
        workflow_id: "workflow-1",
        phase: "idle",
        recovered: false,
        reminder: REMINDER,
        tip: "act",
      },
      advance: { ok: true, new_phase: "planning", turn: "claude", reminder: REMINDER, tip: "act" },
      get_state: { ok: true, reminder: REMINDER, tip: "act" },
      wait_for_turn: { ok: true, turn: "claude", phase: "requirements", reminder: REMINDER, tip: "act" },
      claim_turn: { ok: true, turn: "claude", phase: "requirements", round: 1, reminder: REMINDER, tip: "act" },
      submit: { ok: true, next_turn: "codex", reminder: REMINDER, tip: "act" },
    } as const;

    for (const name of Object.keys(payloadsWithoutInstruction) as Array<keyof typeof payloadsWithoutInstruction>) {
      expect(TOOL_OUTPUT_SCHEMAS[name].safeParse(payloadsWithoutInstruction[name]).success, name).toBe(false);
    }
  });

  it("rejects cross-tool instruction branches and top-level/context mismatches", () => {
    const valid = {
      register: {
        ok: true,
        identity: "claude",
        token: "token-1",
        reminder: REMINDER,
        tip: "confirm",
        instruction: {
          ...instruction,
          next_action: "confirm_task" as const,
          allowed_tools: ["confirm_task" as const],
          reason_code: "REGISTERED_NEEDS_CONFIRMATION" as const,
        },
      },
      confirm_task: {
        ok: true,
        task_path: "C:/repo/docs/task.md",
        workflow_id: "workflow-1",
        phase: "requirements" as const,
        recovered: false,
        ...guidance,
        instruction: { ...guidance.instruction, reason_code: "ROSTER_INCOMPLETE" as const },
      },
      advance: {
        ok: true,
        new_phase: "planning" as const,
        turn: "claude",
        ...advancedGuidance,
      },
      get_state: {
        ok: true,
        workflow_id: "workflow-1",
        phase: "requirements" as const,
        sub_phase: null,
        round: 1,
        turn: "claude",
        ...guidance,
      },
      wait_for_turn: {
        ok: true,
        turn: "claude",
        phase: "requirements" as const,
        round: 1,
        ...guidance,
      },
      claim_turn: {
        ok: true,
        turn: "claude",
        phase: "idle" as const,
        round: 1,
        reminder: REMINDER,
        tip: "advance",
        instruction: {
          ...instruction,
          next_action: "advance" as const,
          allowed_tools: ["advance" as const],
          reason_code: "TURN_READY" as const,
          context: {
            workflow_id: "workflow-1",
            phase: "idle" as const,
            round: 1,
            turn: "claude",
            holds_turn: true,
            can_advance: true,
          },
        },
      },
      submit: {
        ok: true,
        next_turn: "codex",
        reminder: REMINDER,
        tip: "wait",
        instruction: {
          ...instruction,
          reason_code: "SUBMISSION_ACCEPTED" as const,
          context: { ...requirementsContext, turn: "codex" },
        },
      },
    };
    const contextField = {
      confirm_task: "phase",
      advance: "turn",
      get_state: "round",
      wait_for_turn: "turn",
      claim_turn: "round",
      submit: "turn",
    } as const;

    for (const name of actionableToolNames) {
      const payload = valid[name];
      expect(TOOL_OUTPUT_SCHEMAS[name].safeParse(payload).success, `${name} valid`).toBe(true);

      const wrongReason = name === "submit" ? "REGISTERED_NEEDS_CONFIRMATION" : "SUBMISSION_ACCEPTED";
      expect(TOOL_OUTPUT_SCHEMAS[name].safeParse({
        ...payload,
        instruction: { ...payload.instruction, reason_code: wrongReason },
      }).success, `${name} reason`).toBe(false);
      expect(TOOL_OUTPUT_SCHEMAS[name].safeParse({
        ...payload,
        instruction: { ...payload.instruction, next_action: "fix_request" },
      }).success, `${name} action`).toBe(false);
      expect(TOOL_OUTPUT_SCHEMAS[name].safeParse({
        ...payload,
        instruction: { ...payload.instruction, allowed_tools: [] },
      }).success, `${name} allowed_tools`).toBe(false);

      if (name === "register") {
        expect(TOOL_OUTPUT_SCHEMAS.register.safeParse({
          ...payload,
          instruction: { ...payload.instruction, context: requirementsContext },
        }).success).toBe(false);
      } else {
        const field = contextField[name];
        const workflowContext = "context" in payload.instruction ? payload.instruction.context : {};
        expect(TOOL_OUTPUT_SCHEMAS[name].safeParse({
          ...payload,
          instruction: {
            ...payload.instruction,
            context: { ...workflowContext, [field]: field === "round" ? 99 : "mismatch" },
          },
        }).success, `${name} context.${field}`).toBe(false);
      }
    }
  });

  it("accepts structured business rejections for every actionable tool", () => {
    for (const name of actionableToolNames) {
      expect(TOOL_OUTPUT_SCHEMAS[name].safeParse(rejection).success, name).toBe(true);
    }
  });

  it("rejects malformed business rejection instructions and missing errors", () => {
    const malformedRejections = [
      { ...rejection, error: undefined },
      {
        ...rejection,
        instruction: { ...rejectionInstruction, next_action: "wait_for_turn" as const },
      },
      {
        ...rejection,
        instruction: { ...rejectionInstruction, reason_code: "WAITING_FOR_TURN" as const },
      },
      {
        ...rejection,
        instruction: { ...rejectionInstruction, allowed_tools: ["advance" as const] },
      },
    ];

    for (const name of actionableToolNames) {
      for (const payload of malformedRejections) {
        expect(TOOL_OUTPUT_SCHEMAS[name].safeParse(payload).success, name).toBe(false);
      }
    }
  });

  it("does not accept success-only business fields on a rejection", () => {
    const mixedRejections = {
      register: { ...rejection, token: "token-1" },
      confirm_task: { ...rejection, task_path: "C:/repo/docs/task.md" },
      advance: { ...rejection, new_phase: "planning" },
      get_state: { ...rejection, workflow_id: "workflow-1" },
      wait_for_turn: { ...rejection, turn: "claude" },
      claim_turn: { ...rejection, turn: "claude" },
      submit: { ...rejection, next_turn: "codex" },
    } as const;

    for (const name of actionableToolNames) {
      expect(TOOL_OUTPUT_SCHEMAS[name].safeParse(mixedRejections[name]).success, name).toBe(false);
    }
  });

  it("does not require instructions for ping and who_am_i", () => {
    expect(TOOL_OUTPUT_SCHEMAS.ping.safeParse({
      ok: true,
      uptime: 1,
      reminder: REMINDER,
    }).success).toBe(true);
    expect(TOOL_OUTPUT_SCHEMAS.who_am_i.safeParse({
      ok: true,
      identity: "unknown",
      registered: false,
      joined_workflow: false,
      reminder: REMINDER,
    }).success).toBe(true);
  });

  it("closes who_am_i anonymous, unbound, and joined branches", () => {
    const valid = [
      { ok: true, identity: "unknown", registered: false, joined_workflow: false, reminder: REMINDER },
      { ok: true, identity: "claude", registered: true, joined_workflow: false, is_supervisor: false, is_developer: false, workflow_id: null, reminder: REMINDER },
      { ok: true, identity: "claude", registered: true, joined_workflow: true, is_supervisor: true, is_developer: false, workflow_id: "workflow-1", reminder: REMINDER },
    ];
    const invalid = [
      { ...valid[0], workflow_id: null },
      { ...valid[1], workflow_id: "workflow-1" },
      { ...valid[2], workflow_id: null },
      { ...valid[2], registered: false },
    ];

    for (const payload of valid) expect(TOOL_OUTPUT_SCHEMAS.who_am_i.safeParse(payload).success).toBe(true);
    for (const payload of invalid) expect(TOOL_OUTPUT_SCHEMAS.who_am_i.safeParse(payload).success).toBe(false);
  });

  it("requires advance sub_phase only when entering implementation", () => {
    const base = { ok: true, new_phase: "planning", turn: "claude", ...advancedGuidance };
    expect(TOOL_OUTPUT_SCHEMAS.advance.safeParse(base).success).toBe(true);
    expect(TOOL_OUTPUT_SCHEMAS.advance.safeParse({ ...base, sub_phase: "coding" }).success).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.advance.safeParse({ ...base, new_phase: "implementation" }).success).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.advance.safeParse({ ...base, new_phase: "implementation", sub_phase: null }).success).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.advance.safeParse({
      ...base,
      new_phase: "implementation",
      sub_phase: "coding",
      instruction: {
        ...base.instruction,
        context: { ...base.instruction.context, phase: "implementation", sub_phase: "coding" },
      },
    }).success).toBe(true);
  });

  it("closes get_state unbound, bound, and unsupported branches", () => {
    const bound = {
      ok: true,
      workflow_id: "workflow-1",
      phase: "requirements",
      sub_phase: null,
      round: 1,
      turn: "claude",
      ...guidance,
    };
    const unbound = { ok: true, reminder: REMINDER, tip: "confirm", instruction: unboundInstruction };
    const unsupported = {
      ok: true,
      workflow_id: "workflow-1",
      round: 1,
      turn: "claude",
      reminder: REMINDER,
      tip: "report",
      instruction: unsupportedInstruction,
    };

    for (const payload of [bound, unbound, unsupported]) {
      expect(TOOL_OUTPUT_SCHEMAS.get_state.safeParse(payload).success).toBe(true);
    }
    expect(TOOL_OUTPUT_SCHEMAS.get_state.safeParse({ ...bound, sub_phase: "coding" }).success).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.get_state.safeParse({ ...unbound, workflow_id: "workflow-1" }).success).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.get_state.safeParse({ ...unsupported, phase: "requirements" }).success).toBe(false);
  });

  it("uses WORKFLOW_COMPLETED, not idle state, to gate wait completion fields", () => {
    const idleTimeout = {
      ok: true,
      turn: "idle",
      phase: "idle",
      round: 1,
      reminder: REMINDER,
      tip: "wait",
      instruction: {
        ...instruction,
        reason_code: "WAIT_TIMEOUT" as const,
        context: {
          workflow_id: "workflow-1",
          phase: "idle" as const,
          round: 1,
          turn: "idle",
          holds_turn: false,
          can_advance: false,
        },
      },
    };
    const warning = {
      ok: true,
      turn: "claude",
      phase: "requirements",
      round: 1,
      warning: "participant confirmation is stale",
      reminder: REMINDER,
      tip: "report",
      instruction: staleInstruction,
    };
    const completed = {
      ok: true,
      turn: "idle",
      phase: "idle",
      manifest_path: "C:/project/handoff/workflow-1/delivery-manifest.json",
      archive_root: "C:/project/handoff/workflow-1",
      final_summary: finalSummary,
      reminder: REMINDER,
      tip: "stop",
      instruction: completedInstruction,
    };

    for (const payload of [idleTimeout, warning, completed]) {
      expect(TOOL_OUTPUT_SCHEMAS.wait_for_turn.safeParse(payload).success).toBe(true);
    }
    expect(TOOL_OUTPUT_SCHEMAS.wait_for_turn.safeParse({ ...idleTimeout, manifest_path: "unexpected" }).success).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.wait_for_turn.safeParse({ ...completed, round: 1 }).success).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.wait_for_turn.safeParse({ ...completed, cleanup_pending: true, cleanup_error: "unexpected" }).success).toBe(false);
    expect(TOOL_OUTPUT_SCHEMAS.wait_for_turn.safeParse({ ...idleTimeout, warning: "unexpected" }).success).toBe(false);
  });
});

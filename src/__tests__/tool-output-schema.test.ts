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
const guidance = {
  reminder: REMINDER,
  tip: "[行动] 等待轮到自己。",
  instruction,
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
  it("projects claim_turn as a top-level object output schema", () => {
    const publicSchema = toJsonSchemaCompat(TOOL_OUTPUT_SCHEMAS.claim_turn, {
      strictUnions: true,
      pipeStrategy: "output",
    });

    expect(publicSchema.type).toBe("object");
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
      register: { ok: true, identity: "claude", token: "token-1", ...guidance },
      confirm_task: {
        ok: true,
        task_path: "C:/repo/docs/task.md",
        workflow_id: "workflow-1",
        phase: "idle",
        recovered: false,
        ...guidance,
      },
      advance: {
        ok: true,
        new_phase: "implementation",
        turn: "claude",
        sub_phase: "coding",
        ...guidance,
      },
      get_state: {
        ok: true,
        workflow_id: "workflow-1",
        phase: "implementation",
        sub_phase: "review",
        round: 2,
        turn: "codex",
        ...guidance,
      },
      wait_for_turn: {
        ok: true,
        turn: "claude",
        phase: "requirements",
        round: 1,
        warning: "still waiting",
        ...guidance,
      },
      claim_turn: {
        ok: true,
        turn: "claude",
        phase: "requirements",
        round: 1,
        ...guidance,
      },
      submit: { ok: true, next_turn: "codex", ...guidance },
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
});

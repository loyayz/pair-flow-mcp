import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { guidance } from "../instruction.js";
import { err, ok } from "../response.js";

const REMINDER = "质量优先，完整完成任务目标。";
const testGuidance = guidance("response.rejected", { message: "next action" }, {
  next_action: "fix_request",
  allowed_tools: [],
  reason_code: "REQUEST_REJECTED",
});

function channels(result: CallToolResult): Record<string, unknown> {
  const textPayload = JSON.parse((result.content[0] as { text: string }).text);
  expect(result.structuredContent).toEqual(textPayload);
  return textPayload;
}

if (false) {
  // @ts-expect-error String-only guidance is intentionally unsupported.
  ok({ value: 1 }, "tip");
}

describe("tool response contract", () => {
  it("emits matching structured and text channels for successful responses", () => {
    const result = channels(ok({ value: 1 }, testGuidance));

    expect(result.reminder).toBe(REMINDER);
    expect(result).toMatchObject({
      ok: true,
      tip: testGuidance.tip,
      instruction: testGuidance.instruction,
    });
  });

  it("emits matching structured and text channels for rejected responses", () => {
    const response = err("invalid input");
    const result = channels(response);

    expect(response.isError).toBe(true);
    expect(result.reminder).toBe(REMINDER);
    expect(result).toMatchObject({
      ok: false,
      error: "invalid input",
      tip: "[行动] 请求被拒绝：invalid input",
      instruction: {
        next_action: "fix_request",
        reason_code: "REQUEST_REJECTED",
      },
    });
  });

  it("does not mutate successful response data", () => {
    const data = { value: 1 };

    channels(ok(data, testGuidance));

    expect(data).toEqual({ value: 1 });
  });

  it("does not allow response data to override successful contract fields", () => {
    const result = channels(ok({
      ok: false,
      error: "override",
      tip: "override",
      reminder: "override",
    }));

    expect(result.ok).toBe(true);
    expect(result.reminder).toBe(REMINDER);
    expect(result).not.toHaveProperty("error");
    expect(result).not.toHaveProperty("tip");
  });

  it("does not allow error extras to override rejected contract fields", () => {
    const result = channels(err("invalid input", {
      ok: true,
      error: "override",
      tip: "override",
      reminder: "override",
    }));

    expect(result).toMatchObject({
      ok: false,
      error: "invalid input",
      tip: "[行动] 请求被拒绝：invalid input",
      reminder: REMINDER,
    });
  });

  it("rejects unexpected business rejection fields in the actual response path", () => {
    expect(() => err("invalid input", { new_phase: "planning" })).toThrow();
  });
});

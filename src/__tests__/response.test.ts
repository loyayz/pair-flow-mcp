import { describe, expect, it } from "vitest";
import { err, ok } from "../response.js";

const REMINDER = "质量优先，完整完成任务目标。";

function payload(result: ReturnType<typeof ok>): Record<string, unknown> {
  return JSON.parse((result.content[0] as { text: string }).text);
}

describe("tool response contract", () => {
  it("includes the quality reminder in successful responses", () => {
    const result = payload(ok({ value: 1 }, "next action"));

    expect(result.reminder).toBe(REMINDER);
    expect(result.tip).toBe("next action");
  });

  it("includes the quality reminder in rejected responses", () => {
    const result = payload(err("invalid input"));

    expect(result.reminder).toBe(REMINDER);
    expect(result.tip).toBe("[行动] 请求被拒绝：invalid input");
  });

  it("does not mutate successful response data", () => {
    const data = { value: 1 };

    payload(ok(data, "next action"));

    expect(data).toEqual({ value: 1 });
  });

  it("does not allow response data to override successful contract fields", () => {
    const result = payload(ok({
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
    const result = payload(err("invalid input", {
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
});

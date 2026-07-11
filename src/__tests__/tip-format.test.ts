import { describe, expect, it } from "vitest";
import { formatTip } from "../tip-format.js";

describe("formatTip", () => {
  it("requires an action and omits absent optional sections", () => {
    expect(formatTip({ action: "继续等待" })).toBe("[行动] 继续等待");
  });

  it("orders populated sections with one blank line between them", () => {
    expect(formatTip({
      action: "完成当前工作",
      product: "完成后调用 submit",
      current: "当前轮到你",
    })).toBe("[行动] 完成当前工作\n\n[产出] 完成后调用 submit\n\n[当前] 当前轮到你");
  });

  it("omits an empty product without changing section order", () => {
    expect(formatTip({ action: "等待", product: "  ", current: "轮到对方" }))
      .toBe("[行动] 等待\n\n[当前] 轮到对方");
  });
});

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("PairFlow skill contract", () => {
  it("uses the current confirm_task responsibility fields", async () => {
    const skill = await readFile(resolve("skills/pairflow/SKILL.md"), "utf-8");

    expect(skill).toContain('"is_supervisor":');
    expect(skill).toContain('"is_developer":');
    expect(skill).not.toContain('"supervisor":');
    expect(skill).not.toContain('"developer":');
  });

  it("does not call workflow action tools before both participants join", async () => {
    const skill = await readFile(resolve("skills/pairflow/SKILL.md"), "utf-8");

    expect(skill).toContain("你是第一个加入的。调用 `wait_for_turn`");
    expect(skill).toContain("无论当前是哪种成功场景，`confirm_task` 后的下一步都调用 `wait_for_turn`");
  });
});

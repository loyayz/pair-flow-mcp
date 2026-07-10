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
});

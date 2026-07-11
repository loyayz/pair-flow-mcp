import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("PairFlow skill contract", () => {
  it("describes concrete PairFlow setup triggers", async () => {
    const skill = await readFile(resolve("skills/pairflow/SKILL.md"), "utf-8");

    expect(skill).toMatch(/^---\r?\nname: pairflow\r?\ndescription: Use when /);
    expect(skill).toContain("启动 pairflow");
    expect(skill).toContain("结对编程");
  });

  it("provides Codex UI metadata", async () => {
    const metadata = await readFile(resolve("skills/pairflow/agents/openai.yaml"), "utf-8");

    expect(metadata).toContain('display_name: "PairFlow"');
    expect(metadata).toContain("Use $pairflow");
    expect(metadata).toContain("allow_implicit_invocation: true");
  });

  it("uses the current confirm_task responsibility fields", async () => {
    const skill = await readFile(resolve("skills/pairflow/SKILL.md"), "utf-8");

    expect(skill).toContain('"is_supervisor":');
    expect(skill).toContain('"is_developer":');
    expect(skill).not.toContain('"supervisor":');
    expect(skill).not.toContain('"developer":');
  });

  it("does not call workflow action tools before both participants join", async () => {
    const skill = await readFile(resolve("skills/pairflow/SKILL.md"), "utf-8");

    expect(skill).toContain("无论当前是哪种成功场景，`confirm_task` 后的下一步都调用 `wait_for_turn`");
  });

  it("collects task type before asking whether the participant is a developer", async () => {
    const skill = await readFile(resolve("skills/pairflow/SKILL.md"), "utf-8");

    expect(skill.indexOf("任务类型")).toBeLessThan(skill.indexOf("开发者"));
    expect(skill).toContain("requirements 任务建议 `is_developer=false`");
  });

  it("keeps the token internal and uses server tips after initialization", async () => {
    const skill = await readFile(resolve("skills/pairflow/SKILL.md"), "utf-8");

    expect(skill).toContain("不要主动向用户展示 token");
    expect(skill).not.toContain("将 token 告诉用户");
    expect(skill).toContain("后续行动以 PairFlow 返回的 tip 为准");
  });

  it("handles startup and waiting failures without assuming a Unix shell", async () => {
    const skill = await readFile(resolve("skills/pairflow/SKILL.md"), "utf-8");

    expect(skill).toContain("使用当前环境适用的后台进程方式");
    expect(skill).not.toContain("--port <port> &");
    expect(skill).toContain("端口冲突");
    expect(skill).toContain("绝对路径");
    expect(skill).toContain("职责组合");
    expect(skill).toContain("600 秒");
    expect(skill).toContain("继续调用 `wait_for_turn`");
  });
});

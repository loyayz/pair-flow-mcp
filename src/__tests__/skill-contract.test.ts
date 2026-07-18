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

  it("keeps the token internal and treats structured instructions as workflow authority", async () => {
    const skill = await readFile(resolve("skills/pairflow/SKILL.md"), "utf-8");

    expect(skill).toContain("不要主动向用户展示 token");
    expect(skill).not.toContain("将 token 告诉用户");
    expect(skill).toContain("结构化 `instruction` 是 workflow control 的唯一权威");
    expect(skill).toContain("tip 只用于思考、内容和质量");
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

  it("drives initialization from instruction reason codes rather than the first wait response", async () => {
    const skill = await readFile(resolve("skills/pairflow/SKILL.md"), "utf-8");

    expect(skill).toContain('reason_code: "WAIT_TIMEOUT"');
    expect(skill).toContain('reason_code: "TURN_ASSIGNED"');
    expect(skill).toContain('reason_code: "WORKFLOW_COMPLETED"');
    expect(skill).toContain("自动无参调用 `claim_turn`");
    expect(skill).toContain("不得以首次 wait 响应、tip 或单独的 `phase:\"idle\" / turn:\"idle\"` 判定");
  });

  it("documents event-driven JSON waiting and explicit turn claims", async () => {
    const readme = await readFile(resolve("README.md"), "utf-8");
    const waitTemplates = await Promise.all([
      "confirm/created.md",
      "confirm/existing.md",
      "confirm/joined.md",
      "confirm/recovered.md",
      "state/wait-other.md",
      "submit/wait.md",
    ].map((path) => readFile(resolve("templates/tips", path), "utf-8")));

    expect(readme).toContain("通过 workflow 变化事件和 deadline 等待");
    expect(readme).toContain("`claim_turn`");
    for (const template of waitTemplates) {
      expect(template).toContain("600s");
      expect(template).not.toContain("10s 间隔");
    }
  });
});

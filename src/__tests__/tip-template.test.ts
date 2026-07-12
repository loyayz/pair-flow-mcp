import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  resetTipTemplatesForTests,
  initializeTipTemplates,
  renderTip,
  DEFAULT_TIP_TEMPLATE_ROOT,
  type TemplateKey,
} from "../tip-template.js";

// ── Test helpers ────────────────────────────────────────────────────

function tmpRoot() {
  const root = resolve(tmpdir(), `pairflow-tip-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeTemplate(root: string, relativePath: string, content: string) {
  const full = resolve(root, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

/** Write all 45 templates minimally so the engine can initialize. */
function writeAllTemplates(root: string) {
  // response
  writeTemplate(root, "response/rejected.md", "[行动]\n请求被拒绝：{{message}}\n");
  // register
  writeTemplate(root, "register/success.md", "[行动]\nSet X-AI-Identity: {{token}}\n\n[当前]\n你是 {{identity}}。已注册。\n");
  // confirm
  writeTemplate(root, "confirm/existing.md", "[行动]\n调用 wait_for_turn...\n\n[当前]\n你是 {{identity}}（{{responsibility}}）。工作流 {{workflow_id}}，{{phase}} 阶段第 {{round}} 轮，turn 在 {{turn}}（{{turn_relation}}）。\n");
  writeTemplate(root, "confirm/created.md", "[行动]\n调用 wait_for_turn...\n\n[当前]\n你是 {{identity}}（{{responsibility}}）。已创建工作流 {{workflow_id}}。\n");
  writeTemplate(root, "confirm/recovered.md", "[行动]\n调用 wait_for_turn...\n\n[当前]\n你是 {{identity}}（{{responsibility}}）。已恢复工作流 {{workflow_id}}。\n");
  writeTemplate(root, "confirm/joined.md", "[行动]\n调用 wait_for_turn...\n\n[当前]\n你是 {{identity}}（{{responsibility}}）。工作流 {{workflow_id}}{{phase_status}}。双方已就位：{{participant_labels}}。\n");
  // get-state
  writeTemplate(root, "get-state/unbound.md", "[行动]\n调用 confirm_task...\n\n[当前]\n你是 {{identity}}。未绑定工作流。\n");
  writeTemplate(root, "get-state/inactive.md", "[行动]\n调用 confirm_task...\n\n[当前]\n你是 {{identity}}。未加入活跃 workflow。\n");
  writeTemplate(root, "get-state/recovery-pending.md", "[行动]\n调用 wait_for_turn...\n\n[当前]\n你是 {{identity}}。工作流 {{workflow_id}} 恢复未完成。\n");
  writeTemplate(root, "get-state/roster-pending.md", "[行动]\n调用 wait_for_turn...\n\n[当前]\n你是 {{identity}}。工作流 {{workflow_id}} 等待第二位参与者。\n");
  // wait
  writeTemplate(root, "wait/roster-warning.md", "[行动]\n建议向用户报告...\n\n[当前]\n你是 {{identity}}。已等待 {{elapsed_minutes}} 分钟。\n");
  writeTemplate(root, "wait/turn-warning.md", "[行动]\n建议向用户报告...\n\n[当前]\n你是 {{identity}}。第 {{round}} 轮，turn 在 {{turn}} 已超过 {{elapsed_minutes}} 分钟。\n");
  writeTemplate(root, "wait/timeout-ready.md", "[行动]\n继续调用 wait_for_turn...\n\n[当前]\n你是 {{identity}}。超时(600s)，第 {{round}} 轮，轮到你。\n");
  writeTemplate(root, "wait/timeout-roster.md", "[行动]\n继续调用 wait_for_turn...\n\n[当前]\n你是 {{identity}}。超时(600s)，参与者未就位。\n");
  writeTemplate(root, "wait/completed.md", "[行动]\n工作流已结束...\n\n[当前]\n你是 {{identity}}。工作流 {{workflow_id}} 已结束。\n");
  // advance
  writeTemplate(root, "advance/requirements-other.md", "[行动]\n等待 {{turn}} 产出需求分析...\n\n[产出]\n{{turn}} 将产出到 {{file_path}}\n\n[当前]\n你是 {{identity}}（supervisor）。第 1 轮需求分析，轮到 {{turn}} 了。\n");
  writeTemplate(root, "advance/planning-self.md", "[行动]\n产出实施计划...\n\n[产出]\n完成后 git commit，调用 submit，file_path = {{file_path}}\n\n[当前]\n你是 {{identity}}（supervisor）。第 1 轮实施计划，轮到你了。\n");
  writeTemplate(root, "advance/planning-other.md", "[行动]\n等待 {{turn}} 产出实施计划...\n\n[产出]\n{{turn}} 将产出到 {{file_path}}\n\n[当前]\n你是 {{identity}}（supervisor）。第 1 轮实施计划，轮到 {{turn}} 了。\n");
  writeTemplate(root, "advance/implementation-self.md", "[行动]\n进行代码实现...\n\n[产出]\n完成后 git commit，调用 submit，file_path = {{file_path}}\n\n[当前]\n你是 {{identity}}（supervisor）。第 1 轮代码实现，轮到你了。\n");
  writeTemplate(root, "advance/implementation-other.md", "[行动]\n等待 {{turn}} 产出代码实现...\n\n[产出]\n{{turn}} 将产出到 {{file_path}}\n\n[当前]\n你是 {{identity}}（supervisor）。第 1 轮代码实现，轮到 {{turn}} 了。\n");
  writeTemplate(root, "advance/summary-self.md", "[行动]\n产出汇总草稿...\n\n[产出]\n完成后 git commit，调用 submit，file_path = {{file_path}}\n\n[当前]\n你是 {{identity}}（supervisor）。第 1 轮汇总，轮到你了。\n");
  writeTemplate(root, "advance/completed.md", "[行动]\n如需开始新任务...\n\n[产出]\n已归档于 {{archive_root}}/\n\n[当前]\n你是 {{identity}}（supervisor）。工作流已结束。\n");
  // state
  writeTemplate(root, "state/idle-supervisor.md", "[行动]\n调用 advance 开始工作流\n\n[当前]\n你是 {{identity_label}}。\n");
  writeTemplate(root, "state/idle-other.md", "[行动]\n等待监督者调用 advance\n\n[当前]\n你是 {{identity_label}}。\n");
  writeTemplate(root, "state/wait-other.md", "[行动]\n等待 {{turn}} 完成当前轮次。调用 wait_for_turn...\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到 {{turn}} 了。\n");
  writeTemplate(root, "state/unknown.md", "[行动]\n未知的阶段/子阶段组合: phase={{phase}}, sub_phase={{sub_phase}}, round={{round}}\n");
  // requirements
  writeTemplate(root, "requirements/r1.md", "[行动]\n读取 {{task_path}} 并深度分析...\n\n[产出]\n完成后 git commit，调用 submit，file_path = {{file_path}}\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到你了。\n");
  writeTemplate(root, "requirements/r2.md", "[行动]\n先基于任务文档 {{task_path}} 独立分析，再审阅 {{prev_file}}（对方 commit: {{prev_commit}}）...\n\n[产出]\n完成后 git commit，调用 submit，file_path = {{file_path}}\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到你了。\n");
  writeTemplate(root, "requirements/rn.md", "[行动]\n审阅 {{prev_file}}（对方 commit: {{prev_commit}}）...\n\n[产出]\n完成后 git commit，调用 submit，file_path = {{file_path}}\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到你了。\n");
  writeTemplate(root, "requirements/rn-advance.md", "[行动]\n{{advance_target}}。否则审阅 {{prev_file}}（对方 commit: {{prev_commit}}）...\n\n[产出]\n完成后 git commit，调用 submit，file_path = {{file_path}}\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到你了。\n");
  // planning
  writeTemplate(root, "planning/r1.md", "[行动]\n读取 {{task_path}} 并产出实施计划...\n\n[产出]\n完成后 git commit，调用 submit，file_path = {{file_path}}\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到你了。\n");
  writeTemplate(root, "planning/rn.md", "[行动]\n审阅 {{prev_file}}（对方 commit: {{prev_commit}}）...\n\n[产出]\n完成后 git commit，调用 submit，file_path = {{file_path}}\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到你了。\n");
  writeTemplate(root, "planning/rn-advance.md", "[行动]\n{{advance_target}}。否则审阅 {{prev_file}}（对方 commit: {{prev_commit}}）...\n\n[产出]\n完成后 git commit，调用 submit，file_path = {{file_path}}\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到你了。\n");
  // implementation
  writeTemplate(root, "implementation/coding-r1.md", "[行动]\n根据 {{plan_file}} 进行代码实现...\n\n[产出]\n完成后 git commit，调用 submit，file_path = {{file_path}}\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到你了。\n");
  writeTemplate(root, "implementation/coding-rn.md", "[行动]\n根据上一轮评审意见 {{prev_file}}（对方 commit: {{prev_commit}}）修改代码...\n\n[产出]\n完成后 git commit，调用 submit，file_path = {{file_path}}\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到你了。\n");
  writeTemplate(root, "implementation/review-r2.md", "[行动]\n结合 {{plan_file}}，审阅代码产出 {{prev_file}}（对方 commit: {{prev_commit}}）...\n\n[产出]\n完成后 git commit，调用 submit，file_path = {{file_path}}\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到你了。\n");
  writeTemplate(root, "implementation/review-rn.md", "[行动]\n结合 {{plan_file}}、上一轮评审 {{previous_review}}，审阅 {{prev_file}}（对方 commit: {{prev_commit}}）...\n\n[产出]\n完成后 git commit，调用 submit，file_path = {{file_path}}\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到你了。\n");
  writeTemplate(root, "implementation/review-rn-advance.md", "[行动]\n{{advance_target}}。否则结合 {{plan_file}}、上一轮评审 {{previous_review}}，审阅 {{prev_file}}（对方 commit: {{prev_commit}}）...\n\n[产出]\n完成后 git commit，调用 submit，file_path = {{file_path}}\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到你了。\n");
  // summary
  writeTemplate(root, "summary/r1.md", "[行动]\n基于 {{task_path}} 和 {{archive_root}}/，产出汇总草稿...\n\n[产出]\n完成后 git commit，调用 submit，file_path = {{file_path}}\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到你了。\n");
  writeTemplate(root, "summary/r2.md", "[行动]\n审阅监督者的汇总草稿 {{prev_file}}（对方 commit: {{prev_commit}}）...\n\n[产出]\n完成后 git commit，调用 submit，file_path = {{file_path}}\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到你了。\n");
  writeTemplate(root, "summary/rn.md", "[行动]\n审阅 {{prev_file}}（对方 commit: {{prev_commit}}）...\n\n[产出]\n完成后 git commit，调用 submit，file_path = {{file_path}}\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到你了。\n");
  writeTemplate(root, "summary/rn-advance.md", "[行动]\n{{advance_target}}。否则审阅 {{prev_file}}（对方 commit: {{prev_commit}}）...\n\n[产出]\n完成后 git commit，调用 submit，file_path = {{file_path}}\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，轮到你了。\n");
  // submit
  writeTemplate(root, "submit/advance-ready.md", "[行动]\n等待监督者 {{supervisor}} 判断是否调用 advance 推进\n\n[产出]\n{{file_path}}（已提交）\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，turn 已切给 {{turn_label}}。本阶段双方已提交。\n");
  writeTemplate(root, "submit/both-submitted.md", "[行动]\n等待 {{turn}} 继续处理或确认后自然交还监督者 {{supervisor}}\n\n[产出]\n{{file_path}}（已提交）\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，turn 已切给 {{turn_label}}。本阶段双方已提交。\n");
  writeTemplate(root, "submit/wait.md", "[行动]\n等待 {{turn}} 完成当前轮次。调用 wait_for_turn...\n\n[产出]\n{{file_path}}（已提交）\n\n[当前]\n你是 {{identity_label}}。当前是第 {{round}} 轮{{phase_label}}，turn 已切给 {{turn_label}}。\n");
}

// ── Tests ───────────────────────────────────────────────────────────

describe("tip-template engine", () => {
  let root: string;

  beforeEach(() => {
    resetTipTemplatesForTests();
  });

  describe("initialization and validation", () => {
    it("throws on missing template file", () => {
      root = tmpRoot();
      writeAllTemplates(root);
      rmSync(resolve(root, "requirements/r1.md"));
      expect(() => initializeTipTemplates(root)).toThrow(/requirements\.r1/);
    });

    it("throws when template leaf is a directory", () => {
      root = tmpRoot();
      writeAllTemplates(root);
      rmSync(resolve(root, "requirements/r1.md"));
      mkdirSync(resolve(root, "requirements/r1.md"));
      expect(() => initializeTipTemplates(root)).toThrow(/requirements\.r1.*regular file/);
    });

    it("throws when template leaf is a symlink", () => {
      root = tmpRoot();
      writeAllTemplates(root);
      const realFile = resolve(root, "requirements/r1-real.md");
      writeFileSync(realFile, "[行动]\n读取 {{task_path}}\n\n[产出]\n{{file_path}}\n\n[当前]\n{{identity_label}} {{round}} {{phase_label}}\n", "utf8");
      rmSync(resolve(root, "requirements/r1.md"));
      // Symlink requires admin on Windows — only test when we can create one
      try {
        symlinkSync(realFile, resolve(root, "requirements/r1.md"));
        expect(() => initializeTipTemplates(root)).toThrow(/requirements\.r1.*regular file/);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === "EPERM") {
          // Windows without admin — skip the file-type assertion
          return;
        }
        throw e;
      }
    });

    it("throws on unknown placeholder in template", () => {
      root = tmpRoot();
      writeAllTemplates(root);
      // Overwrite a template with an unknown variable
      writeTemplate(root, "requirements/r1.md", "[行动]\nHello {{unknown_var}}\n\n[产出]\n{{file_path}}\n\n[当前]\n{{identity_label}} {{round}} {{phase_label}}\n");
      expect(() => initializeTipTemplates(root)).toThrow(/requirements\.r1.*unknown_var/);
    });

    it("throws when required variable is missing from template text", () => {
      root = tmpRoot();
      writeAllTemplates(root);
      // Overwrite with a template missing required task_path
      writeTemplate(root, "requirements/r1.md", "[行动]\nDo the analysis\n\n[产出]\n{{file_path}}\n\n[当前]\n{{identity_label}} {{round}} {{phase_label}}\n");
      expect(() => initializeTipTemplates(root)).toThrow(/requirements\.r1.*task_path/);
    });

    it("throws when rendering with missing required variable", () => {
      root = tmpRoot();
      writeAllTemplates(root);
      initializeTipTemplates(root);
      expect(() => renderTip("requirements.r1", {} as any)).toThrow(/requirements\.r1.*task_path/);
    });

    it("throws on unknown template key", () => {
      root = tmpRoot();
      writeAllTemplates(root);
      initializeTipTemplates(root);
      expect(() => renderTip("nonexistent.key" as TemplateKey, {})).toThrow(/nonexistent\.key/);
    });

    it("succeeds when all templates are valid", () => {
      root = tmpRoot();
      writeAllTemplates(root);
      expect(() => initializeTipTemplates(root)).not.toThrow();
    });
  });

  describe("rendering", () => {
    beforeEach(() => {
      root = tmpRoot();
      writeAllTemplates(root);
      initializeTipTemplates(root);
    });

    it("renders three sections in correct order", () => {
      const result = renderTip("requirements.r1", {
        task_path: "/path/to/task.md",
        file_path: "/path/to/output.md",
        identity_label: "claude（developer）",
        round: "1",
        phase_label: "需求分析",
      });
      expect(result).toContain("[行动] 读取 /path/to/task.md 并深度分析...");
      expect(result).toContain("[产出] 完成后 git commit，调用 submit，file_path = /path/to/output.md");
      expect(result).toContain("[当前] 你是 claude（developer）。当前是第 1 轮需求分析，轮到你了。");
      const actionIdx = result.indexOf("[行动]");
      const productIdx = result.indexOf("[产出]");
      const currentIdx = result.indexOf("[当前]");
      expect(actionIdx).toBeLessThan(productIdx);
      expect(productIdx).toBeLessThan(currentIdx);
    });

    it("renders template without optional sections", () => {
      const result = renderTip("response.rejected", { message: "test error" });
      expect(result).toBe("[行动] 请求被拒绝：test error");
      expect(result).not.toContain("[产出]");
      expect(result).not.toContain("[当前]");
    });

    it("does not re-read files on second render (cache)", () => {
      // Modify file after init — cache should still return old version
      writeTemplate(root, "response/rejected.md", "[行动]\nchanged: {{message}}\n");
      const result = renderTip("response.rejected", { message: "test" });
      expect(result).toBe("[行动] 请求被拒绝：test");
    });

    it("preserves {{nested}} in variable values (no double interpolation)", () => {
      const result = renderTip("response.rejected", { message: "bad {{nested}}" });
      expect(result).toBe("[行动] 请求被拒绝：bad {{nested}}");
    });

    it("handles template with only action and current sections", () => {
      const result = renderTip("state.idle.other", { identity_label: "claude（developer）" });
      expect(result).toContain("[行动] 等待监督者调用 advance");
      expect(result).toContain("[当前] 你是 claude（developer）。");
      expect(result).not.toContain("[产出]");
    });
  });

  describe("formatTip integration", () => {
    it("respects tip-format.ts section ordering", () => {
      root = tmpRoot();
      writeAllTemplates(root);
      // Replace with template that has sections in non-standard order
      // but formatTip() still outputs [行动] → [产出] → [当前]
      writeTemplate(root, "requirements/r1.md", [
        "[当前]",
        "current text {{identity_label}} {{round}} {{phase_label}}",
        "",
        "[产出]",
        "product text {{file_path}}",
        "",
        "[行动]",
        "action text {{task_path}}",
      ].join("\n"));
      initializeTipTemplates(root);
      const result = renderTip("requirements.r1", {
        task_path: "/t.md",
        file_path: "/o.md",
        identity_label: "x",
        round: "1",
        phase_label: "y",
      });
      // formatTip always outputs [行动] → [产出] → [当前], regardless of template parsing order
      const actionIdx = result.indexOf("[行动]");
      const productIdx = result.indexOf("[产出]");
      const currentIdx = result.indexOf("[当前]");
      expect(actionIdx).toBeLessThan(productIdx);
      expect(productIdx).toBeLessThan(currentIdx);
    });
  });

  describe("default root path", () => {
    it("default root is defined and absolute", () => {
      expect(typeof DEFAULT_TIP_TEMPLATE_ROOT).toBe("string");
      expect(DEFAULT_TIP_TEMPLATE_ROOT.length).toBeGreaterThan(0);
      expect(DEFAULT_TIP_TEMPLATE_ROOT).toContain("templates");
    });
  });
});

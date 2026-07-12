import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatTip } from "./tip-format.js";

// ── Types ──────────────────────────────────────────────────────────

export type TemplateKey =
  | "response.rejected"
  | "register.success"
  | "confirm.existing"
  | "confirm.created"
  | "confirm.recovered"
  | "confirm.joined"
  | "get-state.unbound"
  | "get-state.inactive"
  | "get-state.recovery-pending"
  | "get-state.roster-pending"
  | "wait.roster-warning"
  | "wait.turn-warning"
  | "wait.timeout-ready"
  | "wait.timeout-roster"
  | "wait.completed"
  | "advance.requirements.other"
  | "advance.planning.self"
  | "advance.planning.other"
  | "advance.implementation.self"
  | "advance.implementation.other"
  | "advance.summary.self"
  | "advance.completed"
  | "state.idle.supervisor"
  | "state.idle.other"
  | "state.wait.other"
  | "state.unknown"
  | "requirements.r1"
  | "requirements.r2"
  | "requirements.rn"
  | "requirements.rn.advance"
  | "planning.r1"
  | "planning.rn"
  | "planning.rn.advance"
  | "implementation.coding.r1"
  | "implementation.coding.rn"
  | "implementation.review.r2"
  | "implementation.review.rn"
  | "implementation.review.rn.advance"
  | "summary.r1"
  | "summary.r2"
  | "summary.rn"
  | "summary.rn.advance"
  | "submit.advance-ready"
  | "submit.both-submitted"
  | "submit.wait";

interface TemplateSpec {
  /** Relative file path from the template root */
  file: string;
  /** Variables the template is allowed to reference (required + optional) */
  allowed: string[];
  /** Variables that MUST appear in the template text */
  required: string[];
}

interface ParsedTemplate {
  sections: { action: string; product?: string; current?: string };
  allowedVars: Set<string>;
  requiredVars: Set<string>;
}

// ── Template spec registry ─────────────────────────────────────────

const TEMPLATE_SPECS: Record<TemplateKey, TemplateSpec> = {
  "response.rejected":           { file: "response/rejected.md",                    allowed: ["message"],                          required: ["message"] },
  "register.success":            { file: "register/success.md",                     allowed: ["token", "identity"],                required: ["token", "identity"] },
  "confirm.existing":            { file: "confirm/existing.md",                     allowed: ["identity", "responsibility", "workflow_id", "phase", "round", "turn", "turn_relation"], required: ["identity", "responsibility", "workflow_id", "phase", "round", "turn", "turn_relation"] },
  "confirm.created":             { file: "confirm/created.md",                      allowed: ["identity", "responsibility", "workflow_id"], required: ["identity", "responsibility", "workflow_id"] },
  "confirm.recovered":           { file: "confirm/recovered.md",                    allowed: ["identity", "responsibility", "workflow_id"], required: ["identity", "responsibility", "workflow_id"] },
  "confirm.joined":              { file: "confirm/joined.md",                       allowed: ["identity", "responsibility", "workflow_id", "phase_status", "participant_labels"], required: ["identity", "responsibility", "workflow_id", "phase_status", "participant_labels"] },
  "get-state.unbound":           { file: "get-state/unbound.md",                    allowed: ["identity"],                          required: ["identity"] },
  "get-state.inactive":          { file: "get-state/inactive.md",                   allowed: ["identity"],                          required: ["identity"] },
  "get-state.recovery-pending":  { file: "get-state/recovery-pending.md",           allowed: ["identity", "workflow_id"],           required: ["identity", "workflow_id"] },
  "get-state.roster-pending":    { file: "get-state/roster-pending.md",             allowed: ["identity", "workflow_id"],           required: ["identity", "workflow_id"] },
  "wait.roster-warning":         { file: "wait/roster-warning.md",                  allowed: ["identity", "elapsed_minutes"],       required: ["identity", "elapsed_minutes"] },
  "wait.turn-warning":           { file: "wait/turn-warning.md",                    allowed: ["identity", "elapsed_minutes", "round", "turn"], required: ["identity", "elapsed_minutes", "round", "turn"] },
  "wait.timeout-ready":          { file: "wait/timeout-ready.md",                   allowed: ["identity", "round"],                 required: ["identity", "round"] },
  "wait.timeout-roster":         { file: "wait/timeout-roster.md",                  allowed: ["identity"],                          required: ["identity"] },
  "wait.completed":              { file: "wait/completed.md",                       allowed: ["identity", "workflow_id"],           required: ["identity", "workflow_id"] },
  "advance.requirements.other":  { file: "advance/requirements-other.md",           allowed: ["identity", "turn", "file_path"],     required: ["identity", "turn", "file_path"] },
  "advance.planning.self":       { file: "advance/planning-self.md",                allowed: ["identity", "file_path"],             required: ["identity", "file_path"] },
  "advance.planning.other":      { file: "advance/planning-other.md",               allowed: ["identity", "turn", "file_path"],     required: ["identity", "turn", "file_path"] },
  "advance.implementation.self": { file: "advance/implementation-self.md",          allowed: ["identity", "file_path"],             required: ["identity", "file_path"] },
  "advance.implementation.other":{ file: "advance/implementation-other.md",         allowed: ["identity", "turn", "file_path"],     required: ["identity", "turn", "file_path"] },
  "advance.summary.self":        { file: "advance/summary-self.md",                 allowed: ["identity", "file_path"],             required: ["identity", "file_path"] },
  "advance.completed":           { file: "advance/completed.md",                    allowed: ["identity", "archive_root"],          required: ["identity", "archive_root"] },
  "state.idle.supervisor":       { file: "state/idle-supervisor.md",                allowed: ["identity_label"],                    required: ["identity_label"] },
  "state.idle.other":            { file: "state/idle-other.md",                     allowed: ["identity_label"],                    required: ["identity_label"] },
  "state.wait.other":            { file: "state/wait-other.md",                     allowed: ["identity_label", "turn", "round", "phase_label"], required: ["identity_label", "turn", "round", "phase_label"] },
  "state.unknown":               { file: "state/unknown.md",                        allowed: ["phase", "sub_phase", "round"],       required: ["phase", "sub_phase", "round"] },
  "requirements.r1":             { file: "requirements/r1.md",                      allowed: ["task_path", "file_path", "identity_label", "round", "phase_label"], required: ["task_path", "file_path", "identity_label", "round", "phase_label"] },
  "requirements.r2":             { file: "requirements/r2.md",                      allowed: ["task_path", "prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"], required: ["task_path", "prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"] },
  "requirements.rn":             { file: "requirements/rn.md",                      allowed: ["prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"], required: ["prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"] },
  "requirements.rn.advance":     { file: "requirements/rn-advance.md",              allowed: ["advance_target", "prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"], required: ["advance_target", "prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"] },
  "planning.r1":                 { file: "planning/r1.md",                          allowed: ["task_path", "file_path", "identity_label", "round", "phase_label"], required: ["task_path", "file_path", "identity_label", "round", "phase_label"] },
  "planning.rn":                 { file: "planning/rn.md",                          allowed: ["prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"], required: ["prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"] },
  "planning.rn.advance":         { file: "planning/rn-advance.md",                  allowed: ["advance_target", "prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"], required: ["advance_target", "prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"] },
  "implementation.coding.r1":    { file: "implementation/coding-r1.md",             allowed: ["plan_file", "file_path", "identity_label", "round", "phase_label"], required: ["plan_file", "file_path", "identity_label", "round", "phase_label"] },
  "implementation.coding.rn":    { file: "implementation/coding-rn.md",             allowed: ["prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"], required: ["prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"] },
  "implementation.review.r2":    { file: "implementation/review-r2.md",             allowed: ["plan_file", "prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"], required: ["plan_file", "prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"] },
  "implementation.review.rn":    { file: "implementation/review-rn.md",             allowed: ["plan_file", "previous_review", "prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"], required: ["plan_file", "previous_review", "prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"] },
  "implementation.review.rn.advance": { file: "implementation/review-rn-advance.md", allowed: ["advance_target", "plan_file", "previous_review", "prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"], required: ["advance_target", "plan_file", "previous_review", "prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"] },
  "summary.r1":                  { file: "summary/r1.md",                           allowed: ["task_path", "archive_root", "file_path", "identity_label", "round", "phase_label"], required: ["task_path", "archive_root", "file_path", "identity_label", "round", "phase_label"] },
  "summary.r2":                  { file: "summary/r2.md",                           allowed: ["prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"], required: ["prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"] },
  "summary.rn":                  { file: "summary/rn.md",                           allowed: ["prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"], required: ["prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"] },
  "summary.rn.advance":          { file: "summary/rn-advance.md",                   allowed: ["advance_target", "prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"], required: ["advance_target", "prev_file", "prev_commit", "file_path", "identity_label", "round", "phase_label"] },
  "submit.advance-ready":        { file: "submit/advance-ready.md",                 allowed: ["supervisor", "file_path", "identity_label", "round", "phase_label", "turn_label"], required: ["supervisor", "file_path", "identity_label", "round", "phase_label", "turn_label"] },
  "submit.both-submitted":       { file: "submit/both-submitted.md",                allowed: ["turn", "supervisor", "file_path", "identity_label", "round", "phase_label", "turn_label"], required: ["turn", "supervisor", "file_path", "identity_label", "round", "phase_label", "turn_label"] },
  "submit.wait":                 { file: "submit/wait.md",                          allowed: ["turn", "file_path", "identity_label", "round", "phase_label", "turn_label"], required: ["turn", "file_path", "identity_label", "round", "phase_label", "turn_label"] },
} as const;

// ── Default root ────────────────────────────────────────────────────

export const DEFAULT_TIP_TEMPLATE_ROOT = fileURLToPath(
  new URL("../templates/tips/", import.meta.url),
);

// ── Registry ────────────────────────────────────────────────────────

let registry: Map<TemplateKey, ParsedTemplate> | null = null;

const PLACEHOLDER_RE = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;

function extractPlaceholders(text: string): string[] {
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((match = PLACEHOLDER_RE.exec(text)) !== null) {
    names.add(match[1]);
  }
  return [...names];
}

function parseAndValidate(key: TemplateKey, filePath: string, raw: string, spec: TemplateSpec): ParsedTemplate {
  // Parse into sections: [行动] / [产出] / [当前]
  const actionMatch = raw.match(/\[行动\]\s*\n([\s\S]*?)(?=\n\[产出\]|\n\[当前\]|$)/);
  const productMatch = raw.match(/\[产出\]\s*\n([\s\S]*?)(?=\n\[当前\]|$)/);
  const currentMatch = raw.match(/\[当前\]\s*\n([\s\S]*?)$/);

  if (!actionMatch || !actionMatch[1].trim()) {
    throw new Error(`tip template ${key} must contain a non-empty [行动] section: ${filePath}`);
  }

  const action = actionMatch[1].trim();
  const product = productMatch?.[1]?.trim() || undefined;
  const current = currentMatch?.[1]?.trim() || undefined;

  const sectionsText = [action, product, current].filter(Boolean).join("\n");
  const placeholders = extractPlaceholders(sectionsText);
  const allowedSet = new Set(spec.allowed);
  const requiredSet = new Set(spec.required);

  // Check no unknown placeholders
  for (const ph of placeholders) {
    if (!allowedSet.has(ph)) {
      throw new Error(`tip template ${key} references unknown placeholder "{{${ph}}}" (allowed: ${spec.allowed.join(", ")}): ${filePath}`);
    }
  }

  // Check all required placeholders appear in template
  for (const req of requiredSet) {
    if (!placeholders.includes(req)) {
      throw new Error(`tip template ${key} missing required placeholder "{{${req}}}": ${filePath}`);
    }
  }

  return {
    sections: { action, product, current },
    allowedVars: allowedSet,
    requiredVars: requiredSet,
  };
}

function renderOne(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_full, name: string) => {
    if (name in values) return String(values[name]);
    throw new Error(`missing required variable "${name}" during rendering`);
  });
}

// ── Public API ──────────────────────────────────────────────────────

export function initializeTipTemplates(root: string = DEFAULT_TIP_TEMPLATE_ROOT): void {
  const loaded = new Map<TemplateKey, ParsedTemplate>();

  for (const [key, spec] of Object.entries(TEMPLATE_SPECS) as [TemplateKey, TemplateSpec][]) {
    const file = resolve(root, spec.file);
    let stat;
    try {
      stat = lstatSync(file);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      throw new Error(`tip template ${key} file not found: ${file}${code ? ` (${code})` : ""}`);
    }
    if (!stat.isFile()) {
      throw new Error(`tip template ${key} must be a regular file: ${file}`);
    }
    const raw = readFileSync(file, "utf8");
    loaded.set(key, parseAndValidate(key, file, raw, spec));
  }

  registry = loaded;
}

export function renderTip(key: TemplateKey, values: Record<string, string | number>): string {
  if (!registry) {
    throw new Error("tip templates not initialized — call initializeTipTemplates() first");
  }
  const template = registry.get(key);
  if (!template) {
    throw new Error(`unknown tip template key: ${key}`);
  }

  // Validate all required variables are provided
  for (const req of template.requiredVars) {
    if (!(req in values)) {
      throw new Error(`tip template ${key} missing required variable "${req}" in render call`);
    }
  }

  const action = renderOne(template.sections.action, values);
  const product = template.sections.product ? renderOne(template.sections.product, values) : undefined;
  const current = template.sections.current ? renderOne(template.sections.current, values) : undefined;

  return formatTip({ action, product, current });
}

export function resetTipTemplatesForTests(): void {
  registry = null;
}

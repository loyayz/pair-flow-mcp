#!/usr/bin/env tsx
/**
 * Lint script: validates catalog spec_ref references and coverage.
 * Usage: npx tsx scripts/lint-catalog.ts
 */

import { rulesCatalog } from "../src/template.js";
import { readFile } from "node:fs/promises";

async function main() {
  const specPath = "docs/superpowers/specs/2026-06-21-pair-flow-design.md";
  const spec = await readFile(specPath, "utf-8");
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Validate spec_ref — each reference must exist in spec
  for (const rule of rulesCatalog) {
    const ref = rule.spec_ref.replace("§", "§").replace(/§(\d+(\.\d+)?)/, "");
    const section = rule.spec_ref.replace("§", "").split(".")[0];
    if (!spec.includes(`## ${section}.`)) {
      errors.push(`[${rule.id}] spec_ref "${rule.spec_ref}" not found in spec`);
    }
  }

  // 2. Coverage check — all §1-§17 should have at least one rule
  const covered = new Set<string>();
  for (const rule of rulesCatalog) {
    const section = rule.spec_ref.match(/§(\d+)/)?.[1];
    if (section) covered.add(section);
  }
  // Also check §17 explicitly
  const totalSections = 17;
  for (let i = 1; i <= totalSections; i++) {
    if (!covered.has(String(i))) {
      warnings.push(`Section §${i} has NO rules covering it`);
    }
  }

  // 3. Validate trigger values
  const validTriggers = ["submit", "claim_turn", "advance", "create_issue", "resolve_issue"];
  for (const rule of rulesCatalog) {
    if (!validTriggers.includes(rule.trigger)) {
      errors.push(`[${rule.id}] invalid trigger "${rule.trigger}"`);
    }
  }

  if (errors.length > 0) {
    console.error("ERRORS:");
    errors.forEach((e) => console.error(`  ${e}`));
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.log("WARNINGS:");
    warnings.forEach((w) => console.log(`  ${w}`));
  }

  console.log(`OK: ${rulesCatalog.length} rules, ${covered.size}/${totalSections} sections covered`);
}

main().catch((err) => { console.error(err); process.exit(1); });

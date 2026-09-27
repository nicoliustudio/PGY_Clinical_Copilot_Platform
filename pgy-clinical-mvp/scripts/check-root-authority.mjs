#!/usr/bin/env node
/**
 * Root-authority architecture smell audit.
 *
 * Static check for the known "implicit authority" leaks that P0-1/P0-2/P0-3/P0-6 removed:
 *   - source order must never select a primary product;
 *   - SOURCE_NODE candidate must not expose top-level formulaId/formulaName authority;
 *   - retrieval must never auto-adopt modifications;
 *   - terminology/diagnosis map must never hard-delete a source;
 *   - diseaseRefs must not be conflated with source ids or evidence refs.
 *
 * These are architecture findings, not case-specific failures. Semantic tests (root-invariants.test.ts)
 * are the final gate; this script only flags regressions in the known patterns.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// Use substring matching (not regex) to avoid escaping pitfalls; patterns are literal code fragments.
const checks = [
  {
    id: 'SOURCE_FIRST_PRODUCT_AUTHORITY',
    files: ['clinical/formula-evidence.ts', 'clinical/source-formula-set.ts', 'clinical/modification-adoption-transaction.ts', 'platform/commit/source-bound-core.ts'],
    fragments: ['products[0]', 'activeFormulas[0]', "index === 0 ? 'PRIMARY_SELECTED'"],
  },
  {
    id: 'IMPLICIT_PRIMARY_FROM_SOURCE_ORDER',
    files: ['clinical/source-formula-set.ts', 'platform/commit/source-bound-core.ts'],
    fragments: ['expected exactly 1 PRIMARY_SELECTED', 'defaults to the first active product'],
  },
  {
    id: 'RETRIEVAL_AUTO_ADOPTION',
    files: ['clinical/formula-selection-transaction.ts'],
    fragments: ['searchModificationEvidence', 'modification.plan.recorded'],
  },
  {
    id: 'DISEASE_MAP_HARD_DELETE',
    files: ['clinical/formula-evidence.ts'],
    fragments: ['isApplicableDisease(h.provenance.disease'],
  },
  {
    id: 'OVERLOADED_DISEASE_REFS',
    files: ['adapters/ai-sdk/tool-bindings.ts', 'clinical/formula-evidence.ts', 'platform/workspace/proposal-draft.ts'],
    fragments: ["docs.find((d) => d.id === ref)", '...(disease.diseaseRefs ?? []), ...disease.evidenceRefs'],
  },
  {
    id: 'CANONICAL_CANDIDATE_REQUIRES_LEGACY_PRIMARY',
    files: ['platform/commit/delivery-transaction.ts'],
    fragments: ["formula.relation === 'PRIMARY_SELECTED'", "find((formula) => formula.relation === 'PRIMARY_SELECTED')"],
  },
  {
    id: 'LEGACY_RELATION_DRIVES_COMMIT',
    files: ['platform/commit/delivery-transaction.ts'],
    fragments: ['formula.relation ===', 'formula.relation !==', 'formula.relation ?'],
  },
  {
    id: 'IMPLICIT_MODIFICATION_PRODUCT_TARGET',
    files: ['clinical/modification-adoption-transaction.ts', 'platform/commit/delivery-transaction.ts'],
    fragments: ['formulas[0]', 'selectedProducts[0] ??'],
  },
  {
    id: 'RATIONALE_ONLY_SELECTION_ALLOWED',
    files: ['clinical/formula-selection-transaction.ts'],
    fragments: ['fact refs are optional', 'rationale-only decision remains valid'],
  },
  {
    id: 'UNKNOWN_AS_CONTRADICTION',
    files: ['clinical/formula-selection-transaction.ts', 'clinical/canonical-clinical-state.ts'],
    fragments: ["polarity !== 'present'", 'NOT_MENTIONED/absent is not negative evidence'],
  },
  {
    id: 'STAGE_GUIDANCE_REGEX_INFERENCE',
    files: ['clinical/source-formula-set.ts', 'clinical/formula-evidence.ts', 'knowledge/build.ts'],
    fragments: ['composition.match(', 'composition.split(', '/先.*待.*再/', 'stageRegex'],
  },
];

let findings = 0;
for (const check of checks) {
  for (const relative of check.files) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const fragment of check.fragments) {
      if (text.includes(fragment)) {
        findings++;
        console.log(`[FOUND] ${check.id} :: ${relative} :: ${JSON.stringify(fragment)}`);
      }
    }
  }
}
if (findings === 0) {
  console.log('No known root-authority smell matched. Run semantic tests (root-invariants.test.ts) as the final gate.');
} else {
  console.log(`\n${findings} root-authority smell(s) matched. These are architecture findings, not case-specific failures.`);
}
process.exitCode = findings > 0 ? 2 : 0;

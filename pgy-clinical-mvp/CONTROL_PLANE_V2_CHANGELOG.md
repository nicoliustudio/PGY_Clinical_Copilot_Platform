> **Historical V2 reference. For new implementation/migration work, use `CONTROL_PLANE_V21_FINAL.md` and `TRAE_EXECUTION.md`.**

# Control Plane V2 Reference Changelog

This package is intentionally a **migration reference**, not a claim that the production runtime has already been fully cut over.

## Added

- `src/control-plane-v2/types.ts`
  - `ClinicalRequestIR`
  - capability effect descriptors
  - obligation graph types
  - typed blockers
  - bound durable artifact envelope
- `src/control-plane-v2/request-ir.ts`
  - structured request compiler contract/prompt
  - normalization and exclusivity semantics
- `src/control-plane-v2/capability-resolver.ts`
  - semantic outcome → provider resolution
  - exclusive request activation filter
- `src/control-plane-v2/obligation-graph.ts`
  - initial dependency graph
  - runnable obligation projection
  - artifact-driven closure
  - typed blocker transition
- `src/control-plane-v2/action-surface.ts`
  - effect-driven tool projection
- `src/control-plane-v2/delivery-artifacts.ts`
  - Runtime-owned capability/obligation delivery identity
- `src/control-plane-v2/result-projection.ts`
  - deterministic source-formula cardinality projection
  - deterministic treatment-delivery projection
- `reference/control-plane-v2/runtime.mjs`
  - zero-dependency executable reference
- `reference/control-plane-v2/selftest.mjs`
  - deterministic architecture invariants
- `scripts/control-plane-v2-check.mjs`
  - zero-dependency check entry point
- `tests/control-plane-v2.test.ts`
  - TypeScript regression scaffold for the production suite
- `CONTROL_PLANE_V2.md`
  - architecture rationale and target state
- `TRAE_EXECUTION.md`
  - exact migration order / gates / acceptance criteria

## Modified

- `src/contracts/capability.ts`
  - optional `controlPlaneV2.effects` migration metadata
- `src/contracts/tool.ts`
  - optional tool `effects`
- `src/contracts/runtime.ts`
  - optional shadow `controlPlaneV2` run state
- `src/composition/platform-assets.ts`
  - reference effect metadata on platform tools
- `capabilities/*/capability.json`
  - semantic `modality:*` provides + V2 effect declarations
- `package.json`
  - `control:v2:check`
  - `test:control:v2`

## Intentionally NOT cut over yet

The following production paths remain legacy and are migration targets for Trae:

- `agent-runtime.ts` still owns `actionClassOf` / `PHASE_ALLOWED_CLASSES`.
- production readiness still uses legacy artifact/completion projections.
- treatment delivery is not yet persisted as generic bound durable artifacts.
- `ClinicalResult` remains primarily single-formula shaped.
- production final output is not yet fully assembled from V2 durable artifacts.

This is deliberate: the safe path is shadow → compare → cut over → delete legacy, rather than a blind rewrite.

## Locally verified in this package

```text
npm run control:v2:check
→ Control Plane V2 selftest: PASS
```

The full TypeScript suite was not rerun in this environment because the supplied archive did not include `node_modules` and dependency installation did not complete here. Trae must run `npm ci`, `npm run typecheck`, and `npm test` before and after integration.

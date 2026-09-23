# Control Plane V2.1 Changelog

## Added

- `src/control-plane-v21/types.ts`
  - parameterized ArtifactPattern / ArtifactTarget
  - small domain-neutral EffectOperation algebra
  - production rules / planning issues / V2.1 graph types
- `src/control-plane-v21/terms.ts`
  - variable binding
  - artifact unification
  - effect instantiation
  - structural effect-pattern matching
- `src/control-plane-v21/provider-resolver.ts`
  - terminal outcome → capability/rule resolution
- `src/control-plane-v21/planner.ts`
  - generic backward-chaining dependency expansion
  - target dedupe
  - ambiguity / unsupported / cycle handling
- `src/control-plane-v21/artifacts.ts`
  - runtime-owned artifact binding
  - exact obligation closure
  - imported-artifact migration adapter
- `src/control-plane-v21/action-surface.ts`
  - structural tool-effect projection
- `src/control-plane-v21/blockers.ts`
  - typed evidence-gap recovery
- `src/control-plane-v21/result-projection.ts`
  - deterministic outcome coverage projection
- `src/composition/control-plane-v21-policy.ts`
  - baseline outcome policy moved out of generic planner
- `reference/control-plane-v21/*`
  - zero-dependency executable reference
- `scripts/control-plane-v21-check.mjs`
  - 18-invariant deterministic selftest

## Extended

- `CapabilityDescriptor`
  - optional `controlPlaneV21.rules`
- `RuntimeToolDescriptor`
  - optional `effectPatternsV21`
- capability manifests
  - V2.1 production rules added while legacy/V2 metadata retained for migration
- `src/composition/platform-assets.ts`
  - parameterized V2.1 tool effect patterns
- `package.json`
  - `control:v21:check`
  - `test:control:v21`

## Key architectural difference vs V2

V2:

```text
EffectId string intersection
+ graph builder knows selected artifact categories
```

V2.1:

```text
parameterized EffectTerm structural matching
+ generic rule unification/backward chaining
```

The generic planner is intentionally forbidden from knowing modality names, clinical artifact names, disease names, or tool ids.

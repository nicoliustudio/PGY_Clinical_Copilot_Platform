# PGY Clinical Agent Harness H1 — 改动清单

## 核心变化

- RuntimePreparer 从“预先解析 Capability/Skill/Scope”降级为 Harness bootstrap：只建立共享语义 seed、baseline skill/tool/scope 和 Safety Decision。
- 新增 `HarnessControlPort` + `HarnessSession`：Agent 在 loop 内通过 `capability.search` / `capability.activate` 发现并激活业务能力。
- AI SDK adapter 使用 `prepareStep` 每一步重新计算 `activeTools` 与 instructions；Capability 激活后的 Skill/Scope/Tool 在后续 step 生效。
- RAG 增加 `knowledge.get_source`，允许 search → inspect → re-search → compare。
- `formula.search_normative` 现在严格使用当前 Harness Session 的 knowledge scopes。
- `formula.validate` / Authority 升级为 `source_id + formula_id + composition` 同一 P1 记录绑定校验。
- Safety 从 `severity=high => BLOCK` 改为 `disposition` 驱动：severity 只描述严重程度；`routine / urgent / uncertain` 决定 Runtime 行为。
- Formula Authority 失败不再伪装成 Safety BLOCK；Eval 分开统计 `SAFETY_BLOCK` 与 `FORMULA_AUTHORITY_ERROR`。
- Trace 从模块级单例改为按 `runId` 隔离，避免并发病例串线。
- 删除生产主路径旧 `SemanticNeedCapabilityResolver` 精确 key 匹配；legacy 版本仅迁移到 `src/experiments/classic/` 供 A/B。
- 增加 `CLINICAL_RUNTIME_MODE=harness|classic` 与 debug/holdout A/B scripts。

## 新增文件

- `src/contracts/harness.ts`
- `src/platform/runtime/harness-session.ts`
- `src/adapters/ai-sdk/tool-bindings.ts`
- `src/clinical/formula-binding.ts`
- `src/experiments/classic/classic-runtime-preparer.ts`
- `src/experiments/classic/semantic-need-resolver.ts`
- `prompts/clinical-primary-classic/*`
- `tests/trace-isolation.test.ts`
- `tests/formula-binding.test.ts`
- `VALIDATION_H1.md`
- `H1_CHANGELOG.md`

## 主要修改文件

- `src/adapters/ai-sdk/agent-runtime.ts`
- `src/platform/runtime/runtime-preparer.ts`
- `src/clinical/understanding.ts`
- `src/clinical/risk.ts`
- `src/platform/authority/risk-safety-port.ts`
- `src/clinical/formula.ts`
- `src/authority/formula-authority.ts`
- `src/platform/authority/formula-stage.ts`
- `src/knowledge/search.ts`
- `src/trace.ts`
- `src/eval/run.ts`
- `src/composition/runtime.ts`
- `src/composition/platform-assets.ts`
- `prompts/clinical-primary/prompt.md`
- `skills/general-clinical-reasoning/SKILL.md`
- `tests/helpers.ts`
- `tests/runtime-assembly.test.ts`
- `tests/registry-extension.test.ts`

## 删除/迁移

- 删除生产路径 `src/platform/runtime/semantic-need-resolver.ts`
- legacy 精确匹配实现迁移到 `src/experiments/classic/semantic-need-resolver.ts`，仅供 A/B

## 本地验收

```powershell
cd pgy-clinical-mvp
npm install
npm run typecheck
npm test
npm run arch:test
```

需要私有资产/凭据的 `build:index`、`eval:*` 仍按原边界在本地运行。

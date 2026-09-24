# AUTHORITY BOUNDARY CLOSURE REPORT

> 基线：`f88419713d7c0b9e1ebc226b1b10e2f0e7e4c1ec`（Authority Cutover）
>
> 本次：完成 Authority Boundary Closure，把「已确定的事实」改为只能被验证 / 标记状态 / 投影，不能被下游重新选择、删除、改写身份或重新解释。

---

## 0. 交付概览

| 项 | 值 |
| --- | --- |
| 基线 commit | `f88419713d7c0b9e1ebc226b1b10e2f0e7e4c1ec` |
| 变更文件 | 19 个修改 + 5 个新增（详见 §7） |
| 新增源码 | `contracts/tool-failure.ts`、`platform/commit/fact-ownership.ts` |
| 新增脚本 | `scripts/check-authority-boundary-closure.mjs`、`scripts/authority-boundary-e2e.ts` |
| 新增测试 | `tests/authority-boundary-closure.test.ts` |

---

## 1. 不变量逐条结论

### 1.1 Source Completeness —— PASS

`Canonical SourceBundle N → CommitRecord.sourceBundle N → Final/UI N` 成立。

证据（E2E-2 + `authority-boundary-closure.test.ts` + `delivery-integrity.test.ts`）：

- `hydrateSourceFormulaSet` 保留全部 ACTIVE sibling，`projectFormulaSet` 不含 `.filter`。
- E2E-2 真实 P1 source `P1:K_6269b2dda7f4`（N=3）：
  - `SourceBundle.products = 3`
  - `delivery.commit` 后 `Commit.sourceBundle.products = 3`
  - `Final.formula_set = 3`
  - `UI.formula_set = 3`
- `CLINICALLY_EXCLUDED` 只改 `qualification`，不改 membership：`qualifications = ["PRIMARY_SELECTED","SOURCE_ALTERNATIVE","CLINICALLY_EXCLUDED"]`，N 恒为 3。

### 1.2 Product Completeness —— PASS

`PRESENT / KNOWN_EMPTY / UNKNOWN` 从 knowledge 层贯穿到 Final/UI，三类 modification provenance 独立保留。

证据（`authority-boundary-closure.test.ts` 三态 fixture + E2E-2 2a）：

- `facts` 字段新增到 `ProjectedFormula`（lossless compatibility projection），含 `composition / preparation / usage / modifications{formulaLocal, sourceShared, patientSpecific}`，每项 `FactField<T>` 带 `presence + value + provenanceRefs`。
- fixture 验证三态 round-trip：F1 `PRESENT`、F2 `KNOWN_EMPTY`、F3 `UNKNOWN`（缺失字段 ≠ 空数组）。
- 三类 modification 独立 provenance：`formulaLocal`（provenance `formulaRef`）、`sourceShared`（provenance `parentRecordRef`）、`patientSpecific`（patient evidence refs）。

### 1.3 Intent Fidelity —— PASS

`required exact outcome 只能由 matching Kernel Commit 满足；excluded outcome 不得进入 authoritative Final`。

证据（E2E-1）：

- `required = [modality:acupuncture]`，`excluded = [modality:herbal-formula]`，`exclusive = true`。
- `effectiveRequiredOutcomesV21` 含 acupuncture、不含 herbal。
- `excluded herbal` 无法被 adopt（`OUTCOME_EXCLUDED`），原始 RequestIR 不可变。
- Final 无 herbal product（excluded 不泄漏）。

### 1.4 Fact Ownership —— PASS

`clinical-assessment 只拥有 principle 级事实；modality execution facts 只属于 treatment delivery Commit`。

证据（`fact-ownership.ts` + `authority-boundary-closure.test.ts` + E2E-1）：

- `buildClinicalAssessmentProduct` 只产出 `{disease, syndrome, treatmentPrinciple, treatmentTarget, rationale}`。
- `validateClinicalAssessmentFactOwnership` 拒绝 `points/operation/frequency/course/composition/modifications` 等 execution facts（`IDENTITY_MISMATCH`）。
- E2E-1：`forbidden = ["points","operation","frequency","course"]`。

### 1.5 Adoption Reachability —— PASS

`delivery.adopt` 提供合法、typed、可审计的 contract expansion，只创建义务不产生产品。

证据（`tool-bindings.ts` 新增 `delivery.adopt` + `authority-boundary-closure.test.ts`）：

- `effectiveRequestIRV21(original, adoptedOutcomes)` 返回新 IR，不改写 original。
- adopt 拒绝 `excluded` / `exclusive` contract 外 / `unsupported` / `ambiguous` outcome（typed failure）。
- adopt 幂等；成功后 `refreshControlPlaneV21` 重建 obligation graph。
- E2E-1：`effectiveRequestIRV21` 未改写原始 excluded，原始 `required` 仍只有 acupuncture。

### 1.6 Single Completion Truth —— PASS

`V2.1 COMPILED 时只有 obligation graph 定义 required/missing/complete/readiness`。

证据（`tool-bindings.ts` + `check-authority-boundary-closure.mjs`）：

- `workspace.record_deliberation` 在 V2.1 下忽略 Agent 写入的 `completionObligation`，返回 `completionAuthority: 'CONTROL_PLANE_GRAPH'`。
- `workspaceEventsForTool` 不再把被忽略的 `completionObligation` 写成 durable event（`ignoredArtifacts`）。
- readiness 已从 `requiredArtifactsFromGraphV21` 派生（既存 `control-plane-v21-session.ts`），架构 gate 静态断言不读 Agent completionObligation / planner provisional requirements。

### 1.7 Typed Failure Recovery —— PASS

`expected validation failure 返回 typed tool result，不 throw；失败输入不得写 Workspace`。

证据（`tool-failure.ts` + `agent-runtime.ts` + `workspace-events.ts` + `authority-boundary-closure.test.ts`）：

- `ToolFailure` contract：`{ ok:false, error:{ code, message, path, received, expected, allowedNextActions, details } }`。
- validator 用 `toolContractError()` 抛 `ToolContractError`，`wrapToolWithLedger` 捕获并转成 `ToolFailureOutput`，`ledger.record` 后返回，Agent 拿到机器可读错误。
- `workspaceEventsForTool` 对 `isToolFailureOutput(output) || accepted === false` 返回 `[]`，拒绝输入不落 Workspace。
- unexpected exception 经 `serializeToolError()` 序列化为 `{name,message,code,stack?}`，不再出现 `{}`。
- `delivery.commit` 统一到同一 envelope（`toolFailure(result.code, ...)`）。

### 1.8 Final/UI N→N —— PASS

证据（E2E-2 + `ui-views.test.ts`）：

- `buildResultView` 不丢 `formula_set`（含 excluded sibling）。
- `ui/app.js` 用 `renderFact` 分别渲染三态与三类 modification，不按 presence/qualification 筛选。
- E2E-2：`SourceBundle 3 → Commit 3 → Final 3 → UI 3`。

---

## 2. 验证结果

| 命令 | 结果 |
| --- | --- |
| `npm ci` | —（node_modules 已存在，未重装） |
| `npm run typecheck` | PASS（0 error） |
| `npm run build:index` | PASS（schemaVersion 3, 4428 docs） |
| `npm test` | **503 / 503 PASS** |
| `npm run arch:test` | PASS（9 capability markers） |
| `npm run authority:check` | 23 / 23 PASS |
| `npm run authority-boundary:check` | PASS |
| `npm run control:v211:check` | 29 / 29 PASS |
| `npm run control:v212:check` | 17 / 17 PASS |
| `npx tsx scripts/authority-boundary-e2e.ts` | **27 / 27 PASS** |

---

## 3. 两个 E2E 详情

### E2E-1 针灸 exact modality

```text
RequestIR.required  = [modality:acupuncture]
RequestIR.excluded  = [modality:herbal-formula]
RequestIR.exclusive = true

effective required = [outcome:clinical-assessment, modality:acupuncture]  （不含 herbal）
原始 RequestIR immutable（required 仍只有 acupuncture）

针灸交付 mandatory fields complete（provider manifest requiredFields）
clinical-assessment product = {disease, syndrome, treatmentPrinciple, treatmentTarget, rationale}
clinical-assessment 拒绝 modality execution facts（forbidden = points/operation/frequency/course）
```

### E2E-2 canonical 多产品 SourceBundle

```text
[三态 fixture]
SourceBundle.products = 3
F1 formulaLocal PRESENT / F2 KNOWN_EMPTY / F3 UNKNOWN（缺失字段）
F3 composition UNKNOWN
sourceShared PRESENT
CLINICALLY_EXCLUDED 后 N 不变（=3）

[真实 P1 source P1:K_6269b2dda7f4, N=3]
SourceBundle.products = 3
delivery.commit (modality:herbal-formula) → providerId=tcm.core
Commit.sourceBundle.products = 3
Commit.sourceBundle qualifications = [PRIMARY_SELECTED, SOURCE_ALTERNATIVE, CLINICALLY_EXCLUDED]
Final.formula_set = 3
UI.formula_set = 3
```

---

## 4. 核心链路（不变式）

```text
Fact established once
  → one authority owner
  → immutable semantic identity
  → lossless committed product/source facts
  → qualification only annotates
  → completion only reads canonical graph/ledger
  → Final/UI only project
```

---

## 5. 与参考实现的差异（本次合并中修复的缺陷）

参考实现 `PGY-authority-boundary-reference-f884197.zip` 自述「full tsc / tests NOT certified」。本次吸收后修复了以下 typecheck / 测试问题，未降低任何不变量：

1. `tests/ui-views.test.ts`：参考测试的 `formula_set` 项缺必填 `modification_text` → 补上（三态各自合法值）。
2. `tests/tool-output-envelope.test.ts`：旧断言 `result.error instanceof Error` 与新 `serializeToolError` 契约冲突 → 改为断言 JSON-safe `{message}` 结构。
3. `scripts/authority-boundary-e2e.ts`（新增）：补 `loadSkills` import；`view.formula_set?.some(...)` 用 `Boolean()` 包裹。

---

## 6. 架构 gate

`scripts/check-authority-boundary-closure.mjs` 新增静态门禁（`npm run authority-boundary:check`）：

- `delivery.adopt` 已注册；`PRODUCT_OUTCOME_NOT_ADOPTED` typed handshake 存在。
- 无裸 `throw new Error(`（expected validation）。
- `workspaceEventsForTool` 用 `isToolFailureOutput` + `serializeToolError`。
- `refreshControlPlaneV21` 消费 `effectiveRequestIRV21(state)`。
- V2.1 readiness 只读 graph（不读 Agent completionObligation / planner provisional requirements）。
- proposal canonicalizer 在 V2.1 下不 materialize product。
- `clinical-runtime` 有 `v21Authoritative` 隔离 + `buildClinicalAssessmentProduct` + `facts` 投影。
- `projectFormulaSet` 无 `.filter`、含 `patientSpecific`。
- UI 保留三态/三类 modification 文案。

---

## 7. 变更文件清单

新增：

- `src/contracts/tool-failure.ts`
- `src/platform/commit/fact-ownership.ts`
- `scripts/check-authority-boundary-closure.mjs`
- `scripts/authority-boundary-e2e.ts`
- `tests/authority-boundary-closure.test.ts`

修改：

- `src/adapters/ai-sdk/agent-runtime.ts`（typed failure 捕获 + no-progress + durableProgressSignature + effectiveRequiredOutcomes）
- `src/adapters/ai-sdk/proposal-canonicalizer.ts`（V2.1 下不 hydrate product）
- `src/adapters/ai-sdk/tool-bindings.ts`（typed failure + `delivery.adopt` + completion 去控制权）
- `src/adapters/ai-sdk/tool-call-ledger.ts`（invocation-time reuse 捕获）
- `src/adapters/ai-sdk/workspace-events.ts`（failure 不落 Workspace + serializeError + ignoredArtifacts）
- `src/composition/platform-assets.ts`（`delivery.adopt` 注册）
- `src/contracts/agent-loop.ts`（`no_progress` + adoptedOutcomes trace）
- `src/contracts/result.ts`（`projectedFactSchema` + `facts`）
- `src/contracts/runtime.ts`（`adoptedOutcomes`）
- `src/control-plane-v2/result-projection.ts`（`ProjectedFormulaFacts` + lossless `facts`）
- `src/platform/agent/clinical-runtime.ts`（fact ownership + v21 隔离 + `committedClinicalAssessment` + lossless projection）
- `src/platform/commit/commit-coordinator.ts`（`IDENTITY_MISMATCH` code）
- `src/platform/control-plane/control-plane-v21-session.ts`（`effectiveRequestIRV21` / `effectiveRequiredOutcomesV21`）
- `src/platform/runtime/runtime-preparer.ts`（`adoptedOutcomes: []` 初始化）
- `tests/convergence.test.ts`（stateful reuse 测试）
- `tests/tool-output-envelope.test.ts`（error 序列化契约）
- `tests/ui-views.test.ts`（N→N + 三态/三类 modification 测试）
- `ui/app.js`（`renderFact` 三态/三类渲染）
- `package.json`（`authority-boundary:check` script）

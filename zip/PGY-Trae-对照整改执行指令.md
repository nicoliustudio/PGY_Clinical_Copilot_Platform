# PGY Runtime Hardening — Trae 对照整改执行指令

请把以下两份作为**参考**，不要整包覆盖当前工作区：

```text
1. PGY-系统鲁棒性与泛化性整改方案.md
2. PGY-Clinical-Runtime-Hardening-Reference.zip
```

参考 ZIP 是基于本次代码审计包制作的架构对照版本；当前主仓可能已有更新和未提交改动，必须逐文件理解后合并。

---

## 目标

本轮只解决当前已重复暴露的系统不稳定源：

```text
A. DECIDE 阶段已有 candidate 仍重复 retrieval，导致 T07 类不收敛
B. Completion / proposal.submit readiness 多套口径
C. durable state ready 后仍依赖模型 final JSON / 最后 submit
D. WorkingView 压缩丢 current/history/polarity
E. P2 candidate ↔ expanded evidence identity 丢失
F. structured output malformed/schema drift 无基础设施级 exactly-once repair
G. Core 中 gaofang / GF- 业务硬编码的枚举扩张风险
```

核心原则：

```text
LLM handles clinical judgment.
Runtime handles state integrity, action availability and deterministic delivery.
```

---

## 严格禁止

本轮不要：

```text
增加 maxSteps / timeout
调 temperature 掩盖问题
写 T07/便秘特例
疾病→证型→方剂 hard-code
证型同义词表 / fuzzy includes / regex 医学映射
自动选择 top1 formula
把 P2 升级为 normative authority
降低 Safety / reviewRequired
删除 formula review 以提高 completion
新增 Gaofang Agent / Planner / Verifier
增加 search 次数阈值（如最多 3 次）
```

---

# Step 1 — 先做差异审计，不要立即复制

逐文件对照参考实现，重点检查当前仓是否已经有等价或更好的机制：

```text
src/adapters/ai-sdk/agent-runtime.ts
src/adapters/ai-sdk/tool-bindings.ts
src/adapters/ai-sdk/model-adapter.ts
src/adapters/ai-sdk/workspace-events.ts
src/platform/context/clinical-working-view.ts
src/platform/workspace/proposal-draft.ts
src/platform/workspace/proposal-readiness.ts
src/contracts/capability.ts
src/platform/runtime/harness-session.ts
capabilities/gaofang/capability.json
```

输出一张：

```text
REFERENCE CHANGE
CURRENT MAIN STATUS
ADOPT / ALREADY EXISTS / REJECT
REASON
```

如果当前主仓已经有更通用机制，保留主仓，不要为了贴参考 patch 回退。

---

# Step 2 — Formula DECIDE action surface

必须实现 generic state-driven 行为：

```text
candidates=0
→ formula.search_candidates 可用

candidates>0 && frontier=0
→ formula.search_candidates 隐藏
→ focus / deliberation

frontier>0 && focused candidate expanded evidence missing
→ formula.get_evidence 可用

frontier evidence complete
→ formula retrieval 隐藏
→ assessment / deliberation / selection / review

selectedCandidateRef exists
→ modification evidence 才可用
```

不得使用固定调用次数。

必须确认：

```text
T07 candidate surface 形成以后
formula.search_candidates 不再重新出现在 recovery action surface。
```

---

# Step 3 — Single Proposal Readiness

建立或确认唯一：

```text
evaluateProposalReadiness(context, requestedMode?)
```

合并：

```text
minimum clinical core
formal hypothesis disposition
Planner provisional required artifacts
Capability output contract
Agent completion obligation
mode-specific closure
```

必须让：

```text
Agent loop
Recovery
proposal.submit
WorkingView completion state
```

共享同一真源。

验收 invariant：

```text
readiness.ready=true
→ proposal.submit 不得再被另一 deterministic gate 返回 notReady
```

---

# Step 4 — Ready state deterministic commit

当 readiness ready 时：

```text
Workspace durable state
→ deterministic ProposalSubmit projection
→ canonicalize
→ commit
```

不要再调用 LLM finalizer 来“重写一次 JSON”。

Runtime 不得创建：

```text
新 disease
新 pattern
新 treatment principle
新 formula selection
```

只允许投影已经持久化的 state。

若 readiness=true 但 deterministic projection 无法构造：

```text
FAIL CLOSED
明确记录 invariant violation
```

不得让模型猜缺失字段。

---

# Step 5 — Temporal / Polarity Fidelity

检查 `ClinicalUnderstanding → Workspace → WorkingView`。

WorkingView case facts 必须保留：

```text
temporalRole
polarity
```

至少能显示：

```text
[current/present]
[current/explicitly_absent]
[historical/present]
[post_treatment/present]
```

不得增加 T03-specific temporal rule。

---

# Step 6 — P2 Evidence Identity

`formula.get_evidence(candidateRef)` 写入 Workspace evidence 时：

```text
relatedCandidates
```

必须包含调用时真实 `candidateRef`。

不要只用：

```text
sourceId + formulaId
```

重建，因为 P2 formula-level candidateRef 与 synthetic formulaId 不同。

---

# Step 7 — Structured Output Hardening

`ModelPort.generateStructured` 统一实现：

```text
attempt 1
→ parse/schema fail
→ same task + exact validation error + previous output
→ exactly one format-only repair
```

第二次仍失败：

```text
STRUCTURED_OUTPUT_FAILED[operation]
```

不要：

```text
无限 retry
best-of-N
放宽 schema
静默换模型
```

Understanding / Planner 至少都使用该基础设施。

---

# Step 8 — Capability Contract 去业务硬编码

Core 中删除/禁止：

```text
activeCapabilities.includes('gaofang')
startsWith('GF-')
if form == 膏方
```

需要治疗形式 evidence 时，由 Capability manifest 声明，例如：

```json
{
  "requiresTreatmentFormDecision": true,
  "treatmentFormEvidenceToolIds": [
    "knowledge.search_cards",
    "knowledge.get_asset"
  ]
}
```

对照增加一个假的：

```text
test-modality
```

只要 manifest 相同，Runtime behavior 必须相同。

---

# Step 9 — Treatment Form Presentation

把 source-specific hydration 从：

```text
hydrateGaofangAdvisory / GF-
```

收敛成 generic：

```text
TreatmentFormDecision.sourceEvidenceRefs
→ Runtime Catalog resolve
→ composition / preparation / usage deterministic presentation
```

BaseFormula 和 TreatmentForm 必须继续分离：

```text
GF case-derived evidence
!= normative base formula authority
```

---

# Step 10 — 去重复 Skill 注入

检查当前 prompt 构造。

完整 Skill 文本只保留一份权威注入。

context 中若已有 system full skill，不要再次塞 full skill；只需 active skill IDs / provenance。

本轮不要继续扩 Clinical Skill 医学规则。

---

# Deterministic Tests

至少加入并通过：

```text
D1 candidate surface 已有 → search_candidates hidden
D2 frontier 未形成 → 先 focus，不随机展开多个 evidence
D3 frontier evidence missing → get_evidence available
D4 frontier evidence complete → get_evidence hidden
D5 P2 get_evidence preserves exact candidateRef
D6 temporalRole/polarity survives WorkingView
D7 arbitrary test-modality uses same treatment-form contract
D8 readiness parity: ready=true cannot be deterministically rejected by submit
D9 ready durable state → deterministic clinical submit projection
D10 malformed JSON → exactly one repair success
D11 second malformed/schema failure → STRUCTURED_OUTPUT_FAILED
D12 acupuncture/no-formula task does not acquire formula obligation
```

---

# Validation

先运行：

```text
npm run typecheck
npm test
npm run arch:test
```

不得为了过测试删除已有安全/Authority contract。

然后固定当前 production candidate model/config，不调参数，跑：

```text
T07 ×5
T03 ×3
T11 ×3
T13 ×3
T15 ×3
```

T07 必须：

```text
0 execution_incomplete
0 resource_limit_fallback
candidate surface ready 后 0 repeated formula.search_candidates
```

T11/T13：

```text
TreatmentFormDecision stable
有资产时组成/制法/用法确定性呈现
GF evidence 不升级 BaseFormula authority
```

T15：

```text
不被 formula gate 强迫
不自动开中药
```

T03 不按 exact gold 强制判定，另外做 counterfactual：

```text
A 原病例
B 去历史瘀象
C 保留历史瘀象但减弱当前瘀象
D 加强当前肝郁/脾虚鉴别证据
```

看 primary 是否对真正 decision-changing evidence 有合理敏感性。

最后再跑：

```text
18 cases ×3 runs
```

报告 stability，不只报告单次命中。

---

# 最终验收报告必须回答

```text
1. T07 是否从 “有 candidate 仍不决策” 修复？
2. 是否仍存在重复 no-progress retrieval？
3. readiness 是否已经唯一真源？
4. durable ready state 是否完全取消 LLM final JSON 依赖？
5. malformed structured output 是否 exactly-once repair？
6. temporalRole/polarity 是否全链路保真？
7. P2 candidate/evidence identity 是否完整？
8. Core 是否还有 gaofang/GF-/针灸/制剂业务 branching？
9. Safety / Authority / reviewRequired 是否零回归？
10. 18×3 的 ClinicalDeliveryRate / ExecutionIncompleteRate / ClinicalAcceptableRate / P90 steps/tokens 是多少？
11. 是否出现新的重复系统性根因？
```

只有在：

```text
0 repeated runtime correctness bug
+ targeted 全过
+ 18×3 不再出现同源 convergence collapse
```

后，才建议标记：

```text
CLINICAL_RUNTIME_BASELINE_V1
```

并冻结 Runtime；后续把重心转向真实临床准确率、Knowledge Coverage 和医生接受率。

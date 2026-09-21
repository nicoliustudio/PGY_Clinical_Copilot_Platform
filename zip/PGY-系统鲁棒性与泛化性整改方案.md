# PGY Clinical Runtime — 系统鲁棒性、泛化性与准确性整改方案

> 基于 `PGY-问诊开方链路-代码审计.zip` 的静态代码审计 + 6 例链路报告复盘。  
> 目标不是继续增加“聪明规则”，而是把 Runtime 收敛为：**LLM 做开放世界临床判断；Kernel 只做闭世界状态完整性、动作约束、证据身份、Authority/Safety 与确定性交付。**

---

## 0. 结论摘要

当前系统的不稳定并不能主要归结为“DeepSeek 随机”。模型波动只是触发器，真正放大波动的是 Runtime 中仍存在几处**状态反馈不闭环 / 多套真源 / 压缩语义丢失 / 机械动作仍交给 LLM**的问题。

这次代码审计确认的核心原因如下。

| 优先级 | 根因 | 影响 | 是否系统性 |
|---|---|---|---|
| P0 | `formulaSelection` 缺失时 Recovery 重新开放 `formula.search_candidates`，即使已有候选 | T07 有候选、有证据仍反复检索直到 step budget 用完 | 是 |
| P0 | Completion / submit readiness / finalization 曾存在多套判据 | “Runtime 认为完成，但 submit 仍 notReady”或最后机械 submit 依赖模型 | 是 |
| P0/P1 | durable state ready 后仍用 LLM 做 final JSON serialization | 引入无医学价值的 JSON/Schema 随机失败 | 是 |
| P1 | WorkingView 丢弃 `temporalRole` / `polarity` | Understanding 正确区分 current/history/absent，主 Agent 压缩上下文却失去该结构 | 是 |
| P1 | P2 `formula.get_evidence` 的 evidence→candidate 关联重建错误 | P2 `candidateRef=sourceId::formula`，却按 synthetic formulaId 重建，Runtime 难判断“该候选证据已展开” | 是 |
| P1 | Structured generation 无统一 exactly-once format repair | Planner / Understanding / proposal JSON 偶发格式错误可直接炸整条 run | 是 |
| P1/P2 | Core 中残留 `gaofang` / `GF-` 业务识别 | 当前可工作，但会成为针灸/制剂继续接入后的枚举/if-else 泥潭 | 是 |
| P2 | Skill 全文在系统指令和 context 中重复注入 | token 放大 + 同一规范重复出现，增加模型行为漂移 | 是 |
| P2 | P1 applicability 依赖规范化字符串精确相等 | 对开放世界疾病名称/别名较脆弱，但不建议本轮靠同义词表修 | 是，后续评估 |

### 最关键判断

T07 的本质不是“没检索到方”。Trace 已经显示有候选、P2 候选也被 `presented`，甚至调用过 `formula.get_evidence`；失败发生在：

```text
candidate surface 已存在
        ↓
缺 formulaSelection / formulaReview
        ↓
Recovery 仍允许 formula.search_candidates
        ↓
模型继续搜 / cache-hit / 重复 evidence
        ↓
没有 candidate.assessed / selected
        ↓
16 steps 耗尽
        ↓
EXECUTION_INCOMPLETE
```

这属于 **DECIDE-stage convergence bug**。

正确整改不是：

```text
最多搜索 3 次
便秘时优先某方
P2 top1 自动采用
step limit 从 16 加到 24
```

而是：

```text
当前 durable state
→ 决定下一步还允许什么动作
```

---

# 1. 设计红线：这轮整改必须守住什么

## 1.1 开放世界医学语义不能下沉到 Runtime

Runtime 不得增加：

```ts
if (disease === '便秘') ...
if (pattern.includes('阴虚')) ...
if (form === '膏方') ...
if (specialty === '妇科') ...
```

也不得建立：

```text
疾病 enum
证型 enum
方剂映射表
中医同义词 dictionary
“症状 → 证型 → 方”规则树
```

医学判断继续属于：

```text
Clinical Understanding
Clinical Skill
LLM deliberation
Knowledge evidence
```

Runtime 只认识：

```text
artifact 是否存在
candidate 是否存在
candidate 是否 focus
证据是否已展开
hypothesis 是否 disposition
completion contract 是否满足
capability 声明的 output contract
```

---

## 1.2 “枚举陷阱”要区分业务枚举和平台状态

不是所有 enum 都有问题。

合理的平台闭世界状态例如：

```text
selected / rejected / uncertainty
CURRENTLY_SUITABLE / TREAT_FIRST_THEN_FORM / CURRENTLY_NOT_SUITABLE
PASS / BLOCK / reviewRequired
parse / schema
```

这些是系统控制状态，可以有限枚举。

危险的是把开放医学世界枚举化：

```text
gaofang / acupuncture / preparation / disease list / syndrome list
```

本轮参考实现继续保留平台边界状态，但删除 Core 对 `gaofang`、`GF-` 的业务识别。

---

## 1.3 不用固定次数解决收敛

禁止：

```text
search <= 3
get_evidence <= 2
hypothesis <= 3
```

因为不同病例需要的探索深度不同。

应该使用 **状态进度**：

```text
候选是否增加？
证据是否增加？
frontier 是否形成？
缺失 artifact 是否减少？
decision-changing uncertainty 是否变化？
```

只有“状态是否前进”决定是否继续开放某类动作。

---

# 2. 根因一：Recovery 的动作面没有真正状态化（T07 主因）

## 2.1 原实现的问题

文件：

```text
src/adapters/ai-sdk/agent-runtime.ts
```

原 `recoveryActiveToolIds()` 在缺 `formulaSelection` 时统一开放：

```text
workspace.focus_candidates
workspace.record_candidate_assessment
workspace.record_candidate_exclusion
workspace.record_deliberation
formula.search_candidates
formula.get_evidence
formula.validate
formula.get_modification_evidence
```

问题是：这些动作并不是在所有状态下都合法/必要。

例如 T07：

```text
已有 12 个 formula candidates
已有 P2 case-derived candidates
甚至已经 get_evidence
```

此时再次 `formula.search_candidates` 对完成 `formulaSelection` 并没有必要。

更明显的是：在 **尚未 selected base formula** 时开放 `formula.get_modification_evidence`，语义也不成立；该工具本身会返回 `BASE_FORMULA_REQUIRED`。

## 2.2 参考实现：Formula Decision Surface

新增一个 generic state-driven action surface：

```text
A. candidates = 0
   → 允许 formula.search_candidates

B. candidates > 0，frontier = 0
   → 隐藏 search_candidates
   → 先 focus_candidates / deliberation

C. frontier > 0，frontier candidate 尚无 expanded evidence
   → 允许 formula.get_evidence

D. frontier evidence 已齐
   → 隐藏 retrieval
   → 只剩 assessment / exclusion / deliberation / validate / submit

E. selectedCandidateRef 已存在
   → 才允许 modification evidence
```

这是状态机，不是病例规则。

关键代码：

```text
src/adapters/ai-sdk/agent-runtime.ts
  addFormulaDecisionTools()
  closureAwareActiveToolIds()
  recoveryActiveToolIds()
```

### 为什么泛化

它对：

```text
便秘
咳嗽
胃痛
不孕
妇科
肺系
未来任意病种
```

行为完全一致。

它只看：

```text
candidate / frontier / evidence / selection
```

---

# 3. 根因二：系统已经知道“无进展”，但没有用它收敛动作面

现有 Runtime 已经计算大量很有价值的观测：

```text
decisionImpact
executionNecessity
newCandidateCount
newEvidenceCount
NO_NEW_INFORMATION
repeatedNoProgressCorrectionCount
redundantSearchCount
```

但主要停留在 telemetry。

因此可能发生：

```text
Runtime: 这次没有新证据、没有新候选、没有改变任何决策
Agent下一步: 还可以继续调用同一个 retrieval tool
```

这就是典型“观测层知道错，但控制层没反馈”。

## 本轮建议

不要马上再造一个巨大的 `NoProgressEngine`。

先把最确定的状态事实直接用于现有 activeTools masking：

```text
已有 candidates → 不再重新建 candidate surface
已有 frontier expanded evidence → 不再开放 formula evidence retrieval
ready → 只 commit
```

如果真实 Pilot 后仍出现至少两例“不同工具、同构 no-progress loop”，再抽象一个通用：

```text
ProgressProjection
```

输入：

```text
state delta
new evidence
new candidates
missing-artifact delta
uncertainty delta
```

输出只应是：

```text
PROGRESSED / NO_PROGRESS
```

不能包含医学语义。

---

# 4. 根因三：Completion / Readiness 存在“双重真源”风险

当前系统历史上同时存在：

```text
checkClinicalCompletion()
checkClinicalCoreCompletion()
computeRequiredArtifacts()
proposal.submit 内 gates
Agent loop completion contract
closure state
```

这些函数本身不是坏事，问题是它们如果被不同位置组合，会出现：

```text
Agent loop: complete
proposal.submit: notReady
```

## 参考整改：Single Proposal Readiness

新增：

```text
src/platform/workspace/proposal-readiness.ts
```

提供唯一：

```ts
evaluateProposalReadiness(context, requestedMode?)
```

统一投影：

```text
mode-specific closure
unresolved formal hypotheses
minimum clinical core
Planner provisional contract
Capability output contract
Agent completion obligation
```

调用方：

```text
Agent loop
Completion recovery
proposal.submit
WorkingView completion display
```

必须满足 invariant：

```text
readiness.ready == true
→ proposal.submit 不应再被另一套 deterministic gate 拒绝
```

### WorkingView 同步修正

原 WorkingView 的 `Clinical Completion State` 使用的是 Agent 自己声明的 obligation；H15.5.3 后 Runtime 已经使用：

```text
Planner provisional
+
Capability obligation
+
Agent obligation
```

如果 WorkingView 仍显示旧口径，模型看到的是“完成”，Runtime 却认为“未完成”。

参考实现让 WorkingView 接收同一份 merged requiredArtifacts。

---

# 5. 根因四：Durable state ready 后仍调用 LLM finalizer

这是一个非常值得删除的随机源。

如果 Workspace 已经有：

```text
DiseaseAssessment
PatternAssessment
TreatmentPlan
FormulaSelection（任务需要时）
FormulaReview（任务需要时）
TreatmentFormDecision（能力需要时）
unresolved hypothesis = 0
```

医学判断已经结束。

再让模型执行：

```text
“请把这些内容重新输出成 JSON”
```

不会增加任何医学价值，只会新增：

```text
malformed JSON
schema drift
模型漏字段
模型改写语义
最后一步忘 submit
额外 token / latency
```

## 参考实现

新增：

```text
buildDeterministicClinicalSubmit()
```

链路变为：

```text
readiness.ready
    ↓
Runtime 从 durable state 做只读 projection
    ↓
canonicalizeProposalSubmit
    ↓
commit
```

不选方、不改证、不生成新药、不改变 Authority。

新的平台终止状态：

```text
runtime_committed_ready_state
```

它是 runtime state，不是医学 enum。

### 重要区别

```text
Runtime deterministic commit
!= Runtime 自动做临床决策
```

Runtime 只提交 Agent 已经写入 Workspace 的决定。

---

# 6. 根因五：WorkingView 压缩丢掉 current/history/polarity

Understanding 已经支持：

```text
temporalRole:
  current
  historical
  post_treatment
  baseline
  uncertain_time

polarity:
  present
  explicitly_absent
  unknown
```

但是原 `ClinicalWorkingView.caseFrame` 只投影：

```text
id / kind / value
```

也就是说：

```text
Understanding:
  “上次月经血块” = historical/present
  “现在无明显腹痛” = current/explicitly_absent

↓ 压缩

Main Agent WorkingView:
  文本事实
  （结构时间/极性消失）
```

这会削弱 T03 这种术后病例的时序辨别力。

## 参考修复

WorkingView 保留：

```text
temporalRole
polarity
```

渲染示例：

```text
[CF_006] [historical/present] symptom：上次月经量多、色黯、有血块
[CF_008] [current/explicitly_absent] symptom：无明显腹痛
```

这不是给 T03 加规则，而是**避免 Context Compression 丢掉已经正确理解的语义**。

---

# 7. 根因六：P2 candidate 与 expanded evidence 的 durable identity 断裂

P1 candidate 一般类似：

```text
P1:K_xxx::F_xxx
```

P2 candidate 是：

```text
P2:E_xxx::formula
```

但 `formula.get_evidence` 返回的 formulaId 可能是：

```text
P2_CASE_FORMULA::P2:C_xxx::E_xxx::1
```

原 `workspace-events.ts` 使用：

```text
${sourceId}::${formulaId}
```

重建 `relatedCandidates`。

这对 P2 并不等于真正 candidateRef。

结果：Runtime 很难确定：

> frontier 中这个 P2 candidate 是否已经完整读取证据？

于是重复 `get_evidence` 更容易发生。

## 参考修复

`formula.get_evidence` event 优先保留调用入参中的：

```text
candidateRef
```

再附 derived fallback。

这属于 identity integrity，不属于临床逻辑。

---

# 8. 根因七：Structured output 缺少统一的基础设施级 retry

原 `ModelPort.generateStructured()` 基本是：

```text
generateText
→ JSON.parse / Zod
→ fail
```

而真实运行已经出现：

```text
Expected ',' or '}' ...
criticalEvidenceNeeds 结构漂移
```

这类错误不能靠重跑整个病例来解决。

## 正确策略

仅做一次 **format/schema repair**：

```text
Attempt 1
→ parse/schema fail
→ 把明确 validation error + 原输出反馈给同一模型
→ exactly one repair
→ Attempt 2
```

第二次仍失败：

```text
STRUCTURED_OUTPUT_FAILED[clinical_planner]
STRUCTURED_OUTPUT_FAILED[clinical_understanding]
```

明确暴露。

禁止：

```text
无限 retry
best-of-N 临床重推理
放宽 schema 为 string | object
静默切另一个模型
正则“修 JSON”后猜临床字段
```

参考实现已覆盖 Understanding / Planner 的 ModelPort。

---

# 9. 去除 Core 中的业务硬编码：Capability Contract 驱动

原代码有两类明显架构味道：

```ts
activeCapabilities.includes('gaofang')
sourceEvidenceRefs.filter(r => r.startsWith('GF-'))
```

这在只有一种能力时可工作，但未来：

```text
针灸
制剂
外治
其他 treatment modality
```

都会诱导继续复制：

```text
if acupuncture ...
if preparation ...
hydrateAcupuncture...
hydratePreparation...
```

## 参考整改一：能力声明 evidence tool contract

Capability manifest 增加 generic 字段：

```json
{
  "requiresTreatmentFormDecision": true,
  "treatmentFormEvidenceToolIds": [
    "knowledge.search_cards",
    "knowledge.get_asset"
  ]
}
```

Core 只读取 manifest。

未来新增能力只改 capability 数据，不改 Runtime if/switch。

## 参考整改二：Generic Treatment Form Presentation Hydration

原：

```text
hydrateGaofangAdvisory
GF- prefix
```

改为：

```text
TreatmentFormDecision.sourceEvidenceRefs
        ↓
Runtime Catalog resolve
        ↓
若资产有 composition / preparation / usage
        ↓
确定性 presentation hydration
```

Core 不识别：

```text
GF-
AC-
PREP-
膏方
针灸
制剂
```

这正好符合原架构规则：

> 医学选择由 Agent；已经选中的证据如何完整呈现，由系统确定性处理。

---

# 10. Prompt/Skill 层：不要再加医学规则，本轮只做去重复

审计发现 active skill 全文存在重复注入风险：

```text
dynamic system instructions 已包含完整 skill
context prompt 又再次放完整 skill
```

这会增加：

```text
tokens
相同规则重复强调
模型对同一原则过拟合/过度执行
```

参考实现保留 full skill 在 system instruction，只在 context 中列 active skill IDs。

### 本轮明确不改 Clinical Skill 的内容

现有 Skill 已经包含：

```text
current vs historical
不机械症状计数
不单信号锚定
假设竞争
专家 stop rule
```

T03 还不能证明“Skill 缺一条术后规则”。

继续加：

```text
术后如何判
便秘如何判
某舌脉优先级
```

会把专家系统重新拉回病例规则。

---

# 11. T03 的准确性问题：先做 Counterfactual，不要立即写规则

T03 不能简单归因为 temporal parser bug，因为 Understanding 已正确标注历史与当前。

更可疑的是：

```text
早期 leading hypothesis = 气虚血瘀
↓
后续 query 也围绕 气虚血瘀
↓
retrieval evidence 反向强化初始 hypothesis
```

属于可能的 **confirmation bias / hypothesis discrimination**。

本轮只先修 WorkingView temporal fidelity。

之后做 4 组 counterfactual：

```text
A 原病例
B 去掉历史血块/剧痛，保留当前舌暗脉涩
C 保留历史瘀象，去掉/减弱当前瘀象
D 加强当前肝郁脾虚的真正鉴别证据
```

应该观察：

```text
主证是否随“真正 decision-changing 当前证据”合理变化
```

如果不同输入都粘住首次 hypothesis，才允许下一轮修改 Clinical Mentor 的：

```text
hypothesis discrimination / anti-confirmation-bias
```

仍不得写疾病特例。

---

# 12. 暂不修改但必须记录的下一阶段问题：P1 applicability

当前 `formula-evidence.ts` 对 P1 applicable disease 的判断相对脆弱，核心依赖规范化后的 disease core exact match。

它的优点是：

```text
确定性
不会偷偷做 LLM 医学映射
```

但缺点是开放世界别名/表达变化会导致 coverage 波动。

本轮**不要**用：

```text
includes()
模糊字符串
中医病名同义词表
LLM 判断两个 disease 是否相同
```

来修。

正确长期方向是知识资产逐步增加：

```text
stable disease concept identity / source concept ref
```

让 applicability 基于 identity / metadata，而不是业务字符串。

只有真实 Pilot 证明这已经成为重复 PRIMARY BOTTLENECK 时再做。

---

# 13. 参考代码实际改动清单

参考 ZIP 已修改：

```text
src/contracts/capability.ts
src/platform/runtime/harness-session.ts
capabilities/gaofang/capability.json

src/platform/workspace/proposal-readiness.ts   [NEW]
src/adapters/ai-sdk/agent-runtime.ts
src/adapters/ai-sdk/tool-bindings.ts

src/platform/context/clinical-working-view.ts
src/adapters/ai-sdk/workspace-events.ts

src/ports/model.ts
src/adapters/ai-sdk/model-adapter.ts
src/clinical/understanding.ts
src/platform/planning/clinical-planner.ts

src/platform/workspace/proposal-draft.ts
src/contracts/agent-loop.ts
```

新增/增强测试覆盖：

```text
T07-like candidate-surface convergence
frontier evidence convergence
non-gaofang treatment-form capability generalization
P2 evidence ↔ candidate identity
WorkingView temporal/polarity fidelity
structured output exactly-once repair
deterministic ready-state proposal projection
```

---

# 14. 明确没有做什么

参考实现**没有**：

```text
增加 maxSteps
增加 timeout
疾病 hard-code
证型 hard-code
便秘特例
膏方 if/else
GF prefix branching
自动采用 top1 formula
P2 authority 升级
降低 Safety
跳过 formula review
把 retrieval 当 adoption
新增第二个 Agent / Planner / Verifier
```

这很重要：目标是减少系统自由度和歧义，不是增加更多控制层。

---

# 15. 上线前验证顺序

## Stage A — Deterministic tests

先必须通过：

```text
npm run typecheck
npm test
npm run arch:test
```

以及新增 contract tests。

重点 invariant：

```text
1. candidates 已存在 + formulaSelection missing
   → formula.search_candidates 不再开放

2. frontier 未形成
   → 不随机展开多个 formula evidence

3. frontier formed + evidence missing
   → formula.get_evidence 可用

4. frontier evidence complete
   → formula.get_evidence 自动退出动作面

5. treatment-form capability id 换成任意 test-modality
   → completion/recovery 行为完全一致

6. readiness.ready=true
   → deterministic projection 可生成 clinical submit

7. P2 formula evidence
   → relatedCandidates 包含真实 P2 candidateRef

8. current/historical/explicitly_absent
   → WorkingView 不丢

9. malformed structured JSON
   → exactly one repair

10. repair 再失败
   → stable STRUCTURED_OUTPUT_FAILED
```

## Stage B — 定向真实运行

固定模型、Prompt、Skill、Knowledge、step limit，不同时调参。

### B1 T07 × 5

必须：

```text
0 execution_incomplete
0 resource_limit_fallback
candidate surface 形成后 = 0 次重复 formula.search_candidates
每次形成 physician-reviewable formula decision 或明确 fail-closed 原因
```

重点不是必须同一方，而是：

```text
病证法一致
候选有证据
selection/review 真正发生
```

### B2 T03 × 3 + 4 组 counterfactual

检查：

```text
current/history 保真
初始 hypothesis 是否造成 confirmation bias
真正 discriminative evidence 改变时 primary 是否相应变化
```

禁止把“必须命中参考答案”当唯一指标。

### B3 T11/T13 各 × 3

必须：

```text
capability route stable
TreatmentFormDecision stable
treatment-form source evidence stable
composition/preparation/usage 有资产时确定性呈现
BaseFormula authority 不被 GF asset 污染
```

### B4 T15 × 3

必须验证无回归：

```text
针灸任务不被 formulaSelection 强迫
无自动中药方
external therapy evidence 可交付
```

---

# 16. Stage C — 18 例稳定性测试建议

不要只跑 `18 × 1`。

架构 hardening 后建议：

```text
18 cases × 3 runs
```

分开报告：

### 产品交付稳定性

```text
ClinicalDeliveryRate
ExecutionIncompleteRate
ResourceLimitFallbackRate
StructuredOutputFailureRate
runtimeReadyStateCommitRate
AgentSubmitRate（仅观察，不作为产品成败）
```

### 临床准确性

```text
ChiefComplaintAcceptableRate
CurrentStateAcceptableRate
PrimaryPatternAcceptableRate
TreatmentPrincipleAcceptableRate
CandidateCoverageRate
BaseFormulaAcceptableRate
SafetyCriticalFailureCount
```

### 泛化 / 反规则化

```text
CounterfactualSensitivity
IrrelevantPerturbationStability
TemporalEvidenceUse
retrievalAutoHypothesisRate = 0
formulaAutoDecisionRate = 0
```

### 收敛效率

```text
steps median / P90 / max
tokens median / P90 / max
candidateSurfaceToSelectionSteps
postPrimaryStepCount
noProgressRetrievalCount
repeatedCandidateSearchAfterSurfaceReady
```

---

# 17. Hard PASS 条件

我建议本轮 Release Hardening 至少满足：

```text
T07 ×5:
  0 execution_incomplete
  0 repeated candidate search after candidate surface exists

Structured output:
  first malformed output recoverable by exactly-once repair
  second failure explicitly surfaced

Readiness:
  0 “ready but submit deterministic gate rejects”

Ready-state delivery:
  0 LLM finalization JSON dependency

Treatment-form generalization:
  test-modality 与 gaofang 仅因 manifest contract 不同而行为不同
  Core source code 0 gaofang/GF prefix branching

Temporal fidelity:
  current/history/polarity survives WorkingView projection

Authority:
  P2 remains case-derived / GENERATED_DRAFT
  GF asset does not become BaseFormula authority

Safety:
  H15.4 semantics no regression
```

随后完整 `18 × 3` 若没有新的可重复 Runtime 根因：

> **冻结 Completion / Recovery / Finalization / Capability Core。**

以后只有出现：

```text
>= 2 independent cases
+ same root cause
+ same system layer
```

才重新打开底层架构。

---

# 18. 为什么这套改造更鲁棒，也更简单

整改前系统对模型存在几个隐含要求：

```text
模型要知道什么时候别再搜
模型要记得 candidate 已经有了
模型要记得证据读过了
模型要记得最后 submit
模型要稳定输出 JSON
模型要从压缩后的文本自己恢复 current/history
```

整改后：

```text
模型：
  做开放世界医学判断
  比较证据
  选择/拒绝候选

Runtime：
  展示当前真实状态
  只开放对当前状态有意义的动作
  检查统一 completion/readiness
  保留 evidence identity
  确定性序列化已完成结果
  对结构化格式失败做一次基础设施 repair
```

因此它不是“加了一套新规则系统”。

实际上是在**删掉对 LLM 行为习惯的隐式规则依赖**。

---

# 19. 参考代码的验证状态

本隔离环境中，上传 ZIP 没有 `node_modules`，并且包内未包含 `scripts/`（虽然 `package.json` 引用了 `scripts/check-architecture.ts` 等），知识 assets 也按你的打包说明被排除。因此这里不能诚实宣称已经跑完：

```text
npm test
npm run typecheck
npm run arch:test
真实 DeepSeek E2E
```

已完成的本地静态验证：

```text
TypeScript source + tests parse scan: 146 files, 0 syntax errors
JSON scan: 13 files, 0 parse errors
Core grep: src 中无 gaofang id / GF- prefix 的业务 branching
```

参考 ZIP 的定位是：

> **架构级参考实现 / 对照 patch，不是已经替你宣布可生产上线的 release。**

Trae 必须在你的完整工作区（dependencies + assets + scripts + 本地未提交代码）做逐文件对照、合并和真实验证。

---

# 20. 最后建议

这次不要继续把问题拆成：

```text
T07 修一个
T03 修一个
T11 修一个
DeepSeek 再调一个 temperature
```

应该收敛为四条系统 invariant：

```text
1. State determines allowed actions.
2. One readiness truth.
3. Ready state is deterministically committed.
4. Semantic fidelity survives context compression.
```

再加两条基础设施原则：

```text
5. Structured output format failure gets one repair, not a new clinical reasoning run.
6. Capability-specific behavior is declared by capability contracts, not Core business enums.
```

如果这六条经过 `18 × 3` 和真实医生 Pilot 验证，建议正式结束 H15.x Runtime 深挖阶段，把工程注意力转向：

```text
真实临床准确率
知识覆盖
专家级 hypothesis discrimination
医生接受率
```

而不是继续扩 Runtime。

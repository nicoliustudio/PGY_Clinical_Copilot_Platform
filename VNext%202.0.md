# PGY Clinical Copilot Platform — VNext 2.0 Architecture Baseline

> **Status:** Architecture Baseline / Mandatory  
> **Version:** VNext 2.0  
> **Revision:** 2.0.1 — Evidence-aware Generative Fallback / Model & Prompt Portability  
> **Date:** 2026-09-16  
> **Scope:** PGY Clinical Copilot Platform 全平台  
> **Purpose:** 约束后续人工开发、AI Coding Agent、Capability 扩展、Control Plane、Knowledge、Authority、UI 与外部集成，保证平台长期保持 AI-native、智能、高内聚、低耦合、可审计、可扩展。

---

## 0. Executive Contract

PGY Clinical Copilot 不是“规则引擎 + LLM”，也不是把传统临床流水线改名成 Agent。

平台的核心原则只有两句：

> **AI understands the open world. Deterministic code protects the closed world.**

> **Semantic understanding must never be replaced by configuration logic.**

由此产生以下长期不变量：

- AI 负责开放世界：理解、语义意图、上下文、风险假设、临床假设、信息缺口、能力需求、检索、规划、综合。
- Deterministic Kernel 负责封闭世界：Schema、权限、身份、完整性、Authority、状态变更、安全不变量、审计、发布完整性。
- Capability 是业务扩展单位，不是业务 `if/else` 的包装。
- Skill 提供方法，不提供硬编码答案。
- Knowledge 提供 Evidence，不控制流程。
- Knowledge-first，但 Knowledge 不是系统智能上限；当现有知识证据不足时，允许进入受控 Generative Reasoning Fallback。
- Fallback 模型与 Prompt 必须通过 ModelProfile / PromptProfile / RuntimeRelease 配置，严禁写死在 Core Runtime。
- Tool 执行确定性动作，不拥有临床主权。
- Agent 产生 Proposal，不直接产生 Authoritative State。
- Authority Kernel 决定 Proposal 是否可成为临床事实或临床动作。
- Control Plane 管理能力的配置、验证、评测和发布，但不能绕过 Authority。
- Core Runtime 永远不认识“膏方、儿科、男科、肿瘤”等具体业务概念。
- 新增业务能力应该主要新增 Capability / Skill / Knowledge / Eval，而不是修改 Core Runtime。
- UI 设计可以参考 [ui-shell-2026-09-16](ui-shell-2026-09-16.md)。

---

# 1. Architecture Constitution

## 1.1 Open World → AI Understanding

以下问题属于开放世界，不允许通过硬编码枚举、关键词命中、固定规则树直接得出最终结论：

- 用户现在是在问诊、闲聊、追问、咨询还是表达非临床需求？
- 用户说的临床事实是什么？
- 用户可能表达了什么意图？
- 当前是否存在潜在风险？
- 可能需要什么临床能力？
- 当前缺少什么关键信息？
- 什么问题最值得继续追问？
- 哪些知识和工具最相关？
- 当前临床问题可能有哪些合理假设？

这些问题统一由 `ClinicalUnderstanding` / Semantic Intelligence 处理。

**禁止：**

```ts
if (text.includes("膏方")) ...
if (text.includes("大出血")) ...
switch (disease) ...
switch (syndrome) ...
```

关键词、phrase、例子只允许作为：

- Hint
- Prior
- Retrieval accelerator
- Semantic example

不能作为 Truth。

---

## 1.2 Closed World → Deterministic Boundaries

以下内容必须使用确定性逻辑：

- Contract / Schema validation
- Tenant / Doctor / Patient 权限
- Identity ownership
- Encounter isolation
- Tool permission
- Knowledge release validity
- Formula composition integrity
- Authority state transition
- Safety hard invariant
- Audit completeness
- Release immutability
- Evaluation/runtime data isolation
- Security and secrets boundaries

**规则只约束边界，不规定 AI 思考路线。**

---

## 1.3 Understand Once, Consume Everywhere

系统必须只有一套共享语义理解结果：

```ts
interface ClinicalUnderstanding {
  interaction: InteractionContext;
  facts: FactCandidate[];
  intents: SemanticIntent[];
  risks: RiskHypothesis[];
  hypotheses?: ClinicalHypothesis[];
  informationGaps: InformationGap[];
  capabilityNeeds: CapabilityNeed[];
  uncertainties: Uncertainty[];
}
```

Capability Resolver、Inquiry Planner、Risk Resolution、Primary Agent、Knowledge Scoping 等均消费同一个 `ClinicalUnderstanding`。

禁止形成：

```text
GaofangDetector
BleedingDetector
PediatricsDetector
OncologyDetector
...
```

禁止同一条用户输入被多个业务模块重复“理解”。

---

## 1.4 Understanding ≠ Authority

必须永久保持：

```text
Message ≠ Fact
LLM Understanding ≠ Authoritative Fact
Hypothesis ≠ Confirmed Diagnosis
FormulaProposal ≠ Prescription
Agent Answer ≠ Clinical State
Tool Result ≠ Fact
MCP Result ≠ Fact
Admin Config ≠ Authority
```

AI 输出默认属于 Proposal / Hypothesis / Candidate。

只有 Authority Pipeline 可以完成 Commit。

---

## 1.5 禁止开放世界业务枚举

本项目禁止通过 enum / switch / hard-coded list 穷举开放世界临床语义，例如：

```text
DiseaseEnum
SyndromeEnum
DepartmentEnum
IntentEnum containing all clinical intents
CapabilityTypeEnum containing business domains
RiskKeywordEnum
```

临床语义是开放集合，不应被 Core Code 穷举。

### 允许的有限状态

封闭世界的平台安全状态可以使用 discriminated union / finite state type，例如：

```text
NORMATIVE
GENERATED_DRAFT
BLOCKED
```

或：

```text
MATCH
AMBIGUOUS
NEW
INSUFFICIENT
```

原因：这些不是临床知识枚举，而是平台自身定义的有限安全/权威状态。

原则：

> **Open-world semantics must not be enumerated. Closed-world platform states may be finite and strongly typed.**

---

# 2. VNext 2.0 Overall Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                       Product Plane                          │
│                                                              │
│ Doctor Workspace                 AI Control Center           │
│ Conversation / Case              Capability / Skill          │
│ Evidence / Trace                 Knowledge / Eval            │
│ Clinical View                    Release / Observability     │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│                       Control Plane                          │
│                                                              │
│ Draft → Validate → Compatibility → Eval → Shadow → Canary   │
│                         → Active                             │
│                                                              │
│                 Runtime Release Compiler                     │
└───────────────────────────┬──────────────────────────────────┘
                            │
                  EffectiveRuntimeRelease
                     immutable + hashed
                            │
════════════════════════════╪══════════════════════════════════
                         Runtime Plane
                            │
┌───────────────────────────▼──────────────────────────────────┐
│                    Clinical Runtime                          │
│                                                              │
│ ClinicalUnderstanding                                        │
│ RuntimePreparer / RuntimeContext                              │
│ Capability Resolver                                          │
│ Registry: Capability / Skill / Knowledge / Tool              │
│ Evidence Sufficiency Assessment                              │
│ Reasoning Escalation / Model Router                          │
│ Inquiry Planner                                              │
│ Clinical Primary Agent                                       │
│ Trace                                                        │
└───────────────────────────┬──────────────────────────────────┘
                            │
                         Proposal
                            │
┌───────────────────────────▼──────────────────────────────────┐
│                    Authority Boundary                        │
│                                                              │
│ Safety Invariants                                            │
│ Fact Authority                                               │
│ Formula Authority                                            │
│ Doctor Decision / Commit Authority                           │
│ Identity / Permission / Export Authority                     │
└───────────────────────────┬──────────────────────────────────┘
                            │
                   Authoritative State
                            │
┌───────────────────────────▼──────────────────────────────────┐
│                State / Evidence / Audit                      │
│                                                              │
│ PostgreSQL / Snapshot / Authority Events                     │
│ Evidence / Run Trace / Tool Call / AuditLog                  │
└──────────────────────────────────────────────────────────────┘

External boundaries:
Model Providers / Knowledge Sources / MCP / HIS / LIS / PACS
全部通过 Port / Adapter / Gateway 接入。
```

---

# 3. Runtime Main Path

一次用户输入的默认主链：

```text
User Input
    ↓
ClinicalUnderstanding
    ↓
RuntimePreparer
    ├─ load pinned RuntimeRelease
    ├─ resolve semantic Capability candidates
    ├─ JIT load Skills
    ├─ bind Knowledge Scopes
    ├─ expose allowed Tools
    ├─ attach Model Profile
    └─ attach Trace Context
    ↓
RuntimeContext
    ↓
ClinicalPrimaryAgent
    ├─ reason
    ├─ retrieve
    ├─ assess evidence sufficiency
    ├─ if evidence is insufficient, request controlled reasoning escalation
    ├─ use tools
    └─ produce Proposal
    ↓
AuthorityPipeline
    ├─ safety invariant
    ├─ fact/formula integrity
    ├─ permission
    └─ commit policy
    ↓
AgentResult / DoctorDecision / Authoritative State
```

Primary Agent 不负责组装自己的运行环境。

Primary Agent 只负责：

```text
Reason
Retrieve
Use Tool
Propose
```

Primary Agent 不负责：

```text
Detect Gaofang
Detect Pediatrics
Detect Oncology
Select business branch
Grant authority
Commit clinical state
Bypass safety
```

---

# 4. RuntimeContext

`RuntimeContext` 是 Runtime Plane 的核心装配对象。

建议：

```ts
interface RuntimeContext {
  runId: string;
  runtimeReleaseId: string;

  understanding: ClinicalUnderstanding;

  capabilities: ResolvedCapability[];
  skills: ResolvedSkill[];
  knowledgeScopes: KnowledgeScopeRef[];
  tools: RuntimeToolRef[];

  safetyContext: SafetyContext;

  primaryModelProfile: ModelProfileRef;
  fallbackModelProfiles: ModelProfileRef[];
  promptProfiles: PromptProfileRef[];
  trace: TraceContext;
}
```

## RuntimeContext 不允许包含

- 任意业务硬编码分支
- 具体病种 switch
- 具体证型 switch
- 关键词触发真值
- 测试 gold / expected answer
- Evaluation-only asset

---

# 5. Capability Architecture

## 5.1 Capability 是业务扩展单位

新增：

- 膏方
- 儿科
- 男科
- 肿瘤支持
- 慢病随访
- 营养
- 睡眠

应该主要新增：

```text
Capability Descriptor
Skill
Knowledge Scope
Inquiry resources
Allowed tool requirements
Eval Suite
```

不应该新增：

```text
gaofang_agent.ts
pediatrics_engine.ts
oncology_switch.ts
```

---

## 5.2 Capability Descriptor 使用语义描述，不写业务条件树

推荐：

```yaml
id: treatment.gaofang
version: 2.0.0

semantic_profile:
  description: >
    适用于表达长期中医调养、阶段性膏滋调理、
    希望减少每日煎药或采用膏滋制剂等语境。

  positive_examples:
    - 最近身体比较虚，想调理一段时间，不想天天煎药
    - 天冷以后想弄一料慢慢吃

  negative_examples:
    - 这个膏药怎么贴
    - 外用软膏怎么用

skills:
  - gaofang-reasoning

knowledge_scopes:
  - gaofang.normative
  - gaofang.cases

tool_requirements:
  - knowledge.search
  - formula.search_normative
  - formula.validate

eval_suites:
  - gaofang-golden
```

`positive_examples` / `negative_examples` 是 semantic guidance，不是规则。

---

## 5.3 Capability Resolver

Resolver 输入：

```text
ClinicalUnderstanding
+
Enabled Capability Descriptors
```

输出候选能力。

初期候选控制在少量相关能力中，避免把所有 Skill 全塞给模型。

Capability discovery 应优先使用：

1. shared semantic understanding
2. semantic descriptor matching
3. embedding shortlist（能力数量变大后）
4. LLM contextual selection

禁止：

```ts
if (intent === "gaofang") ...
if (text.includes("冬令")) ...
```

---

# 6. Skill Architecture

Skill = How to reason / How to work.

Skill 不是：

- 固定答案
- 病种引擎
- 证型表
- 方剂映射表
- Authority

Skill 推荐使用 `SKILL.md + metadata`：

```text
skills/
  general-clinical-reasoning/
    skill.json
    SKILL.md

  gaofang-reasoning/
    skill.json
    SKILL.md
```

Skill 必须 JIT activation。

禁止把几十个 Skill 永久注入 Primary Prompt。

Primary Prompt 只保留：

- 角色
- 通用目标
- Tool contract
- Evidence requirement
- Uncertainty principle
- Proposal/Authority boundary

业务 reasoning 进入 Skill，不进入 Primary Prompt。

---

# 7. Knowledge Architecture

## 7.1 Knowledge 提供 Evidence，不控制流程

Knowledge Engine 只认识通用字段：

```text
source
authority level
scope
runtime allowed
release
provenance
checksum
chunk
embedding
rerank score
```

Knowledge Search 不认识：

```text
膏方
妇科
儿科
肿瘤
```

它只接受：

```ts
knowledge.search({
  query,
  scopes: runtimeContext.knowledgeScopes
})
```

---

## 7.2 Knowledge Asset Classes

建议至少物理区分：

```text
knowledge/runtime
knowledge/shadow
knowledge/evaluation
```

`evaluation` 永远不能进入 runtime retrieval。

Knowledge Release 必须可回答：

```text
来源是什么？
authority 是什么？
runtime_allowed 吗？
checksum 是什么？
属于哪个 release？
```

缺失任一关键 provenance 时不得发布。

---

## 7.3 Evidence Sufficiency：知识优先，但知识不是智能上限

PGY 采用 **Knowledge-first, not Knowledge-only**。

知识库的职责是提供可追溯 Evidence；它不能成为系统智能能力的天花板。

当用户主诉、病症或临床问题超出现有 Knowledge Release 的覆盖范围时，系统允许继续使用通用大模型的预训练知识进行受控临床推理，但必须明确区分：

```text
Knowledge-grounded Evidence
≠
Model-generated Reasoning
```

不得使用单一 retrieval score 阈值作为“知识库解决不了”的真值，例如：

```ts
if (top1Score < 0.7) callFallbackModel();
```

原因是：

- 检索分数不是临床证据充分性的等价物；
- 多条中等相关证据可能已足够；
- 高分文档也可能没有回答当前问题；
- 证据之间可能冲突；
- 当前问题可能只解决了一部分。

因此应形成共享的：

```ts
interface EvidenceSufficiencyAssessment {
  supportingEvidence: EvidenceRef[];
  unresolvedAspects: string[];
  contradictions: string[];
  normativeSupportAvailable: boolean;
  semanticAssessment: {
    adequateForCurrentTask: boolean;
    rationale: string;
    uncertainty?: number;
  };
}
```

其中：

- `normativeSupportAvailable` 可由 Knowledge metadata / Authority 确定性验证；
- `adequateForCurrentTask` 属于语义判断，由 AI 基于当前任务、证据和不确定性判断；
- retrieval score 只作为信号之一，不作为单独控制条件。

---

## 7.4 Controlled Generative Reasoning Fallback

当 Evidence Sufficiency 表明现有 Knowledge 无法充分解决当前临床问题时，Runtime 可以进行 **Reasoning Escalation**。

逻辑上：

```text
ClinicalUnderstanding
        ↓
Knowledge Retrieval
        ↓
Evidence Sufficiency Assessment
        ↓
┌──────────────────────────────┐
│ evidence adequate            │
│ → evidence-grounded reasoning│
└──────────────────────────────┘
              OR
┌──────────────────────────────┐
│ evidence insufficient        │
│ → Reasoning Escalation       │
│ → high-capability ModelProfile│
└──────────────────────────────┘
        ↓
Clinical Proposal
        ↓
Authority Pipeline
```

Fallback 不是第二套临床系统，也不是新的 `FallbackAgent`。

第一阶段优先保持 **一个 Clinical Primary Agent**，由 Runtime 提供可切换的 reasoning profile。

### Fallback 输出的 Authority 语义

模型依靠预训练知识生成的临床内容必须携带 provenance：

```text
origin = model_generated
model_profile
model_snapshot
prompt_profile
runtime_release
run_id
```

它不能因为模型“很确定”就升级成 `NORMATIVE`。

如果没有真实规范知识源支持：

```text
Formula → GENERATED_DRAFT
Clinical conclusion → Proposal / Hypothesis
```

仍需经过：

```text
Safety
Formula Validation
Doctor HITL
Authority Commit
```

只有检索到真实规范源并通过 Formula Authority，才允许进入 `NORMATIVE`。

---

## 7.5 ModelProfile：模型必须可替换

Core Runtime 禁止写：

```ts
model = "qwen3.8-max";
```

只允许依赖：

```text
ModelPort
ModelProfileRef
ModelRouter
```

建议 ModelProfile：

```yaml
id: clinical-fallback-high-reasoning
version: 1.0.0

provider_ref: aliyun-model-studio
model_ref: qwen3.8-max

requirements:
  function_calling: true
  structured_output: true
  long_context: true

runtime:
  thinking: true
  timeout_ms: 120000
  max_output_tokens: 16000

prompt_profile:
  ref: clinical-fallback@1

tool_policy:
  native_web_search: false
```

`qwen3.8-max` 只是当前一个 Deployment Profile 的选择，不是 Architecture Contract。

未来可直接替换：

```text
Qwen new Max
GPT family
Claude family
Gemini family
自部署模型
```

只要满足 `ModelPort` 和当前 ModelProfile requirements。

---

## 7.6 PromptProfile：Prompt 也是可发布资产

Prompt 不应散落在：

```text
primary.ts
fallback.ts
tool description
environment variable
```

Prompt 必须成为版本化资源：

```text
prompts/
  clinical-primary/
    prompt.md
    profile.json

  clinical-fallback/
    prompt.md
    profile.json
```

建议：

```ts
interface PromptProfile {
  id: string;
  version: string;
  purpose: string;
  contentHash: string;
  compatibleContractVersion: string;
}
```

Prompt 修改：

```text
DRAFT
→ Eval
→ Invariant Test
→ Release
```

不得保存后立即影响正在运行的 ClinicalRun。

每次 Run 必须能够回答：

```text
用了哪个模型？
哪个 snapshot？
哪个 PromptProfile？
哪个 Prompt hash？
哪个 RuntimeRelease？
```

---

## 7.7 Reasoning Fallback 与 Provider Failover 必须分离

### Reasoning Fallback

原因：

```text
Knowledge evidence insufficient
```

目标：

```text
提高临床推理覆盖能力
```

### Provider Failover

原因：

```text
provider unavailable
model deprecated
rate limit
regional failure
operational migration
```

目标：

```text
提高运行可靠性
```

二者由不同机制负责：

```text
Evidence Sufficiency
    ↓
Reasoning Escalation

Provider Health / Runtime Policy
    ↓
Model Router / Provider Failover
```

禁止把两者混成：

```ts
catch (...) {
  callAnotherClinicalAgent();
}
```

Provider Failover 只能切换满足相同 Contract / Capability requirement 的 ModelProfile。

---

## 7.8 模型原生 Web Search 默认不作为隐式临床证据

即使某模型支持 built-in Web Search，也不能让它在 Runtime 中不可见地搜索互联网，然后把结果当作 Knowledge Evidence。

V1 默认：

```text
native_web_search = false
```

如果未来启用外部文献/网页证据，应通过：

```text
Controlled Search Tool / MCP
        ↓
normalize
        ↓
EvidenceRef + provenance
        ↓
Clinical Reasoning
```

从而保证 Evidence 可追溯、可审计、可复现。


# 8. Policy Architecture

## 8.1 Policy 只回答 “What is allowed?”

Policy 允许控制：

- Capability enable / disable
- Tool allow / deny
- MCP allow / deny
- Model allowlist
- Runtime budget
- Approval requirement
- Tenant permission
- Knowledge scope upper bound
- Timeout
- Export permission

Policy 不允许决定：

- 用户是什么意思
- 病名
- 证型
- 治法
- 方剂
- 风险是否真实存在
- 临床语义
- Doctor Decision
- Authority State

即：

```text
Semantic Intelligence:
What is happening?

Policy:
What is allowed?

Authority:
What may become authoritative?
```

---

## 8.2 Monotonic Safety

低层配置只能收紧高层限制，不能放宽：

```text
Platform Safety
      ↓
Capability Constraints
      ↓
Tenant Policy
```

例如 Tenant 可以禁用 Tool，但不能允许绕过平台 Safety。

这是 Hard Invariant，不是管理员配置项。

---

# 9. Inquiry Architecture

不使用固定 `Inquiry Matrix` 控制问诊流程。

采用：

```text
Inquiry Library
+
Inquiry Planner
```

Library 提供：

```text
问题候选
适用的信息缺口
为什么有鉴别价值
证据来源
```

Planner 输入：

```text
ClinicalUnderstanding.informationGaps
RuntimeContext
```

动态决定最值得问什么。

禁止：

```text
Disease A
→ Question 1
→ Question 2
→ Question 3
```

作为固定程序链。

---

# 10. Reasoning Artifacts, Not Pipelines

以下对象可以存在：

```text
ClinicalHypothesis
ClinicalProblem
ClinicalObjective
StrategyCandidate
FormulaProposal
Contradiction
InformationGap
```

但它们是 `Reasoning Artifacts`，不是强制 Workflow Stage。

禁止将：

```text
Problem
→ Objective
→ Strategy
→ Formula
```

写成每个请求都必须执行的硬流水线。

“病 → 证 → 法 → 方”保留为医生可理解的 UI projection，而不是程序控制模型。

---

# 11. Safety Architecture

Safety = Semantic Risk Understanding + Hard Invariant.

流程：

```text
Natural Language
    ↓
ClinicalUnderstanding.risks
    ↓
RiskHypothesis
    ↓
Risk Resolution
    ↓
RiskState
    ↓
Authority Invariant
```

例如模型可以从：

```text
“一小时换五六片卫生巾，站起来头晕”
```

理解为高风险活动性出血，即使文本中没有“大出血”关键词。

一旦高风险状态被确认：

```text
routine formula commit → forbidden
```

这是 Deterministic Invariant。

禁止创建：

```text
BleedingKeywordGate
StrokeKeywordGate
CancerKeywordGate
```

作为 Safety 主机制。

---

# 12. Authority Kernel

Authority Kernel 必须保持 dumb、stable、small。

它不负责：

- 诊断
- 辨证
- 治法选择
- 最佳方剂选择
- 业务 Capability 选择

它负责：

- Identity authority
- Tenant / Doctor permission
- Encounter isolation
- Fact authority
- Safety invariant
- Formula integrity
- Doctor decision
- Commit
- Export authority
- Audit

原则：

> **Agent may become smarter. Kernel should remain stable.**

---

## 12.1 Formula Authority

保留：

```text
NORMATIVE
GENERATED_DRAFT
BLOCKED
```

### NORMATIVE

必须绑定真实：

```text
formula_id
source_id
composition
provenance
```

LLM 不重新“抄写”权威方组成。

### GENERATED_DRAFT

没有直接规范方，但在安全边界内允许形成医生审核稿。

### BLOCKED

只用于真实 authority / safety / integrity failure。

禁止恢复：

```text
selected_syndrome == null
→ BLOCKED
```

这类把临床不确定性错误转换成系统失败的逻辑。

---

# 13. Control Plane vs Runtime Plane

Control Plane 只操作 Draft。

管理员修改：

```text
Capability
Skill
Prompt/Profile
Policy
Knowledge
Model Profile
Tool
Inquiry resources
```

后不能直接影响下一位患者。

必须：

```text
DRAFT
  ↓
Schema Validation
  ↓
Dependency / Compatibility
  ↓
Architecture Static Analysis
  ↓
Golden Eval
  ↓
Invariant Tests
  ↓
Shadow
  ↓
Canary
  ↓
ACTIVE
  ↓
Runtime Release Compiler
  ↓
EffectiveRuntimeRelease@hash
```

Runtime 只读取不可变 Release。

Runtime 不读取：

- 正在编辑的 Skill
- Draft Prompt
- Draft Policy
- 未发布知识
- 半成品 Capability

---

# 14. EffectiveRuntimeRelease vs ClinicalRunSnapshot

必须区分。

## 14.1 EffectiveRuntimeRelease

描述本次 Run **可以使用什么**：

```json
{
  "platformBuild": "...",
  "contractRelease": "...",
  "agentProfile": "...",
  "modelProfiles": ["..."],
  "fallbackModelProfiles": ["..."],
  "promptBundle": "...",
  "enabledCapabilities": ["..."],
  "knowledgeRelease": "...",
  "skillBundle": "...",
  "toolBundle": "...",
  "policyBundle": "..."
}
```

由 Control Plane 编译并签名/hash。

---

## 14.2 ClinicalRunSnapshot

描述本次 Run **实际上发生了什么**：

```json
{
  "runtimeRelease": "sha256:...",
  "resolvedCapabilities": ["..."],
  "loadedSkills": ["..."],
  "knowledgeScopes": ["..."],
  "modelUsed": "...",
  "retrievalParams": {},
  "toolCalls": [],
  "authorityDecisions": []
}
```

一个 ClinicalRun 开始后，RuntimeRelease 不允许漂移。

---

# 15. Technology Strategy: Reuse > Adapt > Build

## 15.1 不轻易造轮子

任何基础设施开发前必须依次回答：

```text
1. 成熟官方 SDK 是否已经提供？
2. 能否通过 Adapter 使用？
3. 是否真的存在不可替代的业务需求？
4. 自研后是否会形成长期维护负担？
```

技术决策优先级：

> **Reuse > Adapt > Extend > Build**

---

## 15.2 Agent Runtime

当前推荐：

```text
Vercel AI SDK 7
```

用于成熟 Agent runtime primitive：

- ToolLoopAgent
- typed runtime/tool context
- tool approval
- model/provider abstraction
- streaming
- timeout
- telemetry
- durable WorkflowAgent（真正需要长生命周期时）

但 Core Architecture 不依赖 AI SDK。

必须通过：

```text
AgentRuntimePort
ModelPort
ToolPort
ApprovalPort
```

隔离。

AI SDK = Adapter，不是平台架构本身。

---

## 15.3 Model Routing / Prompt Versioning

模型选择与 Prompt 变化必须通过配置资产完成，而不是改 Clinical Runtime。

核心接口：

```text
ModelPort
ModelRouter
ModelProfile
PromptProfile
```

建议区分：

```text
primary reasoning profile
high-capability fallback profile
provider failover profiles
```

这些名称描述平台运行职责，不描述临床业务语义，因此可以作为有限的平台配置角色。

当前可配置一个：

```text
clinical-fallback-high-reasoning
→ Alibaba Cloud Model Studio
→ qwen3.8-max
```

但 Core Code 不引用 `qwen3.8-max` 字符串。

ModelProfile / PromptProfile 均进入 EffectiveRuntimeRelease，并被 ClinicalRunSnapshot 记录。


## 15.4 Workflow

不要自研自由流程编排器。

短生命周期 Agent 直接使用 ToolLoopAgent。

只有出现：

- 长时间等待医生审批
- 跨进程恢复
- 外部系统异步等待
- durable continuation

才考虑 WorkflowAgent。

Workflow 只能使用稳定 primitive，不建立自由业务 `IF/ELSE/JUMP` Clinical Workflow DSL。

---

## 15.5 MCP

MCP 用于外部系统边界：

```text
HIS
LIS
PACS
Literature
Drug DB
Device
External tools
```

使用官方 MCP TypeScript SDK v2 stable line。

所有 MCP 输入：

```text
External MCP
    ↓
Tool Gateway
    ↓
normalize / validate
    ↓
FactCandidate / Evidence
    ↓
Authority
```

MCP 不允许直接写 Encounter / Fact / Prescription。

---

## 15.6 Clinical Core

VNext 2.0 不强制把 Clinical Core 拆成 Python/FastAPI。

当前优先：

```text
TypeScript Modular Monolith
+
Platform-owned Contracts
```

仅在出现真实理由时拆独立服务，例如：

- Python-only clinical/scientific algorithms
- 独立扩缩容
- 独立团队 ownership
- 独立安全/合规部署边界

原则：

> **Separate boundaries before separating processes.**

---

# 16. Recommended VNext 2.0 Stack

```text
Web
- Next.js
- React
- TypeScript

Clinical Runtime
- TypeScript
- Platform-owned Contracts
- AI SDK 7 Adapter

Contracts
- Zod / JSON Schema / OpenAPI
- single source of truth
- generated clients/models when cross-language is required

State
- PostgreSQL
- pgvector where appropriate

Knowledge
- lexical
- dense
- rerank
- source fallback
- provenance

External Integration
- MCP TypeScript SDK v2
- Typed HTTP/OpenAPI internally where needed

Observability
- OpenTelemetry
- runtime trace
- authority audit

Deployment V1
- Docker Compose
```

禁止无明确需求叠加：

```text
LangChain
LangGraph
CrewAI
AutoGen
第二套 Agent Runtime
自研通用 Workflow Engine
自研通用 MCP SDK
```

---

# 17. Repository Architecture

```text
pgy-clinical-platform/
│
├── apps/
│   └── web/
│       ├── doctor/
│       └── admin/
│
├── packages/
│   ├── contracts/
│   ├── ui/
│   └── shared/
│
├── platform/
│   ├── understanding/
│   ├── runtime/
│   ├── agent/
│   ├── model-routing/
│   ├── capability/
│   ├── registry/
│   ├── skills/
│   ├── inquiry/
│   ├── policy/
│   ├── authority/
│   ├── release/
│   └── trace/
│
├── adapters/
│   ├── ai-sdk/
│   ├── model-providers/
│   ├── mcp/
│   └── persistence/
│
├── prompts/
│   ├── clinical-primary/
│   └── clinical-fallback/
│
├── capabilities/
│   ├── tcm-core/
│   ├── gynecology/
│   └── gaofang/
│
├── knowledge/
│   ├── sources/
│   ├── runtime/
│   ├── shadow/
│   └── evaluation/
│
├── evals/
│   ├── golden/
│   ├── regression/
│   ├── architecture/
│   ├── invariant/
│   └── failure-injection/
│
├── infra/
│   ├── docker/
│   ├── postgres/
│   └── observability/
│
└── docs/
    ├── architecture/
    ├── ADR/
    └── contracts/
```

不要创建：

```text
disease_engine/
syndrome_engine/
gaofang_engine/
oncology_engine/
pediatrics_agent/
formula_decision_tree/
```

---

# 18. Data Model Strategy

## 18.1 Authoritative Domain

优先结构化：

```text
Tenant
Doctor
Membership
Patient
PatientIdentifier
Encounter
Fact
FactRevision
DoctorDecision
ClinicalEvent
FormulaCommit / Prescription
RuntimeRelease
AuditLog
```

## 18.2 Non-authoritative Run Artifacts

第一阶段优先：

```text
ClinicalRun
RunArtifact JSONB
Proposal
EvidenceRef
ToolCall
Trace
```

不要因为 AI 当前产生某个中间对象，就立即为它建立永久 SQL 表。

当对象真正需要：

- 跨 Encounter 查询
- 独立权限
- 独立生命周期
- 统计分析
- 稳定版本语义

再升级为正式 domain table。

避免让 AI 的内部推理结构反向绑死数据库。

---

# 19. Architecture Tests — Rules as Executable Tests

`pgy_code_rules` 不能只存在于文档。

CI 必须逐步验证：

### Core Business-ID Guard

Core / Runtime / Authority 不允许引用 Capability manifest 中的业务 ID、目录名、业务 display name。

### Primary Agent Guard

禁止：

- domain switch
- disease switch
- syndrome switch
- capability hard-code
- semantic keyword truth

### Adapter Boundary Guard

`ai` / AI SDK package import 只能存在于 adapter / agent-runtime integration layer。

Clinical Core / Authority / Knowledge 不直接依赖 SDK。

### Knowledge Isolation Guard

`knowledge/evaluation` 不得被 runtime dependency graph 引用。


### Model Portability Guard

Core Runtime 不允许引用具体 provider / model ID，例如：

```text
qwen3.8-max
gpt-*
claude-*
gemini-*
```

这些只能存在于 ModelProfile / deployment config / adapter tests。

### Prompt Drift Guard

Prompt 必须来自 PromptProfile / released prompt bundle。

禁止 Runtime 读取 Draft Prompt；ClinicalRun 必须记录 prompt hash。

### Fallback Authority Guard

Model-generated fallback 内容不得直接标记为 `NORMATIVE`。

没有真实规范 source/provenance 时，方剂最高只能进入 `GENERATED_DRAFT`。


### Authority Bypass Guard

任何 NORMATIVE / Commit 都必须经过 Authority Pipeline。

### Safety Invariant Guard

已确认高风险状态不得被 tenant/capability policy 放宽。

### Release Immutability Guard

Runtime 不得读取 Draft config。

ClinicalRun pin 的 release hash 不得在 run 中变化。

### Capability Extension Test

新增一个测试 Capability 后：

```text
Primary Agent        0 business change
Runtime Core         0 business change
Authority Kernel     0 business change
Knowledge Engine     0 business change
Core DB Schema       0 business change
```

---

# 20. Evaluation Strategy

评测不仅测临床命中率。

至少包含：

```text
Disease / syndrome / formula quality
Retrieval Recall@K
Normative source hit
Capability resolution quality
Interaction mode quality
Evidence sufficiency assessment quality
Fallback invocation precision / recall
Fallback clinical quality
Model / Prompt regression by profile
Safety recall
Authority violation count
Tool failure rate
Latency
Token / cost
Architecture invariant result
```

Golden / calibration / holdout 不得进入 runtime。

调优允许改变：

- Prompt
- Retrieval params
- Skill
- Capability semantic descriptor
- Model profile

但不能通过：

- case-specific hack
- expected-answer lookup
- business `if`
- holdout leakage

提升分数。

---

# 21. Development Roadmap from Current State

当前项目已经不是从零开始，不重做旧 M0–M5。

## R0 — Freeze Current Correct Kernel

- freeze seven-correction baseline
- calibration baseline
- commit/model/knowledge/checksum/retrieval params

## R1 — Runtime Framework

- RuntimeContext
- RuntimePreparer
- unified Registry
- Skill JIT
- Evidence Sufficiency
- Reasoning Escalation
- ModelRouter / ModelProfile / PromptProfile
- AuthorityPipeline
- Architecture Tests

## R2 — Clinical Quality Gate

- calibration
- tuning
- freeze
- holdout
- failure analysis

## R3 — Minimal Authoritative State

- Patient
- Encounter
- DoctorDecision
- Fact Authority
- append-only authority events
- Audit

## R4 — Doctor Workspace

- conversation
- streaming
- structured result
- evidence
- trace
- HITL
- no frontend clinical authority

## R5 — Runtime Release Compiler CLI

- draft
- validate
- compatibility
- eval
- immutable release
- run pinning

## R6 — Minimal Control Plane

- Capability
- Skill
- Knowledge
- Eval
- Release
- Trace

不要一开始建设巨型 Admin Studio。

## R7 — Extensibility Proof

至少再接入 2–3 个新的 Capability。

验收核心代码保持稳定。

## R8 — External Integration

- MCP
- HIS
- LIS
- PACS
- literature
- drug database

## R9 — Production Hardening

- PHI log redaction
- secrets
- backup/restore
- disaster recovery
- rate limits
- tenant audit
- shadow telemetry
- canary rollback

---

# 22. Mandatory Anti-patterns

以下出现时必须暂停开发并重新设计：

```text
if (gaofang)
if (pediatrics)
if (oncology)
switch (disease)
switch (syndrome)
text.includes("临床业务词") → final semantic conclusion
DiseaseEngine → SyndromeEngine → TreatmentEngine → FormulaEngine
业务 Capability 需要修改 Core Runtime
业务需求导致 Authority Kernel 增加 domain switch
所有 Skill 永久塞进 Prompt
Policy DSL 解释临床语义
Workflow DSL 表达临床决策树
evaluation 数据进入 runtime
Agent 直接写 authoritative state
MCP 直接写 clinical state
Admin Draft 立即作用于当前患者
前端判断 Safety / Authority
Core Runtime 写死 qwen3.8-max / GPT / Claude 等具体模型
if (retrievalScore < X) → clinical fallback 作为唯一判断
Fallback 模型输出直接升级 NORMATIVE
Prompt 散落在业务代码并无法版本追踪
模型 built-in Web Search 产生不可追溯的隐式临床证据
```

---

# 23. Coding Agent Mandatory Checklist

每次修改前必须回答：

```text
1. 这是 Understanding / Capability / Skill / Knowledge / Tool /
   Authority / Adapter / UI / Infrastructure 中的哪一层？

2. 是否正在把开放世界语义写成枚举、switch、关键词规则？

3. Core 是否开始认识新的业务 ID？

4. 是否重复创建另一个 semantic detector？

5. 是否把 Proposal 当成 Authority？

6. 是否让 local business change 影响多个 Core modules？

7. 成熟 SDK 是否已经提供该 primitive？

8. 是否可以通过 Port / Adapter 接入，而不是自研？

9. 是否需要新增 Architecture Test？

10. 模型与 Prompt 是否通过 ModelProfile / PromptProfile 引用，
    而不是写死 provider/model/prompt？

11. 当前是在做 Reasoning Fallback 还是 Provider Failover？
    两者是否被错误混合？
```

修改后必须报告：

```text
Changed files
Architecture layer
New hard-coded business logic? YES/NO
Core Runtime changed? YES/NO
Authority changed? YES/NO
Contract changed? YES/NO
Architecture tests
Regression result
```

---

# 24. Architecture Acceptance Scenarios

系统至少长期通过以下测试：

### Case A — Normal clinical input

正常病例：

```text
→ clinical mode
→ retrieve evidence
→ produce clinical proposal
→ formula authority
```

### Case B — Non-clinical conversation

“今天太累了，晚上想去吃烧烤。”

```text
→ conversation mode
→ natural response
→ no fake disease
→ no fake formula
```

### Case C — Semantic Capability Discovery

“最近天冷，身体比较虚，想弄一料慢慢调，不想每天煎药。”

```text
→ shared Understanding
→ semantic Capability resolution
→ gaofang capability
```

不得依赖“膏方”关键词。

### Case D — Semantic Safety

“一小时换五六片卫生巾，站起来眼前发黑。”

```text
→ semantic risk understanding
→ high-risk state
→ routine formula commit blocked
```

不得依赖“大出血”关键词。

### Case E — New Capability

新增一个完全新的临床能力。

必须满足：

```text
Primary Agent      0 business changes
Runtime Core       0 business changes
Authority Kernel   0 business changes
Knowledge Engine   0 business changes
Core Schema        0 business changes
```

### Case F — Knowledge-insufficient Clinical Reasoning

输入一个当前 Knowledge Release 无充分证据覆盖、但模型可以合理推理的临床主诉。

必须满足：

```text
Knowledge retrieval attempted
→ Evidence Sufficiency identifies unresolved aspects
→ controlled reasoning escalation
→ configured high-capability ModelProfile
→ model-generated proposal
→ provenance records model + prompt + release
→ Safety / Authority still enforced
→ no fake normative citation
→ formula cannot become NORMATIVE without real source
```

将 fallback profile 从 `qwen3.8-max` 替换为另一个兼容模型时：

```text
Clinical Runtime code     0 changes
Authority Kernel          0 changes
Capability Core           0 changes
```

只允许：

```text
ModelProfile / PromptProfile / Release / Eval
```

发生变化。

---

# 25. Final Architecture Invariants

1. Open World → AI Understanding.
2. Closed World → Deterministic Code.
3. Semantic understanding must never be replaced by configuration logic.
4. Rules constrain boundaries, not reasoning paths.
5. Business extension → Capability, not Core Branch.
6. Knowledge provides Evidence, not Workflow.
7. Skill provides Method, not hard-coded Answer.
8. Tool performs Action, not Clinical Authority.
9. Agent produces Proposal; Authority controls Commit.
10. Safety = Semantic Risk Understanding + Hard Invariant.
11. Primary Agent does not know concrete business capability IDs.
12. New Capability should not require Core Runtime modification.
13. Evaluation data never enters Runtime.
14. Uncertainty is allowed; do not force Top-1 for software convenience.
15. Natural conversation is part of the product, not an exception.
16. Local business change stays local.
17. Runtime reads immutable Release, never Draft.
18. Release defines what is available; RunSnapshot records what actually happened.
19. Reuse > Adapt > Extend > Build.
20. SDKs are adapters; project-owned Contracts are architecture.
21. Knowledge-first does not mean knowledge-only; insufficient evidence may trigger controlled generative reasoning.
22. Model and Prompt are versioned runtime assets, never Core business dependencies.
23. Reasoning Fallback and Provider Failover are separate mechanisms.
24. Model-generated reasoning never fabricates normative provenance.
25. Agent may become smarter; Authority Kernel should remain stable.
26. Architecture boundaries are enforced by tests, not memory.

---

# 26. Final Decision Rule

每次设计和编码前，先问两个问题：

> **Am I helping AI understand the world, or am I enumerating the world in code?**

如果答案是“enumerating the world”，停止并重新设计。

然后再问：

> **If a completely new clinical capability appears tomorrow, do I need to modify the Core Runtime?**

如果答案是 Yes，说明插件边界还没有完成。

PGY Clinical Copilot VNext 2.0 的目标不是做一个规则更复杂的临床软件，而是：

> **Build an AI-native Clinical Runtime that understands messy real-world input, dynamically discovers capabilities, reasons from evidence, reuses mature agent infrastructure, and preserves stable clinical authority boundaries.**

---

# 27. Technology Verification Notes

截至 2026-09-16：

- Vercel AI SDK 7 已提供 ToolLoopAgent、typed runtime/tool context、tool approval、timeouts、telemetry 与 durable WorkflowAgent 等生产 Agent primitive。平台应优先复用这些能力，但通过 project-owned Ports 隔离。
- MCP TypeScript SDK v2 为 stable release line，实施 2026-07-28 MCP specification；外部系统集成优先采用官方 SDK，并放在 MCP/Tool Gateway Adapter 边界。
- Alibaba Cloud Model Studio 当前提供 `qwen3.8-max`；官方文档显示其支持 thinking、function calling、structured output、built-in tools，并提供约 1M context。它可以作为当前 `clinical-fallback-high-reasoning` ModelProfile 的候选实现。
- `qwen3.8-max` 不是 Architecture Contract。未来更换模型只应修改 ModelProfile / PromptProfile / Release / Eval，而不修改 Clinical Runtime 或 Authority Kernel。
- 上述 SDK / 模型选型属于当前推荐实现，不属于不可替换的 Architecture Contract。真正冻结的是 Ports、Authority、Runtime contracts 和边界。

Official references:

- https://vercel.com/changelog/ai-sdk-7
- https://ts.sdk.modelcontextprotocol.io/v2/
- https://github.com/modelcontextprotocol/typescript-sdk
- https://www.alibabacloud.com/help/en/model-studio/text-generation-model
- https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen3-8-max

---

**Architecture Baseline End — VNext 2.0**

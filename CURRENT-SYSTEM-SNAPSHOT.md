# CURRENT-SYSTEM-SNAPSHOT

> 基于当前工作树与当前实际运行代码，只做 READ / TRACE / SUMMARIZE。本轮未修改任何 src / Skill / Prompt / 知识库 / 评测脚本。
> 生成时间：2026-09-20。基线 commit：`6efe5d8`（本快照前已提交的 H14/H15 工作，见 §1）。

---

## 1. 当前版本与验证状态

```text
git branch:      main（领先 origin/main 5 个 commit）
git commit/HEAD: 6efe5d8 "feat: H14-H15 diagnostic infrastructure, pattern assessment, formula evidence expansion, external-therapy/preparation capabilities"
working tree:    提交后干净（无未提交变更）
Node:            >= 22（engines），package version 0.1.0
依赖:            ai@^7.0.102、@ai-sdk/openai-compatible@^3.0.49、zod@^4.6.5、tsx、typescript@^7.0.2
model:           环境变量 LLM_FAST_MODEL / LLM_DEEP_MODEL（.env.example 未填，运行时注入）
                 deepModel → Primary Agent + Understanding；fastModel → Clinical Planner
knowledgeRelease: KB_RELEASE_DIR = ../assets/knowledge/releases/2026.09.4-kb-parity-r1
                 独立诊断 release：2026.09.19-diagnostic-r1（见 §7）
feature flags:   TCM_DIAGNOSTIC_PATTERN_SET / TCM_DISEASE_CROSSWALK / TCM_STANDARD_RUNTIME /
                 TCM_DIAGNOSTIC_RELEASE / TCM_PATTERN_ASSESSMENT / TCM_H14（全部 env 开关，默认 OFF）
step limit:      maxSteps 默认 16（agent-runtime.ts 的 resourceSteps；reasoningPassCount 恒为 1）
```

```text
typecheck:  PASS（tsc --noEmit，无错误）
tests:      274 pass / 0 fail / 0 skip
arch:test:  PASSED（"Architecture guard PASSED (9 capability markers protected)"）
```

---

## 2. 当前真实 Clinical Runtime 链路

装配入口 [runtime.ts](file:///d:/self/pgyx1.0/PGYxv1.0/pgy-clinical-mvp/src/composition/runtime.ts)：
`RuntimePreparer`（harness）/ `ClassicRuntimePreparer`（classic A/B）→ `AiSdkPrimaryAgent` → `AuthorityPipeline([SafetyInvariantStage, FormulaAuthorityStage])`。

harness 模式真实链路：

```text
医生输入 (context.input，原文保留)
  ↓ understand()                          [Understanding 层] LLM 结构化
  ↓ RiskHypothesisSafetyPort.evaluate     [Safety 种子]      deterministic
  ↓ StructuredClinicalPlanner.plan        [Planner 层]       LLM 结构化
  ↓ RuntimePreparer.prepare：seed workspace（caseFacts=CF_xxx，clinicalQuestion）
  ↓ HarnessSession：capability.discover / activate          [Agent 驱动]
  ↓ AiSdkPrimaryAgent.run（ToolLoopAgent，maxSteps=16）
       ↓ knowledge.search / get_source / search_cards / get_asset /
       ↓   get_diagnostic_patterns / get_disease_standard / get_syndrome_standard
       ↓ formula.search_candidates → formula.get_evidence（两阶段，门禁）
       ↓ workspace.consider_hypotheses / focus_candidates / record_deliberation /
       ↓   record_candidate_assessment / record_candidate_exclusion
       ↓ proposal.submit（门禁：unresolved hypotheses / clinical core / completion）
  ↓ canonicalizeProposalSubmit：candidate_ref → canonical hydrate → NORMATIVE/GENERATED_DRAFT
  ↓ hydrateFormulaProposal（canonical hydrate，不信任模型重建 composition）
  ↓ recordCandidateDecision / recordHypothesisDecision
  ↓ AuthorityPipeline：[SafetyInvariantStage → FormulaAuthorityStage]
  ↓ Commit（AgentResult）
```

各节点归属（谁负责 / 是否模型判断 / 是否 deterministic）：

| 节点 | 谁负责 | 模型判断 | deterministic |
| --- | --- | --- | --- |
| 事实理解（facts） | Understanding（LLM） | YES | NO |
| 风险/安全处置 | RiskHypothesisSafetyPort（Runtime） | NO（消费 understanding.risks） | YES |
| 临床策略 | StructuredClinicalPlanner（LLM） | YES | NO |
| workspace seed | RuntimePreparer（Runtime） | NO | YES |
| 能力发现/激活 | Agent | YES | NO |
| 检索 | Tool（Runtime 内被 Agent 调用） | NO（检索执行 deterministic；调用时机 Agent 决定） | YES |
| 假设/候选/评估 | Agent（workspace.* tools） | YES | NO（写事件 deterministic，内容模型判断） |
| 选方 | Agent（record_deliberation.formulaSelection / proposal.submit.candidate_ref） | YES | NO |
| canonical hydrate | Runtime（canonicalizeProposalSubmit / hydrateFormulaProposal） | NO | YES |
| Safety gate | SafetyInvariantStage（Kernel/Authority） | NO | YES |
| Formula authority | FormulaAuthorityStage（Authority） | NO | YES |

---

## 3. Workspace 当前到底保存什么

定义 [workspace.ts](file:///d:/self/pgyx1.0/PGYxv1.0/pgy-clinical-mvp/src/contracts/workspace.ts)，实现 [clinical-workspace.ts](file:///d:/self/pgyx1.0/PGYxv1.0/pgy-clinical-mvp/src/platform/workspace/clinical-workspace.ts)（事件溯源 + apply 投影）。

主要 durable state：

| State | 谁创建 | 谁更新 | 谁消费 | submit hard requirement | 进入 WorkingView |
| --- | --- | --- | --- | --- | --- |
| caseFacts (CF_xxx) | RuntimePreparer（seed） | 无（只读） | Agent / WorkingView / gate | NO（但 pattern primary 需引用 patient ref） | YES（Case Frame） |
| evidenceState.evidenceItems | 检索工具结果（workspace-events） | 检索工具 | WorkingView / gate / 校验 | NO | 部分（retrievedInterpretations） |
| hypothesisState.hypotheses | workspace.consider_hypotheses | record_deliberation | WorkingView / proposal.submit gate | YES（unresolved formal hypothesis 阻塞 submit） | YES（leadingHypotheses） |
| candidates | 检索工具（candidate.presented） | focus/selected/rejected | WorkingView / hydrate | NO | 部分（focusedCandidates） |
| deliberationState（assessments/frontier/coverage） | Agent | Agent | WorkingView | NO | 部分（frontier） |
| promotionState | 事件派生 | 事件派生 | 诊断/观测 | NO | NO |
| patternAssessment | record_deliberation | 同左 | gate / formula projection | YES（clinical core 要求 patternAssessmentRef） | YES（Pattern Structure，flag ON） |
| clinicalDecisionSpine.* | record_deliberation / seed | 同左 | gate / hydrate | 部分（见 §10） | 间接（decisionState） |
| safetyDisposition | RuntimePreparer（seed） | 无 | WorkingView / Safety stage | NO | 部分 |
| activeCapabilities/activeSkills | harness 激活 | harness | WorkingView / 快照 | NO | YES |

**关键结论：**
- Workspace 主体是「保存 Agent 认知结果」（evidence/hypothesis/candidate/assessment 都是 Agent 动作的持久化投影），不是固定流水线。
- 但 [ClinicalDecisionSpine](file:///d:/self/pgyx1.0/PGYxv1.0/pgy-clinical-mvp/src/contracts/workspace.ts#L225-L237)（H15）把「临床判断的因果顺序」结构化为固定字段（clinicalQuestion → diseaseAssessment → patternHypotheses → patternAssessment → treatmentPlan → formulaSelection → modificationPlan → formulaReview），并对其中若干字段做**版本号**与**submit 硬门禁**（§9/§10）。这是当前唯一「开始强制 Agent 按固定步骤填写」的地方——它固定的是**步骤骨架**，不是医学答案（字段全开放文本，无中医 enum）。

---

## 4. 当前 tcm-clinical-cognition Skill

```text
skill name:    tcm-clinical-cognition
version/path:  0.1.0 / skills/tcm-clinical-cognition/SKILL.md（132 行）
什么时候激活:   harness.baseline 恒注入（RuntimePreparer.baselineSkillIds = ['tcm-clinical-cognition']）
由谁激活:       RuntimePreparer（baseline）；tcm.core capability 亦引用它（激活时已存在则跳过）
进入哪些 steps: 每步 prepareStep 都经 dynamicInstructions 注入 system instructions
大约 token:     ~1.5–2k（英文）
```

内容概括（按主题标记 STRONG / PARTIAL / ABSENT）：

| 主题 | 状态 | 说明 |
| --- | --- | --- |
| 主诉理解 | PARTIAL | 有 CaseFrame/spine 纪律，无专门「主诉解析」方法论 |
| 当前 vs 历史 | STRONG | H15.2 Current-Stage Pattern Discrimination 明确区分 |
| 治疗阶段 | PARTIAL | 提及 current treatment stage / post_treatment temporal role |
| 四诊整合 | PARTIAL | 仅「舌脉冲突需重审主证/兼证」一条 |
| 病/证/法/方 | STRONG | TCM Clinical Reasoning Spine 显式因果依赖 |
| 主证/兼证 | STRONG | primary / secondary patterns |
| 标本 | PARTIAL | root/branch relationship |
| 共同病机 vs 当前主导病机 | STRONG | sharedMechanisms vs currentDominantMechanism |
| 八纲 | ABSENT | — |
| 气血津液 | ABSENT | 仅 prompt 中举「血瘀」为例，skill 无 |
| 脏腑 | ABSENT | — |
| 舌脉 | PARTIAL | 舌脉冲突规则 + temporal role，无完整舌脉法 |
| 证候比较 | STRONG | supporting/contradicting + discriminating evidence |
| 阴性证据 | STRONG | explicitly_absent / explicit-absence |
| 治疗后阶段变化 | PARTIAL | historical vs current after treatment |
| 选方方法 | STRONG | 两阶段 formula 检索 + formulaReview |

**其他 clinical reasoning Skill 是否同时注入：**
- 当前 runtime **只有 `tcm-clinical-cognition` 被注入**（baseline）。
- 可被 capability 额外激活的只有 `gaofang-reasoning`（gaofang capability 引用）。
- `tcm-clinical-reasoning`、`general-clinical-reasoning`、`clinical-reasoning-governor` 三者在 `skills/` 目录存在，但**未接线**：不在 `BASELINE_SKILL_IDS`，也不被任何 capability.json 的 `skillIds` 引用；仅在旧架构文档（H3_ARCHITECTURE.md）与 test 中被引用。属于遗留孤立 skill。

---

## 5. 医生原始输入如何被处理

处理链（[runtime-preparer.ts](file:///d:/self/pgyx1.0/PGYxv1.0/pgy-clinical-mvp/src/platform/runtime/runtime-preparer.ts) + [agent-runtime.ts](file:///d:/self/pgyx1.0/PGYxv1.0/pgy-clinical-mvp/src/adapters/ai-sdk/agent-runtime.ts)）：

1. 原文 `input` → `understand(input)` → `ClinicalUnderstanding.facts`（`kind/value/source/temporalRole/polarity`）。
2. `workspace.facts = understanding.facts`；`workspace.caseFacts = facts.map(CF_xxx)`，恒打 `evidenceKind='patient'`。
3. `workspace.informationGaps` / `uncertainties` 由 understanding 的 gaps/uncertainties 映射。
4. 原文进入 Planner（`用户输入：\n${ctx.input}`），并进入 Agent 首条 user message（`buildContextPrompt` 末尾 `医生输入：\n${context.input}`）。

**事实性回答（只报告行为）：**

- **原始主诉是否完整保留？** 是。`context.input` 原样保留，并作为首条 user message 原文注入（`医生输入：` 段），每步 `compactAgentMessages` 保留 initialMessages。
- **是否只剩拆散的 CaseFacts？** 在 WorkingView（Case Frame）里只看到 `CF_xxx kind:value` 的拆散事实；但原文仍在首条消息里同时可见。
- **原始文字顺序是否保留？** 原文顺序保留（input 未重排）；`caseFacts` 顺序取决于 LLM 抽取顺序，不保证等于原文顺序。
- **医生写在前面的信息还能被看见？** 能（原文可见）。
- **主诉/现病史/舌脉是否有来源身份区别？** 部分。`factKind` 区分 `chief_complaint / symptom / tongue_pulse / examination / past_diagnosis / past_treatment / sex / age / other`。**没有独立的「现病史」kind**——现病史内容会落入 `symptom` 或 `other`，与主诉/症状在 kind 层面不严格分离。
- **拆成 fact 后是否可能失去原始组织关系？** 是。facts 被拍平，事实间的从属/因果/时序关系只能靠原文 + `temporalRole` 部分恢复，Workspace 不保存事实间的结构化关系图。

---

## 6. Understanding 当前做了什么

输出 schema（[understanding.ts](file:///d:/self/pgyx1.0/PGYxv1.0/pgy-clinical-mvp/src/clinical/understanding.ts)）：

```text
interaction.mode (clinical/conversation/clarification/unknown)
facts[]   (kind/value/source/temporalRole/polarity)
intents[] (kind/confidence/evidence)
risks[]   (description/severity/disposition/evidence)
informationGaps[] (question/reason)
capabilityNeeds[] (capability/reason)
uncertainties[]   (item/reason)
```

能力清单：

| 能力 | 是否在做 |
| --- | --- |
| 事实提取 | YES（facts） |
| 时间分类 | YES（temporalRole） |
| polarity | YES（present/explicitly_absent/unknown） |
| evidenceKind | NO（由 RuntimePreparer 统一打 'patient'，非 understanding 产出） |
| 风险判断 | YES（risks[].severity + disposition） |
| 重要性判断 | NO（planner 才有 criticalEvidenceNeeds） |
| 病机推断 | NO（schema 无） |
| 证型推断 | NO（显式「hypotheses 仍由 Primary Agent 形成」） |
| 主次排序 | NO |

**FACT EXTRACTION vs CLINICAL INTERPRETATION：**

- FACT EXTRACTION：`facts[]`（含 temporalRole/polarity 标注——严格说「判断某事实是历史/显性阴性」已带轻微临床解释，但仍是事实层标注）。
- CLINICAL INTERPRETATION：`risks[]`（severity=问题严重度，disposition=是否需改变常规处置路径，这是**安全相关的临床判断**）、`intents[]`（语义意图）、`informationGaps[]`、`uncertainties[]`、`capabilityNeeds[]`。

**结论：** Understanding **已经越过「整理事实」**——通过 `risks[].disposition` 在做安全处置判断（这也是 Safety 种子的来源），但没有做病机/证型推断。它是一层「语义理解 + 风险初判」，不是纯事实抽取器。

---

## 7. Knowledge Base 当前现状

```text
release:            2026.09.4-kb-parity-r1（KB_RELEASE_DIR）
                    独立诊断 release：2026.09.19-diagnostic-r1（diagnostic-release.ts 读取）
主要 source 数量:   manifest 声明 4 个 runtime layer（见下）
P1/P2/其他 tier:    P1_GYN_MANUAL(P1) / P2_SHEN_CASE(P2) / S1_SYMPTOM_DIFFERENTIAL(AUX) /
                    AUX_TCM_DIAGNOSTIC_2024(AUX) / 新诊断 release 各标准(sourceStatus 区分)
```

4 个 runtime layer（[manifest.ts](file:///d:/self/pgyx1.0/PGYxv1.0/pgy-clinical-mvp/src/knowledge/manifest.ts)）：

| sourceId | 角色 | tier | 处方权 |
| --- | --- | --- | --- |
| P1_GYN_MANUAL《中医妇科临床手册》 | NORMATIVE_TREATMENT | P1 | true |
| P2_SHEN_CASE《沈仲理临证医集》 | CLINICAL_CASE | P2 | false |
| S1_SYMPTOM_DIFFERENTIAL《中医症状鉴别诊断学》 | DIAGNOSTIC_DIFFERENTIAL | AUX | false |
| AUX_TCM_DIAGNOSTIC_2024《中医病证诊断疗效标准2024》 | DIAGNOSTIC_STANDARD | AUX | false |

资产类别现状：

| 类别 | 现状 |
| --- | --- |
| 疾病知识/诊断标准 | 结构化（standard-runtime：tcm_diagnostic_2024 + 新诊断 release disease_standards） |
| 证候知识 | 结构化（S1 differential、GB/T 16751.2 syndrome_ontology、P1 diagnostic patterns） |
| 病机知识 | 结构化（诊断 release mechanism 字段，partial） |
| 治法知识 | 结构化（P1 treatment 字段 / 诊断 release treatmentPrinciple） |
| 方剂知识 | 结构化方剂记录（formula.search_normative）+ free-text RAG |
| 方剂组成 | 结构化（validateNormativeFormula 校验 composition 绑定） |
| 适应证 | 主要 free-text RAG（excerpt/indicationText） |
| 加减知识 | free-text（formula evidence 内 inline modification 文本） |
| 针灸/膏方/制剂 | Runtime Catalog 卡片（scopes：tcm.external-therapy / gaofang / tcm.preparation） |
| 其他 | 疾病 crosswalk（诊断 release candidates，runtimeReady=false 不激活） |

- 已有结构化 projection：诊断标准、证候本体、P1 证候 pattern、方剂 composition、disease concepts/crosswalk。
- 主要 free-text RAG：`knowledge.search`（向量）、方剂适应证原文、P2 病例、加减文本。
- 有 provenance：全部（sourceId/sourceFile/sourceTier/sourceSchool）。诊断 release 另有 sourceStatus/verificationStatus。
- 有 source tier：P1/P2/AUX + 诊断 release 的 sourceStatus（NORMATIVE_CURRENT / GUIDELINE_CURRENT 等）。

---

## 8. 当前 Retrieval Surfaces

工具清单（[tool-bindings.ts](file:///d:/self/pgyx1.0/PGYxv1.0/pgy-clinical-mvp/src/adapters/ai-sdk/tool-bindings.ts)，[workspace-events.ts](file:///d:/self/pgyx1.0/PGYxv1.0/pgy-clinical-mvp/src/adapters/ai-sdk/workspace-events.ts)）：

| 工具 | 输入 | 输出 | 写 Workspace | 产生 patient hypothesis | 产生 clinical decision | 是否只供 knowledge evidence | cache/reuse |
| --- | --- | --- | --- | --- | --- | --- | --- |
| knowledge.search | query/topK/role | SearchHit[] | evidence.added + candidate.presented(P1) | NO | NO | YES | evidence reuse 判定 |
| knowledge.get_source | sourceId/detailLevel | 来源全文/excerpt | evidence.added | NO | NO | YES | ledger 复用 |
| knowledge.search_cards | query/topK | RuntimeCardHit[] | knowledge.search.completed（不写 evidence） | NO | NO | YES | 无 |
| knowledge.get_asset | assetId | 完整资产 | evidence.added | NO | NO | YES | dataLineCache |
| knowledge.get_diagnostic_patterns | disease | P1 证候记录[] | 不写（仅观测 telemetry） | NO | NO | YES | 无 |
| knowledge.get_disease_standard | disease | DiseaseStandardView[] | 不写 | NO | NO | YES | 无 |
| knowledge.get_syndrome_standard | syndrome | SyndromeStandardRecord | 不写 | NO | NO | YES | 无 |
| formula.search_normative | query/promotionWorkItemRef | 候选卡[] | candidate.presented | NO | NO | YES | ledger 复用 |
| formula.search_candidates | topK | 轻量候选卡 Top3~5 | candidate.presented | NO | NO | YES | per-run 状态签名复用 |
| formula.get_evidence | candidateRef | 完整方剂证据卡 | evidence.added | NO | NO | YES | per-run evidence cache |
| formula.validate | sourceId/formulaId/composition | valid | 不写（观测） | NO | NO | YES | cached |
| workspace.consider_hypotheses | hypotheses[] | 无 | hypothesis.presented(origin=agent_reasoning) | **YES（唯一入口）** | NO | —（认知写入，非检索） | — |

**关键确认：**

- `retrievalAutoHypothesisRate` 被代码保证为 0 的机制：**结构性**——所有检索工具的 workspace-events 只产出 `evidence.added` / `candidate.presented` / `knowledge.search.completed`，**从不产出 `hypothesis.presented`**。`origin='retrieval_suggested'` 只存在于类型定义与 migration/debug，运行时不写入。patient hypothesis 唯一入口是 `workspace.consider_hypotheses`（`origin='agent_reasoning'`）。smoke 脚本打印的 `retrievalAutoHypothesisRate = 0/n` 只是观测结果，不是运行门槛。
- `formulaAutoDecisionRate` 被代码保证为 0 的机制：**结构性**——没有任何工具产出 `formula.selection.recorded`。选方只能由 Agent 通过 `workspace.record_deliberation.formulaSelection` 或 `proposal.submit.candidate_ref` 显式给出；`recordCandidateDecision` 只在 Agent 提交后按其 candidate_ref 标记 selected/rejected，不是运行时自动选方。
- 两个 rate 都是**观测指标**，不是配置项，也不存在运行门控。

---

## 9. 当前 Kernel / Hard Gates

真正会 `阻止 submit / 要求 correction / BLOCK` 的结构约束：

| Gate | 检查什么 | 为什么存在 | 归类 |
| --- | --- | --- | --- |
| `findUnresolvedFormalHypotheses`（proposal.submit） | 存在 `origin!=retrieval_suggested && status==='alternative'` 的 formal hypothesis 时 notReady | 防止有支持证据的备选假设被静默丢弃 | epistemic integrity |
| `checkClinicalCoreCompletion`（H15.2，proposal.submit） | clinical case 提交需 clinicalQuestion + diseaseAssessment + formalHypotheses + patternAssessment | 关闭 Empty-Spine Submit | clinical workflow requirement |
| `checkClinicalCompletion`（H15.1，proposal.submit） | Agent 自声明的 requiredArtifacts 是否都已形成 | 提交前结构校验（不判医学） | execution integrity |
| `checkTreatmentRetrievalContext`（treatmentSpecific 检索门禁） | treatment 检索需 clinicalQuestion/diseaseAssessment/formalHypotheses/patternAssessment/treatmentPlan | 防止先检索方剂后辨证（H14/H15） | clinical workflow requirement |
| `checkPatternAssessmentReadiness`（H15.2，treatment 检索门禁） | pattern primary 存在 + 非空 supportingEvidenceRefs + 至少一条 patient-derived 证据 | 治疗层消费前辨证结构就绪 | clinical workflow requirement |
| `validateCandidateAssessmentRefs` / `validatePatternAssessmentRefs` | candidate/hypothesis/evidence 引用必须真实存在 | 禁止伪造 identity | execution integrity |
| `SafetyInvariantStage`（Authority） | `safetyDisposition` urgent 时 block NORMATIVE formula commit | 安全兜底 | safety |
| `FormulaAuthorityStage`（Authority） | NORMATIVE 时 source_id+formula_id+composition 必须同源绑定 | 方剂来源完整性 | authority |
| `canonicalizeProposalSubmit` fail-closed | candidate_ref 无法 canonical hydrate → GENERATED_DRAFT（非 NORMATIVE） | 不信任模型重建方剂身份 | authority |
| `minimalFinalization` FAIL CLOSED | 序列化 parse/schema 两次失败 → 抛错 | 不伪造 proposal | execution integrity |

**判断：** 当前确实有把「临床思考步骤」做成 hard gate 的倾向，集中在两处——
1. `checkClinicalCoreCompletion` 强制 clinicalQuestion/diseaseAssessment/formalHypotheses/patternAssessment 四件套（步骤骨架硬门禁）。
2. treatment 检索门禁强制「先完成辨证与治法再检索方剂」（`checkTreatmentRetrievalContext` + `checkPatternAssessmentReadiness`）。

其余 gate 属于 epistemic/execution/safety/authority 的完整性约束，不涉及医学内容。

---

## 10. 当前 Proposal / Completion Contract

不同任务（只辨病/只辨证/方剂/针灸/膏方）**在代码里没有硬编码的差异化 completion requirement**。真实契约是两层：

1. **通用 Clinical Core（H15.2，所有 clinical case 强制）**：`clinicalQuestion + diseaseAssessment + formalHypotheses + patternAssessment`。
2. **Agent 自声明完成义务（H15.1）**：`completionObligation.requiredArtifacts`（允许的 artifact 类型：diseaseAssessment/formalHypotheses/patternAssessment/treatmentPlan/formulaSelection/formulaReview）。运行时只校验 Agent 自己声明的 artifact 是否「存在」，不校验医学内容。

「只辨证不加方」「开方需 formulaSelection+formulaReview」「针灸不强制基础方」这些差异化**只写在 SKILL.md 里作为 guidance，不是 hard gate**。

**关键事实回答：**

> Clinical Core 完整后，一个需要开方的任务是否可以在 selected formula 为空时 successful submit？

**可以（以当前代码为准）。** 证据：
- `checkClinicalCoreCompletion` 不要求 `formulaSelection`。
- `isArtifactSatisfied('formulaSelection')` 只判断 `spine.formulaSelection !== undefined`；而 [applyFormulaSelection](file:///d:/self/pgyx1.0/PGYxv1.0/pgy-clinical-mvp/src/platform/workspace/clinical-workspace.ts#L524-L533) 对 `selectedCandidateRef` 为空**不设防**（只写 version）。即一个 `formulaSelection = { version }` 无 `selectedCandidateRef` 也算「已满足」。
- `formulaReview` 同理只要求 `formulaReview` 存在（disposition 必须合法），不要求有选中的方。
- 因此：只要 clinical core 四件套齐 + Agent 声明（或不声明）的 artifacts 结构上存在，`selectedCandidateRef` 为空也能 successful submit。

---

## 11. 当前真实 Model-visible Context

模型实际可见组件（harness 模式，每步）：

| 组件 | 来源 | 内容 |
| --- | --- | --- |
| system/base prompt | prompt.md（this.options.instructions） | 核心原则/收敛原则/候选处理/最终提交（§见 prompt.md） |
| dynamic ACTION_PRINCIPLE | agent-runtime.ts | 收敛/复用/原子提交/检索-假设分离等（恒定注入） |
| Diagnostic Pattern Principle | agent-runtime.ts（flag ON 时） | 诊断 pattern 证据纪律 |
| Skill | renderActiveSkills(SKILL.md) | tcm-clinical-cognition 全文 |
| Clinical Working View | renderClinicalWorkingView | Goal/DecisionQuestion/CriticalNeeds/StopWhen/DecisionState/RetrievalFeedback/CaseFrame/leadingHypotheses/(PatternStructure)/retrievedInterpretations/focusedCandidates/uncertainty/activeSkills/tools |
| Active scopes | dynamicInstructions | `Active scopes: ...` |
| 首条 user message | buildContextPrompt | interaction mode + 安全处置 + **医生输入原文** |
| recent messages | compactAgentMessages | 只保留 initialMessages + 最近一步 tool call/result |
| tool descriptions | tool schema | 全部 active tools 的 description |

token 结构估算由 `computePromptComponents` 记录（只观测），无阈值。

**重复内容（重点）：** 同一批「epistemic 纪律」被多处重复展示：
- 「收敛/不要无限检索/最短路径」同时出现在 prompt.md（收敛原则）、ACTION_PRINCIPLE、SKILL.md（Convergence）。
- 「检索标签 ≠ 患者诊断、检索不自证假设」同时出现在 prompt.md 原则9、ACTION_PRINCIPLE 第153行、DIAGNOSTIC_PATTERN_PRINCIPLE、SKILL.md（Retrieval vs Patient Hypothesis）、多个 tool description。
- 「检索 query 来自病证法而非原始症状」同时出现在 SKILL.md（H15.1）、tool description、formula-evidence.ts 注释。

即 base prompt、dynamic instruction、SKILL、tool description 四层存在明显的同义重复，是当前 context 膨胀的主要来源。

---

## 12. H15.2 后当前真实状态（仅列有代码证据的事实）

**已经解决（有实现与测试证据）：**

| 项 | 证据 |
| --- | --- |
| clinical core | `checkClinicalCoreCompletion` + `proposal.submit` 门禁 |
| patient evidence | `CaseFact.evidenceKind='patient'` + `checkPatternAssessmentReadiness` 要求 patient-derived ref |
| temporal evidence | `TemporalRole`（current/historical/post_treatment/baseline/uncertain_time）贯通 understanding→caseFact |
| reference provenance | `EvidenceKind`（patient/diagnostic_knowledge/treatment_knowledge）、`sourceSchool`、`evidenceKindForRole` |
| retrieval→hypothesis separation | `origin` 字段 + 检索工具结构性不产出 hypothesis 事件 |
| formula retrieval（两阶段） | `formula.search_candidates` → `formula.get_evidence`，均被 treatment 门禁 + pattern readiness 门禁 |
| formula evidence expansion | `getFormulaEvidence`（组成/适应证/原文/治法/inline modification） |
| formula selection | `selectedCandidateRef` 必须指向本轮已检索 candidate（tool 侧 `assertKnownCandidateRef`） |
| forced finalization | `minimalFinalization`（ProposalDraft 序列化，不重新检索/辨证） |
| successful submit | `proposal.submit` 三重门禁 + `canonicalizeProposalSubmit` 返回真实 proposal 才终止 loop |

**仍未解决（有代码证据的缺口/张力）：**

- `buildProposalDraft` 只序列化 `syndrome + selectedCandidateRef + uncertainty`；`disease` 与 `treatment` 恒为 `undefined`（Workspace 未把 disease name / treatment text 单独持久化为 proposal 可读字段，只有 spine.diseaseAssessment.statement 与 treatmentPlan，未回填 draft）。minimal-finalization 路径下模型被要求输出 `disease.name / treatment.text`，但 prompt 中这两个字段是 null，存在「模型自行补 disease/treatment」的空隙。
- 开方任务在 `selectedCandidateRef` 为空时仍可 successful submit（见 §10），没有硬约束把「开方」绑定到「非空选方」。
- 「只辨证/开方/针灸/膏方」的差异化完成义务仍是 SKILL guidance，未上升为运行时可校验的 per-task contract。

---

## 13. 当前 Architecture Boundary

| 内容 | 当前主要归属 |
| --- | --- |
| 医学认知方法 | Skill（tcm-clinical-cognition）+ Prompt（重复注入） |
| 主诉理解 | Understanding（LLM）——事实抽取；主诉方法论在 Skill 仅 PARTIAL |
| 四诊整合 | Skill（PARTIAL，仅舌脉冲突一条） |
| 辨证方法 | Agent + Skill（主证/兼证/病机结构在 Skill，开放文本） |
| 专科思维 | Capability + Skill（膏方/外治/制剂 capability 声明，专科 skill 少） |
| Patient facts | Runtime（seed caseFacts） |
| Evidence provenance | Knowledge + Workspace（sourceId/sourceSchool/evidenceKind） |
| Temporal state | Understanding→Runtime（temporalRole 标注） |
| Hypothesis state | Workspace（Agent 驱动） |
| Formula evidence | Knowledge + Runtime（两阶段检索 + canonical hydrate） |
| Completion check | Kernel（hard gate：clinical core + self-declared obligation） |
| Safety | Kernel/Authority（SafetyInvariantStage + RiskHypothesisSafetyPort） |
| Authority | Authority（FormulaAuthorityStage + DeterministicFormulaAuthority） |

**MIXED 项：**
- **医学认知方法**：MIXED —— Prompt（base/dynamic）+ Skill 重复承载同一套 epistemic 纪律。
- **完成义务**：MIXED —— 结构性 gate 在 Kernel，但「什么任务该声明什么 artifact」的语义判断在 Skill（guidance）+ Agent。
- **辨证方法**：MIXED —— 结构骨架在 Workspace（ClinicalDecisionSpine/PatternAssessment），方法学在 Skill，执行在 Agent。

---

## 最终自检

```text
Source changes made: NONE
```

（本轮仅做 READ / TRACE / SUMMARIZE / REPORT；唯一落盘产物为本快照 `CURRENT-SYSTEM-SNAPSHOT.md`，不修改任何 src / Skill / Prompt / 知识库 / 评测脚本。）

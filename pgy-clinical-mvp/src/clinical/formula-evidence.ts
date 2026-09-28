import { loadIndex } from '../knowledge/build.js';
import { searchWithDiagnostics } from '../knowledge/search.js';
import { resolveCaseDiseaseNames } from '../knowledge/disease-concepts.js';
import type { RetrievalDiagnostics } from '../knowledge/diagnostics.js';
import type { KnowledgeDoc, SearchHit } from '../knowledge/types.js';
import type { ClinicalWorkspace, FormulaRetrievalLane, SourceSequenceStep } from '../contracts/workspace.js';

/**
 * H15.1 Formula Evidence —— source-backed projection。
 *
 * 关键约束（来自 H15.1 规格）：
 * - FormulaEvidenceCard 的 disease / syndrome / treatmentPrinciple 全部来自现有知识元数据，
 *   绝不自动补证型/治法、绝不根据药味推断、绝不根据病例 Gold 反向填 metadata。
 * - 检索 query 来自 Clinical Spine Projection（病 + 证 + 治法），不是患者原始症状。
 * - 检索只产生「知识关联」，绝不产生 patientMatchScore / bestFormula / 证型评分。
 */

/** 一个证据上下文：statement 来自来源原文，sourceRef 指向来源 identity。 */
export interface EvidenceContext {
  statement: string;
  sourceRef: string;
}

/** 完整方剂证据卡（第二阶段 formula.get_evidence）。 */
export interface FormulaEvidenceCard {
  formulaId: string;
  formulaName: string;
  aliases?: string[];
  diseaseContexts: EvidenceContext[];
  syndromeContexts: EvidenceContext[];
  treatmentPrinciples: EvidenceContext[];
  indicationText?: string;
  sourceId: string;
  sourceTier: string;
  provenance: unknown;
  /** H15.2.7：P2 病例方药单元的组成（source fidelity，不升级处方权）。 */
  composition?: string[];
  /** Parent/source stage semantics, structurally ingested from KB. (Legacy flattened field, backward compat) */
  stageGuidance?: string[];
  conditionalGuidance?: string[];
  sequence?: SourceSequenceStep[];
  /** Scoped stage semantics from source/doc level. */
  sourceStageGuidance?: string[];
  sourceConditionalGuidance?: string[];
  sourceSequence?: Array<{ order: number; instruction: string }>;
  /** Scoped stage semantics from product/formula level. */
  productStageGuidance?: string[];
  productConditionalGuidance?: string[];
  productSequence?: Array<{ order: number; instruction: string }>;
  /** Formula-local stage semantics retain product identity inside a source-level candidate. */
  productGuidance?: Array<{
    formulaId: string;
    formulaName: string;
    stageGuidance?: string[];
    conditionalGuidance?: string[];
    sequence?: SourceSequenceStep[];
  }>;
}

/** 轻量候选卡（第一阶段 formula.search_candidates，Top 3~5）。 */
export interface FormulaCandidateCard {
  candidateRef: string;
  /**
   * Top-level single-formula identity is NOT present for P1 SOURCE_NODE candidates. A source-level
   * candidate must not be represented by its first product; membership lives in sourceProductRefs/Names.
   * P2 case-visit candidates do carry a formulaId/formulaName because each visit is one prescription.
   */
  formulaId?: string;
  formulaName?: string;
  matchedDiseaseContexts: EvidenceContext[];
  matchedSyndromeContexts: EvidenceContext[];
  matchedTreatmentPrinciples: EvidenceContext[];
  indicationSummary: string;
  sourceId: string;
  sourceTier: string;
  provenance: unknown;
  /** H15.2.6：P2 case-derived fallback 时的来源 case 与 authority 标记（不升级处方权）。 */
  sourceCaseRef?: string;
  sourceAuthority?: 'P1' | 'P2_CASE_DERIVED';
  /** Typed truth domain. P2 remains non-normative but may be delivered as historical case truth. */
  sourceKind?: 'P1_NORMATIVE_SOURCE' | 'P2_CASE_SOURCE';
  /** Retrieval ordering is evidence, not authority; retained so Kernel can audit silent frontier loss. */
  retrievalRank?: number;
  retrievalScore?: number;
  /** Selection granularity. P1 is selected at source-node level; P2 is one historical visit prescription. */
  selectionUnit?: 'SOURCE_NODE' | 'CASE_VISIT';
  /** Source membership summary shown during selection without turning sibling formulas into competing candidates. */
  sourceProductRefs?: string[];
  sourceProductNames?: string[];
  sourceProductCount?: number;
  /** Retrieval lane is descriptive provenance, not authority or ranking preference. */
  retrievalLane?: 'NORMATIVE' | 'CASE_ANALOG';
  retrievalLanes?: FormulaRetrievalLane[];
  fallbackReason?: string;
  /** H15.2.7：formula-level 证据单元追溯字段（encounter-level）。 */
  sourceEvidenceRef?: string;
  visitRef?: string;
  stage?: string;
  composition?: string[];
}

/** 检索输入 projection：全部来自 workspace 已形成的临床判断。 */
export interface FormulaRetrievalProjection {
  disease: string[];
  primaryPattern?: string;
  secondaryPatterns?: string[];
  sharedMechanisms?: string[];
  currentDominantMechanism?: string;
  primaryTreatmentPrinciple: string;
  adjunctTreatmentPrinciples?: string[];
  treatmentTarget: string;
}

function nonEmpty(v: string | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function contexts(sourceRef: string, ...values: Array<string | undefined>): EvidenceContext[] {
  const out: EvidenceContext[] = [];
  for (const v of values) {
    if (nonEmpty(v)) out.push({ statement: v.trim(), sourceRef });
  }
  return out;
}

/** H15.2.6：归一化病名用于 applicability 比较（去掉标点/分隔，不做医学同义判断）。 */
function normalizeName(s: string): string {
  return s.replace(/[\s，。、,.;；：:()（）\[\]【】{}《》<>'"“”‘’\-_·]/g, '');
}

/** 取 disease 字段的「最后分类段」作为核心病名（如 "妊娠病-妊娠咳嗽" → "妊娠咳嗽"）。 */
export function diseaseCoreName(disease: string): string {
  const parts = disease.split(/[-—]/);
  return normalizeName(parts[parts.length - 1] ?? disease);
}

/** 同一个 disease identity 同时保留 canonical 全名与核心病名。两侧必须对称归一化。 */
export function diseaseIdentityKeys(disease: string): string[] {
  const canonical = normalizeName(disease);
  const core = diseaseCoreName(disease);
  return [...new Set([canonical, core].filter(Boolean))];
}

/** P1 候选是否 applicable：source 与 patient 两侧使用完全相同的 identity keys。 */
export function isApplicableDisease(disease: string, patientDiseases: string[]): boolean {
  if (patientDiseases.length === 0) return false;
  const sourceKeys = new Set(diseaseIdentityKeys(disease));
  if (sourceKeys.size === 0) return false;
  const patientKeys = new Set(patientDiseases.flatMap(diseaseIdentityKeys));
  return [...sourceKeys].some((key) => patientKeys.has(key));
}

/**
 * 由 diseaseRefs 直接取病名 label。diseaseRefs 是临床病名（clinical label），不是 source id，
 * 也不再是 evidence ref（evidence 由 DiseaseAssessment.evidenceRefs 承载）。禁止用 `docs.find(d => d.id === ref)`
 * 把它误当 source id 解析 —— 那会把 label 与 canonical identity 混为一谈。
 */
export function resolveDiseaseNames(diseaseRefs: string[] | undefined, docs: KnowledgeDoc[]): string[] {
  void docs;
  if (!diseaseRefs || diseaseRefs.length === 0) return [];
  return [...new Set(diseaseRefs.map((name) => name.trim()).filter(Boolean))];
}

/**
 * Patient Fact / Disease Identity Authority —— 用户明确提供的疾病身份。
 *
 * 从 patient facts（kind=past_diagnosis，用户明说的病名）确定性解析出一组检索名：
 *   - surface form（原文，用于召回）
 *   - canonical name（diagnosis_map 交叉映射到 Knowledge Store 规范病名）
 *   - core name（canonical 末段，用于 isApplicableDisease 精确匹配）
 *
 * 这些名字独立于 Agent 的 diseaseAssessment / 辨证 hypothesis，reasoning 无法覆盖或删除。
 */
export function patientDiseaseIdentityNames(workspace: ClinicalWorkspace): string[] {
  // Disease identity 的信号不只在「用户明说的病名」：主诉/症状里的病名与主症描述（如
  // 「带下色黄有腥味」）同样能经 diagnosis_map 语义映射到规范病名（「带下病-黄带」）。
  // 只认 past_diagnosis 会让纯症状输入完全失去 P1 规范方的 applicability 参照。
  const identityKinds = new Set(['past_diagnosis', 'chief_complaint', 'symptom']);
  const surfaceForms = (workspace.caseFacts ?? [])
    .filter((f) => identityKinds.has(f.kind) && typeof f.value === 'string' && f.value.trim())
    .map((f) => f.value.trim());
  if (surfaceForms.length === 0) return [];
  const names = new Set<string>();
  for (const surface of surfaceForms) {
    names.add(surface);
    for (const canonical of resolveCaseDiseaseNames([surface])) {
      names.add(canonical);
      const core = diseaseCoreName(canonical);
      if (core) names.add(core);
    }
  }
  return [...names];
}

/**
 * Exact-disease completeness authority is deliberately narrower than broad patient recall.
 * Only already committed EXPLICIT/RESOLVED disease concepts and explicit diagnosis facts can force
 * source-family completeness. Symptom/phenotype mapping remains recall evidence and may never create
 * a hard deletion/inclusion fact by itself.
 */
export function resolvedDiseaseIdentityNames(workspace: ClinicalWorkspace): string[] {
  const names = new Set<string>();
  const concepts = workspace.clinicalDecisionSpine.diseaseAssessment?.diseaseConcepts ?? [];
  for (const concept of concepts) {
    if (concept.status === 'HYPOTHESIS') continue;
    if (concept.label.trim()) names.add(concept.label.trim());
  }
  for (const fact of workspace.caseFacts ?? []) {
    if (fact.kind !== 'past_diagnosis' || fact.polarity === 'explicitly_absent' || !fact.value.trim()) continue;
    names.add(fact.value.trim());
    for (const canonical of resolveCaseDiseaseNames([fact.value])) {
      names.add(canonical);
      const core = diseaseCoreName(canonical);
      if (core) names.add(core);
    }
  }
  return [...names];
}

export type P1RecallHit = {
  sourceId: string;
  sourceTier: string;
  score?: number;
  excerpt: string;
  provenance: { source: string; sourceFile: string; disease: string; syndrome: string; treatment: string };
  formulas: Array<{ id: string; name: string; composition: string; entityStatus?: string }>;
  retrievalLanes?: FormulaRetrievalLane[];
  retrievalRank?: number;
};

function exactDiseaseFamilyHits(docs: KnowledgeDoc[], scopes: string[], diseaseNames: string[]): P1RecallHit[] {
  if (diseaseNames.length === 0) return [];
  const allowed = new Set(scopes);
  return docs
    .filter((doc) => doc.sourceTier === 'P1'
      && doc.knowledgeRole === 'NORMATIVE_TREATMENT'
      && doc.prescriptionAuthority
      && allowed.has(doc.scope ?? 'general')
      && isApplicableDisease(doc.disease, diseaseNames))
    .filter((doc) => doc.formulas.some((formula) => formula.entityStatus !== 'INACTIVE' && Boolean(formula.composition?.trim())))
    .map((doc) => ({
      sourceId: doc.id,
      sourceTier: doc.sourceTier,
      excerpt: doc.text,
      provenance: { source: doc.source, sourceFile: doc.sourceFile, disease: doc.disease, syndrome: doc.syndrome, treatment: doc.treatment },
      formulas: doc.formulas,
      retrievalLanes: ['EXACT_DISEASE_FAMILY'],
    }));
}

/** Pure audit helper used by invariant tests and diagnostics. */
export function exactDiseaseFamilySourceIds(docs: KnowledgeDoc[], scopes: string[], diseaseNames: string[]): string[] {
  return exactDiseaseFamilyHits(docs, scopes, diseaseNames).map((hit) => hit.sourceId);
}


function laneHits(hits: SearchHit[], lane: FormulaRetrievalLane): P1RecallHit[] {
  return hits.map((hit, index) => ({ ...hit, retrievalLanes: [lane], retrievalRank: index + 1 }));
}

function mergeP1RecallHits(...groups: P1RecallHit[][]): P1RecallHit[] {
  const bySource = new Map<string, P1RecallHit>();
  for (const group of groups) {
    for (const hit of group) {
      const existing = bySource.get(hit.sourceId);
      if (!existing) {
        bySource.set(hit.sourceId, { ...hit, retrievalLanes: [...new Set(hit.retrievalLanes ?? [])] });
        continue;
      }
      existing.retrievalLanes = [...new Set([...(existing.retrievalLanes ?? []), ...(hit.retrievalLanes ?? [])])];
      if (existing.score === undefined && hit.score !== undefined) existing.score = hit.score;
      if (existing.retrievalRank === undefined && hit.retrievalRank !== undefined) existing.retrievalRank = hit.retrievalRank;
    }
  }
  // Stable source identity order prevents a recall lane from silently becoming a selection rank.
  return [...bySource.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}


/** 只读 projection：从 DiseaseAssessment + PatternAssessment + TreatmentPlan 派生。 */
export function buildFormulaRetrievalProjection(
  workspace: ClinicalWorkspace,
  diseaseNames: string[] = [],
): FormulaRetrievalProjection | null {
  const spine = workspace.clinicalDecisionSpine;
  if (!spine.diseaseAssessment || !spine.treatmentPlan) return null;
  const pa = workspace.patternAssessment;
  const disease = diseaseNames.length > 0
    ? diseaseNames
    : (nonEmpty(spine.diseaseAssessment.statement) ? [spine.diseaseAssessment.statement.trim()] : []);
  return {
    disease,
    primaryPattern: pa?.primary?.statement,
    secondaryPatterns: (pa?.secondary ?? []).map((c) => c.statement).filter(nonEmpty),
    sharedMechanisms: (pa?.sharedMechanisms ?? []).map((c) => c.statement).filter(nonEmpty),
    currentDominantMechanism: pa?.currentDominantMechanism?.statement,
    primaryTreatmentPrinciple: spine.treatmentPlan.primaryPrinciple,
    adjunctTreatmentPrinciples: spine.treatmentPlan.adjunctPrinciples,
    treatmentTarget: spine.treatmentPlan.treatmentTarget,
  };
}

export function projectionToQuery(p: FormulaRetrievalProjection): string {
  return [
    ...p.disease,
    p.primaryPattern,
    ...(p.secondaryPatterns ?? []),
    ...(p.sharedMechanisms ?? []),
    p.currentDominantMechanism,
    p.primaryTreatmentPrinciple,
    ...(p.adjunctTreatmentPrinciples ?? []),
    p.treatmentTarget,
  ].filter(nonEmpty).join('，');
}


/**
 * Canonical source recall must not be conditioned on the model's current syndrome/treatment hypothesis.
 * This query is derived only from patient facts + already identified disease names. It is deliberately
 * separate from projectionToQuery(), which is the hypothesis-support channel.
 */
export function patientFactRecallQuery(workspace: ClinicalWorkspace, diseaseNames: string[]): string {
  const values: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || values.includes(trimmed)) return;
    values.push(trimmed.slice(0, 120));
  };
  for (const disease of diseaseNames) add(disease);
  for (const fact of workspace.caseFacts ?? []) {
    if (fact.polarity === 'explicitly_absent' || fact.polarity === 'unknown') continue;
    // Persistent disease identity is recalled independently above. Historical/post-treatment symptoms
    // provide context but must not dominate the current formula-recall lane.
    if ((fact.temporalRole === 'historical' || fact.temporalRole === 'post_treatment') && fact.kind !== 'past_diagnosis') continue;
    add(fact.value);
    if (values.length >= 10) break;
  }
  // Legacy/runtime-view compatibility: some preparation paths still expose patient facts through
  // workspace.facts. Read only explicit string values; never consume hypothesis/treatment fields here.
  if (values.length < 10) {
    for (const raw of workspace.facts ?? []) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      const polarity = record.polarity;
      if (polarity === 'explicitly_absent' || polarity === 'unknown') continue;
      add(record.value);
      if (values.length >= 10) break;
    }
  }
  return values.join('，');
}

function mergeHitsBySource(...groups: SearchHit[][]): SearchHit[] {
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const hit of group) {
      if (seen.has(hit.sourceId)) continue;
      seen.add(hit.sourceId);
      out.push(hit);
    }
  }
  return out;
}

function docToEvidenceCard(doc: KnowledgeDoc, formulaId: string): FormulaEvidenceCard | null {
  const f = doc.formulas.find((x) => x.id === formulaId);
  if (!f) return null;
  return {
    formulaId: f.id,
    formulaName: f.name,
    diseaseContexts: contexts(doc.id, doc.disease),
    syndromeContexts: contexts(doc.id, doc.syndrome),
    treatmentPrinciples: contexts(doc.id, doc.treatment),
    indicationText: doc.text,
    sourceId: doc.id,
    sourceTier: doc.sourceTier,
    stageGuidance: [...new Set([...(doc.stageGuidance ?? []), ...(f.stageGuidance ?? [])])],
    conditionalGuidance: [...new Set([...(doc.conditionalGuidance ?? []), ...(f.conditionalGuidance ?? [])])],
    sequence: [...(doc.sequence ?? []), ...(f.sequence ?? [])],
    sourceStageGuidance: doc.stageGuidance,
    sourceConditionalGuidance: doc.conditionalGuidance,
    sourceSequence: doc.sequence?.map((s) => ({ order: s.order, instruction: s.instruction })),
    productStageGuidance: f.stageGuidance,
    productConditionalGuidance: f.conditionalGuidance,
    productSequence: f.sequence?.map((s) => ({ order: s.order, instruction: s.instruction })),
    provenance: {
      source: doc.source,
      sourceFile: doc.sourceFile,
      sourceSchool: doc.sourceSchool,
      disease: doc.disease,
      syndrome: doc.syndrome,
      treatment: doc.treatment,
      composition: f.composition,
      raw: doc.raw,
    },
  };
}

export interface FormulaSearchCandidatesResult {
  candidates: FormulaCandidateCard[];
  projection: FormulaRetrievalProjection | null;
  diagnostics: RetrievalDiagnostics | null;
  candidateSetContract: {
    exactDiseaseNames: string[];
    requiredExactDiseaseCandidateRefs: string[];
  };
}

/** 第一阶段：light candidate cards，Top 3~5，只做知识关联，不给患者适配评分。 */
export async function searchFormulaCandidates(
  workspace: ClinicalWorkspace,
  scopes: string[],
  topK = 5,
): Promise<FormulaSearchCandidatesResult> {
  const idx = await loadIndex();
  const assessment = workspace.clinicalDecisionSpine.diseaseAssessment;
  // P0-2: prefer typed disease concepts (label is the clinical disease name); fall back to legacy labels.
  const diseaseNames = assessment?.diseaseConcepts?.length
    ? [...new Set(assessment.diseaseConcepts.map((c) => c.label.trim()).filter(Boolean))]
    : resolveDiseaseNames(assessment?.diseaseRefs, idx.docs);
  const projection = buildFormulaRetrievalProjection(workspace, diseaseNames);
  if (!projection) return { candidates: [], projection: null, diagnostics: null, candidateSetContract: { exactDiseaseNames: [], requiredExactDiseaseCandidateRefs: [] } };
  // Patient Fact / Disease Identity Authority：用户明确提供的疾病身份必须参与 canonical source 召回与
  // applicability 判定，且不随 Agent 的 diseaseAssessment 被覆盖或删除。
  const patientDiseases = patientDiseaseIdentityNames(workspace);
  const applicabilityDiseases = [...new Set([...projection.disease, ...patientDiseases])];
  const query = projectionToQuery(projection);
  const patientQuery = patientFactRecallQuery(workspace, applicabilityDiseases);

  // 1a. Exact canonical disease family lane: NOT ranked/truncated. Once disease identity is already
  // EXPLICIT/RESOLVED, every active P1 normative source in that disease family must survive into the
  // frozen CandidateSet. Recall can be wide; only Selection may narrow.
  const exactDiseaseNames = resolvedDiseaseIdentityNames(workspace);
  const exactFamily = exactDiseaseFamilyHits(idx.docs, scopes, exactDiseaseNames);

  // 1b. Patient phenotype recall is bounded, because it is discovery evidence rather than identity authority.
  const sourceRecall = patientQuery
    ? await searchWithDiagnostics(patientQuery, topK, scopes, 'formula.search_candidates', {
        role: 'NORMATIVE_TREATMENT',
        denseRecallGuard: Math.min(3, topK),
      })
    : null;
  // 1c. Hypothesis-conditioned recall is also bounded and explicitly separate from the exact family lane.
  const hypothesisSearch = await searchWithDiagnostics(query, topK, scopes, 'formula.search_candidates', { role: 'NORMATIVE_TREATMENT' });
  const applicableHits = mergeP1RecallHits(
    exactFamily,
    laneHits((sourceRecall?.hits ?? []).filter((h) => h.authority === 'P1'), 'PHENOTYPE'),
    laneHits(hypothesisSearch.hits.filter((h) => h.authority === 'P1'), 'HYPOTHESIS'),
  );
  const p1Candidates = buildP1SourceCandidateCards(applicableHits);
  const requiredExactDiseaseCandidateRefs = p1Candidates
    .filter((candidate) => candidate.retrievalLanes?.includes('EXACT_DISEASE_FAMILY'))
    .map((candidate) => candidate.candidateRef);

  // 2. Historical-case lane is independent from the normative lane. A small wording change in the
  // model-authored clinical projection must not flip the *entire* candidate universe between P1 and
  // P2. Both source roles are recalled; authority remains typed and final selection remains clinical.
  const p2PatientRecall = patientQuery
    ? await searchWithDiagnostics(patientQuery, topK, scopes, 'formula.search_candidates', { role: 'CLINICAL_CASE', kind: 'case-formula' })
    : null;
  const p2HypothesisSearch = await searchWithDiagnostics(query, topK, scopes, 'formula.search_candidates', { role: 'CLINICAL_CASE', kind: 'case-formula' });
  const p2Hits = mergeHitsBySource(p2PatientRecall?.hits ?? [], p2HypothesisSearch.hits);
  const p2Candidates = buildP2CandidateCards(p2Hits);

  return {
    candidates: [...p1Candidates, ...p2Candidates],
    projection,
    diagnostics: sourceRecall?.diagnostics ?? hypothesisSearch.diagnostics ?? p2PatientRecall?.diagnostics ?? p2HypothesisSearch.diagnostics,
    candidateSetContract: { exactDiseaseNames, requiredExactDiseaseCandidateRefs },
  };
}

const P2_FORMULA_DISPLAY_NAME = '病例方（原案无正式方名）';

/** H15.2.7：稳定非医学 formula identity（原案无正式方名时使用）。 */
export function p2FormulaIdentity(sourceCaseRef: string, visitRef: string, formulaIndex = 1): string {
  return `P2_CASE_FORMULA::${sourceCaseRef}::${visitRef}::${formulaIndex}`;
}

export const P1_SOURCE_NODE_PREFIX = 'source-node:';
export const P2_CASE_VISIT_PREFIX = 'case-visit:';

export function p1SourceNodeCandidateRef(sourceId: string): string {
  return `${P1_SOURCE_NODE_PREFIX}${sourceId}`;
}

export function p2CaseVisitCandidateRef(sourceId: string): string {
  return `${P2_CASE_VISIT_PREFIX}${sourceId}`;
}

/** Resolve a model-visible typed candidate identity back to the canonical source id. */
export function candidateSourceId(candidateRef: string): string | null {
  if (candidateRef.startsWith(P1_SOURCE_NODE_PREFIX)) return candidateRef.slice(P1_SOURCE_NODE_PREFIX.length) || null;
  if (candidateRef.startsWith(P2_CASE_VISIT_PREFIX)) return candidateRef.slice(P2_CASE_VISIT_PREFIX.length) || null;
  // Migration compatibility for pre-closure refs (`source::formula`).
  const legacy = candidateRef.split('::')[0];
  return legacy || null;
}

function encounterIndication(h: SearchHit): string {
  return [
    h.visit ? `诊次：${h.visit}` : '',
    h.provenance.syndrome ? `辨证：${h.provenance.syndrome}` : '',
    h.provenance.treatment ? `治法：${h.provenance.treatment}` : '',
  ].filter(Boolean).join('；');
}

function buildP2FormulaCandidateCard(h: SearchHit): FormulaCandidateCard {
  const sourceCaseRef = h.caseId ? `P2:${h.caseId}` : h.sourceId;
  const visitRef = h.sourceId.startsWith('P2:') ? h.sourceId.slice(3) : h.sourceId;
  return {
    candidateRef: p2CaseVisitCandidateRef(h.sourceId),
    formulaId: p2FormulaIdentity(sourceCaseRef, visitRef),
    formulaName: nonEmpty(h.formulaName) ? h.formulaName! : P2_FORMULA_DISPLAY_NAME,
    matchedDiseaseContexts: contexts(h.sourceId, h.provenance.disease),
    matchedSyndromeContexts: contexts(h.sourceId, h.provenance.syndrome),
    matchedTreatmentPrinciples: contexts(h.sourceId, h.provenance.treatment),
    indicationSummary: encounterIndication(h),
    sourceId: h.sourceId,
    sourceTier: h.sourceTier,
    sourceCaseRef,
    sourceAuthority: 'P2_CASE_DERIVED',
    sourceKind: 'P2_CASE_SOURCE',
    selectionUnit: 'CASE_VISIT',
    retrievalLane: 'CASE_ANALOG',
    retrievalLanes: ['CASE_ANALOG'],
    retrievalScore: h.score,
    composition: h.composition ? [h.composition] : undefined,
    sourceEvidenceRef: visitRef,
    visitRef,
    stage: h.visit,
    provenance: {
      source: h.provenance.source,
      sourceFile: h.provenance.sourceFile,
      disease: h.provenance.disease,
      syndrome: h.provenance.syndrome,
      treatment: h.provenance.treatment,
      caseId: h.caseId,
      visit: h.visit,
      sourceSpanId: h.sourceSpanId,
    },
  };
}

/** P2 only becomes selectable when a structured source prescription exists. Evidence-only cases are not formula candidates. */
export function buildP2CandidateCards(hits: SearchHit[]): FormulaCandidateCard[] {
  const p2Hits = hits.filter((h) => h.sourceTier === 'P2');
  const formulaHits = p2Hits.filter((h) => h.kind === 'case-formula' && nonEmpty(h.composition) && h.sourceId);
  return formulaHits.map((hit, index) => ({ ...buildP2FormulaCandidateCard(hit), retrievalRank: index + 1 }));
}

export function buildP1SourceCandidateCards(hits: P1RecallHit[]): FormulaCandidateCard[] {
  const candidates: FormulaCandidateCard[] = [];
  for (const h of hits) {
    const products = h.formulas.filter((formula) => formula.entityStatus !== 'INACTIVE' && Boolean(formula.composition?.trim()));
    if (products.length === 0) continue;
    // Clinical applicability belongs to the disease/syndrome/treatment source node, not to each sibling.
    // A SOURCE_NODE candidate is source-level: it carries NO top-level formulaId/formulaName authority,
    // and product membership is expressed only via sourceProductRefs/Names (order never selects a primary).
    candidates.push({
      candidateRef: p1SourceNodeCandidateRef(h.sourceId),
      matchedDiseaseContexts: contexts(h.sourceId, h.provenance.disease),
      matchedSyndromeContexts: contexts(h.sourceId, h.provenance.syndrome),
      matchedTreatmentPrinciples: contexts(h.sourceId, h.provenance.treatment),
      indicationSummary: (h.excerpt ?? '').slice(0, 160),
      sourceId: h.sourceId,
      sourceTier: h.sourceTier,
      sourceAuthority: 'P1',
      sourceKind: 'P1_NORMATIVE_SOURCE',
      retrievalLane: 'NORMATIVE',
      retrievalLanes: h.retrievalLanes ?? [],
      selectionUnit: 'SOURCE_NODE',
      sourceProductRefs: products.map((formula) => `${h.sourceId}::${formula.id}`),
      sourceProductNames: products.map((formula) => formula.name),
      sourceProductCount: products.length,
      retrievalRank: h.retrievalRank,
      retrievalScore: h.score,
      provenance: { source: h.provenance.source, sourceFile: h.provenance.sourceFile },
    });
  }
  return candidates;
}

/** H15.2.7：canonicalizer 用 —— 从 sourceId 确定性读取 P2 病例方药组成（不做检索，不升权）。 */
export async function getP2CaseFormulaComposition(
  sourceId: string,
  docs?: KnowledgeDoc[],
): Promise<{ composition: string; formulaName: string } | null> {
  const idx = docs ?? (await loadIndex()).docs;
  const doc = idx.find((d) => d.id === sourceId && d.sourceTier === 'P2' && d.kind === 'case-formula');
  if (!doc?.composition) return null;
  return { composition: doc.composition, formulaName: nonEmpty(doc.formulaName) ? doc.formulaName! : P2_FORMULA_DISPLAY_NAME };
}

/** 第二阶段：展开完整方剂证据（组成 / 适应证 / 来源原文 / 相关治法 / inline modification）。 */
export async function getFormulaEvidence(
  candidateRef: string,
  scopes: string[],
): Promise<FormulaEvidenceCard | null> {
  const sourceId = candidateSourceId(candidateRef);
  if (!sourceId) return null;
  const allowed = new Set(scopes);
  const idx = await loadIndex();
  const doc = idx.docs.find(
    (d) => d.id === sourceId && allowed.has(d.scope ?? 'general'),
  );
  if (!doc) return null;
  if (doc.sourceTier === 'P1') {
    // Source-node selection: hydrate one source-backed evidence card while preserving N source products
    // in CandidateSet metadata. No sibling formula receives its own selection vote, and no representative
    // product is inferred from array order.
    const legacyFormulaId = candidateRef.includes('::') ? candidateRef.split('::')[1] : undefined;
    if (legacyFormulaId) {
      const representative = doc.formulas.find((formula) => formula.id === legacyFormulaId);
      if (!representative) return null;
      return docToEvidenceCard(doc, representative.id);
    }
    // No explicit product ref: return source-level evidence, never pick the first product.
    const products = doc.formulas.filter((formula) => Boolean(formula.composition?.trim()));
    if (products.length === 0) return null;
    return {
      formulaId: doc.id,
      formulaName: doc.disease?.trim() || doc.title || doc.id,
      diseaseContexts: contexts(doc.id, doc.disease),
      syndromeContexts: contexts(doc.id, doc.syndrome),
      treatmentPrinciples: contexts(doc.id, doc.treatment),
      indicationText: doc.text,
      sourceId: doc.id,
      sourceTier: doc.sourceTier,
      composition: products.map((formula) => formula.composition),
      stageGuidance: doc.stageGuidance,
      conditionalGuidance: doc.conditionalGuidance,
      sequence: doc.sequence,
      productGuidance: products.map((formula) => ({
        formulaId: formula.id,
        formulaName: formula.name,
        stageGuidance: formula.stageGuidance,
        conditionalGuidance: formula.conditionalGuidance,
        sequence: formula.sequence,
      })),
      provenance: {
        source: doc.source,
        sourceFile: doc.sourceFile,
        sourceSchool: doc.sourceSchool,
        disease: doc.disease,
        syndrome: doc.syndrome,
        treatment: doc.treatment,
        raw: doc.raw,
      },
    };
  }
  // P2 case-derived：encounter（case-formula）返回该诊次的紧凑方药证据；case 全文仅在明确需要时读取。
  if (doc.sourceTier === 'P2') {
    if (doc.kind === 'case-formula' && doc.composition) {
      const sourceCaseRef = doc.caseId ? `P2:${doc.caseId}` : doc.id;
      const visitRef = doc.id.startsWith('P2:') ? doc.id.slice(3) : doc.id;
      return {
        formulaId: p2FormulaIdentity(sourceCaseRef, visitRef),
        formulaName: nonEmpty(doc.formulaName) ? doc.formulaName! : P2_FORMULA_DISPLAY_NAME,
        diseaseContexts: contexts(doc.id, doc.disease),
        syndromeContexts: contexts(doc.id, doc.syndrome),
        treatmentPrinciples: contexts(doc.id, doc.treatment),
        indicationText: [
          doc.patient ? `病人：${doc.patient}` : '',
          doc.visit ? `诊次：${doc.visit}` : '',
          doc.symptoms ? `病症：${doc.symptoms}` : '',
        ].filter(Boolean).join('；'),
        sourceId: doc.id,
        sourceTier: doc.sourceTier,
        composition: [doc.composition],
        provenance: {
          source: doc.source,
          sourceFile: doc.sourceFile,
          disease: doc.disease,
          syndrome: doc.syndrome,
          treatment: doc.treatment,
          caseId: doc.caseId,
          visit: doc.visit,
          composition: doc.composition,
          sourceSpanId: doc.sourceSpanId,
        },
      };
    }
    return {
      formulaId: doc.id,
      formulaName: doc.title ?? doc.disease,
      diseaseContexts: contexts(doc.id, doc.disease),
      syndromeContexts: [],
      treatmentPrinciples: [],
      indicationText: doc.text,
      sourceId: doc.id,
      sourceTier: doc.sourceTier,
      provenance: { source: doc.source, sourceFile: doc.sourceFile, disease: doc.disease, raw: doc.raw },
    };
  }
  return null;
}

/**
 * H15.2 Formula Retrieval Reuse —— 状态签名。
 * 若 disease / pattern / treatment 三层 version 与 PatternAssessment 内容都未变化，
 * 则重复 formula.search_candidates 应复用已有候选集，而不是重新检索。
 */
export function formulaSearchStateSignature(workspace: ClinicalWorkspace): string {
  const spine = workspace.clinicalDecisionSpine;
  return JSON.stringify({
    diseaseVersion: spine.diseaseAssessment?.version,
    patternVersion: spine.patternAssessmentVersion,
    treatmentVersion: spine.treatmentPlan?.version,
    patternAssessment: workspace.patternAssessment,
  });
}

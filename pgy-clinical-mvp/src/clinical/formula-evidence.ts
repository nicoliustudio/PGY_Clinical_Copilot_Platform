import { loadIndex } from '../knowledge/build.js';
import { searchWithDiagnostics } from '../knowledge/search.js';
import type { RetrievalDiagnostics } from '../knowledge/diagnostics.js';
import type { KnowledgeDoc, SearchHit } from '../knowledge/types.js';
import type { ClinicalWorkspace } from '../contracts/workspace.js';

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
}

/** 轻量候选卡（第一阶段 formula.search_candidates，Top 3~5）。 */
export interface FormulaCandidateCard {
  candidateRef: string;
  formulaId: string;
  formulaName: string;
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

/** P1 候选是否 applicable：其核心病名与患者病名核心精确匹配（结构规则，非医学判断）。 */
export function isApplicableDisease(disease: string, patientDiseases: string[]): boolean {
  if (patientDiseases.length === 0) return false;
  const core = diseaseCoreName(disease);
  if (!core) return false;
  return patientDiseases.some((p) => normalizeName(p) === core);
}

/** 由 diseaseRefs 确定性解析病名（不通过文本重建 identity）。 */
export function resolveDiseaseNames(diseaseRefs: string[] | undefined, docs: KnowledgeDoc[]): string[] {
  if (!diseaseRefs || diseaseRefs.length === 0) return [];
  const names: string[] = [];
  for (const ref of diseaseRefs) {
    const doc = docs.find((d) => d.id === ref);
    if (doc && nonEmpty(doc.disease) && !names.includes(doc.disease)) names.push(doc.disease);
  }
  return names;
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
}

/** 第一阶段：light candidate cards，Top 3~5，只做知识关联，不给患者适配评分。 */
export async function searchFormulaCandidates(
  workspace: ClinicalWorkspace,
  scopes: string[],
  topK = 5,
): Promise<FormulaSearchCandidatesResult> {
  const idx = await loadIndex();
  const diseaseNames = resolveDiseaseNames(workspace.clinicalDecisionSpine.diseaseAssessment?.diseaseRefs, idx.docs);
  const projection = buildFormulaRetrievalProjection(workspace, diseaseNames);
  if (!projection) return { candidates: [], projection: null, diagnostics: null };
  const query = projectionToQuery(projection);

  // 1. P1 检索 → 只保留 applicable P1（disease 核心匹配当前病名，避免妇科语境 P1 误命中阻断 fallback）。
  const p1 = await searchWithDiagnostics(query, topK, scopes, 'formula.search_candidates', { role: 'NORMATIVE_TREATMENT' });
  const applicableHits = p1.hits.filter(
    (h) => h.authority === 'P1' && isApplicableDisease(h.provenance.disease, projection.disease),
  );
  const p1Candidates = buildP1Candidates(applicableHits);
  if (p1Candidates.length > 0) {
    return { candidates: p1Candidates, projection, diagnostics: p1.diagnostics };
  }

  // 2. P2 fallback：无 applicable P1 时，优先检索 formula-level 病例方药单元（encounter-level），
  //    无结构化方药时才退回 case-level（保持 H15.2.6 行为）。仅 evidence，不自动选方。
  const p2Formula = await searchWithDiagnostics(query, topK, scopes, 'formula.search_candidates', { role: 'CLINICAL_CASE', kind: 'case-formula', fallbackReason: 'NO_APPLICABLE_P1' });
  if (p2Formula.hits.length > 0) {
    return { candidates: buildP2CandidateCards(p2Formula.hits), projection, diagnostics: p2Formula.diagnostics };
  }
  const p2Case = await searchWithDiagnostics(query, topK, scopes, 'formula.search_candidates', { role: 'CLINICAL_CASE', kind: 'case', fallbackReason: 'NO_APPLICABLE_P1' });
  return { candidates: buildP2CandidateCards(p2Case.hits), projection, diagnostics: p2Case.diagnostics };
}

const P2_FORMULA_DISPLAY_NAME = '病例方（原案无正式方名）';

/** H15.2.7：稳定非医学 formula identity（原案无正式方名时使用）。 */
export function p2FormulaIdentity(sourceCaseRef: string, visitRef: string, formulaIndex = 1): string {
  return `P2_CASE_FORMULA::${sourceCaseRef}::${visitRef}::${formulaIndex}`;
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
    candidateRef: `${h.sourceId}::formula`,
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
    fallbackReason: 'NO_APPLICABLE_P1',
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

function buildP2CaseCandidateCard(h: SearchHit): FormulaCandidateCard {
  // H15.2.6 legacy：无结构化方药时退回 case-level（保持 provenance，不升级处方权）。
  return {
    candidateRef: `${h.sourceId}::case`,
    formulaId: h.sourceId,
    formulaName: h.title ?? diseaseCoreName(h.provenance.disease),
    matchedDiseaseContexts: contexts(h.sourceId, h.provenance.disease),
    matchedSyndromeContexts: [],
    matchedTreatmentPrinciples: [],
    indicationSummary: (h.excerpt ?? '').slice(0, 160),
    sourceId: h.sourceId,
    sourceTier: h.sourceTier,
    sourceCaseRef: h.sourceId,
    sourceAuthority: 'P2_CASE_DERIVED',
    fallbackReason: 'NO_APPLICABLE_P1',
    provenance: { source: h.provenance.source, sourceFile: h.provenance.sourceFile, disease: h.provenance.disease },
  };
}

/** H15.2.7：从 P2 命中形成 formula-level candidates。encounter（case-formula）优先，否则 case-level 兜底。 */
export function buildP2CandidateCards(hits: SearchHit[]): FormulaCandidateCard[] {
  const p2Hits = hits.filter((h) => h.sourceTier === 'P2');
  const formulaHits = p2Hits.filter((h) => h.kind === 'case-formula' && nonEmpty(h.composition) && h.sourceId);
  if (formulaHits.length > 0) {
    return formulaHits.map(buildP2FormulaCandidateCard);
  }
  return p2Hits.filter((h) => h.kind === 'case' || !h.kind).map(buildP2CaseCandidateCard);
}

function buildP1Candidates(hits: Array<{ sourceId: string; sourceTier: string; excerpt: string; provenance: { source: string; sourceFile: string; disease: string; syndrome: string; treatment: string }; formulas: Array<{ id: string; name: string; composition: string }> }>): FormulaCandidateCard[] {
  const candidates: FormulaCandidateCard[] = [];
  for (const h of hits) {
    for (const f of h.formulas) {
      if (!f.composition) continue;
      candidates.push({
        candidateRef: `${h.sourceId}::${f.id}`,
        formulaId: f.id,
        formulaName: f.name,
        matchedDiseaseContexts: contexts(h.sourceId, h.provenance.disease),
        matchedSyndromeContexts: contexts(h.sourceId, h.provenance.syndrome),
        matchedTreatmentPrinciples: contexts(h.sourceId, h.provenance.treatment),
        indicationSummary: (h.excerpt ?? '').slice(0, 160),
        sourceId: h.sourceId,
        sourceTier: h.sourceTier,
        sourceAuthority: 'P1',
        provenance: { source: h.provenance.source, sourceFile: h.provenance.sourceFile },
      });
    }
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
  const [sourceId, formulaId] = candidateRef.split('::');
  if (!sourceId) return null;
  const allowed = new Set(scopes);
  const idx = await loadIndex();
  const doc = idx.docs.find(
    (d) => d.id === sourceId && allowed.has(d.scope ?? 'general'),
  );
  if (!doc) return null;
  if (doc.sourceTier === 'P1') {
    if (!formulaId) return null;
    return docToEvidenceCard(doc, formulaId);
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

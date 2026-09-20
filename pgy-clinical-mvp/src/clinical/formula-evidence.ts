import { loadIndex } from '../knowledge/build.js';
import { searchWithDiagnostics } from '../knowledge/search.js';
import type { RetrievalDiagnostics } from '../knowledge/diagnostics.js';
import type { KnowledgeDoc } from '../knowledge/types.js';
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
  const { hits, diagnostics } = await searchWithDiagnostics(query, topK, scopes, 'formula.search_candidates', { role: 'NORMATIVE_TREATMENT' });
  const candidates: FormulaCandidateCard[] = [];
  for (const h of hits) {
    if (h.authority !== 'P1') continue;
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
        provenance: { source: h.provenance.source, sourceFile: h.provenance.sourceFile },
      });
    }
  }
  return { candidates, projection, diagnostics };
}

/** 第二阶段：展开完整方剂证据（组成 / 适应证 / 来源原文 / 相关治法 / inline modification）。 */
export async function getFormulaEvidence(
  candidateRef: string,
  scopes: string[],
): Promise<FormulaEvidenceCard | null> {
  const [sourceId, formulaId] = candidateRef.split('::');
  if (!sourceId || !formulaId) return null;
  const allowed = new Set(scopes);
  const idx = await loadIndex();
  const doc = idx.docs.find(
    (d) => d.id === sourceId && d.sourceTier === 'P1' && allowed.has(d.scope ?? 'general'),
  );
  if (!doc) return null;
  return docToEvidenceCard(doc, formulaId);
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

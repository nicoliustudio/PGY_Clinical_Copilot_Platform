import { searchWithDiagnostics } from '../knowledge/search.js';
import { loadIndex } from '../knowledge/build.js';
import type { RetrievalDiagnostics } from '../knowledge/diagnostics.js';
import type { KnowledgeDoc } from '../knowledge/types.js';
import { validateNormativeFormulaInDocs } from './formula-binding.js';

export interface NormativeFormulaResult {
  authority: 'NORMATIVE';
  formulaId: string;
  name: string;
  composition: string;
  sourceId: string;
  source: string;
  disease: string;
  syndrome: string;
  treatment: string;
  score: number;
}

export interface NormativeSearchWithDiagnostics {
  results: NormativeFormulaResult[];
  diagnostics: RetrievalDiagnostics;
}

export async function searchNormativeWithDiagnostics(
  query: string,
  topK = 10,
  scopes: string[] = ['general'],
): Promise<NormativeSearchWithDiagnostics> {
  const { hits, diagnostics } = await searchWithDiagnostics(query, topK, scopes, 'formula.search_normative');
  const results: NormativeFormulaResult[] = [];
  for (const h of hits) {
    if (h.authority !== 'P1') continue;
    for (const f of h.formulas) {
      if (!f.composition) continue;
      results.push({
        authority: 'NORMATIVE', formulaId: f.id, name: f.name,
        composition: f.composition, sourceId: h.sourceId,
        source: h.provenance.source, disease: h.provenance.disease,
        syndrome: h.provenance.syndrome, treatment: h.provenance.treatment,
        score: h.score,
      });
    }
  }
  return { results, diagnostics };
}

export async function searchNormative(
  query: string,
  topK = 10,
  scopes: string[] = ['general'],
): Promise<NormativeFormulaResult[]> {
  return (await searchNormativeWithDiagnostics(query, topK, scopes)).results;
}

function normalize(s: string): string {
  return s.replace(/[\s，。、,.;；:：()（）\[\]【】{}《》<>'"“”‘’\-_]/g, '');
}

export interface ValidationResult {
  valid: boolean;
  matchedFormulaId?: string;
  matchedName?: string;
  matchedSourceId?: string;
}

export async function validateFormula(composition: string): Promise<ValidationResult> {
  const idx = await loadIndex();
  const target = normalize(composition);
  if (!target) return { valid: false };
  for (const doc of idx.docs) {
    if (doc.sourceTier !== 'P1') continue;
    for (const f of doc.formulas) {
      if (normalize(f.composition) === target) {
        return { valid: true, matchedFormulaId: f.id, matchedName: f.name, matchedSourceId: doc.id };
      }
    }
  }
  return { valid: false };
}


/** Authority-grade validation: source + formula + composition must bind to the same P1 record. */
export async function validateNormativeFormula(input: {
  sourceId: string;
  formulaId: string;
  composition: string;
}): Promise<ValidationResult> {
  const idx = await loadIndex();
  return validateNormativeFormulaInDocs(idx.docs, input);
}

/** H7 canonical formula lookup：candidateId 的确定性 canonical 数据来源。 */
export interface CanonicalFormula {
  formulaId: string;
  name: string;
  composition: string;
  sourceId: string;
  sourceTier: string;
}

const hydrationCache = new Map<string, CanonicalFormula>();

interface FormulaRunTelemetry {
  /** canonical hydrate 实际发生（cache miss）的调用次数。 */
  formulaHydrationCalls: number;
  formulaHydrationCacheHitCount: number;
  /** formula.validate 调用次数（不区分是否 candidateId）。 */
  formulaValidationCalls: number;
  /** 本 run 已解析出 canonical formula 的 unique candidate keys（miss 或 hit 都算「已解析」）。 */
  hydratedKeys: Set<string>;
  /** 本 run 通过 candidateId 路径 validate 的 unique candidate keys。 */
  validatedKeys: Set<string>;
  /** H10：formula.validate 复用已有 validation cache 的次数。 */
  validationReuseCount: number;
  /** H10：同一 candidateKey 被重复 validate 的次数（>1 次的超额计数）。 */
  duplicateValidationCount: number;
}

/**
 * H7.1：hydration/validation telemetry 按 runId 隔离，避免 module-level 累积导致 run A 污染 run B。
 * canonical formula cache（hydrationCache）继续跨 run 复用，不受 reset 影响。
 */
const telemetryByRun = new Map<string, FormulaRunTelemetry>();

function telemetryFor(runId: string): FormulaRunTelemetry {
  let t = telemetryByRun.get(runId);
  if (!t) {
    t = {
      formulaHydrationCalls: 0,
      formulaHydrationCacheHitCount: 0,
      formulaValidationCalls: 0,
      hydratedKeys: new Set(),
      validatedKeys: new Set(),
      validationReuseCount: 0,
      duplicateValidationCount: 0,
    };
    telemetryByRun.set(runId, t);
  }
  return t;
}

/** 每个 run 开始时可独立初始化 telemetry（不清空 canonical formula cache）。 */
export function resetFormulaHydrationStats(runId: string): void {
  telemetryByRun.delete(runId);
}

/** 由 sourceId + formulaId 确定性查找 canonical formula（不依赖模型重建）。 */
export async function getCanonicalFormula(
  sourceId: string,
  formulaId: string,
  runId?: string,
  docs?: KnowledgeDoc[],
): Promise<CanonicalFormula | null> {
  const key = `${sourceId}::${formulaId}`;
  const cached = hydrationCache.get(key);
  if (cached) {
    if (runId) {
      const t = telemetryFor(runId);
      t.formulaHydrationCacheHitCount += 1;
      t.hydratedKeys.add(key);
    }
    return cached;
  }
  const idx = docs ?? (await loadIndex()).docs;
  const doc = idx.find((d) => d.id === sourceId && d.sourceTier === 'P1');
  if (!doc) return null;
  const f = doc.formulas.find((x) => x.id === formulaId);
  if (!f) return null;
  const canonical: CanonicalFormula = {
    formulaId: f.id,
    name: f.name,
    composition: f.composition,
    sourceId: doc.id,
    sourceTier: doc.sourceTier,
  };
  hydrationCache.set(key, canonical);
  if (runId) {
    const t = telemetryFor(runId);
    t.formulaHydrationCalls += 1;
    t.hydratedKeys.add(key);
  }
  return canonical;
}

/** formula.validate 执行一次；candidateId 路径额外计入 unique validated candidates 与重复计数。 */
export function recordFormulaValidation(runId: string, candidateKey?: string): void {
  const t = telemetryFor(runId);
  t.formulaValidationCalls += 1;
  if (candidateKey) {
    if (t.validatedKeys.has(candidateKey)) t.duplicateValidationCount += 1;
    else t.validatedKeys.add(candidateKey);
  }
}

/** H10：记录一次 validation cache 命中（复用已有 deterministic validation 结果）。 */
export function recordValidationReuse(runId: string): void {
  telemetryFor(runId).validationReuseCount += 1;
}

/**
 * H10 validation reuse：sourceId + formulaId + composition 相同的确定性 validation
 * 只执行一次，后续复用缓存结果。canonical knowledge 在 run 内冻结，缓存不失效。
 */
const validationCache = new Map<string, ValidationResult>();

export async function validateNormativeFormulaCached(
  input: { sourceId: string; formulaId: string; composition: string },
  runId?: string,
  docs?: KnowledgeDoc[],
): Promise<{ result: ValidationResult; reused: boolean }> {
  const key = `${input.sourceId}\u0000${input.formulaId}\u0000${normalize(input.composition)}`;
  const cached = validationCache.get(key);
  if (cached) {
    if (runId) recordValidationReuse(runId);
    return { result: cached, reused: true };
  }
  const result = docs
    ? validateNormativeFormulaInDocs(docs, input)
    : await validateNormativeFormula(input);
  validationCache.set(key, result);
  return { result, reused: false };
}

export interface FormulaTelemetry {
  uniqueCandidatesHydrated: number;
  uniqueCandidatesValidated: number;
  formulaHydrationCalls: number;
  formulaHydrationCacheHitCount: number;
  formulaValidationCalls: number;
  validationReuseCount: number;
  duplicateValidationCount: number;
}

export function getFormulaHydrationStats(runId: string): FormulaTelemetry {
  const t = telemetryFor(runId);
  return {
    uniqueCandidatesHydrated: t.hydratedKeys.size,
    uniqueCandidatesValidated: t.validatedKeys.size,
    formulaHydrationCalls: t.formulaHydrationCalls,
    formulaHydrationCacheHitCount: t.formulaHydrationCacheHitCount,
    formulaValidationCalls: t.formulaValidationCalls,
    validationReuseCount: t.validationReuseCount,
    duplicateValidationCount: t.duplicateValidationCount,
  };
}

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';

/**
 * Runtime Catalog —— 轻量知识接入层（膏方 / 外治 / 制剂 等业务能力的默认检索面）。
 *
 * 关键边界（严格遵守）：
 * - 只索引 `runtime/catalog/*.cards.jsonl` 中的轻量卡片，不 bulk-index
 *   `data/assets_all.jsonl` / `source_text/**` / `audit/**` / `data/other_therapy.jsonl`。
 * - 两阶段检索：先用 indexes 收敛候选 → relevance 排序返回少量 lean card →
 *   Agent 选定证据后，再按 asset_id 精确 fetch 完整资产。
 * - 检索排名只表示知识相关性（disease/source/document/query relevance），
 *   绝不生成 patient match score / best syndrome / best formula / recommended treatment。
 * - deferred 资产（AC-039 / AC-046 / PR-091 / other_therapy）不进默认检索。
 * - Scope → catalog / index 映射完全由 runtime/*.json 数据驱动，不在代码里写死业务 ID。
 */

export interface RuntimeCard {
  asset_id: string;
  asset_type?: string;
  subtype?: string | null;
  title?: string;
  disease?: { name?: string; raw_name?: string; specialty?: string };
  syndrome_pattern?: string;
  applies_to_syndromes?: string[];
  source_label?: string;
  source_kind?: string;
  can_decide_base_formula?: boolean;
  detail_ref?: { file?: string; line?: number; asset_id?: string };
  runtime_eligible?: boolean;
  deferred_reason?: string | null;
  activation_scope?: string | null;
  requires_explicit_or_task_relevant_intent?: boolean;
  search_text?: string;
  [key: string]: unknown;
}

/** 轻量卡片命中结果：只返回检索面字段 + 知识相关性，不返回完整 detail。 */
export interface RuntimeCardHit {
  asset_id: string;
  title: string;
  disease: string;
  specialty?: string;
  asset_type?: string;
  subtype?: string | null;
  activation_scope?: string | null;
  source_label?: string;
  can_decide_base_formula?: boolean;
  detail_ref?: { file?: string; line?: number; asset_id?: string };
  /** 知识相关性（disease/source/document/query relevance），非患者匹配分。 */
  relevance: number;
}

/** 每次 specialized retrieval 的观测（不含患者/证型/方剂评分）。 */
export interface RuntimeCatalogTelemetry {
  activeScopes: string[];
  catalogTotalCount: number;
  candidateCount: number;
  cardsReturnedCount: number;
  cardsReturnedAssetIds: string[];
  narrowedBy: 'disease' | 'medicine' | 'point' | 'none';
}

export interface RuntimeCatalogSearch {
  cards: RuntimeCardHit[];
  telemetry: RuntimeCatalogTelemetry;
}

export interface RuntimeCardSearchOptions {
  /** 病例中已明确的疾病上下文（原文），用于 indexes 收敛。 */
  diseaseContext?: string[];
  /** 返回给 Agent 的卡片数上限，默认走 config.kb.runtimeCardLimit。 */
  topK?: number;
}

interface ScopeSpec {
  capability_id?: string;
  catalog?: string;
  catalogs?: Record<string, string>;
  deferred_asset_ids?: string[];
  deferred_subtypes?: string[];
}

interface NormalizedScope {
  catalogFiles: string[];
  deferredAssetIds: Set<string>;
  deferredSubtypes: Set<string>;
}

interface AssetLocator {
  file?: string;
  line?: number;
  asset_id?: string;
  runtime_eligible?: boolean;
  activation_scope?: string;
}

let scopeIndex: Map<string, NormalizedScope> | null = null;
let locatorIndex: Map<string, AssetLocator> | null = null;
let diseaseIndex: Map<string, string[]> | null = null;
let medicineIndex: Map<string, string[]> | null = null;
let pointIndex: Map<string, string[]> | null = null;
const cardCache = new Map<string, RuntimeCard[]>();
const dataLineCache = new Map<string, string[]>();

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function readJsonl(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function readJson(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function catalogRoot(): string {
  return config.kb.runtimeCatalogDir;
}

/** 读取并解析 runtime/capability_scopes.json，归一化为 scope → catalogFiles + deferred。 */
function loadScopeIndex(): Map<string, NormalizedScope> {
  if (scopeIndex) return scopeIndex;
  scopeIndex = new Map();
  const raw = readJson(join(catalogRoot(), 'runtime', 'capability_scopes.json')) as {
    scopes?: Record<string, ScopeSpec>;
  } | null;
  for (const [scopeId, spec] of Object.entries(raw?.scopes ?? {})) {
    const files: string[] = [];
    if (spec.catalog) files.push(spec.catalog);
    if (spec.catalogs) files.push(...Object.values(spec.catalogs));
    scopeIndex.set(scopeId, {
      catalogFiles: files,
      deferredAssetIds: new Set(asStringArray(spec.deferred_asset_ids)),
      deferredSubtypes: new Set(asStringArray(spec.deferred_subtypes)),
    });
  }
  return scopeIndex;
}

function loadLocator(): Map<string, AssetLocator> {
  if (locatorIndex) return locatorIndex;
  locatorIndex = new Map();
  const raw = readJson(join(catalogRoot(), 'runtime', 'indexes', 'asset_locator.json')) as Record<string, AssetLocator> | null;
  for (const [assetId, loc] of Object.entries(raw ?? {})) locatorIndex.set(assetId, loc);
  return locatorIndex;
}

/** 把 term → asset_ids 形态的 index 扁平化为 Map<term, string[]>。 */
function loadTermIndex(rel: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const raw = readJson(join(catalogRoot(), 'runtime', 'indexes', rel)) as Record<string, unknown> | null;
  for (const [term, v] of Object.entries(raw ?? {})) {
    if (Array.isArray(v)) out.set(term, v.filter((x): x is string => typeof x === 'string'));
  }
  return out;
}

/** disease_to_assets 结构为 { disease: { ASSET_TYPE: [ids] } }，这里把所有 type 的 ids 合并。 */
function loadDiseaseIndex(): Map<string, string[]> {
  if (diseaseIndex) return diseaseIndex;
  diseaseIndex = new Map();
  const raw = readJson(join(catalogRoot(), 'runtime', 'indexes', 'disease_to_assets.json')) as Record<string, unknown> | null;
  for (const [disease, v] of Object.entries(raw ?? {})) {
    if (!v || typeof v !== 'object') continue;
    const ids = new Set<string>();
    for (const idsOfType of Object.values(v as Record<string, unknown>)) {
      if (Array.isArray(idsOfType)) for (const id of idsOfType) if (typeof id === 'string') ids.add(id);
    }
    diseaseIndex.set(disease, [...ids]);
  }
  return diseaseIndex;
}

function loadMedicineIndex(): Map<string, string[]> {
  if (medicineIndex) return medicineIndex;
  medicineIndex = loadTermIndex('medicine_to_assets.json');
  return medicineIndex;
}

function loadPointIndex(): Map<string, string[]> {
  if (pointIndex) return pointIndex;
  pointIndex = loadTermIndex('point_to_assets.json');
  return pointIndex;
}

function loadCards(catalogPath: string): RuntimeCard[] {
  const cached = cardCache.get(catalogPath);
  if (cached) return cached;
  const cards: RuntimeCard[] = [];
  for (const line of readJsonl(join(catalogRoot(), catalogPath))) {
    try {
      cards.push(JSON.parse(line) as RuntimeCard);
    } catch {
      // 跳过无法解析的行，保持 fail-closed。
    }
  }
  cardCache.set(catalogPath, cards);
  return cards;
}

function isDeferred(card: RuntimeCard, scope: NormalizedScope): boolean {
  if (card.runtime_eligible !== true) return true;
  if (scope.deferredAssetIds.has(card.asset_id)) return true;
  if (card.subtype && scope.deferredSubtypes.has(card.subtype)) return true;
  return false;
}

/** 收集当前激活 scope 下、且非 deferred 的全部轻量卡片（默认检索面的全集）。 */
export function loadRuntimeCards(scopes: string[]): RuntimeCard[] {
  const index = loadScopeIndex();
  const active = scopes.filter((s) => index.has(s));
  const out: RuntimeCard[] = [];
  for (const scopeId of active) {
    const scope = index.get(scopeId)!;
    for (const file of scope.catalogFiles) {
      for (const card of loadCards(file)) {
        if (card.activation_scope !== scopeId) continue;
        if (isDeferred(card, scope)) continue;
        out.push(card);
      }
    }
  }
  return out;
}

/** 病名匹配：双向子串，命中 disease_to_assets 的 key。 */
function matchTerm(haystack: string, needle: string): boolean {
  const a = haystack.trim();
  const b = needle.trim();
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

interface CandidateSet {
  ids: Set<string> | null;
  narrowedBy: RuntimeCatalogTelemetry['narrowedBy'];
}

/** 用现有 indexes（disease / medicine / point）收敛候选 asset_ids。 */
function collectCandidateIds(query: string, diseaseContext: string[]): CandidateSet {
  const ids = new Set<string>();

  const ctx = (diseaseContext ?? []).map((s) => s.trim()).filter(Boolean);
  const diseaseTerms = [...ctx, query];
  for (const term of diseaseTerms) {
    for (const [diseaseKey, assetIds] of loadDiseaseIndex()) {
      if (matchTerm(diseaseKey, term)) for (const id of assetIds) ids.add(id);
    }
    if (ids.size > 0) return { ids, narrowedBy: 'disease' };
  }

  for (const [term, assetIds] of loadMedicineIndex()) {
    if (matchTerm(query, term)) for (const id of assetIds) ids.add(id);
  }
  if (ids.size > 0) return { ids, narrowedBy: 'medicine' };

  for (const [term, assetIds] of loadPointIndex()) {
    if (matchTerm(query, term)) for (const id of assetIds) ids.add(id);
  }
  if (ids.size > 0) return { ids, narrowedBy: 'point' };

  return { ids: null, narrowedBy: 'none' };
}

/** 知识相关性：仅衡量 query 与卡片检索文本的文档级重叠，不做患者匹配。 */
function knowledgeRelevance(query: string, card: RuntimeCard): number {
  const q = tokenize(query);
  if (q.size === 0) return 0;
  const hay = `${card.search_text ?? ''} ${card.title ?? ''} ${asString(card.disease?.name)}`;
  const h = tokenize(hay);
  let hit = 0;
  for (const t of q) if (h.has(t)) hit += 1;
  return hit / q.size;
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) tokens.add(w);
  const cjk = text.match(/[\u4e00-\u9fff]/g) ?? [];
  for (const c of cjk) tokens.add(c);
  for (let i = 0; i + 1 < cjk.length; i++) tokens.add(cjk[i] + cjk[i + 1]);
  return tokens;
}

function toHit(card: RuntimeCard, query: string): RuntimeCardHit {
  return {
    asset_id: card.asset_id,
    title: asString(card.title),
    disease: asString(card.disease?.name),
    specialty: asString(card.disease?.specialty) || undefined,
    asset_type: card.asset_type,
    subtype: card.subtype,
    activation_scope: card.activation_scope,
    source_label: card.source_label,
    can_decide_base_formula: card.can_decide_base_formula,
    detail_ref: card.detail_ref,
    relevance: knowledgeRelevance(query, card),
  };
}

/**
 * 两阶段检索 · 第一阶段：在当前激活 scope 中做 focused 检索。
 * 用 indexes + 疾病上下文收敛候选 → 文档级 relevance 排序 → 返回少量卡片（上限 config.kb.runtimeCardLimit）。
 * 不返回完整 detail，也不生成任何患者/证型/方剂评分。
 */
export function searchRuntimeCards(
  query: string,
  scopes: string[],
  options: RuntimeCardSearchOptions = {},
): RuntimeCatalogSearch {
  const all = loadRuntimeCards(scopes);
  const byId = new Map(all.map((c) => [c.asset_id, c]));

  const candidate = collectCandidateIds(query, options.diseaseContext ?? []);
  let pool = all;
  if (candidate.ids) {
    const scoped = [...candidate.ids]
      .map((id) => byId.get(id))
      .filter((c): c is RuntimeCard => c !== undefined);
    // H15.5.2: a global index hit must not collapse an active-scope search to an empty pool.
    // If the narrowed ids have no intersection with the currently active scopes, fall back to
    // relevance scoring across the active-scope catalog instead of returning zero cards.
    if (scoped.length > 0) pool = scoped;
  }

  const scored = pool.map((card) => toHit(card, query)).sort((a, b) => b.relevance - a.relevance);
  const limit = options.topK ?? config.kb.runtimeCardLimit;
  const cards = scored.slice(0, limit);

  return {
    cards,
    telemetry: {
      activeScopes: scopes.filter((s) => loadScopeIndex().has(s)),
      catalogTotalCount: all.length,
      candidateCount: pool.length,
      cardsReturnedCount: cards.length,
      cardsReturnedAssetIds: cards.map((c) => c.asset_id),
      narrowedBy: candidate.narrowedBy,
    },
  };
}

/** 当前激活 scope 下、去 deferred 后的卡片总数（观测/验收用）。 */
export function countRuntimeCards(scopes: string[]): number {
  return loadRuntimeCards(scopes).length;
}

function readDataLine(file: string, line: number): unknown | null {
  let lines = dataLineCache.get(file);
  if (!lines) {
    lines = readJsonl(join(catalogRoot(), file));
    dataLineCache.set(file, lines);
  }
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) return null;
  try {
    return JSON.parse(lines[idx]);
  } catch {
    return null;
  }
}

/**
 * 两阶段检索 · 第二阶段：按 asset_id 精确获取完整资产 detail。
 * 通过 runtime/indexes/asset_locator.json 定位，并做 activation_scope 边界校验
 * （跨 scope 资产不会被读取），deferred 资产同样 fail-closed。
 */
export function getRuntimeAsset(assetId: string, scopes: string[]): Record<string, unknown> | null {
  const loc = loadLocator().get(assetId);
  if (!loc) return null;
  if (loc.runtime_eligible === false) return null;
  if (loc.activation_scope && !scopes.includes(loc.activation_scope)) return null;
  if (!loc.file || typeof loc.line !== 'number') return null;
  const detail = readDataLine(loc.file, loc.line);
  return detail as Record<string, unknown> | null;
}

/** 测试/观测：重置模块级缓存。 */
export function resetRuntimeCatalogCache(): void {
  scopeIndex = null;
  locatorIndex = null;
  diseaseIndex = null;
  medicineIndex = null;
  pointIndex = null;
  cardCache.clear();
  dataLineCache.clear();
}

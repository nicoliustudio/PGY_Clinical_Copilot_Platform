import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface GoldLabel {
  key: string;
  goldId: string;
  diseaseRaw: string;
  diseaseResolved: string;
  syndrome: string;
  variantId: string;
  evaluable: boolean;
  group: string;
}

const goldPath = path.resolve(
  '../assets/data/regression/gold_variant_map.json',
);

let byKey: Map<string, GoldLabel> | null = null;
let byGoldId: Map<string, GoldLabel> | null = null;

function load(): { byKey: Map<string, GoldLabel>; byGoldId: Map<string, GoldLabel> } {
  if (byKey && byGoldId) return { byKey, byGoldId };
  const raw = JSON.parse(readFileSync(goldPath, 'utf8'));
  const src = raw.by_key as Record<string, Record<string, unknown>>;
  byKey = new Map();
  byGoldId = new Map();
  for (const [k, v] of Object.entries(src)) {
    const label: GoldLabel = {
      key: k,
      goldId: String(v.gold_id ?? ''),
      diseaseRaw: String(v.gold_disease_raw ?? ''),
      diseaseResolved: String(v.gold_disease_resolved ?? ''),
      syndrome: String(v.gold_syndrome_normalized ?? v.gold_local_label ?? ''),
      variantId: String(v.gold_variant_id ?? ''),
      evaluable: v.variant_evaluable !== false,
      group: String(v.gold_source_quality ?? ''),
    };
    byKey.set(k, label);
    if (label.goldId) byGoldId.set(label.goldId, label);
  }
  return { byKey, byGoldId };
}

/** 通过 key（妇科::7）或 gold_id（妇科-001）查 gold 标签 */
export function getGold(caseKey: string): GoldLabel | undefined {
  const { byKey, byGoldId } = load();
  return byKey.get(caseKey) ?? byGoldId.get(caseKey);
}

/** 病名命中：预测文本含 gold 病名（原始或解析后末段） */
export function matchDisease(predicted: string, gold: GoldLabel): boolean {
  if (!predicted || !gold.diseaseRaw) return false;
  if (predicted.includes(gold.diseaseRaw)) return true;
  const last = gold.diseaseResolved.split('-').pop();
  if (last && predicted.includes(last)) return true;
  return false;
}

/** 证型命中：预测文本含 gold 证型（完整或核心组合） */
export function matchSyndrome(predicted: string, gold: GoldLabel): boolean {
  if (!predicted || !gold.syndrome) return false;
  if (predicted.includes(gold.syndrome)) return true;
  return false;
}

/** 方剂命中：预测 source_id 的 P1 variant 等于 gold variant_id */
export function matchFormula(sourceId: string, gold: GoldLabel): boolean {
  if (!sourceId || !gold.variantId) return false;
  const vid = sourceId.replace(/^P1:/, '');
  return vid === gold.variantId;
}

/**
 * Source Priority Policy —— 处方来源优先级路由的 Kernel 侧数据加载。
 *
 * 数据源：release 根目录的 SOURCE_PRIORITY.json（hard_treatment_route）。
 * 桥接：route entry 的 source_tier（catalog layer id，如 P1_GYN_MANUAL）通过
 * knowledgeManifest（layer.sourceId ↔ layer.sourceTier）映射为运行时粗粒度 tier
 * （'P1' / 'P2' / 'AUX'），与 KnowledgeDoc.sourceTier 同一值空间。
 *
 * 本模块不做任何业务判断：哪些层是 normative、哪些层是 fallback，全部来自 KB
 * 声明（prescription_authority / open_gate）。新增来源只需在 SOURCE_PRIORITY.json
 * 与 manifest 中声明，本模块与 Core 均不改。
 *
 * 加载失败（文件缺失/损坏/无 route）时返回 null，调用方 gate 不生效（fail-open +
 * 可观测 warn）：SOURCE_PRIORITY 属于 KB 资产契约，缺位属于部署错误，会在知识
 * 构建层暴露；selection gate 不做第二真源失败放大。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { knowledgeManifest } from './manifest.js';
import type { SourceTier } from './types.js';

export interface TreatmentRouteEntry {
  order: number;
  /** catalog layer id（route.source_tier，如 P1_GYN_MANUAL）。 */
  sourceTierId: string;
  /** 桥接后的运行时粗粒度 tier（manifest layer.sourceTier）。 */
  sourceTier: SourceTier;
  prescriptionAuthority: boolean;
  openGate?: string;
}

export interface SourcePriorityRoute {
  /** 按 order 升序的治疗来源路由。 */
  entries: TreatmentRouteEntry[];
  /** 持有处方权的 tier（prescription_authority: true）。 */
  normativeSourceTiers: ReadonlySet<string>;
  /** 无处方权、仅在 normative 层不可用后开放的 tier。 */
  fallbackSourceTiers: ReadonlySet<string>;
}

interface RawRouteEntry {
  order?: unknown;
  source_tier?: unknown;
  prescription_authority?: unknown;
  open_gate?: unknown;
}

function parseRouteFile(file: string): SourcePriorityRoute | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.warn(`[source-priority] 无法加载 ${file}（${error instanceof Error ? error.message : String(error)}）；处方来源优先级 gate 不生效`);
    return null;
  }
  const entriesRaw = (raw as { hard_treatment_route?: unknown }).hard_treatment_route;
  if (!Array.isArray(entriesRaw)) {
    console.warn('[source-priority] SOURCE_PRIORITY.json 缺少 hard_treatment_route 数组；处方来源优先级 gate 不生效');
    return null;
  }

  const tierByLayerId = new Map(knowledgeManifest.map((layer) => [layer.sourceId, layer.sourceTier]));
  const entries: TreatmentRouteEntry[] = [];
  const normativeSourceTiers = new Set<string>();
  const fallbackSourceTiers = new Set<string>();
  for (const item of entriesRaw) {
    const entry = item as RawRouteEntry;
    const sourceTierId = typeof entry.source_tier === 'string' ? entry.source_tier : '';
    const sourceTier = tierByLayerId.get(sourceTierId);
    if (!sourceTier) {
      console.warn(`[source-priority] route entry "${sourceTierId}" 无 manifest layer 映射，忽略该层`);
      continue;
    }
    const prescriptionAuthority = entry.prescription_authority === true;
    entries.push({
      order: typeof entry.order === 'number' ? entry.order : entries.length + 1,
      sourceTierId,
      sourceTier,
      prescriptionAuthority,
      openGate: typeof entry.open_gate === 'string' ? entry.open_gate : undefined,
    });
    if (prescriptionAuthority) normativeSourceTiers.add(sourceTier);
    else fallbackSourceTiers.add(sourceTier);
  }
  if (entries.length === 0) {
    console.warn('[source-priority] hard_treatment_route 解析后为空；处方来源优先级 gate 不生效');
    return null;
  }
  entries.sort((a, b) => a.order - b.order);
  return { entries, normativeSourceTiers, fallbackSourceTiers };
}

let cachedRoute: SourcePriorityRoute | null | undefined;

/** 加载（并进程内缓存）处方来源优先级路由；失败返回 null。 */
export function loadSourcePriorityRoute(): SourcePriorityRoute | null {
  if (cachedRoute === undefined) {
    cachedRoute = parseRouteFile(path.join(config.kb.releaseDir, 'SOURCE_PRIORITY.json'));
  }
  return cachedRoute;
}

/** 失效缓存（KB 强制重建或测试隔离用）。 */
export function resetSourcePriorityRouteCache(): void {
  cachedRoute = undefined;
}

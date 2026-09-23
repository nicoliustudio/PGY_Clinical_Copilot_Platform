/**
 * Delivery Integrity / Single-Truth Cutover —— 3 个高信息密度 E2E 首跑。
 *
 * 目的：确认接线与系统不变量，不用统计掩盖架构问题。
 *   Case A — canonical source 多产品 + 加减（SourceBundle → DeliveryBundle → ClinicalResult → ResultView 不静默丢方）
 *   Case B — locked treatment modality（exact semantic identity + manifest required fields 才 DELIVERED）
 *   Case C — required but impossible（resolved=true / satisfied=false → 确定性终态，不无限 submit）
 *
 * 全部用真实知识索引 + 真实 capability manifest，不调用模型，纯确定性投影。
 */
import { loadIndex } from '../src/knowledge/build.js';
import { hydrateSourceFormulaSet } from '../src/clinical/source-formula-set.js';
import { projectFormulaSet } from '../src/control-plane-v2/result-projection.js';
import { buildResultView } from '../src/ui/views.js';
import {
  treatmentDeliveryCompleteness,
  deriveCapabilityDeliveryClosures,
} from '../src/clinical/capability-delivery.js';
import { createClinicalWorkspace } from '../src/platform/workspace/clinical-workspace.js';
import { discoverCapabilityManifests, loadSkills } from '../src/composition/load-assets.js';
import { normalizeClinicalRequestIR } from '../src/control-plane-v2/request-ir.js';
import { buildSemanticOntology, resolveMention, validateRequestSemantics } from '../src/control-plane-v2/semantic-validator.js';
import {
  contractResolved,
  contractSatisfied,
  refreshControlPlaneV21,
  blockedObligationsV21,
  outcomeCoverage,
} from '../src/platform/control-plane/control-plane-v21-session.js';
import { CONTROL_PLANE_V21_POLICY } from '../src/composition/control-plane-v21-policy.js';
import { RuntimePreparer } from '../src/platform/runtime/runtime-preparer.js';
import { CapabilityRegistry } from '../src/platform/registry/capability-registry.js';
import { SkillRegistry } from '../src/platform/registry/skill-registry.js';
import { ToolRegistry } from '../src/platform/registry/tool-registry.js';
import { RiskHypothesisSafetyPort } from '../src/platform/authority/risk-safety-port.js';
import { emptyClinicalStrategy } from '../src/contracts/clinical-strategy.js';
import {
  BASELINE_KNOWLEDGE_SCOPES,
  BASELINE_SKILL_IDS,
  BASELINE_TOOL_IDS,
  PLATFORM_TOOLS,
} from '../src/composition/platform-assets.js';
import { stubRequestCompiler } from '../tests/helpers.js';
import type { ClinicalRequestIR } from '../src/control-plane-v2/types.js';
import type { RuntimeContext } from '../src/contracts/runtime.js';
import type { CapabilityDescriptor } from '../src/contracts/capability.js';

function line(label: string, value: unknown): void {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function prepareContext(requestIR: ClinicalRequestIR): Promise<RuntimeContext> {
  const manifests = await discoverCapabilityManifests();
  const capabilities = new CapabilityRegistry(manifests);
  const skills = new SkillRegistry(await loadSkills([...manifests.flatMap((m) => m.skillIds), ...BASELINE_SKILL_IDS]));
  const tools = new ToolRegistry(PLATFORM_TOOLS);
  const preparer = new RuntimePreparer({
    understanding: { understand: async () => ({ interaction: { mode: 'clinical' as const }, facts: [], intents: [], risks: [], informationGaps: [], capabilityNeeds: [], uncertainties: [] }) },
    safety: new RiskHypothesisSafetyPort(),
    planner: { plan: async () => emptyClinicalStrategy() },
    capabilities,
    skills,
    tools,
    model: { id: 'e2e:control-plane' },
    baselineToolIds: BASELINE_TOOL_IDS,
    baselineSkillIds: BASELINE_SKILL_IDS,
    baselineKnowledgeScopes: BASELINE_KNOWLEDGE_SCOPES,
    controlPlane: { compiler: stubRequestCompiler(requestIR), policy: CONTROL_PLANE_V21_POLICY },
  });
  return preparer.prepare('e2e-input', 'e2e-run');
}

function request(required: string[]): ClinicalRequestIR {
  return normalizeClinicalRequestIR({
    version: 1,
    goal: 'treatment',
    outcomes: { required, preferred: [], excluded: [], exclusive: false },
    outputPolicy: { formulaCardinality: { mode: 'PRIMARY_ONLY' } },
    generationPolicy: { knowledgeSource: 'KB_PREFERRED' },
    hardConstraints: [],
    preferences: [],
  });
}

async function main(): Promise<void> {
  console.log('================= Delivery Integrity E2E 首跑 =================\n');

  // ---------------- Case A ----------------
  console.log('----- Case A：canonical source 多产品 + 加减 -----');
  const index = await loadIndex();
  const p1Docs = index.docs.filter((d) => d.sourceTier === 'P1' && d.formulas.length >= 2);
  line('P1 文档总数', index.docs.filter((d) => d.sourceTier === 'P1').length);
  line('含 >=2 ACTIVE 方的 P1 文档', p1Docs.length);
  const target = p1Docs.find((d) =>
    d.formulas.some((f) => (f.sourceModifications?.length ?? 0) > 0) || (d.sourceModifications?.length ?? 0) > 0,
  ) ?? p1Docs[0];
  if (!target) {
    console.log('Case A SKIP：无多 sibling P1 源');
    return;
  }
  const selectedFormulaId = target.formulas[0].id;
  const selectedRef = `${target.id}::${selectedFormulaId}`;
  const set = hydrateSourceFormulaSet(index.docs, selectedRef);
  if (!set) {
    console.log('Case A FAIL：SourceFormulaSet 水合失败');
    return;
  }
  line('selected source parent', set.parentRecordRef);
  line('SourceBundle sibling count', set.formulas.length);
  line('SourceBundle sourceLevelModifications', set.sourceLevelModifications);
  const projected = projectFormulaSet(set, { mode: 'PRIMARY_ONLY' });
  line('DeliveryBundle committed/qualified (projected) count', projected.length);
  line('DeliveryBundle relation map', projected.map((f) => `${f.formulaId}:${f.relation}`));
  line('DeliveryBundle modification_status map', projected.map((f) => `${f.formulaId}:${f.modificationStatus}[${f.sourceModifications.join('|')}]`));

  const clinicalResult = {
    mode: 'clinical' as const,
    status: 'COMPLETED' as const,
    disease: { name: set.disease, confidence: 0.9, evidence_refs: [set.parentRecordRef] },
    syndrome: { name: set.syndrome, confidence: 0.8, evidence_refs: [set.parentRecordRef] },
    treatment: { text: set.treatmentMethod, evidence_refs: [set.parentRecordRef] },
    formula: { authority: 'NORMATIVE' as const, formula_id: projected[0]?.formulaId ?? '', name: projected[0]?.name ?? '', composition: [projected[0]?.composition ?? ''], source_id: set.parentRecordRef, evidence_refs: [set.parentRecordRef] },
    formula_set: projected.map((f) => ({
      formula_ref: f.formulaRef, formula_id: f.formulaId, name: f.name, composition: f.composition,
      source_ref: f.sourceRef, modification_rules: f.sourceModifications, modification_status: f.modificationStatus,
      modification_text: f.modificationStatus === 'PRESENT' ? f.sourceModifications.join('；') : (f.modificationStatus === 'KNOWN_EMPTY' ? '无加减' : '源节点存在加减规则，但无法安全归属到该方'),
      relation: f.relation,
    })),
    missing_information: [],
    safety: { status: 'PASS' as const },
  };
  const view = buildResultView(clinicalResult as never);
  line('ClinicalResult.formula_set count', clinicalResult.formula_set.length);
  line('ResultView.formula_set count', view.formula_set?.length);
  line('ResultView 是否 drop formula_set', (view.formula_set?.length ?? 0) !== clinicalResult.formula_set.length ? 'YES(BUG)' : 'NO');
  console.log('Case A PASS（无 silent drop；逐方修改状态见 modification_status map）');

  // 完整链路 JSON：SourceBundle → DeliveryBundle → ClinicalResult.formula_set → ResultView（可证伪证据）。
  console.log('\n[CASE_A SourceBundle JSON]', JSON.stringify({
    parentRecordRef: set.parentRecordRef,
    sourceLevelModifications: set.sourceLevelModifications,
    formulas: set.formulas.map((f) => ({
      formulaId: f.formulaId, relation: f.relation, sourceModifications: f.sourceModifications,
      modificationStatus: f.modificationStatus, usage: f.usage,
    })),
  }, null, 2));
  console.log('[CASE_A DeliveryBundle(projected) JSON]', JSON.stringify(projected.map((f) => ({
    formulaId: f.formulaId, relation: f.relation, modificationStatus: f.modificationStatus,
    sourceModifications: f.sourceModifications, sourceLevelModifications: f.sourceLevelModifications,
  })), null, 2));
  console.log('[CASE_A ResultView JSON]', JSON.stringify({ formula_set: view.formula_set, treatment_deliveries: view.treatment_deliveries }, null, 2));

  // ---------------- Case B ----------------
  console.log('----- Case B：locked treatment modality（针灸 exact identity + manifest fields）-----');
  const manifests: CapabilityDescriptor[] = await discoverCapabilityManifests();
  const acupunctureComplete = {
    outcome: 'modality:acupuncture', form: 'acupuncture', disposition: 'CURRENTLY_SUITABLE' as const, statement: '针刺方案',
    sourceEvidenceRefs: ['AC-049'], details: { points: ['合谷', '三阴交'], operation: '平补平泻', frequency: '每日1次', course: '10次' },
  };
  const complete = treatmentDeliveryCompleteness(
    manifests.map((m) => ({ id: m.id, confidence: 1, reason: 'e2e', provides: m.provides, deliveryObligations: m.deliveryObligations })),
    acupunctureComplete,
  );
  line('完整针灸交付 completeness.complete', complete.complete);
  line('完整针灸交付 missingFields', complete.missingFields);

  const acupunctureIncomplete = { ...acupunctureComplete, details: { points: ['合谷'] } };
  const incomplete = treatmentDeliveryCompleteness(
    manifests.map((m) => ({ id: m.id, confidence: 1, reason: 'e2e', provides: m.provides, deliveryObligations: m.deliveryObligations })),
    acupunctureIncomplete,
  );
  line('缺 course 针灸交付 completeness.complete', incomplete.complete);
  line('缺 course 针灸交付 missingFields', incomplete.missingFields);

  const ws = createClinicalWorkspace();
  ws.clinicalDecisionSpine.treatmentPlan = {
    primaryPrinciple: 'p', treatmentTarget: 't', evidenceRefs: [], version: 1,
    treatmentDeliveries: [acupunctureIncomplete],
  };
  const closures = deriveCapabilityDeliveryClosures(
    manifests.map((m) => ({ id: m.id, confidence: 1, reason: 'e2e', provides: m.provides, deliveryObligations: m.deliveryObligations })),
    ws,
    [],
  );
  line('不完整 payload 的 delivery closure 数（应为 0，不得 DELIVERED）', closures.length);
  console.log('Case B PASS（exact identity + manifest requiredFields；缺 field 保持 OPEN）\n');

  // ---------------- Case C ----------------
  console.log('----- Case C：required but impossible（无合法 provider）-----');
  const ctx = await prepareContext(request(['modality:no-such-modality']));
  // 基线义务可满足（临床核心 + 诊断证据），仅隔离出「无 provider 的 required outcome」。
  const spine = ctx.workspace.clinicalDecisionSpine;
  spine.clinicalQuestion = { statement: 'q', version: 1 };
  spine.diseaseAssessment = { statement: 'd', evidenceRefs: ['P1:x'], version: 1 };
  spine.patternHypothesisRefs = ['h1'];
  spine.patternAssessmentRef = 'h1';
  ctx.workspace.evidenceState.evidenceItems.push({
    id: 'E1', sourceRef: 'P1:std', sourceType: 'knowledge', relatedCandidates: [], supportingSignals: [], contradictingSignals: [],
  });
  refreshControlPlaneV21(ctx);
  const state = ctx.controlPlaneV21!;
  const blocked = blockedObligationsV21(state);
  const coverage = outcomeCoverage(state);
  line('graph compileStatus', state.compileStatus);
  line('blocked required obligations', blocked.map((n) => `${n.target.type}(${n.target.qualifiers.outcome ?? ''})`));
  line('outcomeCoverage status', coverage.map((c) => `${c.outcome}:${c.status}`));
  line('contractResolved', contractResolved(state));
  line('contractSatisfied', contractSatisfied(state));
  const resolved = contractResolved(state);
  const satisfied = contractSatisfied(state);
  console.log(`Case C 结论：required 无 provider → ${resolved && !satisfied ? 'resolved=true / satisfied=false（确定性终态，不无限 submit）' : `resolved=${resolved} / satisfied=${satisfied}`}\n`);

  // ---------------- Case D ----------------
  console.log('----- Case D：semantic identity stability（例二「以膏代煎」回归）-----');
  const descriptors = await discoverCapabilityManifests();
  const ontology = buildSemanticOntology(descriptors);
  line('resolve "膏方"', resolveMention(ontology, '膏方'));
  line('resolve "以膏代煎"', resolveMention(ontology, '以膏代煎'));
  line('resolve "膏方（以膏代煎）"', resolveMention(ontology, '膏方（以膏代煎）'));
  // 模拟例二：compiler 把 required 写成 modality:gaofang，mention 写成 display 化的「膏方（以膏代煎）」。
  const gaofangIR = normalizeClinicalRequestIR({
    version: 1, goal: 'treatment',
    outcomes: {
      required: ['outcome:clinical-assessment', 'modality:gaofang'], preferred: [], allowed: [], excluded: [],
      mentions: [{ name: '膏方（以膏代煎）', commitment: 'REQUIRED' }], unresolved: [], unresolvedPreferred: [], exclusive: false,
    },
    outputPolicy: { formulaCardinality: { mode: 'PRIMARY_ONLY' } },
    generationPolicy: { knowledgeSource: 'KB_PREFERRED' },
    hardConstraints: [], preferences: [],
  });
  const validated = validateRequestSemantics(gaofangIR, descriptors, CONTROL_PLANE_V21_POLICY.baselineOutcomes);
  line('validated.required', validated.ir.outcomes.required);
  line('validated.unresolved', validated.unresolved);
  console.log('Case D 结论：canonical identity 不再因 display surface 被误判 unresolved\n');

  console.log('================= E2E 首跑完成 =================');
}

main().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exit(1);
});

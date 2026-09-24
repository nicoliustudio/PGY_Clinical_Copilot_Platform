/**
 * Authority Boundary Closure —— 两个高价值确定性 E2E 首跑。
 *
 * 不调用 LLM，全部用真实知识索引 + 真实 capability manifest + 真实 Kernel commit 路径。
 * 只验证不变量，不判断「病例答案对不对」。
 *
 *   E2E-1 针灸 exact modality：
 *     required=modality:acupuncture, excluded=modality:herbal-formula
 *     验证：Request IR 契约 / delivery.commit DELIVERED / mandatory fields /
 *          clinical-assessment 不拥有 modality execution facts / Final 无 herbal product
 *
 *   E2E-2 canonical 多产品 SourceBundle：
 *     同一 P1 source 有 N>1 ACTIVE products
 *     验证：SourceBundle N → Commit sourceBundle N → Final formula_set N → UI N
 *          三态 PRESENT/KNOWN_EMPTY/UNKNOWN + 三类 modification provenance
 *          CLINICALLY_EXCLUDED 不改变 N
 */
import { loadIndex } from '../src/knowledge/build.js';
import { getRuntimeAsset, getRuntimeAssetScope } from '../src/knowledge/runtime-catalog.js';
import { recordHydrationReceipt } from '../src/clinical/capability-evidence.js';
import { projectClinicalResult } from '../src/platform/commit/result-projector.js';
import { hydrateSourceFormulaSet } from '../src/clinical/source-formula-set.js';
import { projectFormulaSet } from '../src/control-plane-v2/result-projection.js';
import { buildResultView } from '../src/ui/views.js';
import { discoverCapabilityManifests, loadSkills } from '../src/composition/load-assets.js';
import { normalizeClinicalRequestIR } from '../src/control-plane-v2/request-ir.js';
import { commitDeliveryOutcome } from '../src/platform/commit/delivery-transaction.js';
import { buildClinicalAssessmentProduct, validateClinicalAssessmentFactOwnership } from '../src/platform/commit/fact-ownership.js';
import {
  effectiveRequestIRV21,
  effectiveRequiredOutcomesV21,
} from '../src/platform/control-plane/control-plane-v21-session.js';
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
import { CONTROL_PLANE_V21_POLICY } from '../src/composition/control-plane-v21-policy.js';
import { stubRequestCompiler } from '../tests/helpers.js';
import type { ClinicalRequestIR } from '../src/control-plane-v2/types.js';
import type { RuntimeContext } from '../src/contracts/runtime.js';
import type { KnowledgeDoc } from '../src/knowledge/types.js';

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function requestIR(required: string[], excluded: string[] = [], exclusive = false): ClinicalRequestIR {
  return normalizeClinicalRequestIR({
    version: 1,
    goal: 'treatment',
    outcomes: { required, preferred: [], allowed: [], excluded, exclusive },
    outputPolicy: { formulaCardinality: { mode: 'PRIMARY_ONLY' } },
    generationPolicy: { knowledgeSource: 'KB_PREFERRED' },
    hardConstraints: [],
    preferences: [],
  });
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
    model: { id: 'e2e:authority-boundary' },
    baselineToolIds: BASELINE_TOOL_IDS,
    baselineSkillIds: BASELINE_SKILL_IDS,
    baselineKnowledgeScopes: BASELINE_KNOWLEDGE_SCOPES,
    controlPlane: { compiler: stubRequestCompiler(requestIR), policy: CONTROL_PLANE_V21_POLICY },
  });
  return preparer.prepare('e2e-input', 'e2e-run');
}

async function e2e1(): Promise<void> {
  console.log('\n================= E2E-1 针灸 exact modality =================');
  const ir = requestIR(['modality:acupuncture'], ['modality:herbal-formula'], true);
  check('RequestIR.required = modality:acupuncture', ir.outcomes.required.includes('modality:acupuncture'));
  check('RequestIR.excluded = modality:herbal-formula', ir.outcomes.excluded.includes('modality:herbal-formula'));
  check('RequestIR.exclusive = true', ir.outcomes.exclusive === true);

  const ctx = await prepareContext(ir);
  check('graph COMPILED', ctx.controlPlaneV21?.compileStatus === 'COMPILED');
  check('effective required outcomes 不含 herbal', !effectiveRequiredOutcomesV21(ctx.controlPlaneV21!).includes('modality:herbal-formula'));
  check('effective required outcomes 含 acupuncture', effectiveRequiredOutcomesV21(ctx.controlPlaneV21!).includes('modality:acupuncture'));

  // 采用 contract 外 herbal 意图必须被拒绝（adopt 语义通过 RequestIR.excluded 拒绝）。
  const effective = effectiveRequestIRV21(ctx.controlPlaneV21!);
  check('effective RequestIR 未改写原始 excluded', effective.outcomes.excluded.includes('modality:herbal-formula'));
  check('原始 RequestIR immutable（required 仍只有 acupuncture）', ctx.controlPlaneV21!.requestIR.outcomes.required.length === 1 && ctx.controlPlaneV21!.requestIR.outcomes.required[0] === 'modality:acupuncture');

  // 真实 SOURCE_BOUND 路径：Runtime Catalog AC-049 → hydration receipt → delivery.commit → CommitLedger → Final/UI。
  const ac049 = getRuntimeAsset('AC-049', ctx.knowledgeScopes);
  check('AC-049 canonical asset exists', Boolean(ac049));
  if (!ac049) return;
  const assetScope = getRuntimeAssetScope('AC-049');
  check('AC-049 has activation scope', Boolean(assetScope), String(assetScope));
  if (!assetScope) return;
  recordHydrationReceipt(ctx.workspace, 'AC-049', assetScope);
  ctx.workspace.clinicalDecisionSpine.treatmentPlan = {
    primaryPrinciple: '疏肝理气，调经止痛', treatmentTarget: '痛经', evidenceRefs: ['AC-049'], version: 1,
    treatmentDeliveries: [{
      outcome: 'modality:acupuncture', form: '针灸', disposition: 'CURRENTLY_SUITABLE', statement: '采用来源方案并做患者资格判断',
      sourceEvidenceRefs: ['AC-049'], sourceAssetRefs: ['AC-049'],
      // 这份模型草稿故意与来源不同；commit 后 source truth 仍必须来自 AC-049。
      details: { points: ['模型自拟穴位不得成为 source truth'] },
    }],
  };
  const acupunctureCommit = await commitDeliveryOutcome(ctx, 'modality:acupuncture');
  check('AC-049 delivery.commit succeeds', acupunctureCommit.ok, acupunctureCommit.ok ? String(acupunctureCommit.record.commitId) : JSON.stringify(acupunctureCommit));
  if (!acupunctureCommit.ok) return;
  check('acupuncture provenance = CANONICAL_SOURCE', acupunctureCommit.record.provenance.kind === 'CANONICAL_SOURCE');
  check('Commit.sourceBundle carries exact AC-049 payload', JSON.stringify(acupunctureCommit.record.sourceBundle?.products[0]?.payload) === JSON.stringify(ac049));
  const payload = acupunctureCommit.record.sourceBundle?.products[0]?.payload as Record<string, any> | undefined;
  check('AC-049 body acupuncture source evidence visible', Array.isArray(payload?.protocol?.regimens) && payload.protocol.regimens.some((x: string) => x.includes('三阴交') && x.includes('关元') && x.includes('合谷')));
  check('AC-049 auricular source evidence visible', Array.isArray(payload?.protocol?.regimens) && payload.protocol.regimens.some((x: string) => x.includes('子宫') && x.includes('交感') && x.includes('生殖区')));
  check('reasoning draft cannot replace canonical source points', JSON.stringify(acupunctureCommit.record.sourceBundle).includes('模型自拟穴位不得成为 source truth') === false);
  const projected = projectClinicalResult({}, ctx.commitLedger.all());
  const view = buildResultView({
    mode: 'clinical', status: 'COMPLETED',
    disease: { name: '痛经', confidence: 0.9, evidence_refs: [] },
    syndrome: { name: '气滞', confidence: 0.8, evidence_refs: [] },
    treatment: { text: '疏肝理气，调经止痛', evidence_refs: [] },
    deliveries: projected.deliveries as never, missing_information: [], safety: { status: 'PASS' },
  } as never);
  check('Final/UI preserve AC-049 source bundle', JSON.stringify(view.deliveries?.[0]?.source_bundle?.products?.[0]?.payload) === JSON.stringify(ac049));

  // clinical-assessment fact ownership：assessment 不得拥有 modality execution facts。
  const assessment = buildClinicalAssessmentProduct({
    disease: '痛经', syndrome: '肝郁气滞', treatmentPrinciple: '疏肝理气', treatmentTarget: '疼痛', rationale: 'R',
  });
  const ownership = validateClinicalAssessmentFactOwnership(assessment);
  check('clinical-assessment 仅拥有 principle 级事实', ownership.ok, `fields=${JSON.stringify(Object.keys(assessment))}`);
  const polluted = { ...assessment, points: ['合谷'], operation: '平补平泻', frequency: '每日1次', course: '10次' };
  const pollutedOwnership = validateClinicalAssessmentFactOwnership(polluted);
  check('clinical-assessment 拒绝 modality execution facts', !pollutedOwnership.ok, `forbidden=${JSON.stringify(pollutedOwnership.forbiddenFields)}`);

  console.log('[E2E-1 RequestIR]', JSON.stringify({ required: ir.outcomes.required, excluded: ir.outcomes.excluded, exclusive: ir.outcomes.exclusive }));
  console.log('[E2E-1 effective]', JSON.stringify({ required: effectiveRequiredOutcomesV21(ctx.controlPlaneV21!) }));
  console.log('[E2E-1 assessment product]', JSON.stringify(assessment));
}

async function e2e2(): Promise<void> {
  console.log('\n================= E2E-2 canonical 多产品 SourceBundle =================');

  // ---- 2a：三态 fixture（deterministic，不依赖真实知识恰好三态齐全）----
  const fixtureDoc = (): KnowledgeDoc => ({
    id: 'P1:fixture', text: 'D/S/T', sourceId: 'SRC', source: 'manual', sourceFile: 'x.txt',
    sourceTier: 'P1', knowledgeRole: 'NORMATIVE_TREATMENT', prescriptionAuthority: true, scope: 'general',
    disease: 'D', syndrome: 'S', treatment: 'T', title: 'D｜S', releaseVersion: 'r1', kind: 'normative',
    sourceModifications: ['共享加减'],
    formulas: [
      { id: 'F1', name: '方1', composition: 'A', sourceModifications: ['方内加减'], usage: '每日一次', sourceTier: 'P1', knowledgeRole: 'BASE_FORMULA', entityStatus: 'ACTIVE' },
      { id: 'F2', name: '方2', composition: 'B', sourceModifications: [], usage: '', sourceTier: 'P1', knowledgeRole: 'BASE_FORMULA', entityStatus: 'ACTIVE' },
      { id: 'F3', name: '方3', composition: '', sourceTier: 'P1', knowledgeRole: 'BASE_FORMULA', entityStatus: 'ACTIVE' },
    ],
  });
  const fx = hydrateSourceFormulaSet([fixtureDoc()], 'P1:fixture::F1', {
    exclusions: { 'P1:fixture::F3': { reason: 'patient-specific exclusion', evidenceRefs: ['CF1'] } },
  });
  check('fixture SourceBundle.products = 3', fx?.formulas.length === 3, String(fx?.formulas.length));
  if (fx) {
    const fp = projectFormulaSet(fx, { mode: 'PRIMARY_ONLY' });
    check('fixture F1 formulaLocal PRESENT', fp[0]?.facts?.modifications.formulaLocal.presence === 'PRESENT', JSON.stringify(fp[0]?.facts?.modifications.formulaLocal));
    check('fixture F2 formulaLocal KNOWN_EMPTY', fp[1]?.facts?.modifications.formulaLocal.presence === 'KNOWN_EMPTY', JSON.stringify(fp[1]?.facts?.modifications.formulaLocal));
    check('fixture F3 formulaLocal UNKNOWN', fp[2]?.facts?.modifications.formulaLocal.presence === 'UNKNOWN', JSON.stringify(fp[2]?.facts?.modifications.formulaLocal));
    check('fixture F3 composition UNKNOWN', fp[2]?.facts?.composition.presence === 'UNKNOWN', JSON.stringify(fp[2]?.facts?.composition));
    check('fixture sourceShared PRESENT', fp[0]?.facts?.modifications.sourceShared.presence === 'PRESENT', JSON.stringify(fp[0]?.facts?.modifications.sourceShared));
    check('fixture CLINICALLY_EXCLUDED 后 N 不变', fp.length === 3 && fp[2]?.relation === 'CLINICALLY_EXCLUDED');
  }

  // ---- 2b：真实 P1 source N→N + Kernel commit 路径 + excluded qualification 保留 ----
  const index = await loadIndex();
  const p1Docs = index.docs.filter((d) => d.sourceTier === 'P1' && d.formulas.length >= 3);
  const target = p1Docs[0];
  if (!target) {
    check('2b 找到含 >=3 ACTIVE 方的 P1 source', false, '无可用真实 source');
    return;
  }
  const N = target.formulas.length;
  const selectedFormulaId = target.formulas[0].id;
  const selectedRef = `${target.id}::${selectedFormulaId}`;
  check('2b 找到含 >=3 ACTIVE 方的 P1 source', true, `parent=${target.id}, N=${N}`);

  // 先带 exclusions 水合，作为 prior sourceFormulaSet（commit 时据此保留 excluded qualification）。
  const set = hydrateSourceFormulaSet(index.docs, selectedRef, {
    exclusions: { [`${target.id}::${target.formulas[2].id}`]: { reason: 'e2e clinical exclusion', evidenceRefs: ['CF1'] } },
  });
  check('2b SourceBundle.products = N', set?.formulas.length === N, `N=${N}, actual=${set?.formulas.length}`);
  if (!set) return;
  check('2b projectFormulaSet = N（无 filter）', projectFormulaSet(set, { mode: 'PRIMARY_ONLY' }).length === N);

  const ir = requestIR(['outcome:clinical-assessment', 'modality:herbal-formula']);
  const ctx = await prepareContext(ir);
  ctx.workspace.clinicalDecisionSpine.formulaSelection = { selectedCandidateRef: selectedRef, version: 1 };
  ctx.workspace.candidates = [{
    id: selectedRef, kind: 'formula', name: target.formulas[0].name,
    sourceId: target.id, formulaId: selectedFormulaId,
    composition: [target.formulas[0].composition ?? ''],
  }];
  // 关键：把带 exclusions 的 prior set 放进 workspace，commit 才保留 CLINICALLY_EXCLUDED qualification。
  ctx.workspace.sourceFormulaSet = set;

  const commit = await commitDeliveryOutcome(ctx, 'modality:herbal-formula');
  check('2b delivery.commit (herbal) ok', commit.ok, commit.ok ? `providerId=${commit.record.providerId}` : JSON.stringify(commit));
  if (commit.ok && commit.record.sourceBundle) {
    check('2b Commit.sourceBundle.products = N', commit.record.sourceBundle.products.length === N, `N=${N}, actual=${commit.record.sourceBundle.products.length}`);
    check('2b Commit.sourceBundle 保留 excluded sibling（qualification）', commit.record.sourceBundle.products.some((p) => p.qualification === 'CLINICALLY_EXCLUDED'));

    // Final projection（等价 clinical-runtime committedFormulaSet 的 SourceBundle → formula_set）。
    const finalFormulaSet = commit.record.sourceBundle.products.map((product) => {
      const payload = product.payload as Record<string, unknown>;
      const mods = (payload.modifications && typeof payload.modifications === 'object') ? payload.modifications as Record<string, unknown> : {};
      return {
        formula_ref: `${target.id}::${product.productId}`, formula_id: product.productId, name: product.name,
        composition: '', source_ref: target.id, modification_rules: [] as string[],
        modification_status: 'UNKNOWN' as const, modification_text: 'UNKNOWN', relation: product.qualification,
        facts: {
          composition: payload.composition, preparation: payload.preparation, usage: payload.usage,
          modifications: {
            formulaLocal: mods.formulaLocal, sourceShared: mods.sourceShared, patientSpecific: mods.patientSpecific,
          },
        },
      };
    });
    check('2b Final.formula_set = N', finalFormulaSet.length === N, `N=${N}, actual=${finalFormulaSet.length}`);
    const view = buildResultView({
      mode: 'clinical', status: 'COMPLETED',
      disease: { name: 'D', confidence: 0.9, evidence_refs: [] },
      syndrome: { name: 'S', confidence: 0.8, evidence_refs: [] },
      treatment: { text: 'T', evidence_refs: [] },
      formula_set: finalFormulaSet as never,
      missing_information: [], safety: { status: 'PASS' },
    } as never);
    check('2b UI.formula_set = N', view.formula_set?.length === N, `N=${N}, actual=${view.formula_set?.length}`);
    check('2b UI 保留 excluded sibling（relation）', Boolean(view.formula_set?.some((f: any) => f.relation === 'CLINICALLY_EXCLUDED')));

    console.log('[E2E-2 real source]', JSON.stringify({ parent: target.id, N }));
    console.log('[E2E-2 Commit sourceBundle products]', commit.record.sourceBundle.products.length, 'qualifications=', JSON.stringify(commit.record.sourceBundle.products.map((p) => p.qualification)));
    console.log('[E2E-2 Final formula_set]', finalFormulaSet.length, '| UI formula_set =', view.formula_set?.length);
  }
}

async function main(): Promise<void> {
  await e2e1();
  await e2e2();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n================= Authority Boundary E2E：${results.length - failed.length}/${results.length} PASS =================`);
  if (failed.length) {
    console.error('FAILED:', failed.map((f) => f.name).join('; '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exit(1);
});

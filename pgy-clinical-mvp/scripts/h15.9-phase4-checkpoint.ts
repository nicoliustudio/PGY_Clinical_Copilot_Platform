import { writeFileSync } from 'node:fs';
import { runCase } from '../src/composition/runtime.js';
import { buildIndex } from '../src/knowledge/build.js';

/**
 * H15.9 / Phase 4 — Real-Case Convergence Checkpoint。
 * 12 cases × 1（8 核心 + 4 混合/治疗形式），只观察 5 类结果：
 *   Correctness / Completion / Convergence / Contract Closure / Clinical trace。
 * 不采样 x3/x20；只做单次真实运行，识别跨病例重复的结构性 failure。
 */

interface CaseDef { key: string; intent: string; input: string }

const CASES: CaseDef[] = [
  { key: 'T01', intent: '基础方·月经后期', input: '经行后期，量少色淡清稀。下腹隐痛，喜用热敷，腰痠肢软，纳少便溏。苔薄，舌淡，脉沉细。' },
  { key: 'T02', intent: '基础方·子宫肌瘤', input: '患者于1978年经上海市第二军医大学妇科检查发现子宫肌瘤。月经超前量多四年余，经后带下绵绵，并有腥味，大便秘结。于1981年10月31日B型超声波检查报告：子宫前位，大小4.3cm×6.1cm×7.8cm。子宫左后壁向外突出，呈一实质性暗区，大小约2.4cm×3.0cm，与宫壁间无明显分界，提示为小型子宫肌瘤。' },
  { key: 'T04', intent: '基础方·白带（盆腔炎）', input: '白带过多一周，色乳白，素有盆腔炎。LMP5月25日，5天净止，量中，色鲜红，少量血块；夜寐难以入睡，凌晨盗汗，腰酸，口渴多饮，少腹寒冷，纳可，二便调。舌淡苔白腻，脉濡滑。' },
  { key: 'T08', intent: '仅辨证·失眠', input: '陈某，女，45岁，更年期综合征，失眠3年，近期加重。入睡困难、多梦易醒，每晚睡2～3小时；伴心烦心悸、口干咽燥、手足心热、盗汗、舌尖溃疡；舌红少苔、舌尖红赤，脉细数。甲状腺功能正常。本次只需要辨证和治法，不需要开方。' },
  { key: 'T09', intent: '信息不足·月经异常', input: '患者女，29岁。近两个月月经各推迟约10天，经量较平时略少。未提供腹痛、寒热、带下、睡眠、饮食、二便等伴随情况，也未提供舌象和脉象。想知道中医属于什么证。先判断现有信息是否足够，不要猜。' },
  { key: 'T11', intent: '膏方·月经失调', input: '王某，女，29岁，公司职员。月经周期紊乱1年余，或提前7~10日，或推后半月，经量偏少，色淡质稀，伴神疲乏力、食欲不振、腰膝酸软，经期小腹隐隐坠痛，得温则减。舌淡胖，边有齿痕，苔薄白，脉沉细无力。患者希望冬令长期调理，明确要求以膏代煎药，请按膏方思路给方案，不想每天煎汤药。' },
  { key: 'T15', intent: '针灸·痛经', input: '经前或经期下腹胀痛，经色黯红，经前乳胀，胸膺掣痛。苔薄，脉弦。这次只想做针灸治疗，不开汤药，请给针灸方案。' },
  { key: 'T18', intent: '制剂·人流后恶露不净', input: '人流后恶露淋漓不净，色淡质稀，面色㿠白，神疲乏力，头晕乏力。苔薄，舌淡，脉细弱。患者不方便煎药，明确想优先了解成药或现成膏剂的选择和用法，不要给复杂汤剂。' },
  { key: 'T19', intent: '同源多方·痛经气滞汤药', input: '经前及经期小腹胀痛，胀甚于痛，经色紫暗有块，经前乳房胀痛，胸胁胀满，善太息，苔薄白，脉弦。请开汤药调理。' },
  { key: 'T20', intent: '随症加减·痛经寒凝', input: '经期小腹冷痛，得热痛减，按之痛甚，经量少，色暗有块，畏寒肢冷，面色青白，苔白，脉沉紧。请开汤药。' },
  { key: 'T21', intent: '多个治疗能力·针灸+膏方', input: '痛经反复多年，经期小腹冷痛。这次想用针灸缓解经期疼痛，同时想冬令用膏方长期调补身体，请给针灸方案和膏方调补思路。' },
  { key: 'T22', intent: '同源多方·崩漏脾虚', input: '月经非时而下，量多如崩，色淡质稀，面色㿠白，神疲气短，纳呆便溏，苔薄白，舌淡胖，脉细弱。请开汤药。' },
];

function countTool(toolCalls: { toolName: string; input?: unknown }[], name: string): number {
  return toolCalls.filter((t) => t.toolName === name).length;
}

/** 检测精确重复检索（同 tool + 同规范化输入出现 >1 次）——semantic no-op 的强信号。 */
function repeatedRetrievalCount(toolCalls: { toolName: string; input?: unknown }[]): number {
  const seen = new Map<string, number>();
  for (const t of toolCalls) {
    if (!['knowledge.search_cards', 'knowledge.get_asset', 'knowledge.search'].includes(t.toolName)) continue;
    const key = `${t.toolName}::${JSON.stringify(t.input ?? {})}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let repeats = 0;
  for (const n of seen.values()) if (n > 1) repeats += n - 1;
  return repeats;
}

async function main() {
  const keys = process.argv[2]?.split(',').filter(Boolean);
  const selected = keys ? CASES.filter((c) => keys.includes(c.key)) : CASES;

  console.log(`[P4-checkpoint] cases=${selected.map((c) => c.key).join(',')} runs=1，确保索引就绪...`);
  await buildIndex(false);

  const rows: Record<string, unknown>[] = [];

  for (const c of selected) {
    const started = Date.now();
    try {
      const { result, trace, workspace, authority } = await runCase(c.input);
      const agentLoop = trace.agentLoop;
      const stepCount = agentLoop?.stepCount ?? trace.toolCalls.length;
      const termination = agentLoop?.terminationReason;
      const toolCalls = trace.toolCalls;

      const evidenceClosures = (workspace.capabilityEvidenceClosures ?? []).map((cl) => `${cl.capabilityId}:${cl.obligationId ?? '-'}=${cl.status}`);
      const deliveryClosures = (workspace.capabilityDeliveryClosures ?? []).map((cl) => `${cl.capabilityId}:${cl.obligationId}=${cl.status}`);
      const sourceFormulaSet = workspace.sourceFormulaSet
        ? { parent: workspace.sourceFormulaSet.parentRecordRef, formulas: workspace.sourceFormulaSet.formulas.length, primary: workspace.sourceFormulaSet.formulas.filter((f) => f.relation === 'PRIMARY_SELECTED').length, alt: workspace.sourceFormulaSet.formulas.filter((f) => f.relation === 'SOURCE_ALTERNATIVE').length }
        : null;
      const modClosure = workspace.modificationEvidenceClosure
        ? { status: workspace.modificationEvidenceClosure.status, matchedRuleRefs: workspace.modificationEvidenceClosure.matchedRuleRefs.length }
        : null;

      const blockCodes = authority.decisions.filter((d) => d.action === 'BLOCK').map((d) => `${d.stage}:${d.reasons[0] ?? ''}`);
      const formulaSelection = workspace.clinicalDecisionSpine.formulaSelection !== undefined;
      const treatmentFormDecision = workspace.clinicalDecisionSpine.treatmentPlan?.treatmentFormDecision !== undefined;

      const row = {
        key: c.key, intent: c.intent,
        mode: result.mode,
        authorityStatus: authority.status,
        blockCodes,
        disease: result.mode === 'clinical' ? (result as { disease?: { name?: string } }).disease?.name : undefined,
        syndrome: result.mode === 'clinical' ? (result as { syndrome?: { name?: string } }).syndrome?.name : undefined,
        stepCount,
        termination,
        forcedFinalization: agentLoop?.forcedFinalization ?? false,
        toolCalls: toolCalls.length,
        searchCards: countTool(toolCalls, 'knowledge.search_cards'),
        getAsset: countTool(toolCalls, 'knowledge.get_asset'),
        knowledgeSearch: countTool(toolCalls, 'knowledge.search'),
        getSource: countTool(toolCalls, 'knowledge.get_source'),
        considerHypotheses: countTool(toolCalls, 'workspace.consider_hypotheses'),
        submitAttempts: countTool(toolCalls, 'proposal.submit'),
        activate: countTool(toolCalls, 'capability.activate'),
        repeatedRetrieval: repeatedRetrievalCount(toolCalls),
        capabilities: trace.capabilities ?? [],
        knowledgeScopes: trace.knowledgeScopes ?? [],
        evidenceClosures,
        deliveryClosures,
        sourceFormulaSet,
        modificationClosure: modClosure,
        formulaSelection,
        treatmentFormDecision,
        ms: Date.now() - started,
      };
      rows.push(row);
      console.log(
        `[${c.key}] mode=${result.mode} auth=${authority.status}${blockCodes.length ? ` BLOCK=${blockCodes.join(';')}` : ''} ` +
        `steps=${stepCount} term=${termination} tools=${toolCalls.length} ` +
        `search=${row.searchCards} asset=${row.getAsset} ksearch=${row.knowledgeSearch} hyp=${row.considerHypotheses} submit=${row.submitAttempts} ` +
        `repeats=${row.repeatedRetrieval} ` +
        `caps=${(row.capabilities as string[]).join('|') || '-'} ` +
        `evid=${evidenceClosures.join('|') || '-'} deliv=${deliveryClosures.join('|') || '-'} ` +
        `srcSet=${sourceFormulaSet ? `${sourceFormulaSet.formulas}F(${sourceFormulaSet.primary}P/${sourceFormulaSet.alt}A)` : '-'} ` +
        `mod=${modClosure ? modClosure.status : '-'} sel=${formulaSelection} formDec=${treatmentFormDecision} ${Date.now() - started}ms`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      rows.push({ key: c.key, intent: c.intent, error: msg.slice(0, 500) });
      console.error(`[${c.key}] ERROR: ${msg.slice(0, 300)}`);
    }
  }

  const outPath = 'reports/h15.9-phase4-checkpoint.json';
  writeFileSync(outPath, JSON.stringify(rows, null, 2), 'utf8');

  console.log('\n================ P4 Checkpoint 汇总 ================');
  console.log(`完成 ${rows.filter((r) => !r.error).length}/${selected.length}`);
  for (const r of rows) {
    if (r.error) { console.log(`  ${r.key} ERROR: ${r.error}`); continue; }
    const evid = (r.evidenceClosures as string[]) ?? [];
    const deliv = (r.deliveryClosures as string[]) ?? [];
    const mod = r.modificationClosure as { status?: string } | null | undefined;
    console.log(
      `  ${r.key} [${r.intent}] mode=${r.mode} auth=${r.authorityStatus} term=${r.termination} steps=${r.stepCount} ` +
      `search=${r.searchCards} ksearch=${r.knowledgeSearch} repeats=${r.repeatedRetrieval} hyp=${r.considerHypotheses} submit=${r.submitAttempts} ` +
      `evid=${evid.join('|') || '-'} deliv=${deliv.join('|') || '-'} ` +
      `srcSet=${r.sourceFormulaSet ? JSON.stringify(r.sourceFormulaSet) : '-'} mod=${mod?.status ?? '-'}`,
    );
  }

  console.log(`\n结果已写入 ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

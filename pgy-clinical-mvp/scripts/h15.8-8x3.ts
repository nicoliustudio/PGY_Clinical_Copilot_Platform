import { runCase } from '../src/composition/runtime.js';
import { buildIndex } from '../src/knowledge/build.js';

/** H15.8 8×3 稳定性 harness：覆盖基础方 / 仅辨证 / 信息不足 / 膏方 / 针灸 / 成药。 */
interface CaseDef { key: string; input: string; intent: string }

const CASES: CaseDef[] = [
  { key: 'T01', intent: '基础方·月经后期', input: '经行后期，量少色淡清稀。下腹隐痛，喜用热敷，腰痠肢软，纳少便溏。苔薄，舌淡，脉沉细。' },
  { key: 'T02', intent: '基础方·子宫肌瘤', input: '患者于1978年经上海市第二军医大学妇科检查发现子宫肌瘤。月经超前量多四年余，经后带下绵绵，并有腥味，大便秘结。于1981年10月31日B型超声波检查报告：子宫前位，大小4.3cm×6.1cm×7.8cm。子宫左后壁向外突出，呈一实质性暗区，大小约2.4cm×3.0cm，与宫壁间无明显分界，提示为小型子宫肌瘤。' },
  { key: 'T04', intent: '基础方·白带', input: '白带过多一周，色乳白，素有盆腔炎。LMP5月25日，5天净止，量中，色鲜红，少量血块；夜寐难以入睡，凌晨盗汗，腰酸，口渴多饮，少腹寒冷，纳可，二便调。舌淡苔白腻，脉濡滑。' },
  { key: 'T08', intent: '仅辨证·失眠', input: '陈某，女，45岁，更年期综合征，失眠3年，近期加重。入睡困难、多梦易醒，每晚睡2～3小时；伴心烦心悸、口干咽燥、手足心热、盗汗、舌尖溃疡；舌红少苔、舌尖红赤，脉细数。甲状腺功能正常。本次只需要辨证和治法，不需要开方。' },
  { key: 'T09', intent: '信息不足·月经异常', input: '患者女，29岁。近两个月月经各推迟约10天，经量较平时略少。未提供腹痛、寒热、带下、睡眠、饮食、二便等伴随情况，也未提供舌象和脉象。想知道中医属于什么证。先判断现有信息是否足够，不要猜。' },
  { key: 'T11', intent: '膏方·月经失调', input: '王某，女，29岁，公司职员。月经周期紊乱1年余，或提前7~10日，或推后半月，经量偏少，色淡质稀，伴神疲乏力、食欲不振、腰膝酸软，经期小腹隐隐坠痛，得温则减。舌淡胖，边有齿痕，苔薄白，脉沉细无力。患者希望冬令长期调理，明确要求以膏代煎药，请按膏方思路给方案，不想每天煎汤药。' },
  { key: 'T15', intent: '针灸·痛经', input: '经前或经期下腹胀痛，经色黯红，经前乳胀，胸膺掣痛。苔薄，脉弦。这次只想做针灸治疗，不开汤药，请给针灸方案。' },
  { key: 'T18', intent: '成药/制剂·人流后恶露不净', input: '人流后恶露淋漓不净，色淡质稀，面色㿠白，神疲乏力，头晕乏力。苔薄，舌淡，脉细弱。患者不方便煎药，明确想优先了解成药或现成膏剂的选择和用法，不要给复杂汤剂。' },
];

function countTool(toolCalls: { toolName: string }[], name: string): number {
  return toolCalls.filter((t) => t.toolName === name).length;
}

async function main() {
  const nRuns = Number(process.argv[2] ?? 3);
  const keys = process.argv[3]?.split(',').filter(Boolean);
  const selected = keys ? CASES.filter((c) => keys.includes(c.key)) : CASES;

  console.log(`[8x3] cases=${selected.map((c) => c.key).join(',')} runs=${nRuns}，确保索引就绪...`);
  await buildIndex(false);

  const steps: number[] = [];
  let executionIncomplete = 0;
  let conversationCount = 0;
  const rows: Record<string, unknown>[] = [];

  for (const c of selected) {
    for (let r = 1; r <= nRuns; r++) {
      const started = Date.now();
      try {
        const { result, trace, workspace } = await runCase(c.input);
        const agentLoop = trace.agentLoop;
        const stepCount = agentLoop?.stepCount ?? trace.toolCalls.length;
        steps.push(stepCount);
        if (agentLoop?.terminationReason === 'resource_limit_fallback' || agentLoop?.terminationReason === 'timeout_fallback' || agentLoop?.terminationReason === 'execution_incomplete') executionIncomplete++;
        if (result.mode === 'conversation') conversationCount++;

        const closures = (workspace.capabilityEvidenceClosures ?? []).map((cl) => `${cl.capabilityId}:${cl.obligationId}=${cl.status}`);
        const receipts = Object.entries(workspace.capabilityEvidenceReceipts ?? {}).map(([scope, r]) => {
          const disc = Object.entries(r.discoveryByTool).map(([t, ids]) => `${t}(${ids.length})`).join(';');
          const hyd = Object.entries(r.hydrationByTool).map(([t, ids]) => `${t}(${ids.length})`).join(';');
          return `${scope}[disc:${disc}|hyd:${hyd}]`;
        });
        const sfs = workspace.sourceFormulaSet ? `formulas=${workspace.sourceFormulaSet.formulas.length}` : 'none';
        const modClosure = workspace.modificationEvidenceClosure?.status ?? 'none';

        const row = {
          key: c.key, run: r, intent: c.intent,
          mode: result.mode,
          authority: result.mode === 'clinical' ? (result as { formula?: { authority?: string } }).formula?.authority : result.mode,
          disease: result.mode === 'clinical' ? (result as { disease?: { name?: string } }).disease?.name : undefined,
          stepCount,
          termination: agentLoop?.terminationReason,
          toolCalls: trace.toolCalls.length,
          searchCards: countTool(trace.toolCalls, 'knowledge.search_cards'),
          getAsset: countTool(trace.toolCalls, 'knowledge.get_asset'),
          activate: countTool(trace.toolCalls, 'capability.activate'),
          submitAttempts: countTool(trace.toolCalls, 'proposal.submit'),
          considerHypotheses: countTool(trace.toolCalls, 'workspace.consider_hypotheses'),
          formulaSelection: workspace.clinicalDecisionSpine.formulaSelection !== undefined,
          capabilities: trace.capabilities ?? [],
          knowledgeScopes: trace.knowledgeScopes ?? [],
          closures,
          receipts,
          sourceFormulaSet: sfs,
          modificationClosure: modClosure,
          ms: Date.now() - started,
        };
        rows.push(row);
        console.log(
          `[${c.key}-R${r}] mode=${result.mode} auth=${row.authority} steps=${stepCount} ` +
          `search_cards=${row.searchCards} get_asset=${row.getAsset} submit=${row.submitAttempts} ` +
          `hyp=${row.considerHypotheses} sel=${row.formulaSelection} ` +
          `caps=${(row.capabilities as string[]).join('|') || '-'} ` +
          `closures=${closures.join('|') || '-'} ${Date.now() - started}ms`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        rows.push({ key: c.key, run: r, intent: c.intent, error: msg.slice(0, 400) });
        console.error(`[${c.key}-R${r}] ERROR: ${msg.slice(0, 300)}`);
      }
    }
  }

  steps.sort((a, b) => a - b);
  const pct = (p: number) => steps.length ? steps[Math.min(steps.length - 1, Math.floor((p / 100) * steps.length))] : 0;
  const mean = steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length : 0;

  console.log('\n================ 8×3 汇总 ================');
  console.log(`完成运行 ${rows.length}/${selected.length * nRuns} | steps mean=${mean.toFixed(1)} P50=${pct(50)} P95=${pct(95)} execution_incomplete=${executionIncomplete} conversation=${conversationCount}`);
  const okRows = rows.filter((r) => r.key !== undefined && r.error === undefined);
  const hypVals = okRows.map((r) => (r.considerHypotheses as number) ?? 0);
  const hypMean = hypVals.length ? hypVals.reduce((a, b) => a + b, 0) / hypVals.length : 0;
  const selCount = okRows.filter((r) => r.formulaSelection === true).length;
  const formulaRuns = okRows.filter((r) => !['T08', 'T09', 'T15'].includes(String(r.key))).length;
  console.log(`hypothesis churn：consider_hypotheses mean=${hypMean.toFixed(1)}/run | formulaSelection 完成=${selCount}/${formulaRuns}（需开方 case）`);
  console.log('\n--- treatment intent 证据闭环核对 ---');
  for (const c of selected.filter((x) => ['T11', 'T15', 'T18'].includes(x.key))) {
    const rs = rows.filter((r) => r.key === c.key);
    console.log(`  ${c.key} (${c.intent}):`);
    for (const r of rs) {
      console.log(`    R${r.run}: closures=${(r.closures as string[]).join('|') || '-'} receipts=${(r.receipts as string[]).join('|') || '-'}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

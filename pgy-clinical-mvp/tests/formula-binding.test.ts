import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNormativeFormulaInDocs } from '../src/clinical/formula-binding.js';
import type { KnowledgeDoc } from '../src/knowledge/types.js';

const docs: KnowledgeDoc[] = [
  {
    id: 'P1:A', tier: 'P1', kind: 'normative', source: 'A', sourceFile: 'a.json',
    disease: 'd', syndrome: 's', treatment: 't', scope: 'general', title: 'A', text: 'A',
    formulas: [{ id: 'F:A', name: '方A', composition: '药甲10g，药乙6g', sourceTier: 'P1', knowledgeRole: 'normative' }],
    raw: {},
  },
  {
    id: 'P1:B', tier: 'P1', kind: 'normative', source: 'B', sourceFile: 'b.json',
    disease: 'd', syndrome: 's', treatment: 't', scope: 'general', title: 'B', text: 'B',
    formulas: [{ id: 'F:B', name: '方B', composition: '药丙10g，药丁6g', sourceTier: 'P1', knowledgeRole: 'normative' }],
    raw: {},
  },
];

test('Formula Authority 要求 source/formula/composition 三者同源', () => {
  assert.equal(validateNormativeFormulaInDocs(docs, {
    sourceId: 'P1:A', formulaId: 'F:A', composition: '药甲10g 药乙6g',
  }).valid, true);

  // 组成确实存在于另一个 P1，但 source/formula 引用不一致时必须失败。
  assert.equal(validateNormativeFormulaInDocs(docs, {
    sourceId: 'P1:A', formulaId: 'F:B', composition: '药丙10g，药丁6g',
  }).valid, false);
});

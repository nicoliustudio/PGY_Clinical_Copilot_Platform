import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentResult } from '../src/contracts/result.js';
import type { GoldLabel } from '../src/eval/metrics.js';
import { classifyAudit } from '../src/ui/audit.js';

const gold: GoldLabel = {
  key: '妇科-001',
  goldId: '妇科-001',
  diseaseRaw: '子宫肌瘤',
  diseaseResolved: '女性生殖系统肿瘤-子宫肌瘤',
  syndrome: '血热内盛',
  variantId: 'K_8153cbb8ba46',
  evaluable: true,
  group: 'P1',
};

function clinical(overrides: Partial<Extract<AgentResult, { mode: 'clinical' }>> = {}): AgentResult {
  return {
    mode: 'clinical',
    status: 'COMPLETED',
    disease: { name: '子宫肌瘤', confidence: 0.9, evidence_refs: ['P1:a'] },
    syndrome: { name: '血热内盛', confidence: 0.8, evidence_refs: ['P1:a'] },
    treatment: { text: '清热', evidence_refs: ['P1:a'] },
    formula: { authority: 'NORMATIVE', formula_id: 'f', name: '方', composition: ['药'], source_id: 'P1:K_8153cbb8ba46', evidence_refs: ['P1:a'] },
    missing_information: [],
    safety: { status: 'PASS' },
    ...overrides,
  } as AgentResult;
}

test('病证方全命中 → GOLD_MATCH', () => {
  const a = classifyAudit(clinical(), gold);
  assert.equal(a.classification, 'GOLD_MATCH');
  assert.deepEqual(a.exactMatch, { disease: true, syndrome: true, formula: true });
});

test('方剂未命中但病证命中且有证据 → 不误判为 decision error（GOLD_EVIDENCE_TENSION）', () => {
  const a = classifyAudit(clinical({ formula: { authority: 'NORMATIVE', formula_id: 'f', name: '他方', composition: ['药'], source_id: 'P1:other', evidence_refs: ['P1:b'] } }), gold);
  assert.equal(a.classification, 'GOLD_EVIDENCE_TENSION');
  assert.notEqual(a.classification, 'DECISION_ERROR');
});

test('方剂未命中但病证命中且为 AI 拟方 → DEFENSIBLE_ALTERNATIVE', () => {
  const a = classifyAudit(clinical({ formula: { authority: 'GENERATED_DRAFT', formula_id: '', name: '拟方', composition: ['药'], source_id: 'P1:other', evidence_refs: ['P1:b'] } }), gold);
  assert.equal(a.classification, 'DEFENSIBLE_ALTERNATIVE');
});

test('方剂权威 BLOCKED → DECISION_ERROR', () => {
  const a = classifyAudit(clinical({ formula: { authority: 'BLOCKED', formula_id: '', name: '', composition: [], source_id: '', evidence_refs: [] } }), gold);
  assert.equal(a.classification, 'DECISION_ERROR');
});

test('无证据支撑 → UNSUPPORTED_REASONING', () => {
  const a = classifyAudit(clinical({
    disease: { name: '子宫肌瘤', confidence: 0.5, evidence_refs: [] },
    syndrome: { name: '血热内盛', confidence: 0.5, evidence_refs: [] },
    formula: { authority: 'GENERATED_DRAFT', formula_id: '', name: '拟方', composition: [], source_id: 'P1:other', evidence_refs: [] },
  }), gold);
  assert.equal(a.classification, 'UNSUPPORTED_REASONING');
});

test('非临床输出 → UNRESOLVED', () => {
  const a = classifyAudit({ mode: 'conversation', message: '你好' } as AgentResult, gold);
  assert.equal(a.classification, 'UNRESOLVED');
});

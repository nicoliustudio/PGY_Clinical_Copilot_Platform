import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeGroupKey,
  projectDiagnosticRecord,
  type DiagnosticKnowledgeRecord,
  type KnowledgeField,
  type SourceMetadata,
} from '../src/knowledge/diagnostic-schema.js';
import { buildIngestionManifest, qaIngestion } from '../src/knowledge/diagnostic-qa.js';

function field(text: string, overrides?: Partial<KnowledgeField['provenance']>): KnowledgeField {
  return {
    text,
    provenance: {
      sourceId: 'P1_GYN_MANUAL',
      sourceType: 'standard',
      sourceStatus: 'NORMATIVE_CURRENT',
      verificationStatus: 'VERIFIED_ORIGINAL',
      ...overrides,
    },
  };
}

function source(overrides?: Partial<SourceMetadata>): SourceMetadata {
  return {
    sourceId: 'P1_GYN_MANUAL',
    sourceType: 'standard',
    sourceStatus: 'NORMATIVE_CURRENT',
    verificationStatus: 'VERIFIED_ORIGINAL',
    ...overrides,
  };
}

function makeRecord(overrides?: Partial<DiagnosticKnowledgeRecord>): DiagnosticKnowledgeRecord {
  return {
    id: 'P1:K_ba9520cb8cd8',
    disease: { canonicalName: '女性生殖系统肿瘤-子宫肌瘤' },
    syndrome: { name: '肝郁脾虚型', originalName: '肝郁脾虚型' },
    definition: field('因肝气郁结，脾虚失运所致……'),
    manifestations: {
      main: field('月经量多如崩，小腹下坠，大便溏薄'),
      tongue: field('舌质淡白或薄白'),
      pulse: field('脉濡细或弦细'),
    },
    diagnosticBasis: field('……'),
    mechanism: field('肝郁脾虚，冲任不固'),
    treatmentPrinciple: field('健脾升清，疏肝散结'),
    differential: [
      {
        againstSyndrome: '气滞血瘀',
        distinguishingFeatures: '本证以脾虚便溏、经后带多清稀为主，气滞血瘀以胀痛拒按、经血夹块为主',
        provenance: source(),
      },
    ],
    source: source(),
    ...overrides,
  };
}

test('Field-level provenance：每个 KnowledgeField 自带来源状态', () => {
  const r = makeRecord();
  assert.equal(r.manifestations?.tongue?.provenance.sourceStatus, 'NORMATIVE_CURRENT');
  assert.equal(r.manifestations?.tongue?.provenance.verificationStatus, 'VERIFIED_ORIGINAL');
  assert.equal(r.manifestations?.tongue?.provenance.sourceId, 'P1_GYN_MANUAL');
});

test('Diagnostic projection 不含 formula / bestMatch / score', () => {
  const p = projectDiagnosticRecord(makeRecord());
  const json = JSON.stringify(p);
  for (const forbidden of ['formulaId', 'candidateRef', 'composition', 'bestMatch', 'recommendedSyndrome', '"score"', '妇2号方']) {
    assert.ok(!json.includes(forbidden), `不应出现 ${forbidden}`);
  }
  assert.equal(p.syndrome, '肝郁脾虚型');
  assert.equal(p.treatmentPrinciple, '健脾升清，疏肝散结');
  assert.equal(p.differential?.length, 1);
});

test('dedupeGroupKey：同一病+证归为同一 group（不 merge 成超级答案）', () => {
  const a = makeRecord({ id: 'srcA' });
  const b = makeRecord({ id: 'srcB', source: source({ sourceId: 'OLD_STANDARD' }) });
  assert.equal(dedupeGroupKey(a), dedupeGroupKey(b));
});

test('QA：空 disease / syndrome 报错', () => {
  const r = qaIngestion([makeRecord({ disease: { canonicalName: '' }, syndrome: { name: '' } })]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('disease.canonicalName 为空')));
  assert.ok(r.errors.some((e) => e.includes('syndrome.name 为空')));
});

test('QA：provenance 丢失报错', () => {
  const r = makeRecord();
  r.diagnosticBasis = { text: 'x', provenance: { sourceId: '', sourceType: 'standard', sourceStatus: 'NORMATIVE_CURRENT', verificationStatus: 'VERIFIED_ORIGINAL' } };
  const qa = qaIngestion([r]);
  assert.equal(qa.ok, false);
  assert.ok(qa.errors.some((e) => e.includes('provenance 丢失')));
});

test('QA：sourceStatus / verificationStatus 不明报错', () => {
  const r = makeRecord({ source: source({ sourceStatus: 'UNVERIFIED', verificationStatus: 'UNVERIFIED' }) });
  const qa = qaIngestion([r]);
  assert.equal(qa.ok, false);
  assert.ok(qa.errors.some((e) => e.includes('sourceStatus 不明')));
  assert.ok(qa.errors.some((e) => e.includes('verificationStatus 不明')));
});

test('QA：重复 ID 报错', () => {
  const qa = qaIngestion([makeRecord(), makeRecord()]);
  assert.equal(qa.ok, false);
  assert.ok(qa.errors.some((e) => e.includes('重复 ID')));
});

test('QA：Gold 数据混入报错', () => {
  const r = makeRecord() as unknown as Record<string, unknown>;
  r.expectedSyndrome = '肝郁脾虚型';
  const qa = qaIngestion([r as unknown as DiagnosticKnowledgeRecord]);
  assert.equal(qa.ok, false);
  assert.ok(qa.errors.some((e) => e.includes('Gold 数据混入')));
});

test('QA：crosswalk unresolved 记为 warning（不阻止发布但可见）', () => {
  const r = makeRecord({ disease: { canonicalName: '未知病名' } });
  const qa = qaIngestion([r], { resolvedDiseaseNames: new Set(['女性生殖系统肿瘤-子宫肌瘤']) });
  assert.equal(qa.ok, true);
  assert.ok(qa.warnings.some((w) => w.includes('crosswalk unresolved')));
});

test('Manifest：统计 recordCount / differentialCount / duplicateGroups / unresolvedDiseaseNames', () => {
  const records = [
    makeRecord({ id: 'a', differential: [makeRecord().differential![0], makeRecord().differential![0]] }),
    makeRecord({ id: 'b' }),
  ];
  const manifest = buildIngestionManifest(records, {
    releaseVersion: '2026.09.xx-diagnostic-r1',
    sourceFiles: ['女性生殖系统肿瘤.txt'],
    resolvedDiseaseNames: new Set(['女性生殖系统肿瘤-子宫肌瘤']),
  });
  assert.equal(manifest.recordCount, 2);
  assert.equal(manifest.differentialCount, 3);
  assert.equal(manifest.diseaseCount, 1);
  assert.equal(manifest.duplicateGroups.length, 1);
  assert.equal(manifest.unresolvedDiseaseNames.length, 0);
});

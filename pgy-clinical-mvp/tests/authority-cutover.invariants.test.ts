import test from 'node:test';
import assert from 'node:assert/strict';
import type { CapabilityDescriptor } from '../src/contracts/capability.js';
import type { ObligationGraphV21 } from '../src/control-plane-v21/types.js';
import { createClinicalWorkspace } from '../src/platform/workspace/clinical-workspace.js';
import { projectGraphV21 } from '../src/platform/control-plane/artifact-bridge.js';
import { CommitLedger } from '../src/platform/commit/commit-ledger.js';

const capability: CapabilityDescriptor = {
  id: 'test.cap', version: '1', enabled: true, description: 'test', semanticDescription: 'test',
  provides: ['modality:test'], positiveExamples: [], negativeExamples: [], knowledgeScopes: [], skillIds: [], toolIds: [],
  deliveryObligations: [{ id: 'delivery', requiredArtifact: 'treatmentFormDecision', requiredFields: ['outcome', 'form'], materialization: 'REASONING_PRODUCT' }],
};

function graph(): ObligationGraphV21 {
  return {
    version: 2,
    issues: [],
    nodes: [
      {
        id: 'draft', source: 'request', required: true, dependsOn: [], status: 'OPEN', rootOutcomes: ['modality:test'],
        target: { type: 'artifact:treatment-draft', qualifiers: { outcome: 'modality:test' }, producerCapabilityId: 'test.cap' },
        allowedEffects: [{ op: 'commit', target: { type: 'artifact:treatment-draft', qualifiers: { outcome: 'modality:test' } } }],
      },
      {
        id: 'terminal', source: 'request', required: true, dependsOn: ['draft'], status: 'OPEN', rootOutcomes: ['modality:test'],
        target: { type: 'artifact:treatment-delivery', qualifiers: { outcome: 'modality:test' }, producerCapabilityId: 'test.cap' },
        allowedEffects: [{ op: 'commit', target: { type: 'artifact:treatment-delivery', qualifiers: { outcome: 'modality:test' } } }],
      },
    ],
  };
}

test('authority cutover: Workspace draft cannot close terminal delivery without CommitRecord', () => {
  const workspace = createClinicalWorkspace();
  workspace.capabilityDeliveryClosures = [{ capabilityId: 'test.cap', obligationId: 'delivery', status: 'DELIVERED', artifactRef: 'treatmentFormDecision' }];
  const ledger = new CommitLedger();
  const projected = projectGraphV21(graph(), workspace, [capability], ledger);
  assert.equal(projected.nodes.find((node) => node.id === 'draft')?.status, 'SATISFIED');
  assert.equal(projected.nodes.find((node) => node.id === 'terminal')?.status, 'OPEN');
});

test('authority cutover: exact matching CommitRecord closes terminal delivery', () => {
  const workspace = createClinicalWorkspace();
  workspace.capabilityDeliveryClosures = [{ capabilityId: 'test.cap', obligationId: 'delivery', status: 'DELIVERED', artifactRef: 'treatmentFormDecision' }];
  const ledger = new CommitLedger();
  ledger.append({
    outcome: 'modality:test', semanticIdentity: 'modality:test', providerId: 'test.cap', deliveryStatus: 'DELIVERED',
    executionClearance: 'CLEARED', provenance: { kind: 'MODEL_DERIVED', sourceRefs: [], providerId: 'test.cap' }, product: { form: 'x' },
  });
  const projected = projectGraphV21(graph(), workspace, [capability], ledger);
  assert.equal(projected.nodes.find((node) => node.id === 'terminal')?.status, 'SATISFIED');
});

test('authority cutover: wrong semantic outcome cannot satisfy exact delivery', () => {
  const workspace = createClinicalWorkspace();
  workspace.capabilityDeliveryClosures = [{ capabilityId: 'test.cap', obligationId: 'delivery', status: 'DELIVERED', artifactRef: 'treatmentFormDecision' }];
  const ledger = new CommitLedger();
  ledger.append({
    outcome: 'modality:other', semanticIdentity: 'modality:other', providerId: 'test.cap', deliveryStatus: 'DELIVERED',
    executionClearance: 'CLEARED', provenance: { kind: 'MODEL_DERIVED', sourceRefs: [], providerId: 'test.cap' }, product: { form: 'x' },
  });
  const projected = projectGraphV21(graph(), workspace, [capability], ledger);
  assert.equal(projected.nodes.find((node) => node.id === 'terminal')?.status, 'OPEN');
});

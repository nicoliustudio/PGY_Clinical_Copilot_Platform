import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityRegistry } from '../src/platform/registry/capability-registry.js';
import { baseUnderstanding, buildTestRuntime, clinicalProposal } from './helpers.js';

test('新增 Capability 是数据注册，不是核心分支', () => {
  const registry = new CapabilityRegistry();
  registry.register({
    id: 'demo.specialty',
    version: '0.1.0',
    description: 'demo',
    semanticDescription: 'demo',
    provides: ['demo_need'],
    positiveExamples: [],
    negativeExamples: [],
    knowledgeScopes: ['demo.scope'],
    skillIds: [],
    toolIds: [],
  });

  assert.deepEqual(registry.require('demo.specialty').knowledgeScopes, ['demo.scope']);
});

test('新 Capability 无需修改 Core Runtime 即可被 Harness 动态激活', async () => {
  const runtime = await buildTestRuntime({
    extraCapabilities: [
      {
        id: 'demo.specialty',
        version: '0.1.0',
        enabled: true,
        description: 'demo capability',
        semanticDescription: 'demo semantic description',
        provides: ['demo_need'],
        positiveExamples: [],
        negativeExamples: [],
        knowledgeScopes: ['demo.scope'],
        skillIds: [],
        toolIds: [],
      },
    ],
    understand: () => baseUnderstanding('clinical'),
    propose: (context) => {
      const discoverable = context.harness.listCapabilities();
      assert.ok(discoverable.some((c) => c.id === 'demo.specialty'));
      context.harness.activateCapability('demo.specialty', 'agent chose it from descriptor');
      return { ...clinicalProposal(), missing_information: context.capabilities.map((c) => c.id) };
    },
  });

  const { authority } = await runtime.run('demo input');
  if (authority.proposal.mode !== 'clinical') throw new Error('expected clinical');
  assert.ok(authority.proposal.missing_information.includes('demo.specialty'));
});

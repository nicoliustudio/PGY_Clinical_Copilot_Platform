import type { CapabilityNeed } from '../clinical/understanding.js';
import { capabilityRegistry } from './registry.js';
import type { CapabilityDescriptor } from './types.js';

/**
 * Capability Resolver —— 消费统一 Understanding 的 capabilityNeeds，
 * 在注册表中查找匹配的 Capability。注册表查找是数据驱动，不写业务 if。
 */
export function resolveCapabilities(
  capabilityNeeds: CapabilityNeed[],
): CapabilityDescriptor[] {
  const activated: CapabilityDescriptor[] = [];
  for (const need of capabilityNeeds) {
    const descriptor = capabilityRegistry.find((d) => d.id === need.capability);
    if (descriptor && !activated.includes(descriptor)) {
      activated.push(descriptor);
    }
  }
  return activated;
}

/** 汇总激活 Capability 的知识 scopes（默认含 general） */
export function resolveKnowledgeScopes(
  capabilityNeeds: CapabilityNeed[],
): string[] {
  const scopes = new Set<string>(['general']);
  for (const d of resolveCapabilities(capabilityNeeds)) {
    for (const s of d.knowledgeScopes) scopes.add(s);
  }
  return [...scopes];
}

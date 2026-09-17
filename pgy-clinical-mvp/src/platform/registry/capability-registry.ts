import type { CapabilityDescriptor } from '../../contracts/capability.js';
import { GenericRegistry } from './generic-registry.js';

export class CapabilityRegistry extends GenericRegistry<CapabilityDescriptor> {
  enabled(): CapabilityDescriptor[] {
    return this.list().filter((item) => item.enabled !== false);
  }
}

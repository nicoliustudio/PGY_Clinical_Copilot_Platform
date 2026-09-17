import type { RuntimeToolDescriptor } from '../../contracts/tool.js';
import { GenericRegistry } from './generic-registry.js';

export class ToolRegistry extends GenericRegistry<RuntimeToolDescriptor> {}

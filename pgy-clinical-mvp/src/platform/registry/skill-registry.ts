import type { SkillDescriptor } from '../../contracts/skill.js';
import { GenericRegistry } from './generic-registry.js';

export class SkillRegistry extends GenericRegistry<SkillDescriptor> {}

/** Skill = 方法/推理指引，不是 Authority、不是硬编码答案。 */
export interface SkillDescriptor {
  id: string;
  version: string;
  description: string;
  /** SKILL.md 内容，仅在对应 Capability 激活时注入 */
  instruction: string;
  /** 附带的 prompt 片段（如 skills/<id>/prompts/*.md），随 instruction 一起注入 */
  promptSections: string[];
}

export interface ResolvedSkill extends SkillDescriptor {
  activatedBy: string[];
}

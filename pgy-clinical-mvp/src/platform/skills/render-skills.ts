import type { ResolvedSkill } from '../../contracts/skill.js';

/** 纯函数：把激活的 Skill（instruction + promptSections）渲染为模型上下文片段。 */
export function renderActiveSkills(skills: ResolvedSkill[]): string {
  return skills.map((skill) => {
    const parts = [skill.instruction, ...skill.promptSections].filter((p) => p.trim().length > 0);
    return `### Skill: ${skill.id} (v${skill.version})\n${parts.join('\n\n')}`;
  }).join('\n\n');
}

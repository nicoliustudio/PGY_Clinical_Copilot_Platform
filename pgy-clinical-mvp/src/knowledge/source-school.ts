import type { SourceSchool } from './types.js';

/**
 * 来源流派归类（provenance 元数据，不是临床规则）。
 * 这里用声明式映射表把知识资产的 source 字符串归为固定流派，落在知识层（数据侧），
 * 不进入 Core 的业务分支。
 */
const SCHOOL_RULES: { pattern: RegExp; school: SourceSchool }[] = [
  { pattern: /沈仲理|沈氏/, school: 'shen_zhongli' },
  { pattern: /手册|规范|标准|国标|指南/, school: 'national_standard' },
  { pattern: /经典|经方|伤寒|金匮|素问|灵枢|本经/, school: 'classical' },
];

export function classifySourceSchool(source: string): SourceSchool {
  const s = source.trim();
  for (const { pattern, school } of SCHOOL_RULES) {
    if (pattern.test(s)) return school;
  }
  return 'general_tcm';
}

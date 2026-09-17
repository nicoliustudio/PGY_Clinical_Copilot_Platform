import type { ClinicalUnderstanding } from './understanding.js';
import type { ResolvedCapability } from './capability.js';
import type { ResolvedSkill } from './skill.js';
import type { RuntimeToolDescriptor } from './tool.js';

/** 封闭世界安全决策：由语义理解派生的确定性状态，不由关键词推断。 */
export interface SafetyDecision {
  status: 'PASS' | 'CAUTION' | 'BLOCK';
  reasons: string[];
  blockNormativeCommit: boolean;
}

export interface ModelProfile {
  id: string;
  provider?: string;
  model?: string;
}

/**
 * 最小版 ClinicalRunSnapshot —— 描述「本次 Run 实际用了什么」。
 * 与 EffectiveRuntimeRelease（可用的全部）区分：这里只记录被本次 Run 实际解析/装配的部分。
 */
export interface RuntimeSnapshot {
  modelProfileId: string;
  promptHash?: string;
  capabilities: string[];
  skills: string[];
  knowledgeScopes: string[];
}

export interface TraceContext {
  runId: string;
  startedAt: string;
  tags?: Record<string, string>;
}

/**
 * RuntimeContext —— Runtime Plane 的核心装配对象。
 * Primary Agent 消费已装配好的世界，不自行重新组装/发现业务。
 */
export interface RuntimeContext {
  runId: string;
  input: string;
  understanding: ClinicalUnderstanding;
  capabilities: ResolvedCapability[];
  skills: ResolvedSkill[];
  knowledgeScopes: string[];
  tools: RuntimeToolDescriptor[];
  safety: SafetyDecision;
  model: ModelProfile;
  trace: TraceContext;
}

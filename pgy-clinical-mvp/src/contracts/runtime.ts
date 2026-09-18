import type { ClinicalUnderstanding } from './understanding.js';
import type { ResolvedCapability } from './capability.js';
import type { ResolvedSkill } from './skill.js';
import type { RuntimeToolDescriptor } from './tool.js';
import type { HarnessControlPort } from './harness.js';
import type { ClinicalWorkspace, WorkspaceControlPort } from './workspace.js';

/** Closed-world runtime disposition. Severity is semantic evidence; disposition controls authority. */
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

export interface SkillVersion {
  id: string;
  version: string;
}

export interface RuntimeSnapshot {
  modelProfileId: string;
  promptHash?: string;
  capabilities: string[];
  skills: string[];
  activeSkills: string[];
  skillVersions: SkillVersion[];
  skillPromptSections: string[];
  knowledgeScopes: string[];
}

export interface TraceContext {
  runId: string;
  startedAt: string;
  tags?: Record<string, string>;
}

/**
 * RuntimeContext is a per-run mutable harness session.
 * The agent owns the path; Authority remains outside this context.
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
  harness: HarnessControlPort;
  workspace: ClinicalWorkspace;
  workspaceStore: WorkspaceControlPort;
}

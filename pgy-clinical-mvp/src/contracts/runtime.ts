import type { ClinicalUnderstanding } from './understanding.js';
import type { CapabilityDescriptor, ResolvedCapability } from './capability.js';
import type { ResolvedSkill } from './skill.js';
import type { RuntimeToolDescriptor } from './tool.js';
import type { HarnessControlPort } from './harness.js';
import type { ClinicalWorkspace, WorkspaceControlPort } from './workspace.js';
import type { ClinicalStrategy } from './clinical-strategy.js';
import type { ClinicalRequestIR } from '../control-plane-v2/types.js';
import type { DurableArtifactEnvelopeV21, ObligationGraphV21, TypedBlockerV21, ControlPlanePolicyV21 } from '../control-plane-v21/types.js';
import type { CommitLedger } from '../platform/commit/commit-ledger.js';

/**
 * V2.1 runtime 拥有的 typed blocker（模型无写入通道）。
 * evidenceVersion 记录施加时的证据体量，用于判断「定向取证是否真的带来了新证据」。
 */
export interface AppliedBlockerV21 {
  obligationId: string;
  blocker: TypedBlockerV21;
  evidenceVersion: number;
}

/** Request IR 编译结果。FAILED 表示本次 run 无法建立闭世界执行契约。 */
export type RequestCompileStatusV21 = 'COMPILED' | 'FAILED';

/** Closed-world runtime disposition. Severity is semantic evidence; disposition controls authority. */
export interface SafetyDecision {
  status: 'PASS' | 'CAUTION' | 'BLOCK';
  reasons: string[];
  /** H15.4：确定性 clinician review requirement（非 Agent 决定，由 structured risk attributes 导出）。 */
  reviewRequired: boolean;
  reviewReasons: string[];
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
  /** 临床总策划状态：本次 run 的 reasoning mission（observable planning state，非 CoT）。 */
  strategy: ClinicalStrategy;
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
  /** Kernel Commit Boundary：本次 run 的唯一权威交付真相（Kernel-owned append-only ledger）。 */
  commitLedger: CommitLedger;
  /** V2.1 shadow/cutover state. Uses the same Request IR with parameterized planning semantics. */
  controlPlaneV21?: {
    /** Immutable user-compiled request. Contract expansion is recorded separately in adoptedOutcomes. */
    requestIR: ClinicalRequestIR;
    /** Kernel-owned append-only contract extensions created only by delivery.adopt. */
    adoptedOutcomes: string[];
    graph: ObligationGraphV21;
    durableArtifacts: DurableArtifactEnvelopeV21[];
    /** Request IR 是否成功编译；FAILED 时 V2.1 不接管 action surface（退化为纯观测）。 */
    compileStatus: RequestCompileStatusV21;
    compileError?: string;
    /** Runtime 施加的 typed blocker（唯一允许重新打开定向检索的通道）。 */
    appliedBlockers: AppliedBlockerV21[];
    /**
     * 本次 run 的 enabled capability descriptors（planner 的闭世界 provider 集合）。
     * 图由此 + Request IR + durable state 确定性推导；capability 激活只影响知识 scope/skill，
     * 不再决定义务拓扑（否则 activation 会成为第二个控制平面）。
     */
    capabilityDescriptors: CapabilityDescriptor[];
    /** 本次 run 生效的 composition policy（baseline outcome 等；planner 不认识具体业务名称）。 */
    policy: ControlPlanePolicyV21;
    /**
     * V2.1.2 Deterministic Semantic Validator 结果（mention → EXACT/ALIAS/SUBTYPE/FAMILY/UNKNOWN）。
     * 只用于审计与 telemetry：IR 本身已被校验器修正（家族顶替项已 fail-closed 到 unresolved）。
     */
    semanticValidation?: {
      resolutions: Array<{ mention: string; relation: string; term?: string }>;
      rejected: Array<{ term: string; mention: string; relation: string }>;
      /** V2.1.3：PREFERRED 且不可表示 → 非阻断 shortfall（显式报告，不产生义务）。 */
      preferredShortfalls: string[];
    };
  };
}

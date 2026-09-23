import { randomUUID } from 'node:crypto';
import type { ClinicalPlannerPort, ClinicalUnderstandingPort, RuntimePreparationPort, SafetyPort } from '../../contracts/ports.js';
import type { ModelProfile, RequestCompileStatusV21, AppliedBlockerV21, RuntimeContext } from '../../contracts/runtime.js';
import type { ResolvedSkill } from '../../contracts/skill.js';
import type { ModelPort } from '../../ports/model.js';
import type { ClinicalRequestIR } from '../../control-plane-v2/types.js';
import type { ControlPlanePolicyV21 } from '../../control-plane-v21/types.js';
import { compileClinicalRequest, defaultClinicalRequestIR } from '../../control-plane-v2/request-ir.js';
import { validateRequestSemantics } from '../../control-plane-v2/semantic-validator.js';
import { CapabilityRegistry } from '../registry/capability-registry.js';
import { SkillRegistry } from '../registry/skill-registry.js';
import { ToolRegistry } from '../registry/tool-registry.js';
import { HarnessSession } from './harness-session.js';
import { ClinicalWorkspaceStore, createClinicalWorkspace } from '../workspace/clinical-workspace.js';
import { deriveGraphV21 } from '../control-plane/control-plane-v21-session.js';

export interface RuntimePreparerDependencies {
  understanding: ClinicalUnderstandingPort;
  safety: SafetyPort;
  planner: ClinicalPlannerPort;
  capabilities: CapabilityRegistry;
  skills: SkillRegistry;
  tools: ToolRegistry;
  model: ModelProfile;
  baselineToolIds: string[];
  baselineSkillIds: string[];
  baselineKnowledgeScopes: string[];
  /**
   * Control Plane V2.1（Phase 2）：用户表达 → Request IR 的**一次性**编译。
   * 未配置时 V2.1 保持休眠（不产生第二种调度语义）；配置后由 V2.1 承担调度主权。
   */
  controlPlane?: {
    compiler: ModelPort;
    policy: ControlPlanePolicyV21;
  };
}

/**
 * H1 Harness bootstrap. Under Control Plane V2.1.1, provider capabilities selected by the
 * closed-world obligation graph are deterministically activated by the Harness; the model no
 * longer spends reasoning steps rediscovering providers the resolver already selected.
 */
export class RuntimePreparer implements RuntimePreparationPort {
  constructor(private readonly deps: RuntimePreparerDependencies) {}

  async prepare(input: string, runId: string = randomUUID()): Promise<RuntimeContext> {
    const understanding = await this.deps.understanding.understand(input);
    const safety = await this.deps.safety.evaluate(understanding);
    const strategy = await this.deps.planner.plan({
      input,
      understanding,
      safety,
      availableCapabilities: this.deps.capabilities.enabled().map((c) => ({
        id: c.id,
        semanticDescription: c.semanticDescription,
      })),
    });
    const skills: ResolvedSkill[] = this.deps.baselineSkillIds.map((id) => ({
      ...this.deps.skills.require(id),
      activatedBy: ['harness.baseline'],
    }));

    const workspace = createClinicalWorkspace();
    const workspaceStore = new ClinicalWorkspaceStore(workspace, runId);
    workspace.facts = [...understanding.facts];
    workspace.caseFacts = understanding.facts.map((f, i) => ({
      id: `CF_${String(i + 1).padStart(3, '0')}`,
      kind: f.kind,
      value: f.value,
      source: f.source,
      evidenceKind: 'patient',
      temporalRole: f.temporalRole,
      polarity: f.polarity,
    }));
    workspace.informationGaps = understanding.informationGaps.map((g) => g.question);
    workspace.uncertainties = understanding.uncertainties.map((u) => u.item);
    workspace.safetyDisposition =
      safety.status === 'BLOCK' ? 'urgent' : safety.status === 'CAUTION' ? 'uncertain' : 'routine';
    // H15：Clinical Decision Spine 的 clinical question 从规划层初始化为当前临床判断。
    workspace.clinicalDecisionSpine.clinicalQuestion = { statement: strategy.decisionQuestion ?? '', version: 0 };
    workspaceStore.append('workspace.seeded', { input });

    const context: RuntimeContext = {
      runId,
      input,
      understanding,
      strategy,
      capabilities: [],
      skills,
      knowledgeScopes: [...new Set(this.deps.baselineKnowledgeScopes)],
      tools: this.deps.baselineToolIds.map((id) => this.deps.tools.require(id)),
      safety,
      model: this.deps.model,
      trace: { runId, startedAt: new Date().toISOString() },
      harness: undefined as unknown as RuntimeContext['harness'],
      workspace,
      workspaceStore,
    };

    context.harness = new HarnessSession(
      context,
      this.deps.capabilities,
      this.deps.skills,
      this.deps.tools,
    );

    // Phase 2：用户表达一次性编译为 Request IR（Runtime 不再反复 regex 用户句子）。
    if (this.deps.controlPlane) {
      const capabilityDescriptors = this.deps.capabilities.enabled();
      let requestIR: ClinicalRequestIR = defaultClinicalRequestIR();
      let compileStatus: RequestCompileStatusV21 = 'FAILED';
      let compileError: string | undefined;
      let semanticValidation: ReturnType<typeof validateRequestSemantics> | undefined;
      try {
        // Request IR 的 outcome 词汇表由 registry 提供，但只取**语义命名空间**（modality:/outcome:）。
        // 这不是业务枚举：新增治疗形式只要在 manifest 里声明 modality:* / outcome:* 即自动进入。
        // 收窄命名空间可避免把 capability 的内部 key 误当成 outcome。
        const semanticTypes = [...new Set(capabilityDescriptors.flatMap((c) => c.provides))]
          .filter((value) => value.startsWith('modality:') || value.startsWith('outcome:'))
          .sort();
        requestIR = await compileClinicalRequest(
          { input, understanding, availableSemanticTypes: semanticTypes },
          this.deps.controlPlane.compiler,
        );
        // V2.1.2：Request IR 建立后立即做确定性语义校验。
        // 家族关系不构成 exact satisfaction —— 被更宽家族项顶替的指名形式 fail-closed 到 unresolved。
        semanticValidation = validateRequestSemantics(
          requestIR,
          capabilityDescriptors,
          this.deps.controlPlane.policy.baselineOutcomes,
        );
        requestIR = semanticValidation.ir;
        compileStatus = 'COMPILED';
      } catch (error) {
        compileError = error instanceof Error ? error.message : String(error);
      }
      const appliedBlockers: AppliedBlockerV21[] = [];
      const graph = deriveGraphV21(requestIR, capabilityDescriptors, workspace, appliedBlockers, this.deps.controlPlane.policy);
      context.controlPlaneV21 = {
        requestIR,
        graph,
        durableArtifacts: [],
        compileStatus,
        ...(compileError ? { compileError } : {}),
        appliedBlockers,
        capabilityDescriptors,
        policy: this.deps.controlPlane.policy,
        ...(semanticValidation ? {
          semanticValidation: {
            resolutions: semanticValidation.resolutions,
            rejected: semanticValidation.rejected,
            preferredShortfalls: semanticValidation.preferredShortfalls,
          },
        } : {}),
      };
      if (compileStatus === 'COMPILED') {
        const providerIds = [...new Set(graph.nodes
          .map((node) => node.provider?.capabilityId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0))];
        for (const id of providerIds) {
          context.harness.activateCapability(id, 'control-plane-v21:resolved-provider');
        }
      }
    }
    return context;
  }
}

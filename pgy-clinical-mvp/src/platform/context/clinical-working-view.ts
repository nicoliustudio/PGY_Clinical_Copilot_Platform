import type { ClinicalStrategy, StoppingCriteria } from '../../contracts/clinical-strategy.js';
import type { ClinicalWorkspace } from '../../contracts/workspace.js';

/**
 * ClinicalWorkingView —— Agent 每一步默认看到的「目标驱动工作上下文」。
 * 只做结构化压缩与投影，不引入任何医学 relevance 判断。
 * 完整数据继续保存在 Workspace / Trace，此处只提供 current attention。
 */

export interface WorkingHypothesis {
  id: string;
  label: string;
  status: string;
  supporting: string[];
  contradicting: string[];
  unknown: string[];
}

export interface WorkingEvidence {
  id: string;
  sourceRef: string;
  sourceType: string;
  title?: string;
  summary?: string;
}

export interface WorkingCandidate {
  id: string;
  name?: string;
  composition?: string[];
  sourceId?: string;
}

export interface RecentAction {
  toolName: string;
  summary: string;
}

export interface ClinicalWorkingView {
  goal: string;
  primaryQuestion: string;
  secondaryQuestions: string[];
  activeQuestions: string[];
  stoppingCriteria: StoppingCriteria;
  importantFacts: string[];
  activeHypotheses: WorkingHypothesis[];
  discriminatingEvidence: WorkingEvidence[];
  focusedCandidates: WorkingCandidate[];
  openQuestions: string[];
  uncertainty: string[];
  recentUsefulActions: string[];
}

function factToLine(f: unknown): string {
  if (typeof f === 'string') return f;
  if (f && typeof f === 'object') {
    const o = f as { kind?: string; value?: string };
    return o.value ? `${o.kind ?? 'fact'}：${o.value}` : (o.kind ?? 'fact');
  }
  return String(f);
}

export function buildClinicalWorkingView(
  workspace: ClinicalWorkspace,
  strategy: ClinicalStrategy,
  recentActions: RecentAction[] = [],
): ClinicalWorkingView {
  const importantFacts = (workspace.facts ?? []).map(factToLine);

  const activeHypotheses = (workspace.hypothesisState?.hypotheses ?? [])
    .filter((h) => h.status !== 'rejected')
    .map((h) => ({
      id: h.id,
      label: h.label,
      status: h.status,
      supporting: h.supportingEvidenceRefs ?? [],
      contradicting: h.contradictingEvidenceRefs ?? [],
      unknown: h.missingEvidence ?? [],
    }));

  const discriminatingEvidence = (workspace.evidenceState?.evidenceItems ?? []).map((e) => ({
    id: e.id,
    sourceRef: e.sourceRef,
    sourceType: e.sourceType,
    title: e.title,
    summary: e.summary,
  }));

  const frontier = workspace.deliberationState?.frontier ?? [];
  const focusedCandidates = frontier
    .map((ref) => workspace.candidates.find((c) => c.id === ref && c.kind === 'formula'))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map((c) => ({ id: c.id, name: c.name, composition: c.composition, sourceId: c.sourceId }));

  const openQuestions = [
    ...(strategy.activeQuestions ?? []),
    ...(strategy.evidenceNeeds ?? []).map((n) => n.question),
    ...(workspace.informationGaps ?? []),
  ];

  const uncertainty = [
    ...(strategy.uncertainty ?? []).map((u) => (u.reason ? `${u.item}（${u.reason}）` : u.item)),
    ...(workspace.uncertainties ?? []),
  ];

  return {
    goal: strategy.goal ?? '',
    primaryQuestion: strategy.primaryQuestion ?? '',
    secondaryQuestions: strategy.secondaryQuestions ?? [],
    activeQuestions: strategy.activeQuestions ?? [],
    stoppingCriteria: strategy.stoppingCriteria ?? { readyWhen: [], stopSignals: [] },
    importantFacts,
    activeHypotheses,
    discriminatingEvidence,
    focusedCandidates,
    openQuestions,
    uncertainty,
    recentUsefulActions: recentActions.map((a) => `${a.toolName}: ${a.summary}`),
  };
}

function renderHypotheses(hs: WorkingHypothesis[]): string {
  if (!hs.length) return '（无）';
  return hs
    .map((h) => {
      const lines = [`- ${h.label} [${h.status}]`];
      if (h.supporting.length) lines.push(`    支持: ${h.supporting.join('、')}`);
      if (h.contradicting.length) lines.push(`    反证: ${h.contradicting.join('、')}`);
      if (h.unknown.length) lines.push(`    未知: ${h.unknown.join('、')}`);
      return lines.join('\n');
    })
    .join('\n');
}

function renderEvidence(es: WorkingEvidence[]): string {
  if (!es.length) return '（无）';
  return es
    .map((e) => `- [${e.sourceRef}] ${e.title ?? ''}${e.summary ? ` — ${e.summary.slice(0, 400)}` : ''}`)
    .join('\n');
}

/** 将 WorkingView 渲染为 Agent 上下文片段。 */
export function renderClinicalWorkingView(view: ClinicalWorkingView): string {
  const block = (title: string, body: string) => `## ${title}\n${body}`;
  const list = (items: string[]) => (items.length ? items.map((x) => `- ${x}`).join('\n') : '（无）');

  const sections = [
    block('Goal', view.goal || '（未定义）'),
    block('Primary Question', view.primaryQuestion || '（未定义）'),
  ];
  if (view.secondaryQuestions.length) {
    sections.push(block('Secondary Questions', list(view.secondaryQuestions)));
  }
  sections.push(
    block('Important Facts', list(view.importantFacts)),
    block('Active Hypotheses', renderHypotheses(view.activeHypotheses)),
    block('Discriminating Evidence', renderEvidence(view.discriminatingEvidence)),
    block(
      'Focused Candidates',
      view.focusedCandidates.length
        ? view.focusedCandidates
            .map((c) => `- ${c.name ?? c.id}${c.composition?.length ? `（${c.composition.join('、')}）` : ''}${c.sourceId ? ` [${c.sourceId}]` : ''}`)
            .join('\n')
        : '（无）',
    ),
    block('Open Questions', list(view.openQuestions)),
    block('Uncertainty', list(view.uncertainty)),
    block('Recent Useful Actions', list(view.recentUsefulActions)),
    block(
      'Stopping Criteria',
      `readyWhen: ${view.stoppingCriteria.readyWhen.join('; ') || '—'}\nstopSignals: ${view.stoppingCriteria.stopSignals.join('; ') || '—'}`,
    ),
  );

  return sections.join('\n\n');
}

/** 粗略 token 估算：CJK 按 1 token/字，其余按 4 字符/token。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}

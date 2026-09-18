import type {
  CandidateComparisonRow,
  ClinicalWorkspace,
  ComparisonMatrix,
} from '../../contracts/workspace.js';

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * Candidate Comparison Matrix: 只并列展示进入 Deliberation Frontier 的 candidate。
 * presented 候选（仅「搜索发现过」）不进入比较矩阵，避免对所有 search results 施加 assessment obligation。
 */
export function buildComparisonMatrix(workspace: ClinicalWorkspace): ComparisonMatrix {
  const rows: CandidateComparisonRow[] = [];
  for (const candidateRef of workspace.deliberationState.frontier) {
    const candidate = workspace.candidates.find((c) => c.id === candidateRef && c.kind === 'formula');
    if (!candidate) continue;
    const assessments = workspace.deliberationState.assessments.filter((a) => a.candidateRef === candidate.id);
    const coverage = workspace.deliberationState.coverage.find((c) => c.candidateRef === candidate.id);

    const hypothesisRefs = dedupe([
      ...(candidate.originatingHypothesisRefs ?? []),
      ...assessments.map((a) => a.hypothesisRef),
    ]);

    rows.push({
      candidateRef: candidate.id,
      hypothesisRefs,
      assessmentStatus: coverage?.assessmentStatus ?? (assessments.length > 0 ? 'assessed' : 'not_assessed'),
      supportingEvidenceRefs: dedupe(assessments.flatMap((a) => a.supportingEvidenceRefs)),
      contradictingEvidenceRefs: dedupe(assessments.flatMap((a) => a.contradictingEvidenceRefs)),
      unresolvedQuestions: dedupe(assessments.flatMap((a) => a.unresolvedQuestions)),
      assessmentSummaries: assessments.map((a) => a.assessmentSummary),
    });
  }
  return { rows };
}

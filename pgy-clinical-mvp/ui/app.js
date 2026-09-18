'use strict';

/* ============================================================
 * 蒲公英中医 Clinical Copilot 前端
 * 用户端：ChatGPT 极简对话 + 语音流式输入 + 可展开工作台 + Trace
 * 管理员端：系统健康 / 运行 Trace / Eval 模式
 * 原则：只消费后端稳定 DTO，不 import runtime 内部对象；
 *       只展示可观测状态，不暴露 hidden CoT。
 * ============================================================ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}

async function api(path, opt = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opt });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

/* ---------- 全局状态 ---------- */
const state = {
  view: 'user',
  sessions: [],           // 本地会话（用户端历史）
  activeSession: null,    // 当前展示的 SessionView
  streaming: false,
  liveEvents: [],
  lifecycle: null,        // 收敛生命周期阶段
};

/* ---------- 视图切换 ---------- */
function switchView(view) {
  state.view = view;
  $('#userView').classList.toggle('hidden', view !== 'user');
  $('#adminView').classList.toggle('hidden', view !== 'admin');
  if (view === 'admin') refreshAdmin();
}

$('#viewToggle').addEventListener('click', () => switchView('admin'));
$('#viewToggleBack').addEventListener('click', () => switchView('user'));

const EMPTY_STATE_HTML = `<div class="empty-state" id="emptyState">
  <div class="empty-logo">蒲</div>
  <h2>中医临床 Copilot</h2>
  <p>粘贴病例，Agent 自主辨证、检索证据、比较候选方，再由 Authority Kernel 校验。右侧可展开完整推理过程，不隐藏、不黑箱。</p>
</div>`;
function clearEmpty() { const es = $('#emptyState'); if (es) es.remove(); }

/* ---------- 会话列表 ---------- */
function renderSessions() {
  const list = $('#sessionList');
  if (state.sessions.length === 0) {
    list.innerHTML = '<div class="wp-empty">暂无历史会话</div>';
    return;
  }
  list.innerHTML = state.sessions.map((s, i) =>
    `<div class="session-item" data-i="${i}">${esc(s.title || '问诊')}</div>`
  ).join('');
}
function addSession(title, session) {
  state.sessions.unshift({ title, session, runId: session?.runId });
  if (state.sessions.length > 50) state.sessions.pop();
  renderSessions();
}
$('#sessionList').addEventListener('click', (e) => {
  const item = e.target.closest('.session-item');
  if (!item) return;
  const s = state.sessions[Number(item.dataset.i)];
  if (s?.session) {
    state.activeSession = s.session;
    renderChatFromSession(s.session);
    renderWorkspace(s.session.workspace);
    renderTrace(s.session);
  }
});
$('#newCase').addEventListener('click', () => {
  state.activeSession = null;
  $('#chat').innerHTML = EMPTY_STATE_HTML;
  $('#caseTitle').innerHTML = '<strong>新问诊</strong><span>输入病例开始临床推理</span>';
  renderWorkspace(null);
  renderTrace(null);
});

/* ---------- 聊天渲染 ---------- */
function appendUserMessage(text) {
  clearEmpty();
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = `<div class="user-bubble">${esc(text)}</div>`;
  $('#chat').appendChild(div);
  scrollChat();
}

function showThinking() {
  clearEmpty();
  const div = document.createElement('div');
  div.className = 'msg assistant thinking-msg';
  div.innerHTML = `
    <div class="bot-avatar">蒲</div>
    <div class="assistant-content">
      <div class="thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="thinking-text">正在理解病例…</span></div>
      <div class="live-activity"></div>
    </div>`;
  $('#chat').appendChild(div);
  scrollChat();
}

function toolCategory(name) {
  if (name === 'capability.discover' || name === 'capability.activate') return '发现能力';
  if (name === 'knowledge.search') return '检索临床证据';
  if (name === 'knowledge.get_source') return '核对来源';
  if (name === 'formula.search_normative') return '检索候选方';
  if (name === 'formula.validate') return '校验方剂出处';
  if (name === 'workspace.focus_candidates' || name === 'workspace.record_deliberation' || name === 'workspace.record_candidate_assessment' || name === 'workspace.record_candidate_exclusion') return '比较候选';
  if (name === 'proposal.submit') return '生成临床建议';
  return name;
}

/**
 * 默认折叠：相同类别连续工具调用合并为一行摘要，点击展开才显示真实 tool name / query / result / ms。
 * 开发者 Trace 始终保留完整原始调用。
 */
function renderLiveActivity() {
  const box = document.querySelector('.thinking-msg:last-child .live-activity');
  if (!box) return;
  const tools = state.liveEvents.filter((x) => x.type === 'tool').map((x) => x.data);
  const groups = [];
  for (const t of tools) {
    const cat = toolCategory(t.toolName);
    const last = groups[groups.length - 1];
    if (last && last.cat === cat) { last.count += 1; last.items.push(t); }
    else groups.push({ cat, count: 1, items: [t] });
  }
  box.innerHTML = groups.map((g, i) => {
    const label = g.count > 1 ? `${esc(g.cat)} × ${g.count}` : esc(g.cat);
    const raw = g.items.map((t) => `
      <div class="trace-tool">
        <div class="tool-name">${esc(t.toolName)}${t.reused ? ' <span class="muted">(reused)</span>' : ''}</div>
        <div class="tool-meta">${t.ms}ms${t.error ? ' · ' + esc(t.error) : ''}</div>
        <pre>${esc(JSON.stringify(t.input, null, 2))}</pre>
        ${t.output !== undefined ? `<pre>${esc(JSON.stringify(t.output, null, 2))}</pre>` : ''}
      </div>`).join('');
    return `<div class="live-group"><div class="live-group-head" data-live-group="${i}">${label}</div><div class="live-group-body hidden">${raw}</div></div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

function updateLiveActivity() {
  renderLiveActivity();
}

const LIFECYCLE_LABELS = {
  exploring: '正在检索证据…',
  reviewing: '正在比较候选…',
  finalizing: '正在收敛并生成建议…',
  completed: '完成',
  'no-commit': '未提交结论',
};

function renderLifecycle() {
  const stage = state.lifecycle || 'exploring';
  const label = LIFECYCLE_LABELS[stage] || stage;
  const title = $('#caseTitle');
  if (title) title.innerHTML = `<strong>临床推理中…</strong><span>${esc(label)}</span>`;
  const live = $('#liveStatus');
  if (live) live.textContent = label;
}

// 折叠组点击展开/收起（委托）
document.addEventListener('click', (e) => {
  const head = e.target.closest('.live-group-head');
  if (!head) return;
  const body = head.parentElement.querySelector('.live-group-body');
  if (body) body.classList.toggle('hidden');
});

function finishThinking(session) {
  const node = document.querySelector('.thinking-msg:last-child');
  if (node) node.remove();
  renderConclusion(session);
  renderWorkspace(session.workspace);
  renderTrace(session);
}

/**
 * 运行失败时不留黑箱：保留已发生的工具调用与工作区事件，并在其上追加失败原因。
 * 失败不隐藏过程——只标注没有得到可提交的结论。
 */
function failThinking(message) {
  const node = document.querySelector('.thinking-msg:last-child');
  if (!node) {
    toast(message);
    return;
  }
  node.classList.remove('thinking-msg');
  const content = node.querySelector('.assistant-content');
  content.querySelector('.thinking')?.remove();

  const block = document.createElement('div');
  block.className = 'assistant-block error-block';
  block.innerHTML = `<div class="answer-head"><h3>推理未完成</h3><span class="authority-badge BLOCKED">NO COMMIT</span></div><div class="plain-text">${esc(message)}</div><div class="error-hint">上方为本次运行已真实发生的工具调用；可在右上角 Trace 查看完整事件。</div>`;
  content.appendChild(block);
  renderLiveTrace(message);
  scrollChat();
}

function renderChatFromSession(session) {
  $('#chat').innerHTML = '';
  appendUserMessage(session.trace.input);
  renderConclusion(session);
  $('#caseTitle').innerHTML = `<strong>问诊</strong><span>${esc(session.runId)} · ${esc(session.model)}</span>`;
}

function renderConclusion(session) {
  const r = session.result;
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.innerHTML = `<div class="bot-avatar">蒲</div><div class="assistant-content">${renderResult(r, session.authority)}</div>`;
  $('#chat').appendChild(div);
  scrollChat();
  updateSafety(r);
}

function renderResult(r, authority) {
  if (r.mode === 'clinical') return renderClinical(r, authority);
  if (r.mode === 'conversation') return `<div class="assistant-block"><div class="plain-text">${esc(r.message)}</div></div>`;
  if (r.mode === 'clarification') {
    return `<div class="assistant-block"><div class="plain-text">${(r.questions || []).map((q) => `<div>· ${esc(q)}</div>`).join('')}</div></div>`;
  }
  if (r.mode === 'urgent') {
    const risks = (r.risks || []).map((rk) => `<div class="risk-item"><strong>${esc(rk.severity)}</strong> · ${esc(rk.description)}</div>`).join('');
    return `<div class="assistant-block"><div class="answer-head"><h3>安全提示</h3></div><div class="plain-text">${esc(r.message)}</div><div class="risk-list">${risks}</div></div>`;
  }
  return `<div class="assistant-block"><div class="plain-text">${esc(JSON.stringify(r))}</div></div>`;
}

function renderClinical(r, authority) {
  const authorityState = r.formula?.authority || '';
  const badge = authorityState ? `<span class="authority-badge ${esc(authorityState)}">${esc(authorityState)}</span>` : '';
  const herbs = (r.formula?.composition || []).map((h) => `<span class="herb-pill">${esc(h)}</span>`).join('');
  const missing = (r.missing_information || []).map((m) => `<li>${esc(m)}</li>`).join('');
  const ev = (refs) => (refs || []).map((x) => `<span class="ev-refs">${esc(x)}</span>`).join('');
  return `
    <div class="assistant-block">
      <div class="answer-head"><h3>临床判断</h3>${badge}</div>
      <div class="clinical-line"><span class="k">病名</span><span class="v">${esc(r.disease?.name)}<span class="confidence">${(r.disease?.confidence ?? '').toFixed ? (r.disease.confidence * 100).toFixed(0) + '%' : ''}</span>${ev(r.disease?.evidence_refs)}</span></div>
      <div class="clinical-line"><span class="k">辨证</span><span class="v">${esc(r.syndrome?.name)}<span class="confidence">${r.syndrome?.confidence != null ? (r.syndrome.confidence * 100).toFixed(0) + '%' : ''}</span>${ev(r.syndrome?.evidence_refs)}</span></div>
      <div class="clinical-line"><span class="k">治法</span><span class="v">${esc(r.treatment?.text)}${ev(r.treatment?.evidence_refs)}</span></div>
      <div class="clinical-line formula"><span class="k">方剂</span><span class="v">${esc(r.formula?.name)}${r.formula?.source_id ? ` <span class="ev-refs">${esc(r.formula.source_id)}</span>` : ''}<div class="herb-list">${herbs}</div></span></div>
      ${missing ? `<div class="missing-info"><strong>尚缺信息</strong><ul>${missing}</ul></div>` : ''}
    </div>`;
}

function updateSafety(r) {
  const chip = $('#safetyState');
  if (r.mode === 'clinical' && r.safety?.status) {
    const status = r.safety.status;
    chip.className = `safety-chip ${status === 'PASS' ? 'routine' : 'urgent'}`;
    chip.textContent = status === 'PASS' ? '安全 · 常规' : '安全 · 需复核';
  } else if (r.mode === 'urgent') {
    chip.className = 'safety-chip urgent';
    chip.textContent = '安全 · 紧急';
  } else {
    chip.className = 'safety-chip';
    chip.textContent = '';
  }
}

function scrollChat() {
  const c = $('#chat');
  c.scrollTop = c.scrollHeight;
}

/* ---------- 工作台 ---------- */
$('#wpTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  $$('#wpTabs button').forEach((b) => b.classList.toggle('active', b === btn));
  renderWorkspace(state.activeSession?.workspace || null, btn.dataset.tab);
});
$('#wpBody').addEventListener('click', (e) => {
  const src = e.target.closest('[data-source]');
  if (src) openSource(src.dataset.source);
});

let currentWpTab = 'overview';

function renderWorkspace(ws, tab) {
  if (tab) currentWpTab = tab;
  const body = $('#wpBody');
  if (!ws) {
    body.innerHTML = '<div class="wp-empty">发送病例后，这里展示 Agent 的可观测推理状态。</div>';
    return;
  }
  const renderers = {
    overview: renderOverview,
    evidence: renderEvidence,
    hypotheses: renderHypotheses,
    candidates: renderCandidates,
    deliberation: renderDeliberation,
  };
  body.innerHTML = (renderers[currentWpTab] || renderOverview)(ws);
}

function renderStrategy(strategy) {
  if (!strategy || !strategy.goal) return '';
  const needs = (strategy.criticalEvidenceNeeds || []);
  const uncertainty = (strategy.uncertainty || []).map((u) => `${u.item}${u.reason ? '（' + u.reason + '）' : ''}`);
  const list = (items) => (items.length ? `<ul class="wp-list">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<span class="muted">—</span>');
  return `
    <div class="wp-section strategy">
      <div class="wp-section-title">当前目标</div><div class="wp-card">${esc(strategy.goal || '—')}</div>
      <div class="wp-section-title">当前关键判断</div><div class="wp-card">${esc(strategy.decisionQuestion || '—')}</div>
      <div class="wp-section-title">关键证据需求</div><div class="wp-card">${list(needs)}</div>
      <div class="wp-section-title">当前不确定性</div><div class="wp-card">${list(uncertainty)}</div>
    </div>`;
}

const SCHOOL_LABELS = {
  shen_zhongli: '沈仲理',
  national_standard: '国标',
  classical: '经典',
  general_tcm: '通用中医',
};

function renderHypothesisMap(ws) {
  const hs = (ws.hypotheses || []).filter((h) => h.status !== 'rejected');
  if (!hs.length) return '<div class="wp-empty">暂无假设</div>';
  return hs.map((h) => {
    const sup = (h.supportingEvidenceRefs || []).length;
    const con = (h.contradictingEvidenceRefs || []).length;
    const unk = (h.missingEvidence || []).length;
    return `
      <div class="wp-card">
        <div class="wp-card-title">${esc(h.label)}<span class="wp-tag ${esc(h.status)}">${esc(h.status)}</span></div>
        <div class="wp-inline"><span class="wp-tag sup">支持 ${sup}</span> <span class="wp-tag con">反证 ${con}</span> <span class="wp-tag unk">未知 ${unk}</span></div>
      </div>`;
  }).join('');
}

function renderFocusedCandidates(ws) {
  const frontier = new Set((ws.deliberation?.rows || []).map((r) => r.candidateRef));
  const focused = (ws.candidates || []).filter((c) => frontier.has(c.id));
  if (!focused.length) return '<div class="wp-empty">暂无聚焦候选</div>';
  return focused.map((c) => `
    <div class="wp-card">
      <div class="wp-card-title">${esc(c.name || c.id)}<span class="wp-tag ${esc(c.status)}">${esc(c.status)}</span></div>
      ${c.sourceId ? `<div class="muted">${esc(c.sourceId)}</div>` : ''}
    </div>`).join('');
}

function renderSourceSchools(ws) {
  const schools = new Set();
  for (const e of (ws.evidence || [])) {
    if (e.sourceSchool) schools.add(e.sourceSchool);
  }
  if (!schools.size) return '<span class="muted">—</span>';
  return [...schools].map((s) => `<span class="wp-tag school">${esc(SCHOOL_LABELS[s] || s)}</span>`).join(' ');
}

function renderOverview(ws) {
  const facts = (ws.facts || []).map((f) => {
    if (typeof f === 'string') return `<li>${esc(f)}</li>`;
    const k = f?.kind || 'fact';
    const v = f?.value || '';
    return `<li>${esc(k)}：${esc(v)}</li>`;
  }).join('');
  const gaps = (ws.informationGaps || []).map((g) => `<li>${esc(g)}</li>`).join('');
  const unc = (ws.uncertainties || []).map((u) => `<li>${esc(u)}</li>`).join('');
  const caps = (ws.activeCapabilities || []).map((c) => `<span class="wp-tag active">${esc(c)}</span>`).join(' ');
  const skills = (ws.activeSkills || []).map((s) => `<span class="wp-tag">${esc(s)}</span>`).join(' ');
  return `
    ${renderStrategy(state.activeSession?.strategy)}
    <div class="wp-section"><div class="wp-section-title">安全状态</div>
      <div class="wp-card"><span class="wp-tag ${esc(ws.safetyDisposition)}">${esc(ws.safetyDisposition)}</span></div></div>
    <div class="wp-section"><div class="wp-section-title">假设地图</div><div class="wp-card">${renderHypothesisMap(ws)}</div></div>
    <div class="wp-section"><div class="wp-section-title">当前候选（聚焦）</div><div class="wp-card">${renderFocusedCandidates(ws)}</div></div>
    <div class="wp-section"><div class="wp-section-title">学术来源</div><div class="wp-card">${renderSourceSchools(ws)}</div></div>
    <div class="wp-section"><div class="wp-section-title">病例事实</div><div class="wp-card"><ul class="wp-list">${facts || '<li>—</li>'}</ul></div></div>
    <div class="wp-section"><div class="wp-section-title">信息缺口</div><div class="wp-card"><ul class="wp-list">${gaps || '<li>—</li>'}</ul></div></div>
    <div class="wp-section"><div class="wp-section-title">不确定点</div><div class="wp-card"><ul class="wp-list">${unc || '<li>—</li>'}</ul></div></div>
    <div class="wp-section"><div class="wp-section-title">已激活能力</div><div class="wp-card">${caps || '<span class="muted">—</span>'}</div></div>
    <div class="wp-section"><div class="wp-section-title">已激活技能</div><div class="wp-card">${skills || '<span class="muted">—</span>'}</div></div>`;
}

function renderEvidence(ws) {
  const items = (ws.evidence || []).map((e) => `
    <div class="wp-card">
      <div class="wp-card-title">${esc(e.title || e.sourceRef)}</div>
      <div class="muted"><span class="source-link" data-source="${esc(e.sourceRef)}">${esc(e.sourceRef)}</span> · ${esc(e.sourceType)}</div>
      ${e.summary ? `<div style="margin-top:5px;color:#4d5650">${esc(e.summary)}</div>` : ''}
    </div>`).join('');
  return `<div class="wp-section"><div class="wp-section-title">证据条目</div>${items || '<div class="wp-empty">暂无证据</div>'}</div>`;
}

function renderHypotheses(ws) {
  const hs = (ws.hypotheses || []).map((h) => `
    <div class="wp-card">
      <div class="wp-card-title">${esc(h.label)}<span class="wp-tag ${esc(h.status)}">${esc(h.status)}</span></div>
      ${h.description ? `<div class="muted">${esc(h.description)}</div>` : ''}
      ${(h.supportingEvidenceRefs || []).length ? `<div style="margin-top:5px"><span class="muted">支持：</span>${h.supportingEvidenceRefs.map(esc).join('、')}</div>` : ''}
      ${(h.contradictingEvidenceRefs || []).length ? `<div><span class="muted">反证：</span>${h.contradictingEvidenceRefs.map(esc).join('、')}</div>` : ''}
      ${(h.missingEvidence || []).length ? `<div><span class="muted">缺失：</span>${h.missingEvidence.map(esc).join('、')}</div>` : ''}
    </div>`).join('');
  return `<div class="wp-section"><div class="wp-section-title">证候假设</div>${hs || '<div class="wp-empty">暂无假设</div>'}</div>`;
}

function renderCandidates(ws) {
  const cs = (ws.candidates || []).map((c) => `
    <div class="wp-card">
      <div class="wp-card-title">${esc(c.name || c.id)}<span class="wp-tag ${esc(c.status)}">${esc(c.status)}</span></div>
      <div class="muted">${c.sourceId ? `<span class="source-link" data-source="${esc(c.sourceId)}">${esc(c.sourceId)}</span>` : '—'}${c.formulaId ? ' · ' + esc(c.formulaId) : ''}</div>
      ${(c.composition || []).length ? `<div style="margin-top:5px">${c.composition.map((x) => `<span class="herb-pill">${esc(x)}</span>`).join('')}</div>` : ''}
    </div>`).join('');
  return `<div class="wp-section"><div class="wp-section-title">候选方</div>${cs || '<div class="wp-empty">暂无候选方</div>'}</div>`;
}

function renderDeliberation(ws) {
  const rows = (ws.deliberation?.rows || []).map((r) => `
    <div class="wp-card">
      <div class="wp-card-title">${esc(r.candidateRef)}<span class="wp-tag ${esc(r.assessmentStatus)}">${esc(r.assessmentStatus)}</span></div>
      ${(r.assessmentSummaries || []).map((s) => `<div class="muted">${esc(s)}</div>`).join('')}
      ${(r.supportingEvidenceRefs || []).length ? `<div style="margin-top:4px"><span class="muted">支持：</span>${r.supportingEvidenceRefs.map(esc).join('、')}</div>` : ''}
      ${(r.contradictingEvidenceRefs || []).length ? `<div><span class="muted">反证：</span>${r.contradictingEvidenceRefs.map(esc).join('、')}</div>` : ''}
      ${(r.unresolvedQuestions || []).length ? `<div><span class="muted">待决：</span>${r.unresolvedQuestions.map(esc).join('、')}</div>` : ''}
    </div>`).join('');
  const assessments = (ws.deliberation?.assessments || []).map((a) => `
    <div class="wp-card"><div class="wp-card-title">${esc(a.candidateRef)} × ${esc(a.hypothesisRef)}</div><div class="muted">${esc(a.assessmentSummary)}</div></div>`).join('');
  return `
    <div class="wp-section"><div class="wp-section-title">比较矩阵</div>${rows || '<div class="wp-empty">暂无评估</div>'}</div>
    <div class="wp-section"><div class="wp-section-title">候选评估</div>${assessments || '<div class="wp-empty">暂无</div>'}</div>`;
}

/* ---------- Trace Drawer ---------- */
$('#openTrace').addEventListener('click', () => { $('#traceDrawer').classList.remove('hidden'); });
$('#traceClose').addEventListener('click', () => { $('#traceDrawer').classList.add('hidden'); });

function renderTrace(session) {
  const body = $('#traceBody');
  if (!session) { body.innerHTML = '<div class="wp-empty">暂无 Trace</div>'; return; }
  const t = session.trace;
  const tools = (t.toolCalls || []).map((tc) => `
    <div class="trace-tool">
      <div class="tool-name">${esc(tc.toolName)}${tc.reused ? ' <span class="muted">(reused)</span>' : ''}</div>
      <div class="tool-meta">${tc.ms}ms${tc.error ? ' · ' + esc(tc.error) : ''}</div>
      <pre>${esc(JSON.stringify(tc.input, null, 2))}</pre>
      ${tc.output !== undefined ? `<pre>${esc(JSON.stringify(tc.output, null, 2))}</pre>` : ''}
    </div>`).join('');
  const events = (t.workspaceEvents || []).map((e) => `<div class="trace-event"><span class="ev-type">${esc(e.type)}</span> <span class="muted">${esc(e.timestamp)}</span></div>`).join('');
  const diag = (t.retrievalDiagnostics || []).map((d) => `<pre>${esc(JSON.stringify(d, null, 2))}</pre>`).join('');
  const authority = (session.authority?.decisions || []).map((d) => `<div class="trace-kv"><span class="k">${esc(d.stage)}</span><span>${esc(d.action)}${(d.reasons || []).length ? ' · ' + d.reasons.map(esc).join('、') : ''}</span></div>`).join('');
  const snap = t.snapshot || {};
  const loop = t.agentLoop || {};
  const loopHtml = `
    <div class="trace-kv"><span class="k">steps</span><span>${loop.stepCount != null ? loop.stepCount : '—'}</span></div>
    <div class="trace-kv"><span class="k">终止原因</span><span>${esc(loop.terminationReason || '—')}</span></div>
    <div class="trace-kv"><span class="k">finishReason</span><span>${esc(loop.finishReason || '—')}</span></div>
    <div class="trace-kv"><span class="k">proposal.submit</span><span>${loop.proposalSubmitted ? '是' : '否'}</span></div>
    <div class="trace-kv"><span class="k">forced finalization</span><span>${loop.forcedFinalization ? '是' : '否'}</span></div>
    <div class="trace-kv"><span class="k">末步含工具调用</span><span>${loop.finalStepHadToolCalls ? '是' : '否'}</span></div>`;
  const cm = t.contextMetrics || {};
  const cmHtml = Object.keys(cm).length ? `
    <div class="trace-kv"><span class="k">workingView tokens</span><span>${cm.workingViewTokenEstimate ?? '—'}</span></div>
    <div class="trace-kv"><span class="k">raw context tokens</span><span>${cm.rawContextTokenEstimate ?? '—'}</span></div>
    <div class="trace-kv"><span class="k">压缩比 (raw/working)</span><span>${cm.compressionRatio != null ? cm.compressionRatio.toFixed(1) + '×' : '—'}</span></div>` : '';
  body.innerHTML = `
    <div class="trace-section"><h3>Run</h3>
      <div class="trace-kv"><span class="k">runId</span><span>${esc(t.runId)}</span></div>
      <div class="trace-kv"><span class="k">模型</span><span>${esc(snap.modelProfileId || session.model)}</span></div>
      <div class="trace-kv"><span class="k">耗时</span><span>${t.totalMs != null ? t.totalMs + 'ms' : '—'}</span></div>
      ${Object.keys(loop).length ? loopHtml : ''}
      ${cmHtml}
    </div>
    <div class="trace-section"><h3>Authority</h3>${authority || '<div class="muted">—</div>'}</div>
    <div class="trace-section"><h3>工具调用（${(t.toolCalls || []).length}）</h3>${tools || '<div class="muted">—</div>'}</div>
    <div class="trace-section"><h3>Workspace 事件（${(t.workspaceEvents || []).length}）</h3>${events || '<div class="muted">—</div>'}</div>
    <div class="trace-section"><h3>检索诊断</h3>${diag || '<div class="muted">—</div>'}</div>
    <div class="trace-section"><h3>Snapshot</h3>
      <div class="trace-kv"><span class="k">能力</span><span>${(snap.capabilities || []).map(esc).join('、') || '—'}</span></div>
      <div class="trace-kv"><span class="k">技能</span><span>${(snap.activeSkills || []).map(esc).join('、') || '—'}</span></div>
      <div class="trace-kv"><span class="k">知识域</span><span>${(snap.knowledgeScopes || []).map(esc).join('、') || '—'}</span></div>
    </div>`;
}

/**
 * 失败态的 Trace：直接用流式过程中已收到的事件渲染，保证「展开推理过程」在失败时同样成立。
 */
function renderLiveTrace(message) {
  const tools = state.liveEvents
    .filter((x) => x.type === 'tool')
    .map((x) => `
      <div class="trace-tool">
        <div class="tool-name">${esc(x.data.toolName)}</div>
        <div class="tool-meta">${x.data.ms}ms${x.data.error ? ' · ' + esc(x.data.error) : ''}</div>
        <pre>${esc(JSON.stringify(x.data.input, null, 2))}</pre>
        ${x.data.output !== undefined ? `<pre>${esc(JSON.stringify(x.data.output, null, 2))}</pre>` : ''}
      </div>`).join('');
  const events = state.liveEvents
    .filter((x) => x.type === 'workspace')
    .map((x) => `<div class="trace-event"><span class="ev-type">${esc(x.data.type)}</span></div>`).join('');
  $('#traceBody').innerHTML = `
    <div class="trace-section"><h3>Run</h3>
      <div class="trace-kv"><span class="k">状态</span><span>未完成 · NO COMMIT</span></div>
      <div class="trace-kv"><span class="k">原因</span><span>${esc(message)}</span></div>
    </div>
    <div class="trace-section"><h3>工具调用（${state.liveEvents.filter((x) => x.type === 'tool').length}）</h3>${tools || '<div class="muted">—</div>'}</div>
    <div class="trace-section"><h3>Workspace 事件（${state.liveEvents.filter((x) => x.type === 'workspace').length}）</h3>${events || '<div class="muted">—</div>'}</div>`;
}

/* ---------- 知识来源 Modal ---------- */
$('#sourceClose').addEventListener('click', () => $('#sourceModal').classList.add('hidden'));
async function openSource(sourceId) {
  try {
    const data = await api(`/api/knowledge/source/${encodeURIComponent(sourceId)}`);
    $('#sourceBody').innerHTML = `
      <div class="kv"><span class="k">来源</span><span>${esc(data.source || '—')}</span></div>
      <div class="kv"><span class="k">文件</span><span>${esc(data.sourceFile || '—')}</span></div>
      <div class="kv"><span class="k">层级</span><span>${esc(data.tier || '—')}</span></div>
      <div class="kv"><span class="k">病名</span><span>${esc(data.disease || '—')}</span></div>
      <div class="kv"><span class="k">证型</span><span>${esc(data.syndrome || '—')}</span></div>
      <div class="kv"><span class="k">治法</span><span>${esc(data.treatment || '—')}</span></div>
      ${(data.formulas || []).map((f) => `<div class="kv"><span class="k">方剂</span><span><strong>${esc(f.name)}</strong>${f.composition ? '（' + esc(f.composition) + '）' : ''}</span></div>`).join('')}
      ${data.summary ? `<pre>${esc(data.summary)}</pre>` : ''}`;
    $('#sourceModal').classList.remove('hidden');
  } catch (e) {
    toast(e.message);
  }
}

/* ---------- 发送 / SSE 流 ---------- */
const inputEl = $('#input');
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 170) + 'px';
});
$('#send').addEventListener('click', () => {
  if (state.streaming) return;
  send();
});

async function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  if (state.streaming) return;
  state.streaming = true;
  $('#send').classList.add('stop');
  $('#send .send-icon').classList.add('hidden');
  $('#send .stop-square').classList.remove('hidden');
  $('#wpRunState').textContent = 'running';
  $('#wpRunState').className = 'wp-run-state running';
  inputEl.value = '';
  inputEl.style.height = 'auto';

  appendUserMessage(text);
  showThinking();
  state.liveEvents = [];
  state.lifecycle = 'exploring';
  renderLifecycle();

  try {
    const res = await fetch('/api/run/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let session = null;
    let failure = '';

    const handle = (event, data) => {
      if (event === 'meta') {
        $('#modelState').textContent = data.model || '';
        if (data.asrEnabled === false) $('#mic').classList.add('hidden');
      } else if (event === 'tool') {
        state.liveEvents.push({ type: 'tool', data });
        updateLiveActivity();
      } else if (event === 'workspace') {
        (data.events || []).forEach((e) => state.liveEvents.push({ type: 'workspace', data: e }));
      } else if (event === 'lifecycle') {
        state.lifecycle = data.stage;
        renderLifecycle();
      } else if (event === 'result') {
        session = data;
      } else if (event === 'error') {
        failure = data.message || '运行失败';
        toast(failure);
      } else if (event === 'done') {
        /* 结束 */
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        parseBlock(block, handle);
      }
    }

    if (session) {
      state.activeSession = session;
      finishThinking(session);
      addSession(session.trace.input.slice(0, 24) || '问诊', session);
      $('#caseTitle').innerHTML = `<strong>问诊完成</strong><span>${esc(session.runId)} · ${esc(session.model)}</span>`;
    } else {
      failThinking(failure || '本次运行未产生可提交的结论。');
      $('#caseTitle').innerHTML = '<strong>推理未完成</strong><span>已保留本次运行的工具调用轨迹</span>';
    }
  } catch (e) {
    toast(e.message || '请求失败');
    failThinking(e.message || '请求失败');
    $('#caseTitle').innerHTML = '<strong>推理未完成</strong><span>已保留本次运行的工具调用轨迹</span>';
  } finally {
    state.streaming = false;
    $('#send').classList.remove('stop');
    $('#send .send-icon').classList.remove('hidden');
    $('#send .stop-square').classList.add('hidden');
    $('#wpRunState').textContent = 'idle';
    $('#wpRunState').className = 'wp-run-state';
  }
}

function parseBlock(block, handle) {
  let event = 'message';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5);
  }
  if (data) {
    let parsed;
    try { parsed = JSON.parse(data); } catch { return; }
    handle(event, parsed);
  }
}

/* ---------- 管理员端 ---------- */
$('#adminNav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-page]');
  if (!btn) return;
  $$('#adminNav button').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.admin-page').forEach((p) => p.classList.toggle('hidden', p.dataset.page !== btn.dataset.page));
  $('#adminPageTitle').textContent = btn.textContent.trim();
  const page = btn.dataset.page;
  if (page === 'health') loadHealth();
  if (page === 'traces') loadTraces();
});
$('#adminRefresh').addEventListener('click', () => refreshAdmin());
$('#evalRun').addEventListener('click', () => runEval());

function refreshAdmin() {
  loadHealth();
  loadTraces();
}

async function loadHealth() {
  try {
    const h = await api('/api/health');
    $('#healthCards').innerHTML = `
      <div class="stat-card"><span>运行时模式</span><strong>${esc(h.runtimeMode)}</strong></div>
      <div class="stat-card"><span>Deep 模型</span><strong style="font-size:14px">${esc(h.llm.deep)}</strong></div>
      <div class="stat-card"><span>知识索引</span><strong>${h.knowledge.ok ? esc(h.knowledge.docCount) : '—'}</strong><em>${h.knowledge.ok ? esc(h.knowledge.version) : esc(h.knowledge.error)}</em></div>
      <div class="stat-card"><span>语音 ASR</span><strong>${h.asr.enabled ? '可用' : '未配置'}</strong></div>`;
    $('#healthList').innerHTML = `
      <div class="health-row"><span>知识索引</span><b><span class="status-badge ${h.knowledge.ok ? 'ok' : 'bad'}">${h.knowledge.ok ? 'OK' : 'ERROR'}</span></b></div>
      <div class="health-row"><span>LLM（Deep）</span><b>${esc(h.llm.deep)}</b></div>
      <div class="health-row"><span>LLM（Fast）</span><b>${esc(h.llm.fast)}</b></div>
      <div class="health-row"><span>ASR</span><b><span class="status-badge ${h.asr.enabled ? 'ok' : 'warn'}">${h.asr.enabled ? 'ENABLED' : 'DISABLED'}</span></b></div>`;
    $('#capSkillList').innerHTML = `
      <div class="wp-section-title">Capabilities</div>
      ${(h.capabilities || []).map((c) => `<div class="health-row"><span>${esc(c.displayName || c.id)}</span><b>${esc(c.version)}</b></div>`).join('') || '<div class="muted">—</div>'}
      <div class="wp-section-title" style="margin-top:14px">Skills</div>
      ${(h.skills || []).map((s) => `<div class="health-row"><span>${esc(s.id)}</span><b>${esc(s.version)}</b></div>`).join('') || '<div class="muted">—</div>'}`;
  } catch (e) {
    $('#healthCards').innerHTML = `<div class="stat-card"><span>错误</span><strong>${esc(e.message)}</strong></div>`;
  }
}

async function loadTraces() {
  try {
    const data = await api('/api/traces');
    const items = data.items || [];
    $('#traceTable').innerHTML = items.length ? items.map((r) => `
      <tr>
        <td><strong>${esc(new Date(r.startedAt).toLocaleTimeString())}</strong><small>${esc(new Date(r.startedAt).toLocaleDateString())}</small></td>
        <td><span class="input-preview">${esc(r.input)}</span></td>
        <td>${esc(r.model)}</td>
        <td><span class="status-badge ${r.status === 'done' ? 'ok' : r.status === 'error' ? 'bad' : 'warn'}">${esc(r.status)}</span></td>
        <td><button class="table-action" data-run="${esc(r.runId)}">查看</button></td>
      </tr>`).join('') : '<tr><td colspan="5" class="wp-empty">暂无运行记录</td></tr>';
  } catch (e) {
    toast(e.message);
  }
}
$('#traceTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-run]');
  if (!btn) return;
  try {
    const rec = await api(`/api/traces/${encodeURIComponent(btn.dataset.run)}`);
    const detail = $('#traceDetail');
    detail.classList.remove('hidden');
    if (rec.session) {
      detail.innerHTML = `<div class="card-head"><h2>${esc(rec.runId)}</h2><span class="status-badge ok">DONE</span></div><pre>${esc(JSON.stringify(rec.session.result, null, 2))}</pre>`;
    } else {
      const loop = rec.trace?.agentLoop || {};
      const tools = (rec.trace?.toolCalls || []).length;
      detail.innerHTML = `<div class="card-head"><h2>${esc(rec.runId)}</h2><span class="status-badge bad">ERROR</span></div>
        <div class="muted">${esc(rec.error || '')}</div>
        <div class="trace-kv"><span class="k">steps</span><span>${loop.stepCount != null ? loop.stepCount : '—'}</span></div>
        <div class="trace-kv"><span class="k">终止原因</span><span>${esc(loop.terminationReason || '—')}</span></div>
        <div class="trace-kv"><span class="k">工具调用</span><span>${tools}</span></div>`;
    }
  } catch (e2) {
    toast(e2.message);
  }
});

async function runEval() {
  const input = $('#evalInput').value.trim();
  const key = $('#evalKey').value.trim();
  if (!input) return toast('请输入病例内容');
  $('#evalResult').innerHTML = '<div class="thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="thinking-text">运行中…</span></div>';
  try {
    const data = await api('/api/eval/run', { method: 'POST', body: JSON.stringify({ input, caseKey: key }) });
    const s = data.session;
    let html = '';
    if (data.audit) {
      const a = data.audit;
      html += `<div class="audit-banner ${esc(a.classification)}"><strong>Clinical Audit：${esc(a.classification)}</strong><div class="muted">${esc(a.summary)}</div><div class="muted">Exact Match → 病 ${a.exactMatch.disease ? '✓' : '✗'} · 证 ${a.exactMatch.syndrome ? '✓' : '✗'} · 方 ${a.exactMatch.formula ? '✓' : '✗'}</div></div>`;
    }
    if (data.gold) {
      const g = data.gold;
      html += `<div class="admin-card"><div class="card-head"><h2>Gold 参考（评估用，非唯一真理）</h2></div><div class="trace-kv"><span class="k">病名</span><span>${esc(g.diseaseResolved || g.diseaseRaw)}</span></div><div class="trace-kv"><span class="k">辨证</span><span>${esc(g.syndrome)}</span></div><div class="trace-kv"><span class="k">variant</span><span>${esc(g.variantId)}</span></div></div>`;
    } else if (key) {
      html += `<div class="admin-card"><div class="card-head"><h2>Gold</h2></div><div class="muted">gold 数据不可用（gold 文件不在工作区）</div></div>`;
    }
    html += `<div class="admin-card"><div class="card-head"><h2>Agent 结果</h2></div><pre>${esc(JSON.stringify(s.result, null, 2))}</pre></div>`;
    $('#evalResult').innerHTML = html;
  } catch (e) {
    $('#evalResult').innerHTML = `<div class="audit-banner DECISION_ERROR">${esc(e.message)}</div>`;
  }
}

/* ---------- 启动 ---------- */
(async function boot() {
  try {
    const h = await api('/api/health');
    $('#modelState').textContent = h.llm?.deep || '';
    if (!h.asr?.enabled) $('#mic').classList.add('hidden');
  } catch (e) {
    $('#modelState').textContent = '后端未连接';
  }
})();

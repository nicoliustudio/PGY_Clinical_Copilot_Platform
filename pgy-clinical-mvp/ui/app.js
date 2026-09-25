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
  if (res.status === 401) {
    window.location.replace('/login');
    throw new Error('会话已过期，请重新登录');
  }
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
  openGroups: new Set(),  // 展开中的推理过程节点（跨重渲染保持）
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

/* ---------- 左栏 / 右栏 收起 ---------- */
const PANEL_KEYS = { side: 'pgy.panel.side', ws: 'pgy.panel.workspace' };

function setSideCollapsed(collapsed) {
  $('#userView').classList.toggle('side-collapsed', collapsed);
  $('#sideExpand').classList.toggle('hidden', !collapsed);
  try { localStorage.setItem(PANEL_KEYS.side, collapsed ? '1' : '0'); } catch { /* 隐私模式忽略 */ }
}
function setWorkspaceCollapsed(collapsed) {
  $('#userView').classList.toggle('ws-collapsed', collapsed);
  $('#wpExpand').classList.toggle('hidden', !collapsed);
  try { localStorage.setItem(PANEL_KEYS.ws, collapsed ? '1' : '0'); } catch { /* 隐私模式忽略 */ }
}
$('#sideCollapse').addEventListener('click', () => setSideCollapsed(true));
$('#sideExpand').addEventListener('click', () => setSideCollapsed(false));
$('#wpCollapse').addEventListener('click', () => setWorkspaceCollapsed(true));
$('#wpExpand').addEventListener('click', () => setWorkspaceCollapsed(false));
(function restorePanels() {
  try {
    setSideCollapsed(localStorage.getItem(PANEL_KEYS.side) === '1');
    setWorkspaceCollapsed(localStorage.getItem(PANEL_KEYS.ws) === '1');
  } catch { /* 忽略 */ }
})();

const EMPTY_STATE_HTML = `<div class="empty-state" id="emptyState">
  <img class="empty-logo" src="/logo.png" alt="蒲公英中医" />
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
    <img class="bot-avatar" src="/logo.png" alt="蒲公英中医" />
    <div class="assistant-content">
      <div class="thinking-card">
        <div class="thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="thinking-text">正在理解病例…</span></div>
        <div class="thinking-bar"><i></i></div>
      </div>
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

/** 阶段配色：仅用于推理过程节点的时间线标记。 */
const CATEGORY_TONE = {
  '发现能力': 'a', '检索临床证据': 'b', '核对来源': 'b', '检索候选方': 'c',
  '校验方剂出处': 'c', '比较候选': 'd', '生成临床建议': 'e',
};

/** 连续同类工具调用合并为一组，作为推理过程的一个节点。 */
function groupTools(tools) {
  const groups = [];
  for (const t of tools) {
    const cat = toolCategory(t.toolName);
    const last = groups[groups.length - 1];
    if (last && last.cat === cat) last.items.push(t);
    else groups.push({ cat, items: [t] });
  }
  return groups.map((g) => ({
    ...g,
    tone: CATEGORY_TONE[g.cat] || 'n',
    totalMs: g.items.reduce((n, t) => n + (typeof t.ms === 'number' ? t.ms : 0), 0),
  }));
}

const VALUE_LIMIT = 160;
/** 把工具入参 / 结果渲染为可读结构，避免整屏裸 JSON；完整原文仍在 Trace 中保留。 */
function renderValue(v, depth = 0) {
  if (v === null || v === undefined) return '<span class="j-null">—</span>';
  if (typeof v === 'boolean') return `<span class="j-bool">${v}</span>`;
  if (typeof v === 'number') return `<span class="j-num">${v}</span>`;
  if (typeof v === 'string') {
    return `<span class="j-str">${esc(v.length > VALUE_LIMIT ? v.slice(0, VALUE_LIMIT) + '…' : v)}</span>`;
  }
  if (depth >= 3) return `<span class="j-null">${esc(JSON.stringify(v).slice(0, VALUE_LIMIT))}…</span>`;
  if (Array.isArray(v)) {
    if (!v.length) return '<span class="j-null">[ ]</span>';
    const head = v.slice(0, 6).map((x) => `<li>${renderValue(x, depth + 1)}</li>`).join('');
    const rest = v.length > 6 ? `<li class="j-more">… 其余 ${v.length - 6} 项见 Trace</li>` : '';
    return `<ul class="j-arr">${head}${rest}</ul>`;
  }
  const entries = Object.entries(v);
  if (!entries.length) return '<span class="j-null">{ }</span>';
  const rows = entries.slice(0, 12).map(([k, val]) =>
    `<div class="j-row"><span class="j-key">${esc(k)}</span><span class="j-val">${renderValue(val, depth + 1)}</span></div>`
  ).join('');
  const rest = entries.length > 12 ? `<div class="j-more">… 其余 ${entries.length - 12} 个字段见 Trace</div>` : '';
  return `<div class="j-obj">${rows}${rest}</div>`;
}

function toolCardHtml(t) {
  const hasErr = t.error !== undefined && t.error !== null && t.error !== '';
  const errText = typeof t.error === 'string' ? t.error : JSON.stringify(t.error ?? '');
  return `
    <div class="tool-card${hasErr ? ' err' : ''}">
      <div class="tool-card-head">
        <code class="tool-name">${esc(t.toolName)}</code>
        <span class="tool-chip">${typeof t.ms === 'number' ? t.ms + 'ms' : '—'}</span>
        ${t.reused ? '<span class="tool-chip reused">复用缓存</span>' : ''}
        ${hasErr ? `<span class="tool-chip err">${esc(errText.slice(0, 120))}</span>` : ''}
      </div>
      ${t.input !== undefined ? `<div class="tool-io"><span class="io-key">参数</span><div class="io-val">${renderValue(t.input)}</div></div>` : ''}
      ${t.output !== undefined ? `<div class="tool-io"><span class="io-key">结果</span><div class="io-val">${renderValue(t.output)}</div></div>` : ''}
    </div>`;
}

/** 推理过程节点列表（默认折叠，仅保留阶段摘要）。 */
function groupsHtml(tools, streaming = false) {
  const groups = groupTools(tools);
  return groups.map((g, i) => {
    const occurrence = groups.slice(0, i).filter((x) => x.cat === g.cat).length;
    const key = `${g.cat}#${occurrence}`;
    const open = state.openGroups.has(key);
    const isLast = i === groups.length - 1;
    const body = g.items.map(toolCardHtml).join('');
    return `
      <div class="live-group" data-tone="${g.tone}"${streaming && isLast ? ' data-live="1"' : ''}>
        <span class="lg-marker"><i class="lg-node"></i></span>
        <div class="lg-main">
          <button class="live-group-head${open ? ' open' : ''}" type="button" data-group-key="${esc(key)}" aria-expanded="${open}">
            <span class="lg-label">${esc(g.cat)}</span>
            ${g.items.length > 1 ? `<span class="lg-count">×${g.items.length}</span>` : ''}
            <span class="lg-dur">${g.totalMs}ms</span>
            <svg class="lg-chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
          </button>
          <div class="live-group-body${open ? '' : ' hidden'}">${body}</div>
        </div>
      </div>`;
  }).join('');
}

function liveTools() {
  return state.liveEvents.filter((x) => x.type === 'tool').map((x) => x.data);
}

function renderLiveActivity() {
  const box = document.querySelector('.thinking-msg:last-child .live-activity');
  if (!box) return;
  const tools = liveTools();
  box.innerHTML = tools.length ? groupsHtml(tools, true) : '';
  scrollChat();
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
  const thinkingText = document.querySelector('.thinking-msg:last-child .thinking-text');
  if (thinkingText) thinkingText.textContent = label;
}

// 推理过程节点 / 折叠组点击展开收起（委托）
document.addEventListener('click', (e) => {
  const proc = e.target.closest('[data-proc-toggle]');
  if (proc) {
    const node = proc.closest('.process-node');
    const body = node?.querySelector('.process-body');
    if (!body) return;
    const hidden = body.classList.toggle('hidden');
    node.classList.toggle('open', !hidden);
    proc.setAttribute('aria-expanded', String(!hidden));
    return;
  }
  const head = e.target.closest('.live-group-head');
  if (!head) return;
  const body = head.parentElement.querySelector('.live-group-body');
  if (!body) return;
  const hidden = body.classList.toggle('hidden');
  head.classList.toggle('open', !hidden);
  head.setAttribute('aria-expanded', String(!hidden));
  const key = head.dataset.groupKey;
  if (key) { if (hidden) state.openGroups.delete(key); else state.openGroups.add(key); }
});

/** 用 trace 已记录的完整调用链还原折叠的推理过程节点（供历史会话回看）。 */
function appendProcessNode(tools, totalMs) {
  if (!tools?.length) return;
  const div = document.createElement('div');
  div.className = 'msg assistant process-node';
  div.innerHTML = `
    <img class="bot-avatar" src="/logo.png" alt="蒲公英中医" />
    <div class="assistant-content">
      <button class="process-head" type="button" data-proc-toggle aria-expanded="false">
        <span class="proc-dot"></span><strong>推理过程</strong>
        <span class="proc-meta">${tools.length} 次工具调用${totalMs ? ' · ' + totalMs + 'ms' : ''}</span>
        <svg class="proc-chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
      </button>
      <div class="process-body hidden">${groupsHtml(tools)}</div>
    </div>`;
  $('#chat').appendChild(div);
}

function finishThinking(session) {
  const node = document.querySelector('.thinking-msg:last-child');
  if (node) {
    node.classList.remove('thinking-msg');
    node.classList.add('process-node');
    const content = node.querySelector('.assistant-content');
    const activity = content.querySelector('.live-activity');
    content.querySelector('.thinking-card')?.remove();
    const tools = liveTools();
    if (activity && tools.length) {
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'process-head';
      head.setAttribute('data-proc-toggle', '');
      head.setAttribute('aria-expanded', 'false');
      head.innerHTML = `<span class="proc-dot"></span><strong>推理过程</strong>
        <span class="proc-meta">${tools.length} 次工具调用${session.trace?.totalMs ? ' · ' + session.trace.totalMs + 'ms' : ''}</span>
        <svg class="proc-chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>`;
      activity.classList.add('process-body', 'hidden');
      content.insertBefore(head, activity);
    } else {
      node.remove();
    }
  }
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
  content.querySelector('.thinking-card')?.remove();

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
  appendProcessNode(session.trace.toolCalls, session.trace.totalMs);
  renderConclusion(session);
  $('#caseTitle').innerHTML = `<strong>问诊</strong><span>${esc(session.runId)} · ${esc(session.model)}</span>`;
}

function renderConclusion(session) {
  const r = session.result;
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.innerHTML = `<img class="bot-avatar" src="/logo.png" alt="蒲公英中医" /><div class="assistant-content">${renderResult(r, session.authority)}</div>`;
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

/* ---------- 治疗方案：统一结构化渲染 ----------
 * 渲染纪律（与 Agent / Kernel 边界一致）：
 * - 只渲染 committed 事实，不筛选、不重排、不重算完整性（UI 无权威）；
 * - 方剂 / 膏方 / 针灸 / 成药等所有交付共用同一套卡片，任何字段都不以裸 JSON 呈现；
 * - 「一味药 = 一枚标签（药名+脚注+剂量）」，药名与剂量永不拆成两行；
 * - 来源原文与技术标识无损保留在可展开的溯源区（可读文本，非 JSON）。
 */

const MODALITY_LABELS = {
  'modality:herbal-formula': '方剂',
  'modality:gaofang': '膏方',
  'modality:acupuncture': '针灸',
  'modality:moxibustion': '艾灸',
  'modality:auricular': '耳穴',
  'modality:external-therapy': '外治',
  'modality:preparation': '成药',
};
const RELATION_LABELS = { PRIMARY_SELECTED: '主选', SOURCE_ALTERNATIVE: '同源备选', CLINICALLY_EXCLUDED: '已排除' };
const FORMULA_AUTHORITY_LABELS = { NORMATIVE: '规范来源', GENERATED_DRAFT: '生成草稿', BLOCKED: '已阻断' };
const CLEARANCE_LABELS = { CLEARED: '可执行', REVIEW_REQUIRED: '需医生复核', BLOCKED: '暂不可执行' };
const APPLICABILITY_LABELS = { CURRENTLY_SUITABLE: '当前适用', DEFERRED: '择期适用', CURRENTLY_NOT_SUITABLE: '当前不适用' };

/** 来源载荷字段 → 医生可读标签。未收录的键保留原键名（不丢字段）。 */
const PAYLOAD_LABELS = {
  title: '名称', name: '名称', raw_name: '原始病名', specialty: '科别',
  disease: '病名', patient: '患者', syndrome_pattern: '证型', applies_to_syndromes: '适用证型',
  indication_text: '适应证', indication: '适应证', tongue: '舌象', pulse: '脉象',
  treatment_method: '治法', composition: '组成', preparation_process: '制备', usage: '用法',
  contraindication: '禁忌', auxiliary_formulas: '辅助方', protocol: '治疗方案',
  modalities: '治疗方式', points: '取穴', technique: '手法', regimens: '疗程',
  medicine: '成药', raw: '原文', source_tag: '来源标记',
  operation: '操作', frequency: '频次', course: '疗程次数',
};

/** 技术 / 检索元数据：不进医生主视图，折叠进溯源区（不丢弃）。 */
const PAYLOAD_TECH_KEYS = new Set([
  'asset_id', 'asset_type', 'subtype', 'content_hash', 'evidence_tier', 'knowledge_domain',
  'knowledge_role', 'curated_id', 'curated_source_tier', 'can_decide_base_formula',
  'requires_explicit_intent', 'sex', 'occurrences', 'tags_seen', 'syndrome_specific',
  'duplicate_occurrences', 'source_tag_mismatch', 'activation_scope', 'runtime_eligible',
  'deferred_reason', 'search_text', 'provenance',
]);
const PROVENANCE_DISPLAY_KEYS = new Set(['book', 'section', 'source_label', 'raw_text']);

function isObj(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function isBlank(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.every(isBlank);
  if (isObj(v)) return Object.values(v).every(isBlank);
  return false;
}
function modalityLabel(outcome) {
  if (typeof outcome !== 'string' || !outcome.trim()) return '治疗';
  const key = outcome.trim();
  if (MODALITY_LABELS[key]) return MODALITY_LABELS[key];
  const tail = key.split(/[:/]/).filter(Boolean).pop();
  return MODALITY_LABELS[tail] || tail;
}
function chipsHtml(items) {
  const list = (items || []).map((x) => String(x).trim()).filter(Boolean);
  if (!list.length) return '';
  return `<div class="rx-chips">${list.map((x) => `<span class="rx-chip">${esc(x)}</span>`).join('')}</div>`;
}
/** 成句的规则 / 疗程逐条成行；胶囊只留给药味与穴位这类短词条。 */
function rulesHtml(items) {
  const list = (items || []).map((x) => String(x).trim()).filter(Boolean);
  if (!list.length) return '';
  return `<div class="rx-rules">${list.map((x) => `<div class="rx-rule">${esc(x)}</div>`).join('')}</div>`;
}
/** 结构化成份 [{name,note,dose}] → 「药名（脚注）剂量」；药名与剂量永远同枚标签。 */
function ingredientItems(list) {
  return list.filter(isObj).map((it) => {
    const name = String(it.name ?? '').trim();
    const note = String(it.note ?? '').trim();
    const dose = String(it.dose ?? '').trim();
    if (!name) return dose;
    return `${name}${note ? `（${note}）` : ''}${dose ? ` ${dose}` : ''}`.trim();
  }).filter(Boolean);
}
/**
 * 组成 / 取穴等文本拆成「一味药 = 一条」。先按顿号逗号等分隔；若某段用空格罗列，
 * 且每段都自带剂量（形如「党参10克」），再按空格拆开——保证药名与其剂量始终同一条。
 */
function splitList(text) {
  const out = [];
  for (const fragment of String(text).split(/[，,、；;。\n]+/).map((s) => s.trim()).filter(Boolean)) {
    const tokens = fragment.split(/\s+/).filter(Boolean);
    if (tokens.length > 1 && tokens.every((t) => /\d/.test(t))) out.push(...tokens);
    else out.push(fragment);
  }
  return out;
}
function rawDetailsHtml(summary, text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  return `<details class="rx-raw"><summary>${esc(summary)}</summary><div class="rx-raw-body"><div class="rx-raw-text">${esc(text)}</div></div></details>`;
}
function rowHtml(label, body) {
  if (!body) return '';
  return `<div class="rx-row"><span class="rx-k">${esc(label)}</span><div class="rx-v">${body}</div></div>`;
}
/** 任意字段值 → 可读 HTML（标签 / 文本 / 子字段）。永不输出裸 JSON。 */
function valueHtml(value, key) {
  if (isBlank(value)) return '';
  if (Array.isArray(value)) {
    if (value.every((x) => !isObj(x))) return chipsHtml(value);
    if (value.every((x) => isObj(x) && String(x.name ?? '').trim())) return chipsHtml(ingredientItems(value));
    return `<div class="rx-sub">${value.map((x) => `<div class="rx-sub-item">${isObj(x) ? objectRowsHtml(x) : esc(String(x))}</div>`).join('')}</div>`;
  }
  if (isObj(value)) {
    // 结构化组成：以 ingredients 呈现药味标签，raw 折叠为可核对原文。
    if (Array.isArray(value.ingredients)) {
      return chipsHtml(ingredientItems(value.ingredients)) + rawDetailsHtml('组成原文', value.raw);
    }
    return objectRowsHtml(value);
  }
  const text = String(value).trim();
  if (key === 'composition' || key === 'points') {
    const items = splitList(text);
    if (items.length > 1) return chipsHtml(items);
  }
  if (key === 'regimens') {
    const items = splitList(text);
    if (items.length > 1) return rulesHtml(items);
  }
  return `<div class="rx-text">${esc(text)}</div>`;
}
function objectRowsHtml(obj, skipKeys) {
  return Object.entries(obj).map(([k, v]) => {
    if (skipKeys?.has(k) || PAYLOAD_TECH_KEYS.has(k) || k === 'provenance' || isBlank(v)) return '';
    return rowHtml(PAYLOAD_LABELS[k] || k, valueHtml(v, k));
  }).join('');
}
/** 三态事实（PRESENT / KNOWN_EMPTY / UNKNOWN）渲染，UNKNOWN 绝不写成「无」。 */
function presenceHtml(fact, key) {
  if (!fact) return '';
  if (fact.presence === 'PRESENT') return valueHtml(fact.value, key);
  if (fact.presence === 'KNOWN_EMPTY') return '<div class="rx-text muted">明确无</div>';
  return '<div class="rx-text muted">未知</div>';
}
/** 三个加减命名空间共用：PRESENT 列出规则，KNOWN_EMPTY 为「无加减」，UNKNOWN 保持未知。 */
function modificationHtml(fact) {
  if (!fact) return '';
  if (fact.presence === 'PRESENT') {
    const items = (Array.isArray(fact.value) ? fact.value : [fact.value])
      .map((x) => (isObj(x) ? String(x.statement ?? '') : String(x ?? '')))
      .map((x) => x.trim()).filter(Boolean);
    return items.length ? rulesHtml(items) : '<div class="rx-text muted">无加减</div>';
  }
  if (fact.presence === 'KNOWN_EMPTY') return '<div class="rx-text muted">无加减</div>';
  return '<div class="rx-text muted">未知</div>';
}
function provenanceLineHtml(prov) {
  if (!isObj(prov)) return '';
  const label = [prov.source_label, prov.book].find((x) => typeof x === 'string' && x.trim());
  const section = typeof prov.section === 'string' && prov.section.trim() ? prov.section : '';
  if (!label && !section) return '';
  return `<div class="rx-source">出处：${esc(label || '—')}${section ? ` · ${esc(section)}` : ''}</div>`;
}
function provenanceDetailsHtml(prov) {
  if (!isObj(prov)) return '';
  const raw = typeof prov.raw_text === 'string' ? prov.raw_text : '';
  const extras = Object.entries(prov)
    .filter(([k, v]) => !PROVENANCE_DISPLAY_KEYS.has(k) && !isBlank(v))
    .map(([k, v]) => `<div class="rx-kv"><span>${esc(k)}</span><span>${esc(Array.isArray(v) ? v.join('、') : String(v))}</span></div>`)
    .join('');
  if (!raw && !extras) return '';
  return `<details class="rx-raw"><summary>来源原文与溯源字段</summary><div class="rx-raw-body">${raw ? `<div class="rx-raw-text">${esc(raw)}</div>` : ''}${extras ? `<div class="rx-kv-list">${extras}</div>` : ''}</div></details>`;
}
function techDetailsHtml(payload) {
  const entries = Object.entries(payload).filter(([k, v]) => PAYLOAD_TECH_KEYS.has(k) && k !== 'provenance' && !isBlank(v));
  if (!entries.length) return '';
  const rows = entries.map(([k, v]) => `<div class="rx-kv"><span>${esc(k)}</span><span>${esc(Array.isArray(v) ? v.join('、') : String(v))}</span></div>`).join('');
  return `<details class="rx-raw"><summary>来源资产标识</summary><div class="rx-raw-body"><div class="rx-kv-list">${rows}</div></div></details>`;
}
function deliveryCardHtml({ kind, title, badge, ref, meta, rows, source, details, exclusion }) {
  return `<div class="rx-card">
      <div class="rx-head">
        <span class="rx-kind">${esc(kind)}</span>
        <strong class="rx-title">${esc(title || kind)}</strong>
        ${badge || ''}
        ${ref || ''}
      </div>
      ${meta ? `<div class="rx-meta">${esc(meta)}</div>` : ''}
      <div class="rx-body">${rows || '<div class="rx-text muted">该来源未提供可展示的结构化字段。</div>'}${exclusion || ''}</div>
      ${source || ''}
      ${details || ''}
    </div>`;
}
function formulaCardHtml(f) {
  const facts = f.facts || {};
  const rows = [
    rowHtml('组成', facts.composition ? presenceHtml(facts.composition, 'composition') : valueHtml(f.composition, 'composition')),
    rowHtml('制备', facts.preparation ? presenceHtml(facts.preparation) : ''),
    rowHtml('用法', facts.usage ? presenceHtml(facts.usage) : (f.usage ? `<div class="rx-text">${esc(f.usage)}</div>` : '')),
    rowHtml('方内原始加减', facts.modifications ? modificationHtml(facts.modifications.formulaLocal) : ''),
    rowHtml('来源节点共享加减', facts.modifications ? modificationHtml(facts.modifications.sourceShared) : ''),
    rowHtml('患者个体化加减', facts.modifications ? modificationHtml(facts.modifications.patientSpecific) : ''),
  ].filter(Boolean).join('');
  const ctx = f.case_context;
  const ctxText = ctx ? [
    ctx.disease ? `病名：${ctx.disease}` : '', ctx.syndrome ? `证型：${ctx.syndrome}` : '',
    ctx.treatment ? `治法：${ctx.treatment}` : '', ctx.patient ? `患者：${ctx.patient}` : '',
    ctx.symptoms ? `症状：${ctx.symptoms}` : '', ctx.sourceRef ? `来源：${ctx.sourceRef}` : '',
  ].filter(Boolean).join('\n') : '';
  return deliveryCardHtml({
    kind: '方剂',
    title: f.name,
    badge: `<span class="rx-badge ${esc(f.relation || '')}">${esc(RELATION_LABELS[f.relation] || f.relation || '来源成员')}</span>`,
    ref: f.source_ref ? `<span class="ev-refs">${esc(f.source_ref)}</span>` : '',
    rows,
    details: rawDetailsHtml('来源病例上下文', ctxText),
  });
}
function legacyFormulaCardHtml(f) {
  const items = (f.composition || []).flatMap((x) => splitList(x));
  return deliveryCardHtml({
    kind: '方剂',
    title: f.name,
    badge: `<span class="rx-badge ${esc(f.authority || '')}">${esc(FORMULA_AUTHORITY_LABELS[f.authority] || f.authority || '')}</span>`,
    ref: f.source_id ? `<span class="ev-refs">${esc(f.source_id)}</span>` : '',
    rows: rowHtml('组成', items.length ? chipsHtml(items) : ''),
  });
}
/** SOURCE_BOUND 交付：每个被采纳来源成员渲染一张卡，字段无损，形态与方剂一致。 */
function sourceProductCardHtml(delivery, product) {
  const payload = isObj(product.payload) ? product.payload : {};
  const title = (typeof product.name === 'string' && product.name.trim())
    || (typeof payload.title === 'string' ? payload.title : product.productId);
  const applicability = product.clinicalApplicability || delivery.clinical_applicability;
  const meta = [
    CLEARANCE_LABELS[delivery.execution_clearance] || delivery.execution_clearance,
    APPLICABILITY_LABELS[applicability] || applicability,
  ].filter(Boolean).join(' · ');
  const exclusion = product.qualification === 'CLINICALLY_EXCLUDED'
    ? `<div class="rx-exclusion">临床排除${product.exclusionReason ? `：${esc(product.exclusionReason)}` : ''}</div>` : '';
  return deliveryCardHtml({
    kind: modalityLabel(delivery.outcome),
    title,
    badge: `<span class="rx-badge ${esc(product.qualification || '')}">${esc(RELATION_LABELS[product.qualification] || '来源成员')}</span>`,
    ref: product.productId ? `<span class="ev-refs">${esc(product.productId)}</span>` : '',
    meta,
    rows: objectRowsHtml(payload, new Set(['title', 'name'])),
    source: provenanceLineHtml(payload.provenance),
    details: techDetailsHtml(payload) + provenanceDetailsHtml(payload.provenance),
    exclusion,
  });
}
function advisoryDeliveryCardHtml(d) {
  const rows = [
    rowHtml('适用性', APPLICABILITY_LABELS[d.disposition] ? `<div class="rx-text">${esc(APPLICABILITY_LABELS[d.disposition])}</div>` : ''),
    rowHtml('说明', d.statement ? `<div class="rx-text">${esc(d.statement)}</div>` : ''),
    rowHtml('参考组成', Array.isArray(d.advisory_composition) && d.advisory_composition.length ? chipsHtml(d.advisory_composition) : ''),
    ...(isObj(d.details) ? Object.entries(d.details).filter(([, v]) => !isBlank(v)).map(([k, v]) => rowHtml(PAYLOAD_LABELS[k] || k, valueHtml(v, k))) : []),
    rowHtml('制备', d.preparation ? `<div class="rx-text">${esc(d.preparation)}</div>` : ''),
    rowHtml('用法', d.usage ? `<div class="rx-text">${esc(d.usage)}</div>` : ''),
  ].filter(Boolean).join('');
  return deliveryCardHtml({
    kind: '治疗建议',
    title: d.form || modalityLabel(d.outcome),
    badge: '<span class="rx-badge advisory">模型建议</span>',
    rows,
  });
}

function renderClinical(r, authority) {
  const authorityState = r.formula?.authority || '';
  const badge = authorityState ? `<span class="authority-badge ${esc(authorityState)}">${esc(FORMULA_AUTHORITY_LABELS[authorityState] || authorityState)}</span>` : '';
  const missing = (r.missing_information || []).map((m) => `<li>${esc(m)}</li>`).join('');
  const ev = (refs) => (refs || []).map((x) => `<span class="ev-refs">${esc(x)}</span>`).join('');
  // 置信度可能未给出（UNKNOWN ≠ 0）：未给出就不渲染，绝不显示 0%。
  const confidenceBadge = (value) => (typeof value === 'number' ? `<span class="confidence">${(value * 100).toFixed(0)}%</span>` : '');

  const cards = [];
  // 方剂：committed SourceBundle 的无损投影。UI 只渲染，不按 relation / qualification 再筛选。
  if (Array.isArray(r.formula_set) && r.formula_set.length) {
    cards.push(...r.formula_set.map(formulaCardHtml));
  } else if (r.formula?.name || (r.formula?.composition || []).length) {
    cards.push(legacyFormulaCardHtml(r.formula));
  }
  // 其他来源绑定交付（膏方 / 针灸 / 艾灸 / 耳穴 / 外治 / 成药…）：逐来源成员渲染，一个成员一张卡。
  for (const delivery of (Array.isArray(r.deliveries) ? r.deliveries : [])) {
    if (delivery?.outcome === 'modality:herbal-formula') continue; // 已由 formula_set 无损呈现
    const products = Array.isArray(delivery?.source_bundle?.products) ? delivery.source_bundle.products : [];
    for (const product of products) cards.push(sourceProductCardHtml(delivery, product));
  }
  // 无来源包的治疗交付（模型生成的建议）：与来源交付共用同一套卡片形态。
  for (const delivery of (Array.isArray(r.treatment_deliveries) ? r.treatment_deliveries : [])) {
    cards.push(advisoryDeliveryCardHtml(delivery));
  }
  const deliveryHtml = cards.length
    ? `<div class="rx-section-title">治疗方案</div><div class="rx-list">${cards.join('')}</div>`
    : '';

  return `
    <div class="assistant-block">
      <div class="answer-head"><h3>临床判断</h3>${badge}</div>
      <div class="clinical-line"><span class="k">病名</span><span class="v">${esc(r.disease?.name)}${confidenceBadge(r.disease?.confidence)}${ev(r.disease?.evidence_refs)}</span></div>
      <div class="clinical-line"><span class="k">辨证</span><span class="v">${esc(r.syndrome?.name)}${confidenceBadge(r.syndrome?.confidence)}${ev(r.syndrome?.evidence_refs)}</span></div>
      <div class="clinical-line"><span class="k">治法</span><span class="v">${esc(r.treatment?.text)}${ev(r.treatment?.evidence_refs)}</span></div>
      ${deliveryHtml}
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
      body: JSON.stringify({
        input: text,
        ...(modelCatalog?.active ? {
          modelOptionId: modelCatalog.active.optionId,
          thinking: Boolean(modelCatalog.active.thinking),
          budget: modelCatalog.active.budget || 'off',
        } : {}),
      }),
    });
    if (res.status === 401) { window.location.replace('/login'); return; }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let session = null;
    let failure = '';

    const handle = (event, data) => {
      if (event === 'meta') {
        if (data.asrEnabled === false) $('#mic').classList.add('hidden');
      } else if (event === 'tool') {
        state.liveEvents.push({ type: 'tool', data });
        renderLiveActivity();
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
      <div class="stat-card"><span>活动模型</span><strong style="font-size:14px">${esc(h.llm.label)}</strong><em>${esc(h.llm.channelLabel)} · ${esc(llmThinkingText(h.llm))}</em></div>
      <div class="stat-card"><span>知识索引</span><strong>${h.knowledge.ok ? esc(h.knowledge.docCount) : '—'}</strong><em>${h.knowledge.ok ? esc(h.knowledge.version) : esc(h.knowledge.error)}</em></div>
      <div class="stat-card"><span>语音 ASR</span><strong>${h.asr.enabled ? '可用' : '未配置'}</strong></div>`;
    $('#healthList').innerHTML = `
      <div class="health-row"><span>知识索引</span><b><span class="status-badge ${h.knowledge.ok ? 'ok' : 'bad'}">${h.knowledge.ok ? 'OK' : 'ERROR'}</span></b></div>
      <div class="health-row"><span>活动模型（渠道 / 模型）</span><b>${esc(h.llm.channelLabel)} / ${esc(h.llm.modelId)}</b></div>
      <div class="health-row"><span>推理思考</span><b>${esc(llmThinkingText(h.llm))}</b></div>
      <div class="health-row"><span>思考预算</span><b>${esc(llmBudgetText(h.llm))}</b></div>
      <div class="health-row"><span>模型选择来源</span><b>${esc(h.llm.optionId)}</b></div>
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

/* ---------- 会话：账号与角色 ---------- */
function applySession(user) {
  const roleLabel = user.role === 'admin' ? '管理员' : '医生';
  $('#userChip').innerHTML = `<b>${esc(user.displayName || user.loginName)}</b><span class="role-tag">${roleLabel}</span>`;
  // 调试 / 评测视图属于管理面，医生端不暴露
  const isAdmin = user.role === 'admin';
  $('#viewToggle').classList.toggle('hidden', !isAdmin);
  if (!isAdmin && state.view === 'admin') switchView('user');
}

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* 会话已失效也照样跳转 */ }
  window.location.replace('/login');
});

/* ---------- 右上角：模型 / 推理开关（真实热切换） ----------
 * 切换是服务端事务：POST 后以后端返回的目录快照为准重新渲染，
 * 因此不存在「本地改了、后端没变」的假切换；不可用的模型/开关直接置灰，也不存在死按钮。 */
let modelCatalog = null;
let modelBusy = false;

const THINKING_HINT = {
  toggle: { label: '推理', title: '可开关：关闭后模型直接生成回复' },
  always: { label: '总是思考', title: '该模型无法关闭推理（实测参数无效或会被拒绝）' },
  none: { label: '无推理', title: '该模型不产生推理过程' },
};

/** 健康页展示用：把推理三态翻译成一句人话。 */
function llmThinkingText(active) {
  if (!active) return '—';
  if (active.thinkingMode === 'toggle') return active.thinking ? '开（可关）' : '关（可开）';
  return (THINKING_HINT[active.thinkingMode] || THINKING_HINT.none).label;
}

function thinkingSuffix(option) {
  if (!option.available) return '';
  if (option.thinking === 'none') return ' · 非推理';
  if (option.thinking === 'always') return ' · 总是思考';
  return ' · 可开关推理';
}

/** 思考预算的人话描述：只描述**本次请求真实会发生什么**。 */
function llmBudgetText(active) {
  if (!active) return '—';
  if (!active.budgetSupported) return '该模型忽略此参数';
  if (!active.thinking) return '推理已关（不发送）';
  return active.effectiveBudgetTokens ? `上限 ${active.effectiveBudgetTokens} tok` : '不限制';
}

/**
 * 渲染思考预算档位。
 * 只有「模型实测生效」且「推理已开启」时才可点——其余情况一律禁用并写明原因，
 * 因此不存在「能拖但请求里没有这个参数」的假旋钮。
 */
function renderBudgetControl(catalog) {
  const active = catalog.active;
  const field = $('#budgetField');
  const sel = $('#budgetSelect');

  sel.textContent = '';
  for (const level of catalog.budgetLevels || []) {
    const el = document.createElement('option');
    el.value = level.value;
    el.textContent = level.label;
    sel.appendChild(el);
  }
  sel.value = active.budget || 'off';

  const enabled = Boolean(active.budgetSupported) && Boolean(active.thinking);
  sel.disabled = !enabled;
  field.classList.toggle('disabled', !enabled);

  let title;
  if (!active.budgetSupported) {
    title = '该模型实测会忽略 thinking_budget（请求已发送/未发送均无效果），故不可调';
  } else if (!active.thinking) {
    title = '推理已关闭：本次请求不发送思考预算。开启推理后本档位生效';
  } else if (active.effectiveBudgetTokens) {
    title = `本次请求将发送 thinking_budget=${active.effectiveBudgetTokens}（思考超长即截断）`;
  } else {
    title = '不限制思考长度：本次请求不发送 thinking_budget';
  }
  field.title = title;
  sel.title = title;
}

function renderModelControl(catalog) {
  modelCatalog = catalog;
  const sel = $('#modelSelect');
  const groups = new Map();
  for (const option of catalog.options) {
    if (!groups.has(option.channelLabel)) groups.set(option.channelLabel, []);
    groups.get(option.channelLabel).push(option);
  }
  sel.textContent = '';
  for (const [groupLabel, options] of groups) {
    const group = document.createElement('optgroup');
    group.label = groupLabel;
    for (const option of options) {
      const el = document.createElement('option');
      el.value = option.id;
      el.textContent = `${option.label}${thinkingSuffix(option)}${option.available ? '' : '（未配置密钥）'}`;
      el.disabled = !option.available;
      if (option.measured) el.title = option.measured;
      group.appendChild(el);
    }
    sel.appendChild(group);
  }
  sel.value = catalog.active.optionId;

  const hint = THINKING_HINT[catalog.active.thinkingMode] || THINKING_HINT.none;
  const togglable = catalog.active.thinkingMode === 'toggle';
  const input = $('#thinkingInput');
  const wrap = $('#thinkingSwitch');
  input.checked = Boolean(catalog.active.thinking);
  input.disabled = !togglable;
  wrap.classList.toggle('disabled', !togglable);
  wrap.title = hint.title;
  $('#thinkingLabel').textContent = hint.label;

  renderBudgetControl(catalog);

  sel.title = [
    `${catalog.active.channelLabel} · ${catalog.active.modelId}`,
    `推理：${hint.label}`,
    `思考预算：${llmBudgetText(catalog.active)}`,
    catalog.active.measured || '',
  ].filter(Boolean).join('\n');
}

async function applyModelChange(payload) {
  if (modelBusy) return;
  modelBusy = true;
  $('#modelControl').classList.add('busy');
  try {
    const catalog = await api('/api/models/select', { method: 'POST', body: JSON.stringify(payload) });
    renderModelControl(catalog);
    const hint = THINKING_HINT[catalog.active.thinkingMode] || THINKING_HINT.none;
    const thinkingText = catalog.active.thinkingMode === 'toggle'
      ? `推理${catalog.active.thinking ? '开' : '关'}`
      : hint.label;
    const budgetText = catalog.active.effectiveBudgetTokens ? `｜预算${catalog.active.effectiveBudgetTokens}` : '';
    toast(`已切换：${catalog.active.channelLabel}/${catalog.active.label}｜${thinkingText}${budgetText}`);
  } catch (e) {
    toast(e.message || '模型切换失败');
    // 回滚为后端确认的状态，避免界面与后端不一致。
    if (modelCatalog) renderModelControl(modelCatalog);
  } finally {
    modelBusy = false;
    $('#modelControl').classList.remove('busy');
  }
}

// 换模型时不携带 thinking / budget：让新模型使用它自己的默认值，避免把上一个模型的设置带过去。
$('#modelSelect').addEventListener('change', (e) => applyModelChange({ optionId: e.target.value }));
// 开关推理时带上当前预算档位，使档位在关-开之间被保留（关闭期间不发送，重新开启即生效）。
$('#thinkingInput').addEventListener('change', (e) => applyModelChange({
  optionId: $('#modelSelect').value,
  thinking: e.target.checked,
  budget: $('#budgetSelect').value,
}));
$('#budgetSelect').addEventListener('change', (e) => applyModelChange({ optionId: $('#modelSelect').value, budget: e.target.value }));

async function loadModels() {
  try {
    renderModelControl(await api('/api/models'));
  } catch {
    $('#modelSelect').title = '后端未连接';
  }
}

/* ---------- 启动 ---------- */
(async function boot() {
  try {
    const me = await api('/api/auth/me');
    applySession(me.user);
  } catch {
    return; // 未登录：api() 已跳转登录页
  }
  try {
    const h = await api('/api/health');
    if (!h.asr?.enabled) $('#mic').classList.add('hidden');
  } catch { /* 健康探针失败不阻塞；模型目录单独加载并自行提示 */ }
  await loadModels();
})();

import { createVoiceHub } from './voice.js?v=20260916';
import { seed } from './seed.js?v=20260911';
import { applyPublishedUpdates } from './migrations.js?v=20260911';
const KEY = 'fala-dan-v1';
const icons = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M9 21v-8h6v8"/>',
  book: '<path d="M12 5v16m0-16C8 2 3 3 3 3v16s5-1 9 2c4-3 9-2 9-2V3s-5-1-9 2"/>',
  journal:
    '<rect x="5" y="3" width="15" height="18" rx="2"/><path d="M9 3v18M3 7h4m-4 5h4m-4 5h4m6-10h4m-4 4h4"/>',
  cards:
    '<rect x="7" y="6" width="14" height="15" rx="2"/><path d="m4 17-2-12a2 2 0 0 1 2-2h11M11 11h6m-6 4h4"/>',
  pattern:
    '<rect x="3" y="4" width="7" height="6" rx="1"/><rect x="14" y="14" width="7" height="6" rx="1"/><path d="M7 14v3h3m5-10h3V4M10 7h8v7"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 5 7 7-7 7"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  circleCheck: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  volume: '<path d="m11 4-6 5H2v6h3l6 5zM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  headphones:
    '<path d="M3 15v-3a9 9 0 0 1 18 0v3"/><rect x="2" y="12" width="4" height="8" rx="2"/><rect x="18" y="12" width="4" height="8" rx="2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  edit: '<path d="m15 4 5 5M3 21l5-1L21 7a2 2 0 0 0-5-5L3 15z"/>',
  flag: '<path d="M4 21V3c5-3 9 4 15 0v10c-6 4-10-3-15 0"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  message:
    '<path d="M21 13a3 3 0 0 1-3 3H9l-6 5V5a2 2 0 0 1 2-2h13a3 3 0 0 1 3 3z"/><path d="M7 8h10M7 12h6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',
  leaf: '<path d="M20 3C8 1 1 8 5 16c8 4 16-1 15-13zM3 21l12-12"/>',
  history: '<path d="M3 10a9 9 0 1 1 1 7M3 4v6h6m3-3v6l3 2"/>',
};
const I = (n) => `<svg aria-hidden="true" viewBox="0 0 24 24">${icons[n] || icons.book}</svg>`;
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[x],
  );
let state = structuredClone(seed),
  storageError = false;
try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (validState(parsed)) state = parsed;
    else storageError = true;
  }
} catch {
  storageError = true;
}
const mergedState = applyPublishedUpdates(state);
if (mergedState !== state) {
  state = mergedState;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    storageError = true;
  }
}
const tabs = [
  ['overview', 'Quick review', 'home'],
  ['voice', 'Voice lesson', 'headphones'],
  ['curriculum', 'Living curriculum', 'book'],
  ['lessons', 'Lesson journal', 'journal'],
  ['vocabulary', 'Phrasebook', 'cards'],
  ['patterns', 'Sentence patterns', 'pattern'],
  ['sticky', 'Sticky points', 'flag'],
  ['next', 'Next lesson', 'arrow'],
  ['costs', 'API costs', 'clock'],
];
const levels = ['Planned', 'New', 'Developing', 'Functional', 'Mastered', 'Automatic'];
let view = tabs.some((x) => x[0] === location.hash.slice(1)) ? location.hash.slice(1) : 'overview',
  filter = 'All',
  search = '',
  review = null,
  playSession = 0,
  voiceList = [];
const $ = (s) => document.querySelector(s);
function validState(s) {
  return (
    s &&
    s.schema === 1 &&
    ['phrases', 'lessons', 'issues', 'curriculum', 'patterns', 'reviews'].every(
      (k) => Array.isArray(s[k]) && s[k].length < 5000,
    ) &&
    s.next &&
    typeof s.next === 'object' &&
    s.sources &&
    typeof s.sources === 'object' &&
    s.phrases.every(
      (p) =>
        p &&
        typeof p.id === 'string' &&
        typeof p.pt === 'string' &&
        typeof p.en === 'string' &&
        ['Planned', 'New', 'Developing', 'Functional', 'Mastered', 'Automatic'].includes(p.level),
    ) &&
    s.lessons.every(
      (p) =>
        p && typeof p.id === 'string' && typeof p.title === 'string' && typeof p.date === 'string',
    ) &&
    s.curriculum.every((p) => p && typeof p.id === 'string' && Array.isArray(p.topics)) &&
    s.issues.every((p) => p && typeof p.id === 'string') &&
    s.patterns.every((p) => p && typeof p.id === 'string') &&
    ['goal', 'recap', 'warmup', 'newMaterial', 'roleplay', 'adapt', 'close'].every(
      (k) => typeof s.next[k] === 'string',
    )
  );
}
function persist(message = 'Saving your notebook…') {
  state.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    storageError = false;
  } catch {
    storageError = true;
  }
  voiceHub.save();
  if (message) toast(message);
  return true;
}
function toast(message) {
  const e = $('#toast');
  e.textContent = message;
  e.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => e.classList.remove('show'), 4000);
}
const prettyDate = (s) => {
  if (!s) return 'Not yet';
  const d = new Date(s + 'T12:00:00');
  return isNaN(d)
    ? s
    : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
};
const practiced = () => state.phrases.filter((p) => p.level !== 'Planned');
const mastered = () => state.phrases.filter((p) => ['Mastered', 'Automatic'].includes(p.level));
const activeIssues = () => state.issues.filter((p) => p.status === 'Review');
const tag = (s, type = '') =>
  `<span class="tag ${type || (['Mastered', 'Automatic', 'Resolved'].includes(s) ? 'green' : s === 'Developing' || s === 'Reconstructed' ? 'amber' : s === 'Planned' ? 'neutral' : '')}">${esc(s)}</span>`;
const btn = (label, action, icon = '', cls = '', id = '') =>
  `<button class="btn ${cls}" data-action="${action}"${id ? ` data-id="${esc(id)}"` : ''}>${icon ? I(icon) : ''}${label}</button>`;
function nav(to) {
  view = to;
  filter = 'All';
  search = '';
  location.hash = to;
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
  $('#main').focus({ preventScroll: true });
}
function render() {
  const title = tabs.find((t) => t[0] === view)?.[1] || 'Quick review';
  $('#app').innerHTML =
    `<aside class="sidebar" id="sidebar" aria-label="Main navigation"><a class="logo" href="#overview" data-nav="overview"><span class="logo-mark">${I('message')}</span>fala.</a><div class="brand-caption">Your Portuguese, growing.</div><div class="eyebrow nav-heading">Your learning space</div><nav class="nav">${tabs.map(([id, label, ic]) => `<button data-nav="${id}" class="${view === id ? 'active' : ''}" ${view === id ? 'aria-current="page"' : ''}>${I(ic)}${label}${id === 'sticky' && activeIssues().length ? `<span class="nav-count">${activeIssues().length}</span>` : ''}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="journey-box"><div class="journey-label"><span class="status-dot"></span>At your own pace</div><p>One conversation at a time.<br>Review, repeat, then build.</p></div><div class="user"><div class="avatar">D</div><div><b>Dan’s notebook</b><small>Brazilian Portuguese · Beginner</small></div></div></div></aside><div class="shell"><header class="topbar"><div class="crumb">MY PORTUGUESE <span>/</span><strong>${title}</strong></div><span class="mobile-logo">fala.</span><div class="top-actions"><span class="private">${I('lock')}<span>Private space</span></span><div class="avatar">D</div><button class="mobile-menu" data-action="menu" aria-label="Open navigation" aria-expanded="false" aria-controls="sidebar">${I('menu')}</button></div></header><main id="main" tabindex="-1">${page()}${footer()}</main></div>`;
}
function footer() {
  return `<footer class="footer"><span>${I('leaf')} Made for a little practice between conversations.</span><button class="btn text" data-action="data">${I('circleCheck')}<span data-sync-label>${voiceHub.syncLabel()}</span> · Backup & data</button></footer>`;
}
function page() {
  switch (view) {
    case 'voice':
      return voiceHub.page();
    case 'costs':
      return voiceHub.costs();
    case 'curriculum':
      return curriculumPage();
    case 'lessons':
      return lessonsPage();
    case 'vocabulary':
      return vocabularyPage();
    case 'patterns':
      return patternsPage();
    case 'sticky':
      return stickyPage();
    case 'next':
      return nextPage();
    default:
      return overview();
  }
}
function heading(title, desc, actions = '') {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${desc}</p></div><div class="page-actions">${actions}</div></div>`;
}
function overview() {
  const p = practiced(),
    m = mastered(),
    issues = activeIssues();
  return `<div class="welcome-row"><p class="hello">Bom dia, Dan <span style="color:#9aab78">☀</span></p><p class="date">BRAZILIAN PORTUGUESE <span style="margin:0 7px;color:#c1c9b7">·</span> YOUR PERSONAL NOTEBOOK</p></div>${voiceHub.dashboard()}<section class="stats" aria-label="Your progress"><div class="stat"><div class="stat-icon">${I('cards')}</div><div><strong>${p.length.toString().padStart(2, '0')}</strong><p>Phrases practised</p></div><span class="tiny-label">Your starting collection</span></div><div class="stat"><div class="stat-icon">${I('circleCheck')}</div><div><strong>${m.length.toString().padStart(2, '0')}</strong><p>Confirmed mastered</p></div><span class="tiny-label">${m.length ? 'Growing naturally' : 'Ready to verify'}</span></div><div class="stat"><div class="stat-icon">${I('flag')}</div><div><strong>${issues.length.toString().padStart(2, '0')}</strong><p>Review priorities</p></div><span class="tiny-label">One at a time</span></div></section><section class="dashboard-grid"><div class="panel"><div class="panel-body"><div class="section-head"><h2>Your next conversation</h2>${tag('Ready when you are')}</div><div class="lesson-preview"><div class="eyebrow">Next voice lesson</div><h3>${esc(state.next.title)}</h3><p>${esc(state.next.goal)}</p><div class="meta"><span>${I('clock')}${esc(state.next.duration)}</span><span>${I('headphones')}Speaking first</span></div></div><div class="lesson-footer"><span>Begin with a recap. Build when ready.</span>${btn('View plan', 'go-next', 'arrow', 'text')}</div></div></div><div class="panel"><div class="panel-body"><div class="section-head"><h2>Keep these close</h2>${btn('All sticky points', 'go-sticky', 'arrow', 'text')}</div>${
    issues.length
      ? issues
          .slice(0, 3)
          .map(
            (it, i) =>
              `<div class="issue-preview"><span class="issue-num">0${i + 1}</span><div><h3>${esc(it.title)}</h3><p>${esc(it.cue)}</p></div><button class="round" data-action="issue-detail" data-id="${esc(it.id)}" aria-label="Review ${esc(it.title)}">${I('chevronRight')}</button></div>`,
          )
          .join('')
      : `<div class="empty" style="padding:25px"><h2>A clear path ahead.</h2><p>No open review priorities. Keep revisiting familiar phrases.</p></div>`
  }</div></div></section><div class="source-strip">${I('info')}<p><b>A notebook with an honest starting point.</b> Original curriculum recovered. Earlier notes reconstructed; 9 and 11 September logged from your handoffs.</p>${btn('About the notes', 'sources', 'arrow', 'text')}</div>`;
}
function filterButtons(options) {
  return `<div class="filters" aria-label="Filter items">${options.map((f) => `<button class="filter ${filter === f ? 'active' : ''}" data-filter="${f}" aria-pressed="${filter === f}">${f}</button>`).join('')}</div>`;
}
function searchInput(placeholder) {
  return `<div class="search-wrap">${I('search')}<input type="search" id="search" aria-label="${placeholder}" placeholder="${placeholder}" value="${esc(search)}"></div>`;
}
function audioButtons(id) {
  return `<div class="audio-actions"><button class="round" data-action="speak" data-id="${esc(id)}" aria-label="Listen at natural speed">${I('volume')}</button><button class="btn small" data-action="slow" data-id="${esc(id)}" aria-label="Listen slowly">Slow</button></div>`;
}
function vocabularyPage() {
  return (
    heading(
      'Your phrasebook',
      'Words you’ve met, phrases you’re building, and space for everything that comes next.',
      btn('Listen & repeat', 'listen', 'headphones') +
        btn('Add phrase', 'add-phrase', 'plus', 'primary'),
    ) +
    `<div class="toolbar">${filterButtons(['All', 'Practised', 'Needs review', 'Mastered', 'Planned'])}${searchInput('Find a phrase or meaning…')}</div><div id="filtered">${phraseResults()}</div>`
  );
}
function phraseResults() {
  let items = state.phrases.filter(
    (p) =>
      (filter === 'All' ||
        (filter === 'Practised' && p.level !== 'Planned') ||
        (filter === 'Needs review' && ['Developing', 'New'].includes(p.level)) ||
        (filter === 'Mastered' && ['Mastered', 'Automatic'].includes(p.level)) ||
        (filter === 'Planned' && p.level === 'Planned')) &&
      normalize(p.pt + ' ' + p.en + ' ' + p.category).includes(normalize(search)),
  );
  return `${filter === 'Mastered' ? '<div class="info-box">Mastered means you can use a phrase spontaneously in a short conversation. A successful repetition alone doesn’t establish mastery.</div>' : ''}<p class="count-note">${items.length} phrase${items.length === 1 ? '' : 's'}${filter === 'All' ? ' · Practised and planned are kept separate' : ''}</p><div class="phrase-grid">${items.length ? items.map((p) => `<article class="phrase-card"><div class="card-top"><span class="eyebrow">${esc(p.category)}</span>${tag(p.level)}</div><h2 lang="pt-BR">${esc(p.pt)}</h2><p>${esc(p.en)}</p><div class="card-footer">${audioButtons(p.id)}<button class="btn text small" data-action="edit-phrase" data-id="${esc(p.id)}" aria-label="Edit ${esc(p.pt)}">Details ${I('chevronRight')}</button></div></article>`).join('') : emptyResults(filter === 'Mastered' ? 'Your confidence will grow here.' : 'No phrases found.', filter === 'Mastered' ? 'No phrases are confirmed mastered yet. After a spontaneous conversation, update the level in a phrase’s details.' : 'Try a different word or filter.')}</div>`;
}
function normalize(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
function emptyResults(title, desc) {
  return `<div class="empty">${I('leaf')}<h2>${title}</h2><p>${desc}</p>${btn('Show all', 'clear-filter', 'arrow', 'small')}</div>`;
}
function curriculumPage() {
  return (
    heading(
      'A path, at your pace.',
      'Your living curriculum, recovered from the original document. Lesson ranges guide the journey; recall decides when to move forward.',
      btn('Teaching approach', 'approach', 'book'),
    ) +
    `<div class="info-box"><strong>Start with what you know.</strong> A short recap comes first. If recall is shaky, revisit and simplify. If it’s secure, add variation and natural speed.</div><div class="curriculum-list">${state.curriculum.map((p, i) => `<details class="phase ${p.status === 'In progress' ? 'current' : ''}" ${p.status === 'In progress' ? 'open' : ''}><summary><span class="phase-num">${i + 1}</span><div><h2>${esc(p.title)}</h2><p>${esc(p.range)} · ${esc(p.goal)}</p></div>${tag(p.status)}${I('chevron')}</summary><div class="phase-content"><ul class="topic-list">${p.topics.map((t) => `<li>${I('check')}<span>${esc(t)}</span></li>`).join('')}</ul><div class="phase-notes"><p>${esc(p.notes || 'Ready to shape around your progress.')}</p>${btn('Update phase', 'edit-phase', 'edit', 'small', p.id)}</div></div></details>`).join('')}</div><div class="source-strip">${I('book')}<p><b>Based on your original living curriculum.</b> Phase goals are concise summaries. Dates and completion are not assumed.</p>${btn('Source notes', 'sources', 'arrow', 'text')}</div>`
  );
}
function lessonsPage() {
  return (
    heading(
      'The conversation continues.',
      'What you practised, what felt natural, and what to bring into the next lesson.',
      btn('Add lesson log', 'add-lesson', 'plus', 'primary'),
    ) +
    `<div class="toolbar">${filterButtons(['All', 'Logged', 'Reconstructed'])}${searchInput('Search your lesson notes…')}</div><div id="filtered">${lessonResults()}</div>`
  );
}
function lessonResults() {
  const items = [...state.lessons]
    .sort((a, b) => b.date.localeCompare(a.date))
    .filter(
      (l) =>
        (filter === 'All' || filter === l.source) &&
        normalize(Object.values(l).join(' ')).includes(normalize(search)),
    );
  return `<div class="journal-list">${
    items.length
      ? items
          .map(
            (l, i) =>
              `<article class="journal-card"><div class="journal-top"><div><div class="date">${esc(prettyDate(l.date)).toUpperCase()}</div><h2>${esc(l.title)}</h2><p>${esc(l.duration)}</p></div><div class="page-actions">${tag(l.source)}${btn('Edit', 'edit-lesson', 'edit', 'small', l.id)}</div></div><details ${i === 0 ? 'open' : ''}><summary>Lesson notes & handover ${I('chevron')}</summary><div class="journal-detail"><div class="detail-grid">${[
                ['Focus', l.focus],
                ['Material practised', l.practised],
                ['Mastered independently', l.mastered],
                ['Recurring mistakes', l.mistakes],
                ['Pronunciation sticky points', l.pronunciation],
                ['Unguided role-play', l.roleplay],
              ]
                .map(([k, v]) => `<div><h3>${k}</h3><p>${esc(v || 'Not recorded.')}</p></div>`)
                .join(
                  '',
                )}<div class="full callout"><h3>Bring into the next lesson</h3><p>${esc(l.next || 'Set the next priority after reviewing recall.')}</p></div>${l.notes ? `<div class="full"><h3>Journal notes & context</h3><p>${esc(l.notes)}</p></div>` : ''}</div></div></details></article>`,
          )
          .join('')
      : emptyResults(
          'No lessons in this view.',
          'Your next conversation can become the first logged entry.',
        )
  }</div>`;
}
function patternsPage() {
  return (
    heading(
      'One pattern. More to say.',
      'Build useful sentences without a grammar lecture. Start with the patterns you’ve already practised.',
      btn('Add pattern', 'add-pattern', 'plus'),
    ) +
    `<div class="toolbar">${filterButtons(['All', 'Practised', 'Planned'])}${searchInput('Find a sentence pattern…')}</div><div id="filtered">${patternResults()}</div>`
  );
}
function patternResults() {
  const items = state.patterns.filter(
    (p) =>
      (filter === 'All' ||
        (filter === 'Practised' && p.level !== 'Planned') ||
        (filter === 'Planned' && p.level === 'Planned')) &&
      normalize(p.pt + ' ' + p.en + ' ' + p.use).includes(normalize(search)),
  );
  return `<div class="phrase-grid">${items.length ? items.map((p) => `<article class="phrase-card pattern-card"><div class="card-top"><span class="eyebrow">Sentence pattern</span>${tag(p.level)}</div><h2 lang="pt-BR">${esc(p.pt)}</h2><p>${esc(p.en)}</p><p class="description">${esc(p.use)}</p>${p.example ? `<div class="example"><span lang="pt-BR">${esc(p.example)}</span><small>${esc(p.translation)}</small></div>` : ''}<div class="card-footer"><span class="subtle">${p.level === 'Planned' ? 'Coming later' : 'Build on this'}</span>${btn('Details', 'edit-pattern', 'chevronRight', 'text small', p.id)}</div></article>`).join('') : emptyResults('No patterns found.', 'Try a different search or filter.')}</div>`;
}
function stickyPage() {
  return (
    heading(
      'A little extra attention.',
      'Keep recurring mistakes and pronunciation checks visible, then revisit them in a real conversation.',
      btn('Add sticky point', 'add-issue', 'plus', 'primary'),
    ) +
    `<div class="info-box"><strong>A check, not a verdict.</strong> Earlier reconstructed notes come from transcripts. Notes labelled “Supplied lesson log” reflect your handoffs; recheck pronunciation in the next voice lesson.</div><div class="toolbar">${filterButtons(['All', 'Review', 'Monitor', 'Resolved'])}${searchInput('Find a sticky point…')}</div><div id="filtered">${stickyResults()}</div>`
  );
}
function stickyResults() {
  const items = state.issues.filter(
    (p) =>
      (filter === 'All' || p.status === filter) &&
      normalize(p.title + ' ' + p.description + ' ' + p.type).includes(normalize(search)),
  );
  return `<div class="issues-list">${items.length ? items.map((p) => `<article class="issue-card"><div class="card-top"><span class="eyebrow">${esc(p.type)}</span>${tag(p.status, p.status === 'Review' ? 'amber' : '')}</div><h2>${esc(p.title)}</h2><p>${esc(p.description)}</p><div class="cue"><p><strong>Try this</strong><br>${esc(p.cue)}</p></div><span class="evidence">${esc(p.evidence)}</span><div class="card-footer">${btn('Edit note', 'edit-issue', 'edit', 'text small', p.id)}${btn(p.status === 'Resolved' ? 'Reopen' : 'Mark resolved', p.status === 'Resolved' ? 'reopen-issue' : 'resolve-issue', 'check', 'small', p.id)}</div></article>`).join('') : emptyResults('Nothing needs attention here.', 'Keep listening, use your phrases, and add a note if something feels sticky.')}</div>`;
}
function nextPage() {
  const n = state.next;
  return (
    heading(
      'Your next conversation',
      esc(n.title) + ' · ' + esc(n.duration),
      btn('Edit plan', 'edit-next', 'edit') +
        btn('Start voice lesson', 'go-voice', 'headphones', 'primary') +
        btn('External chat handover', 'handover', 'copy'),
    ) +
    `<div class="next-grid"><section class="panel"><ol class="plan-steps">${[
      ['2–3 min', 'Retrieve before repeating', n.recap],
      ['1–2 min', 'Warm up the sticky sounds', n.warmup],
      ['5–7 min', 'One pattern, a few useful responses', n.newMaterial],
      ['4–5 min', 'Make it a real conversation', n.roleplay],
      ['1–2 min', 'Recap and record', n.close],
    ]
      .map(
        ([t, h, p]) =>
          `<li class="plan-step"><span class="time">${t}</span><div><h3>${h}</h3><p>${esc(p)}</p></div></li>`,
      )
      .join(
        '',
      )}</ol></section><aside class="next-aside"><div class="panel panel-body"><span class="eyebrow">The small win</span><h2>${esc(n.goal)}</h2><p>Sentence pattern: <strong lang="pt-BR">${esc(n.pattern)}</strong></p><span class="source-badge">${I('info')}Proposed plan · not yet taught</span></div><div class="plan-rule"><h3>Let recall set the pace.</h3><p>${esc(n.adapt)}</p></div><div class="panel panel-body"><h3>Keep the thread next time.</h3><p style="margin-top:10px">Start your lesson in Fala to load this plan automatically. Your time target can change as you speak.</p><p style="margin-top:10px">Lessons delivered inside Fala save practice checkpoints, journal notes and next priorities. Separate ChatGPT voice chats still need a handover.</p>${btn('Add a lesson log', 'add-lesson', 'plus', 'small')}</div></aside></div>${n.notes ? `<div class="source-strip">${I('info')}<p>${esc(n.notes)}</p></div>` : ''}`
  );
}
const modal = $('#modal');
function openModal(title, subtitle, body) {
  stopAudio();
  modal.innerHTML = `<div class="modal-header"><div><h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div><button class="close" data-action="close" aria-label="Close dialog">${I('close')}</button></div><div class="modal-body">${body}</div>`;
  if (!modal.open) modal.showModal();
}
function closeModal() {
  stopAudio();
  modal.close();
  review = null;
}
function field(name, label, value = '', type = 'text', full = false, opts = [], hint = '') {
  const input =
    type === 'textarea'
      ? `<textarea id="field-${name}" name="${name}" maxlength="12000" rows="3">${esc(value)}</textarea>`
      : type === 'select'
        ? `<select id="field-${name}" name="${name}">${opts.map((o) => `<option value="${esc(o)}" ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
        : `<input id="field-${name}" name="${name}" type="${type}" value="${esc(value)}" maxlength="${name === 'title' || name === 'goal' ? 240 : 800}" ${['title', 'pt', 'en', 'date'].includes(name) ? 'required' : ''}>`;
  return `<div class="field ${full ? 'full' : ''}"><label for="field-${name}">${label}</label>${input}${hint ? `<small>${hint}</small>` : ''}</div>`;
}
function formBody(kind, id, fields, info = '') {
  return `${info ? `<div class="lesson-form-info">${info}</div>` : ''}<form data-form="${kind}" data-id="${esc(id || '')}"><div class="form-grid">${fields}</div><div class="modal-actions">${btn('Cancel', 'close', '', 'small')}<button type="submit" class="btn primary">${I('check')}Save ${kind === 'lesson' ? 'lesson log' : kind === 'next' ? 'plan' : 'changes'}</button></div><p class="subtle" style="margin:12px 0 0;font-size:10px">Changes sync to your private notebook. Offline edits are kept as a local draft until they can be saved.</p></form>`;
}
function editPhrase(id) {
  const p = state.phrases.find((p) => p.id === id) || {
    pt: '',
    en: '',
    category: 'Greetings',
    level: 'New',
    first: new Date().toISOString().slice(0, 10),
    note: '',
    cue: '',
    source: 'Added by Dan',
  };
  openModal(
    id ? 'Make this phrase your own.' : 'A new phrase for your notebook.',
    'Separate repetition, independent recall and spontaneous conversation.',
    formBody(
      'phrase',
      id,
      field('pt', 'Portuguese', p.pt) +
        field('en', 'English meaning', p.en) +
        field('category', 'Category', p.category) +
        field('level', 'Current level', p.level, 'select', false, levels) +
        field('first', 'First practised', p.first, 'date') +
        field('cue', 'Pronunciation cue', p.cue, 'textarea', true) +
        field('note', 'Practice notes', p.note, 'textarea', true),
      `New: needs a model. Developing: can repeat. Functional: can recall from a cue. Mastered: can use spontaneously. Automatic: flows naturally. ${id ? 'Source: ' + esc(p.source) + '.' : ''}`,
    ),
  );
  const date = modal.querySelector('[name="first"]');
  if (date) date.removeAttribute('required');
}
function editLesson(id) {
  const l = state.lessons.find((l) => l.id === id) || {
    date: new Date().toLocaleDateString('en-CA'),
    title: '',
    duration: '15–20 minutes',
    source: 'Logged',
  };
  openModal(
    id ? 'Your lesson notes' : 'Keep the next lesson connected.',
    'Only record what you actually practised.',
    formBody(
      'lesson',
      id,
      field('date', 'Lesson date', l.date, 'date') +
        field('duration', 'Duration / context', l.duration) +
        field('title', 'Lesson title', l.title, 'text', true) +
        field('focus', 'Focus / sentence pattern', l.focus, 'textarea', true) +
        field('practised', 'Material practised', l.practised, 'textarea', true) +
        field('mastered', 'Mastered independently', l.mastered, 'textarea', true) +
        field('mistakes', 'Recurring mistakes', l.mistakes, 'textarea', true) +
        field('pronunciation', 'Pronunciation sticky points', l.pronunciation, 'textarea', true) +
        field('roleplay', 'Unguided role-play result', l.roleplay, 'textarea', true) +
        field('next', 'Bring into the next lesson', l.next, 'textarea', true) +
        field('notes', 'Journal notes', l.notes, 'textarea', true),
      id && l.source === 'Reconstructed'
        ? 'This entry was reconstructed from conversation context. Editing keeps its source label; use the notes to record what you have verified.'
        : 'Your log will be included in the voice handover. Update phrase levels and sticky points separately so planned material isn’t marked as mastered.',
    ),
  );
}
function editPhase(id) {
  const p = state.curriculum.find((p) => p.id === id);
  if (!p) return;
  openModal(
    'Keep your curriculum living.',
    esc(p.title),
    formBody(
      'phase',
      id,
      field('title', 'Phase title', p.title, 'text', true) +
        field('range', 'Suggested lesson range', p.range) +
        field('status', 'Progress', p.status, 'select', false, [
          'Planned',
          'In progress',
          'Review',
          'Complete',
        ]) +
        field('goal', 'Conversation goal', p.goal, 'text', true) +
        field('topics', 'Topics · one per line', p.topics.join('\n'), 'textarea', true) +
        field('notes', 'Progress notes / next priority', p.notes, 'textarea', true),
    ),
  );
}
function editPattern(id) {
  const p = state.patterns.find((p) => p.id === id) || {
    pt: '',
    en: '',
    use: '',
    example: '',
    translation: '',
    level: 'Planned',
    note: '',
  };
  openModal(
    id ? 'One pattern, more possibilities.' : 'Add a useful sentence pattern.',
    'Keep the example short and useful in speech.',
    formBody(
      'pattern',
      id,
      field('pt', 'Portuguese pattern', p.pt) +
        field('en', 'English meaning', p.en) +
        field('use', 'When to use it', p.use, 'text', true) +
        field('example', 'Example sentence', p.example) +
        field('translation', 'Example meaning', p.translation) +
        field('level', 'Current level', p.level, 'select', true, levels) +
        field('note', 'Teaching / progress note', p.note, 'textarea', true),
    ),
  );
}
function editIssue(id) {
  const p = state.issues.find((p) => p.id === id) || {
    title: '',
    type: 'Pronunciation',
    status: 'Review',
    evidence: 'Added by Dan',
    description: '',
    cue: '',
  };
  openModal(
    id ? 'A note for the next conversation.' : 'Give a sticky point a little attention.',
    'Record what happened and one simple way to revisit it.',
    formBody(
      'issue',
      id,
      field('title', 'Sticky point', p.title, 'text', true) +
        field('type', 'Type', p.type, 'select', false, [
          'Pronunciation',
          'Comprehension',
          'Recall',
          'Recurring mistake',
        ]) +
        field('status', 'Status', p.status, 'select', false, ['Review', 'Monitor', 'Resolved']) +
        field('evidence', 'Evidence / when it happened', p.evidence, 'text', true) +
        field('description', 'What feels sticky?', p.description, 'textarea', true) +
        field('cue', 'Correction cue / practice plan', p.cue, 'textarea', true),
    ),
  );
}
function editNext() {
  const n = state.next;
  openModal(
    'Shape your next lesson.',
    'Keep it hands-free, adaptive and conversation-first.',
    formBody(
      'next',
      '',
      field('title', 'Lesson title', n.title, 'text', true) +
        field('goal', 'The small win', n.goal, 'text', true) +
        field('duration', 'Target duration', n.duration) +
        field('pattern', 'One sentence pattern', n.pattern) +
        field('recap', 'Retrieve before repeating', n.recap, 'textarea', true) +
        field('warmup', 'Pronunciation warm-up', n.warmup, 'textarea', true) +
        field('newMaterial', 'New material · only if ready', n.newMaterial, 'textarea', true) +
        field('roleplay', 'Unguided conversation / role-play', n.roleplay, 'textarea', true) +
        field('adapt', 'How to adapt to recall', n.adapt, 'textarea', true) +
        field('close', 'Spoken recap & journal update', n.close, 'textarea', true) +
        field('notes', 'Planning notes', n.notes, 'textarea', true),
    ),
  );
}
function issueDetail(id) {
  const p = state.issues.find((p) => p.id === id);
  if (!p) return;
  openModal(
    esc(p.title),
    esc(p.type) + ' · ' + esc(p.evidence),
    `<p>${esc(p.description)}</p><div class="info-box"><strong>Try this</strong><br>${esc(p.cue)}</div><div class="modal-actions">${p.phraseId ? btn('Listen to the phrase', 'speak', 'volume', '', p.phraseId) : ''}${btn('Edit note', 'edit-issue', 'edit', '', p.id)}${btn(p.status === 'Resolved' ? 'Reopen' : 'Mark resolved', p.status === 'Resolved' ? 'reopen-issue' : 'resolve-issue', 'check', 'primary', p.id)}</div>`,
  );
}
function sourceModal() {
  openModal(
    'A clear starting point.',
    'Sources checked on 6 September 2026.',
    `<p>${esc(state.sources.note)}</p><a class="source-doc" href="https://chatgpt.com/api/library/files/libfile_0fcdb7713bc8819190c48a51c6c3c0ae/download" target="_blank" rel="noopener">${I('book')}<span>Original living curriculum<small>Brazilian_Portuguese_Living_Curriculum(1).docx · 4 pages</small></span></a><a class="source-doc" href="https://chatgpt.com/api/library/files/libfile_672f8015b4688191ba740147b77f630b/download" target="_blank" rel="noopener">${I('journal')}<span>Original lesson journal<small>Brazilian_Portuguese_Lesson_Journal.docx · baseline template</small></span></a><div class="info-box" style="margin:20px 0 0"><strong>What was reconstructed?</strong><br>Two dated practice summaries, nine practised phrases and four initial pronunciation or comprehension notes. The 9 and 11 September entries and subsequent observations come from your supplied logs. These earlier summaries are not a verified count of completed lessons. The next lesson is a new proposal. No independent mastery is assumed.</div>`,
  );
}
function approachModal() {
  openModal(
    'Conversation comes first.',
    'Your original teaching approach, made easy to carry forward.',
    `<p>Lessons last around 15–20 minutes and use voice while driving. The hub is for reviewing and recording outside the car.</p><div class="detail-grid"><div><h3>Begin with retrieval</h3><p>Read the latest journal and curriculum first. Ask one question at a time and wait. Don’t give the answer before testing recall.</p></div><div><h3>Model, then use</h3><p>Say Portuguese slowly, then naturally. Teach one sentence pattern and roughly five useful phrases, with fewer when needed.</p></div><div><h3>Build a real exchange</h3><p>Move from call-and-response to an everyday conversation. Finish with an unguided role-play.</p></div><div><h3>Keep useful memory</h3><p>Revisit recurring issues in the next 1–3 lessons. Record practice, mastery, errors, pronunciation and the next priority.</p></div></div><div class="info-box" style="margin:22px 0 0"><strong>Progress levels</strong><br>New → Developing → Functional → Mastered → Automatic.<br>Mastered means spontaneous use in a short conversation, not just repeating a model.</div>`,
  );
}
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function dataModal() {
  openModal(
    'Your notebook, kept close.',
    'Private saving and portable backups.',
    `<p><strong>Your notebook syncs across devices.</strong> Voice lessons delivered here save practice checkpoints, a lesson log and the next priorities automatically. The save indicator confirms when changes reach your notebook.</p><p>If the connection drops, a local draft is retained. Conflicting edits are kept for review. Backups include your curriculum, phrase progress, lessons and next plan; API billing records stay with the hub.</p><div class="storage-buttons">${btn('Download backup', 'export', 'download', 'primary')}${btn('Restore a backup', 'import', 'upload')}${btn('Export lesson notes', 'export-notes', 'journal')}<button class="btn" data-voice="download-draft">Download preserved local copy</button></div><input type="file" id="import-file" accept="application/json,.json" hidden><div class="info-box"><strong>Voice in Fala and voice in ChatGPT</strong><br>Fala lessons update this notebook. A separate ChatGPT voice conversation still needs its lesson log brought here. Original Word documents are not changed automatically.</div>`,
  );
}
function handoverText() {
  const latest = [...state.lessons].sort((a, b) => b.date.localeCompare(a.date))[0];
  const n = state.next;
  return `DAN’S BRAZILIAN PORTUGUESE — NEXT VOICE LESSON\nPrepared from the Fala notebook on ${new Date().toLocaleDateString('en-AU')}\n\nTEACHING RULES\n15–20 minutes, hands-free while driving. Everyday conversation, no screen or written exercises. Read this journal, curriculum and next plan first. Ask one question at a time and wait. Test recall before giving the answer. Model slowly, then at natural Brazilian speed. Reduce new content if recall is weak. Revisit open issues in the next 1–3 lessons.\n\nCURRENT CURRICULUM\n${
    state.curriculum
      .filter((p) => p.status === 'In progress' || p.status === 'Review')
      .map((p) => `${p.title}: ${p.topics.join('; ')}. Notes: ${p.notes}`)
      .join('\n') || 'Use the latest lesson entry to select the next phase.'
  }\n\nLATEST JOURNAL\n${latest ? `${prettyDate(latest.date)} — ${latest.title} [${latest.source}]\nFocus: ${latest.focus}\nPractised: ${latest.practised}\nMastered independently: ${latest.mastered}\nRecurring mistakes: ${latest.mistakes}\nPronunciation: ${latest.pronunciation}\nRole-play: ${latest.roleplay}\nBring forward: ${latest.next}\nNotes: ${latest.notes}` : 'No lesson logged yet.'}\n\nPHRASE LEVELS\n${state.phrases.map((p) => `${p.pt} — ${p.en} [${p.level}]${p.note ? ' — ' + p.note : ''}`).join('\n')}\n\nCONFIRMED MASTERED\n${
    mastered()
      .map((p) => p.pt)
      .join('; ') || 'None confirmed yet. Repetition alone is not mastery.'
  }\n\nOPEN STICKY POINTS\n${
    state.issues
      .filter((i) => i.status !== 'Resolved')
      .map((i) => `${i.title} [${i.status}; ${i.evidence}]: ${i.description} Practice: ${i.cue}`)
      .join('\n') || 'None recorded.'
  }\n\nPROPOSED NEXT LESSON\nTitle: ${n.title}\nGoal: ${n.goal}\nPattern: ${n.pattern}\nRecap: ${n.recap}\nWarm-up: ${n.warmup}\nOnly if ready: ${n.newMaterial}\nRole-play: ${n.roleplay}\nAdapt: ${n.adapt}\nClose: ${n.close}\nPlan notes: ${n.notes}\nIf a newer journal recommendation differs from this plan, use that recommendation and adapt the plan before teaching. Planned content has not been completed.\n\nSOURCE LIMITS\n${state.sources.note}\n\nEND OF LESSON\nProvide a concise log with date, focus, material actually practised, independent mastery, recurring mistakes, pronunciation, role-play result and next priority. Dan will add it to the hub outside the car. Do not claim that this hub or a source document was updated automatically.`;
}
function handoverModal() {
  openModal(
    'Pick up the right thread.',
    'Copy this into your Portuguese project chat before starting voice.',
    `<p>Your current lesson notes, phrase levels, sticky points and next plan travel together. This is a handover for your coach; it doesn’t start or connect a voice session automatically.</p><textarea id="handover-text" class="handover" aria-label="Voice lesson handover" readonly>${esc(handoverText())}</textarea><div class="modal-actions">${btn('Download brief', 'download-handover', 'download')}${btn('Copy handover', 'copy-handover', 'copy', 'primary')}</div>`,
  );
}
async function copyHandover() {
  const text = handoverText();
  try {
    await navigator.clipboard.writeText(text);
    toast('Handover copied. Paste it into your Portuguese project chat.');
  } catch {
    const area = $('#handover-text');
    area?.focus();
    area?.select();
    toast('Select and copy the handover above. Clipboard access isn’t available.');
  }
}
async function importData(file) {
  if (!file) return;
  if (file.size > 3000000) {
    toast('This backup is too large. Choose a Fala JSON backup under 3 MB.');
    return;
  }
  try {
    const parsed = JSON.parse(await file.text());
    if (!validState(parsed)) throw new Error('schema');
    openModal(
      'Restore this notebook?',
      'This replaces your synced notebook. Download a backup first if you want to keep both.',
      `<p>The backup contains <strong>${parsed.lessons.length} lesson entries</strong>, <strong>${parsed.phrases.length} phrases</strong> and <strong>${parsed.issues.length} sticky points</strong>.</p><p>Download your current backup first if you want to keep both versions.</p><div class="modal-actions">${btn('Cancel', 'close')}${btn('Back up current', 'export', 'download')}${btn('Restore notebook', 'confirm-import', 'check', 'primary')}</div>`,
    );
    modal._restore = parsed;
  } catch {
    toast('That file isn’t a valid Fala backup. Your current notes are unchanged.');
  }
}
function loadVoices() {
  voiceList = window.speechSynthesis?.getVoices() || [];
}
if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.addEventListener('voiceschanged', loadVoices);
}
const brazilianVoice = () => voiceList.find((v) => /^pt[-_]BR$/i.test(v.lang));
function stopAudio() {
  playSession++;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}
function speechAvailable() {
  loadVoices();
  if (!('speechSynthesis' in window) || !brazilianVoice()) {
    openModal(
      'Brazilian Portuguese audio',
      'Audio uses the Brazilian Portuguese voice available on your device.',
      `<p>This browser hasn’t made a Brazilian Portuguese voice available. The phrase cards and review still work.</p><p>If your device supports it, add a Portuguese (Brazil) speech voice in its language or accessibility settings, then reload this page. You can also use the handover in your regular voice lesson for pronunciation practice.</p><div class="modal-actions">${btn('Back to my notebook', 'close', '', 'primary')}</div>`,
    );
    return false;
  }
  return true;
}
function utter(text, rate = 1, lang = 'pt-BR') {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = rate;
    if (lang === 'pt-BR') u.voice = brazilianVoice();
    else
      u.voice =
        voiceList.find((v) => v.lang === 'en-AU') ||
        voiceList.find((v) => v.lang.startsWith('en')) ||
        null;
    u.onend = () => resolve(true);
    u.onerror = () => resolve(false);
    speechSynthesis.speak(u);
  });
}
function speakPhrase(id, rate = 1) {
  const p = state.phrases.find((p) => p.id === id);
  if (p && speechAvailable()) {
    stopAudio();
    utter(p.pt, rate);
  }
}
function startReview() {
  const p = practiced();
  if (!p.length) {
    toast('Add a practised phrase to start a review.');
    return;
  }
  const flagged = new Set(activeIssues().map((i) => i.phraseId));
  const lastUsed = new Set(state.reviews.at(-1)?.ids || []);
  const sorted = [...p].sort(
    (a, b) =>
      (flagged.has(b.id) ? 3 : 0) +
      (lastUsed.has(b.id) ? 0 : 1) -
      (flagged.has(a.id) ? 3 : 0) -
      (lastUsed.has(a.id) ? 0 : 1),
  );
  review = {
    ids: sorted.slice(0, 5).map((p) => p.id),
    index: 0,
    revealed: false,
    known: 0,
    again: 0,
  };
  drawReview();
}
function drawReview() {
  if (!review) return;
  if (review.index >= review.ids.length) {
    const r = review;
    state.reviews.push({
      date: new Date().toISOString(),
      ids: r.ids,
      known: r.known,
      again: r.again,
    });
    persist('Review saved. A little more familiar.');
    openModal(
      'A little more familiar.',
      'Quick review complete.',
      `<div class="review-card">${I('leaf')}<h2>You showed up.<br>That’s how it grows.</h2><p>${r.known} recalled · ${r.again} to revisit · ${r.ids.length} phrases reviewed</p><div class="info-box">“I recalled it” records a functional self-check. Mastery still needs spontaneous use in conversation.</div><div class="practice-options">${btn('Review again', 'review', 'history')}${btn('View next lesson', 'finish-next', 'arrow', 'primary')}</div></div>`,
    );
    review = null;
    render();
    return;
  }
  const p = state.phrases.find((p) => p.id === review.ids[review.index]);
  openModal(
    'A quick return to what you know.',
    'Read the English cue, then say the Portuguese out loud.',
    `<div class="review-progress"><span>PHRASE ${review.index + 1} OF ${review.ids.length}</span><span>${esc(p.category)}</span></div><div class="review-track"><span style="width:${(review.index / review.ids.length) * 100}%"></span></div><div class="review-card"><h3>How would you say…</h3><h2>${esc(p.en)}</h2>${review.revealed ? `<div class="review-answer"><h2 lang="pt-BR">${esc(p.pt)}</h2><p>${esc(p.cue)}</p>${audioButtons(p.id)}</div><div class="rating">${btn('Needs another go', 'review-again', 'history')}${btn('I recalled it', 'review-known', 'check', 'primary')}</div><p class="subtle">Choose “I recalled it” only if you said it before revealing the answer.<br>This updates your self-assessed recall, not pronunciation or mastery.</p>` : `${btn('Reveal Portuguese', 'reveal', 'cards', 'primary')}<p class="subtle">Try once before you look. No rush.</p>`}</div>`,
  );
}
function rateReview(known) {
  if (!review || !review.revealed) return;
  const p = state.phrases.find((p) => p.id === review.ids[review.index]);
  if (known) {
    review.known++;
    if (['New', 'Developing'].includes(p.level)) p.level = 'Functional';
  } else {
    review.again++;
    p.level = 'Developing';
  }
  p.lastTested = new Date().toISOString().slice(0, 10);
  p.testEvidence = 'Self-assessed quick review';
  persist(null);
  review.index++;
  review.revealed = false;
  drawReview();
}
function listenModal() {
  const p = practiced();
  openModal(
    'Listen, leave a pause, repeat.',
    'A short audio recap of your practised phrases.',
    `<div class="listen-box"><span class="eyebrow">Hands-free listening</span><h2 id="listen-phrase">Your familiar phrases.</h2><p id="listen-meaning">${p.length} phrases · slow, natural, then a pause</p><span class="listen-status" id="listen-status">Ready when you are.</span></div><p>Start this while parked. You’ll hear the English meaning, Portuguese slowly, then naturally, with a four-second pause to repeat. No microphone is used and pronunciation is not assessed.</p><div class="practice-options">${btn('Play recap', 'play-recap', 'play', 'primary')}${btn('Stop audio', 'stop-audio', 'stop')}</div><p style="font-size:10px;margin-top:18px">Requires a Brazilian Portuguese speech voice on your device. Some browsers pause audio when the screen locks.</p>`,
  );
}
async function playRecap() {
  if (!speechAvailable()) return;
  stopAudio();
  const session = playSession;
  const items = practiced();
  const status = $('#listen-status');
  if (!status) return;
  for (let i = 0; i < items.length; i++) {
    if (session !== playSession || !modal.open) return;
    const p = items[i];
    $('#listen-phrase').textContent = p.pt;
    $('#listen-meaning').textContent = p.en;
    status.textContent = `Phrase ${i + 1} of ${items.length} · listen, then repeat`;
    for (const [txt, rate, lang] of [
      [p.en, 1, 'en-AU'],
      [p.pt, 0.72, 'pt-BR'],
      [p.pt, 1, 'pt-BR'],
    ]) {
      if (session !== playSession) return;
      const ok = await utter(txt, rate, lang);
      if (!ok) {
        status.textContent = 'Audio could not play. Tap Play recap to try again.';
        return;
      }
    }
    if (session !== playSession) return;
    status.textContent = 'Your turn · four seconds';
    await new Promise((r) => setTimeout(r, 4000));
  }
  if (session === playSession && $('#listen-status'))
    $('#listen-status').textContent = 'Recap complete. Até a próxima!';
}
function handleAction(action, id) {
  switch (action) {
    case 'menu': {
      const open = $('#sidebar').classList.toggle('open');
      $('.mobile-menu').setAttribute('aria-expanded', open);
      break;
    }
    case 'close':
      closeModal();
      break;
    case 'go-next':
      nav('next');
      break;
    case 'go-voice':
      nav('voice');
      break;
    case 'go-sticky':
      nav('sticky');
      break;
    case 'finish-next':
      closeModal();
      nav('next');
      break;
    case 'sources':
      sourceModal();
      break;
    case 'approach':
      approachModal();
      break;
    case 'data':
      dataModal();
      break;
    case 'add-phrase':
      editPhrase();
      break;
    case 'edit-phrase':
      editPhrase(id);
      break;
    case 'add-pattern':
      editPattern();
      break;
    case 'edit-pattern':
      editPattern(id);
      break;
    case 'edit-phase':
      editPhase(id);
      break;
    case 'add-lesson':
      editLesson();
      break;
    case 'edit-lesson':
      editLesson(id);
      break;
    case 'add-issue':
      editIssue();
      break;
    case 'edit-issue':
      editIssue(id);
      break;
    case 'issue-detail':
      issueDetail(id);
      break;
    case 'edit-next':
      editNext();
      break;
    case 'resolve-issue':
    case 'reopen-issue': {
      const p = state.issues.find((p) => p.id === id);
      if (p) {
        p.status = action === 'resolve-issue' ? 'Resolved' : 'Review';
        persist(
          p.status === 'Resolved'
            ? 'Marked resolved. You can reopen this at any time.'
            : 'Added back to your review priorities.',
        );
        if (modal.open) closeModal();
        render();
      }
      break;
    }
    case 'handover':
      handoverModal();
      break;
    case 'copy-handover':
      copyHandover();
      break;
    case 'download-handover':
      download('Fala-Next-Voice-Lesson.txt', handoverText(), 'text/plain');
      toast('Voice brief downloaded.');
      break;
    case 'export':
      download(
        'Fala-Notebook-' + new Date().toISOString().slice(0, 10) + '.json',
        JSON.stringify(state, null, 2),
        'application/json',
      );
      toast('Notebook backup downloaded.');
      break;
    case 'export-notes':
      download('Fala-Lesson-Journal.md', exportNotes(), 'text/markdown');
      toast('Lesson journal exported.');
      break;
    case 'import':
      $('#import-file')?.click();
      break;
    case 'confirm-import':
      if (modal._restore) {
        state = applyPublishedUpdates(modal._restore);
        modal._restore = null;
        persist('Restored notebook queued for syncing.');
        closeModal();
        render();
      }
      break;
    case 'clear-filter':
      filter = 'All';
      search = '';
      render();
      break;
    case 'review':
      startReview();
      break;
    case 'reveal':
      if (review) {
        review.revealed = true;
        drawReview();
      }
      break;
    case 'review-again':
      rateReview(false);
      break;
    case 'review-known':
      rateReview(true);
      break;
    case 'speak':
      speakPhrase(id);
      break;
    case 'slow':
      speakPhrase(id, 0.72);
      break;
    case 'speak-intro':
      if (speechAvailable()) {
        stopAudio();
        utter('Oi, bom dia. Eu sou Dan.');
      }
      break;
    case 'listen':
      listenModal();
      break;
    case 'play-recap':
      playRecap();
      break;
    case 'stop-audio':
      stopAudio();
      if ($('#listen-status'))
        $('#listen-status').textContent = 'Audio stopped. Tap Play recap to start again.';
      break;
  }
}
function exportNotes() {
  return `# Dan’s Brazilian Portuguese notebook\n\nExported ${new Date().toLocaleDateString('en-AU')}\n\n## Source notes\n${state.sources.note}\n\n## Living curriculum\n${state.curriculum.map((p) => `### ${p.title} · ${p.status}\n${p.range}\n${p.topics.map((t) => '- ' + t).join('\n')}\n${p.notes}`).join('\n\n')}\n\n## Lesson journal\n${[
    ...state.lessons,
  ]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(
      (l) =>
        `### ${prettyDate(l.date)} — ${l.title} [${l.source}]\n\n${[
          ['Focus', l.focus],
          ['Practised', l.practised],
          ['Mastered independently', l.mastered],
          ['Recurring mistakes', l.mistakes],
          ['Pronunciation', l.pronunciation],
          ['Role-play', l.roleplay],
          ['Next priority', l.next],
          ['Notes', l.notes],
        ]
          .map(([k, v]) => `**${k}:** ${v || 'Not recorded.'}`)
          .join('\n\n')}`,
    )
    .join(
      '\n\n',
    )}\n\n## Phrase tracker\n${state.phrases.map((p) => `- ${p.pt} — ${p.en} [${p.level}]. ${p.note}`).join('\n')}\n\n## Sticky points\n${state.issues.map((i) => `- **${i.title}** [${i.status}; ${i.evidence}]: ${i.description}\n  Practice: ${i.cue}`).join('\n')}\n\n## Next voice lesson handover\n${handoverText()}`;
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action],[data-nav],[data-filter]');
  if (!el) return;
  if (el.dataset.nav) {
    e.preventDefault();
    nav(el.dataset.nav);
  } else if (el.dataset.filter) {
    filter = el.dataset.filter;
    render();
  } else {
    if (el.tagName === 'BUTTON') e.preventDefault();
    handleAction(el.dataset.action, el.dataset.id);
  }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'search') {
    search = e.target.value;
    const renderers = {
      vocabulary: phraseResults,
      lessons: lessonResults,
      patterns: patternResults,
      sticky: stickyResults,
    };
    if (renderers[view]) $('#filtered').innerHTML = renderers[view]();
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'import-file') importData(e.target.files?.[0]);
});
document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  if (!form.reportValidity()) return;
  const val = Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v).trim()]));
  const id = form.dataset.id || crypto.randomUUID();
  const kind = form.dataset.form;
  const map = {
    phrase: 'phrases',
    pattern: 'patterns',
    lesson: 'lessons',
    phase: 'curriculum',
    issue: 'issues',
  };
  if (kind === 'next') {
    state.next = { ...state.next, ...val };
  } else {
    const list = state[map[kind]];
    const index = list.findIndex((p) => p.id === id);
    const old = index >= 0 ? list[index] : {};
    const extra =
      kind === 'phrase'
        ? { source: old.source || 'Added by Dan' }
        : kind === 'lesson'
          ? { source: old.source || 'Logged' }
          : kind === 'phase'
            ? {
                topics: val.topics
                  .split('\n')
                  .map((t) => t.trim())
                  .filter(Boolean),
              }
            : {};
    const item = { ...old, ...val, ...extra, id };
    if (index >= 0) list[index] = item;
    else list.push(item);
    if (kind === 'lesson' && item.source === 'Logged' && item.next)
      state.next.notes = `Latest journal recommendation (${prettyDate(item.date)}): ${item.next}\nReview this recommendation and adjust the proposed plan before teaching.`;
  }
  persist();
  closeModal();
  render();
});
modal.addEventListener('cancel', () => {
  stopAudio();
  review = null;
});
modal.addEventListener('click', (e) => {
  if (e.target === modal) {
    const r = modal.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
      closeModal();
  }
});
window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  if (tabs.some((t) => t[0] === v) && view !== v) {
    view = v;
    filter = 'All';
    search = '';
    render();
  }
});
window.addEventListener('pagehide', stopAudio);
window.addEventListener('storage', (e) => {
  if (e.key === KEY && e.newValue) {
    try {
      const updated = JSON.parse(e.newValue);
      if (validState(updated)) {
        if (modal.open) {
          toast('Another tab updated the notebook. Close this dialog and reload before saving.');
          return;
        }
        state = applyPublishedUpdates(updated);
        render();
        toast('Notebook refreshed from your other tab.');
      }
    } catch {}
  }
});
const voiceHub = createVoiceHub({
  getState: () => state,
  setState: (next) => {
    if (validState(next)) {
      state = applyPublishedUpdates(next);
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch {
        storageError = true;
      }
    }
  },
  render,
  toast,
  navigate: nav,
  stopAudio,
  onReview: startReview,
});
render();
void voiceHub.boot();

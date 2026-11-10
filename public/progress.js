// Progress and history screens. Everything here is computed from the
// practice record, the session index and the phrase list; nothing is
// written prose.
import { progressGroups, challenges, buildLessonPlan, cueText, MODES } from './lib/plan.js';
import { FEEDBACK_TAGS } from './lib/tutor.js';

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const RESULT_LABEL = {
  independent: 'without help',
  prompted: 'needed a hint',
  repeated: 'repeated after the model',
  not_recalled: 'not recalled',
  unclear: 'unclear',
};
const dot = (r) =>
  `<i class="dot ${r === 'independent' ? 'ok' : r === 'prompted' ? 'mid' : r === 'repeated' ? '' : 'bad'}" title="${esc(RESULT_LABEL[r] || r)}"></i>`;
const shortDate = (s) => {
  if (!s) return '—';
  const d = new Date(s + 'T12:00:00');
  return isNaN(d) ? s : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
};
export const modeLabel = (mode) => (MODES[mode] || MODES.lesson).label;
export const scoreLine = (score) =>
  score && score.asked ? `${score.unaided} of ${score.asked} without help` : 'No practice recorded';

export function challengeCards(notebook, practice, lessons, now = Date.now(), limit = 4) {
  return `<div class="challenge-grid">${challenges(notebook, practice, lessons, now)
    .slice(0, limit)
    .map(
      (c) =>
        `<article class="challenge ${c.done ? 'done' : ''}"><h3>${esc(c.title)}</h3><p>${esc(c.detail)}</p><div class="cost-track" role="progressbar" aria-valuemin="0" aria-valuemax="${c.target}" aria-valuenow="${c.progress}" aria-label="${esc(c.title)}"><i style="width:${Math.min(100, (c.progress / c.target) * 100)}%"></i></div></article>`,
    )
    .join('')}</div>`;
}

// "This session will cover": the same plan the tutor is given.
export function planPreview(
  notebook,
  practice,
  { mode = 'lesson', minutes = 15, now = Date.now() } = {},
) {
  const plan = buildLessonPlan(notebook, practice, { mode, minutes, now, seed: 1 });
  const list = (items, fn) =>
    `<ol class="plan-list">${items.map((i) => `<li>${fn(i)}</li>`).join('')}</ol>`;
  const pt = (i) => `<span lang="pt-BR">${esc(i.pt)}</span>`;
  if (mode === 'quiz')
    return `<p>${plan.quiz.length} quick questions on what you know, in a shuffled order, with a score at the end. In the mix:</p>${list(plan.quiz, pt)}`;
  if (mode === 'challenge')
    return `<p>A short role-play in Portuguese. The aim is to use these without a hint:</p>${list(plan.scene.targets, (i) => `${pt(i)} <small>${esc(i.en)}</small>`)}`;
  const fresh = plan.newPhrases.length
    ? plan.newPhrases.map((p) => `${pt(p)} <small>${esc(p.en)}</small>`).join(', ')
    : 'none this time';
  return `<p><strong>1. Recall.</strong> You will be asked how to say:</p>${list(plan.review, (i) => `${esc(cueText(i))}${i.trouble ? ' <small>needs work</small>' : ''}`)}<p><strong>2. One new phrase,</strong> only if recall goes well: ${fresh}.</p><p><strong>3. Short conversation</strong> using ${plan.scene.targets.map(pt).join(', ')}.</p>`;
}

function phraseList(title, hint, rows, empty) {
  const body = rows.length
    ? `<ul class="progress-list">${rows
        .map(
          (s) =>
            `<li><span lang="pt-BR">${esc(s.pt)}</span><small>${esc(s.en)}</small><span class="dots">${s.recent.map(dot).join('')}</span></li>`,
        )
        .join('')}</ul>`
    : `<p class="subtle">${empty}</p>`;
  return `<div class="panel panel-body progress-col"><h2>${title} <span class="count">${rows.length}</span></h2><p class="voice-small">${hint}</p>${body}</div>`;
}

function sessionCard(l, { practice, fx, open, loaded, busy }) {
  const attempts = practice.filter((p) => p.sessionId === l.id);
  const isOpen = open === l.id;
  const tags = (l.feedback?.tags || []).map((t) => FEEDBACK_TAGS[t] || t);
  const said = loaded[l.id];
  const minutes = Math.max(
    0,
    Math.round(((l.ended || l.lastSeen || l.started) - l.started) / 60000),
  );
  const result = l.score?.asked
    ? scoreLine(l.score)
    : l.checkpoints
      ? `${l.checkpoints} checkpoints`
      : 'No practice recorded';
  const head = `<button class="history-head" data-voice="toggle-session" data-id="${esc(l.id)}" aria-expanded="${isOpen}"><span class="date">${esc(shortDate(l.date))}</span><strong>${esc(modeLabel(l.mode))}</strong><span>${esc(result)}</span><span class="subtle">${minutes} min · A$${((l.usd || 0) * fx).toFixed(2)}</span></button>`;
  if (!isOpen) return `<article class="history-item">${head}</article>`;
  const tries = attempts.length
    ? `<ul class="progress-list">${attempts
        .map(
          (a) =>
            `<li>${dot(a.result)}<span lang="pt-BR">${esc(a.pt)}</span><small>${esc(RESULT_LABEL[a.result] || a.result)}${a.context === 'conversation' ? ' · in conversation' : a.context === 'meaning' ? ' · meaning check' : ''}${a.note ? ' · ' + esc(a.note) : ''}</small></li>`,
        )
        .join('')}</ul>`
    : '<p class="subtle">Nothing was practised in this session.</p>';
  const feedback = l.feedback
    ? `<p class="voice-small">Your feedback: ${esc(l.feedback.rating === 'good' ? 'Good' : tags.join(', ') || 'noted')}${l.feedback.note ? ' · “' + esc(l.feedback.note) + '”' : ''}</p>`
    : '';
  const transcript = said
    ? `<ol class="said">${said.map((t) => `<li><strong>${esc(t.speaker)}</strong> ${esc(t.text)}</li>`).join('') || '<li>No transcript was kept.</li>'}</ol>`
    : '';
  const saidButton = said
    ? ''
    : `<button class="btn small" data-voice="show-said" data-id="${esc(l.id)}" ${busy === 'said:' + l.id ? 'disabled' : ''}>What the tutor said</button>`;
  const writeButton =
    attempts.length && !l.journal
      ? `<button class="btn small" data-voice="write-up" data-id="${esc(l.id)}" ${busy === 'write:' + l.id ? 'disabled' : ''}>${busy === 'write:' + l.id ? 'Writing…' : 'Write a journal entry'}</button>`
      : '';
  const written = l.journal ? '<span class="subtle">Journal entry written</span>' : '';
  return `<article class="history-item">${head}<div class="history-body">${tries}${feedback}${transcript}<div class="voice-actions">${saidButton}${writeButton}${written}</div></div></article>`;
}

export function progressPage({
  notebook,
  practice,
  lessons,
  fx = 1,
  now = Date.now(),
  open = null,
  loaded = {},
  busy = '',
}) {
  if (!notebook) return '';
  const g = progressGroups(notebook, practice, now);
  const tested = g.stats.filter((s) => s.tests);
  const unaided = tested.reduce((n, s) => n + s.unaided, 0);
  const total = tested.reduce((n, s) => n + s.tests, 0);
  const sessions = [...lessons].sort((a, b) => (b.started || 0) - (a.started || 0));
  const table = g.stats
    .filter((s) => s.status !== 'planned')
    .sort((a, b) => b.priority - a.priority)
    .map(
      (s) =>
        `<tr><td><span lang="pt-BR">${esc(s.pt)}</span><small>${esc(s.en)}</small></td><td><span class="dots">${s.recent.map(dot).join('') || '<small>not tested yet</small>'}</span></td><td>${s.tests ? `${s.unaided}/${s.tests}` : '—'}</td><td>${s.conversationDays ? `${s.conversationDays} day${s.conversationDays === 1 ? '' : 's'}` : '—'}</td><td>${esc(shortDate(s.lastDate))}</td><td>${esc(s.level)}</td></tr>`,
    )
    .join('');
  const history = sessions.length
    ? sessions.map((l) => sessionCard(l, { practice, fx, open, loaded, busy })).join('')
    : '<p class="subtle">No voice sessions yet. Your first one will appear here.</p>';
  const coming =
    g.planned
      .slice(0, 5)
      .map((p) => `<span lang="pt-BR">${esc(p.pt)}</span>`)
      .join(', ') || 'nothing planned';
  const lead = total
    ? `${unaided} of ${total} recall tests without help so far.`
    : 'Your first session will start filling this in.';
  return `<div class="page-heading"><div><h1>What’s working, what isn’t.</h1><p>Built from every recorded attempt. ${lead}</p></div></div><h2 class="section-title">Challenges</h2>${challengeCards(notebook, practice, lessons, now)}<div class="progress-cols">${phraseList('Working', 'Said without help twice running.', g.working, 'Nothing here yet. Two clean recalls in a row moves a phrase in.')}${phraseList('Nearly there', 'Mixed results. One more clean recall helps.', g.shaky, 'Nothing in between right now.')}${phraseList('Not sticking', 'Missed more than once recently. Asked first next time.', g.struggling, 'Nothing is stuck.')}</div><section class="panel usage-panel"><div class="cost-heading"><h2>Every phrase</h2><span class="voice-small">${g.untested.length} not yet tested by voice · ${g.planned.length} still to come</span></div><div class="usage-table-wrap"><table class="usage-table progress-table"><thead><tr><th>Phrase</th><th>Last tries</th><th>Unaided</th><th>In conversation</th><th>Last tested</th><th>Level</th></tr></thead><tbody>${table}</tbody></table></div><p class="voice-small"><i class="dot ok"></i> without help <i class="dot mid"></i> needed a hint <i class="dot bad"></i> missed or unclear. Coming next: ${coming}.</p></section><h2 class="section-title">Session history</h2><div class="history-list">${history}</div>`;
}

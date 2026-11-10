export const PRICING_VERSION = 'openai-2026-09-16';
export const RATES = {
  'gpt-realtime-2.1': {
    audioIn: 32,
    audioOut: 64,
    audioCached: 0.4,
    textIn: 4,
    textOut: 24,
    textCached: 0.4,
  },
  'gpt-realtime-2.1-mini': {
    audioIn: 10,
    audioOut: 20,
    audioCached: 0.3,
    textIn: 0.6,
    textOut: 2.4,
    textCached: 0.06,
  },
  'gpt-5.6-luna': { textIn: 0.2, textOut: 1.2, textCached: 0.02 },
};
export const DEFAULT_SETTINGS = {
  model: 'gpt-realtime-2.1',
  minutes: 20,
  budgetAud: 60,
  usdToAud: 1 / 0.7122,
  fxDate: '2026-09-15',
  // quick | balanced | patient: how soon the tutor replies once Dan stops.
  pace: 'quick',
  // near (phone close) | far (on the dash, speakerphone).
  mic: 'near',
  // Write a journal entry with the notes model after each lesson.
  recap: false,
};
export const SUMMARY_MODEL = 'gpt-5.6-luna';
const num = (n) => (Number.isFinite(Number(n)) ? Math.max(0, Number(n)) : 0);
export function priceUsage(model, usage, realtime = true) {
  const r = RATES[model];
  if (!r) throw new Error('Unknown model rate');
  const i = usage?.input_token_details || usage?.input_tokens_details || {};
  const o = usage?.output_token_details || usage?.output_tokens_details || {};
  const c = i.cached_tokens_details || {};
  let audioIn = realtime ? num(i.audio_tokens) : 0;
  let textIn = realtime ? num(i.text_tokens) : num(usage?.input_tokens);
  const cachedAudio = Math.min(audioIn, num(c.audio_tokens));
  const cachedText = Math.min(
    textIn,
    c.text_tokens === undefined
      ? Math.max(0, num(i.cached_tokens) - cachedAudio)
      : num(c.text_tokens),
  );
  const audioOut = realtime ? num(o.audio_tokens) : 0;
  // Some models report reasoning separately from the modality breakdown.
  const textOut = realtime
    ? Math.max(num(o.text_tokens), num(usage?.output_tokens) - audioOut)
    : num(usage?.output_tokens);
  const unclassified = Math.max(0, num(usage?.input_tokens) - audioIn - textIn);
  const incomplete =
    realtime && (unclassified > 0 || (num(i.cached_tokens) > 0 && !i.cached_tokens_details));
  // Missing modality information is disclosed; never silently show a known-zero bill.
  textIn += unclassified;
  const usd =
    ((audioIn - cachedAudio) * (r.audioIn || 0) +
      cachedAudio * (r.audioCached || 0) +
      audioOut * (r.audioOut || 0) +
      (textIn - cachedText) * r.textIn +
      cachedText * r.textCached +
      textOut * r.textOut) /
    1e6;
  return {
    usd,
    incomplete,
    breakdown: { audioIn, audioOut, cachedAudio, textIn, textOut, cachedText },
  };
}
export function validNotebook(s) {
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
export function validateSettings(v) {
  if (!RATES[v.model] || !v.model.startsWith('gpt-realtime-'))
    throw new Error('Choose a supported voice model.');
  if (!Number.isInteger(v.minutes) || v.minutes < 5 || v.minutes > 55)
    throw new Error('Choose 5–55 minutes.');
  if (!Number.isFinite(v.budgetAud) || v.budgetAud < 5 || v.budgetAud > 500)
    throw new Error('Set a monthly budget between A$5 and A$500.');
  if (!Number.isFinite(v.usdToAud) || v.usdToAud < 0.1 || v.usdToAud > 10)
    throw new Error('Enter a valid USD to AUD conversion.');
  const merged = { ...DEFAULT_SETTINGS, ...v };
  if (!['quick', 'balanced', 'patient'].includes(merged.pace))
    throw new Error('Choose a reply speed.');
  if (!['near', 'far'].includes(merged.mic)) throw new Error('Choose a microphone position.');
  merged.recap = !!merged.recap;
  return merged;
}
// The tutor reports an attempt by phrase id; the Portuguese and English come
// from the phrase list so the record cannot drift from the notebook.
export function validateAttempt(a, phrases = []) {
  const str = (v, n) => typeof v === 'string' && v.length <= n;
  if (!a) throw new Error('Invalid practice evidence.');
  const id = a.id || a.phraseId || '';
  const phrase = phrases.find((p) => p.id === id);
  const pt = phrase ? phrase.pt : a.pt;
  const en = phrase ? phrase.en : a.en;
  if (id && phrases.length && !phrase && !(str(a.pt, 200) && a.pt.trim()))
    throw new Error('Unknown phrase id. Use an id from the list.');
  if (
    !str(pt, 200) ||
    !pt.trim() ||
    !str(en, 300) ||
    !en.trim() ||
    !str(id, 100) ||
    !str(a.heard || '', 1000) ||
    !str(a.note || '', 1500) ||
    !['independent', 'prompted', 'repeated', 'not_recalled', 'unclear'].includes(a.result) ||
    !['isolated', 'conversation', 'meaning'].includes(a.context) ||
    !['clear', 'needs_work', 'uncertain'].includes(a.pronunciation)
  )
    throw new Error('Invalid practice evidence.');
  return {
    phraseId: id,
    pt: pt.trim(),
    en: en.trim(),
    heard: a.heard || '',
    result: a.result,
    context: a.context,
    pronunciation: a.pronunciation,
    note: (a.note || '').slice(0, 300),
  };
}
const norm = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
export const sydneyDate = (date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
export function monthStart(now = Date.now()) {
  // Count the local calendar month; AU UTC offset is determined by Intl for its first day.
  const d = sydneyDate(new Date(now));
  const utc = Date.parse(d.slice(0, 7) + '-01T00:00:00Z');
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Australia/Sydney',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(utc));
  return utc - Number(local) * 3600000;
}
const labelOf = (mode) =>
  ({ quiz: 'Quick quiz', challenge: 'Conversation challenge' })[mode] || 'Lesson';

// A plain record of a session, built only from its checkpoints. Used for
// history, and as the journal entry whenever a written recap is not wanted
// or the notes model is unavailable.
export function buildSummary(session, attempts, score, mode = 'lesson') {
  const unique = [...new Set(attempts.map((a) => a.pt))];
  const trouble = attempts.filter((a) =>
    ['prompted', 'not_recalled', 'unclear'].includes(a.result),
  );
  const pron = attempts.filter((a) => a.pronunciation === 'needs_work');
  const list = (items) => [...new Set(items)].join('; ');
  const title = !attempts.length
    ? 'No practice recorded'
    : `${labelOf(mode)}: ${score.unaided} of ${score.asked} without help`;
  return {
    title,
    focus: `${labelOf(mode)}${session.status === 'interrupted' ? ' (interrupted)' : ''}`,
    practised: list(unique) || 'Nothing recorded.',
    mastered: list(score.strongest) || 'Nothing recalled without help this time.',
    mistakes:
      list(
        trouble.map((a) => `${a.pt} (${a.result.replace('_', ' ')}${a.note ? ': ' + a.note : ''})`),
      ) || 'None recorded.',
    pronunciation:
      list(pron.map((a) => `${a.pt}${a.note ? ': ' + a.note : ''}`)) || 'Nothing flagged.',
    roleplay:
      list(
        attempts
          .filter((a) => a.context === 'conversation' && a.result === 'independent')
          .map((a) => a.pt),
      ) || 'None used unaided in conversation.',
    next: score.weakest.length
      ? `Keep practising: ${list(score.weakest)}.`
      : 'Recall was secure. Ready for something new.',
    notes: `Built from ${attempts.length} recorded checkpoint${attempts.length === 1 ? '' : 's'}.`,
  };
}
export const SUMMARY_KEYS = [
  'title',
  'focus',
  'practised',
  'mastered',
  'mistakes',
  'pronunciation',
  'roleplay',
  'next',
  'notes',
];
export const validSummary = (s) =>
  !!s && SUMMARY_KEYS.every((k) => typeof s[k] === 'string' && s[k].length < 12000);

// Updates phrase levels and sticky points from one session's checkpoints.
// "Meaning" checks (Portuguese to English) are recorded but do not move a
// phrase's level, which is about being able to say it.
export function applyProgress(notebook, session, attempts, priorAttempts = []) {
  const s = structuredClone(notebook);
  const date = sydneyDate(new Date(session.started));
  const learned = [];
  const spoken = attempts.filter((a) => a.context !== 'meaning');
  const done = new Set();
  for (const a of spoken) {
    let p =
      s.phrases.find((p) => p.id === a.phraseId) ||
      s.phrases.find((p) => norm(p.pt) === norm(a.pt));
    if (!p) {
      p = {
        id: 'phrase-' + session.id.slice(0, 8) + '-' + s.phrases.length,
        pt: a.pt,
        en: a.en,
        category: 'Conversation',
        level: 'New',
        first: date,
        source: 'Voice lesson checkpoint',
        note: '',
        cue: '',
      };
      s.phrases.push(p);
    }
    if (done.has(p.id)) continue;
    done.add(p.id);
    const same = spoken.filter((t) => t.phraseId === p.id || norm(t.pt) === norm(p.pt));
    const hasFailure = same.some((t) => ['not_recalled', 'prompted', 'unclear'].includes(t.result));
    const clean = same.some((t) => t.result === 'independent' && t.pronunciation === 'clear');
    // A phrase met for the first time today stays Developing however well
    // the first recall went.
    const fresh = ['Planned', 'New'].includes(p.level);
    if (fresh || hasFailure) p.level = 'Developing';
    else if (clean && !['Mastered', 'Automatic'].includes(p.level)) p.level = 'Functional';
    if (!p.first) p.first = date;
    const history = [
      ...priorAttempts,
      ...same.map((t) => ({ ...t, sessionId: session.id, date })),
    ].filter((t) => t.phraseId === p.id || norm(t.pt) === norm(p.pt));
    const days = (context) =>
      new Set(
        history
          .filter(
            (t) =>
              t.result === 'independent' && t.context === context && t.pronunciation === 'clear',
          )
          .map((t) => t.date),
      ).size;
    if (!fresh && !hasFailure && clean && days('conversation') >= 2 && days('isolated') >= 2) {
      p.level = 'Mastered';
      learned.push(p.pt);
    }
    p.lastTested = date;
    p.testEvidence = `Voice session ${date}: ${same.map((t) => t.result + ' / ' + t.context).join('; ')}`;
    const notes = same
      .map((t) => t.note)
      .filter(Boolean)
      .filter((x, i, arr) => arr.indexOf(x) === i);
    if (notes.length) p.note = `${date}: ${notes.join(' ')}`;
    const existingIssue = s.issues.find((i) => i.phraseId === p.id && i.status !== 'Resolved');
    const issueId = existingIssue?.id || 'voice-review-' + p.id;
    const issue = s.issues.find((i) => i.id === issueId);
    const needsWork = same.some((t) => t.pronunciation === 'needs_work');
    if (hasFailure || needsWork) {
      const values = {
        id: issueId,
        phraseId: p.id,
        title: p.pt,
        type: needsWork ? 'Pronunciation' : 'Recall',
        status: 'Review',
        evidence: `Voice session ${date}`,
        description: same
          .map((t) => `${t.result.replace('_', ' ')}${t.note ? ': ' + t.note : ''}`)
          .join('\n'),
        cue: `Recall “${p.en}” with no model, then use it in a conversation.`,
      };
      if (issue) Object.assign(issue, values);
      else s.issues.push(values);
    } else if (clean) {
      for (const old of s.issues.filter((i) => i.phraseId === p.id && i.status !== 'Resolved')) {
        old.status = 'Monitor';
        old.evidence = `Recalled without help ${date}; recheck next session.`;
      }
    }
  }
  s.updatedAt = new Date().toISOString();
  return { notebook: s, learned: [...new Set(learned)] };
}

// Adds (or replaces) the written journal entry for a session. Optional:
// progress tracking does not depend on it.
export function addJournalEntry(
  notebook,
  session,
  summary,
  { mode = 'lesson', learned = [] } = {},
) {
  const s = structuredClone(notebook);
  const id = 'voice-' + session.id;
  const date = sydneyDate(new Date(session.started));
  const duration = Math.max(
    0,
    Math.round(((session.ended || session.last_seen || session.started) - session.started) / 60000),
  );
  const entry = {
    id,
    date,
    title: summary.title,
    duration: `${duration} minutes · ${labelOf(mode).toLowerCase()}${session.status === 'interrupted' ? ' · interrupted' : ''}`,
    source: 'Logged',
    focus: summary.focus,
    practised: summary.practised,
    mastered: learned.length
      ? `${learned.join('; ')} reached Mastered. ${summary.mastered}`
      : summary.mastered,
    mistakes: summary.mistakes,
    pronunciation: summary.pronunciation,
    roleplay: summary.roleplay,
    next: summary.next,
    notes: summary.notes,
    voiceSessionId: session.id,
    automatic: true,
  };
  const index = s.lessons.findIndex((l) => l.id === id);
  if (index >= 0) s.lessons[index] = entry;
  else s.lessons.push(entry);
  s.updatedAt = new Date().toISOString();
  return s;
}

export const NOTES_MODEL = SUMMARY_MODEL;
export const MAX_LESSON_MINUTES = 55;
export function validUsageEvent(e) {
  return (
    !!e &&
    typeof e.id === 'string' &&
    typeof e.model === 'string' &&
    Number.isFinite(e.usd) &&
    Number.isFinite(e.at)
  );
}

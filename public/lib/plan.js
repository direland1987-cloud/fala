// What to practise, worked out from the record of every attempt
// (data/practice.json) and the phrase list. Nothing here is written prose:
// the same functions feed the tutor, the plan preview and the progress page,
// so what Dan sees is what the lesson does.
import { sydneyDate } from './domain.js';

export const FAILED = ['prompted', 'not_recalled', 'unclear'];
const DAY = 86400000;
const LEVEL_RANK = { Planned: -1, New: 0, Developing: 1, Functional: 2, Mastered: 3, Automatic: 4 };
const fold = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

export const isTest = (a) => a.result !== 'repeated';
export const isProduction = (a) => a.context !== 'meaning';

// Deterministic shuffle so a quiz differs between sessions but is testable.
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(list, seed = 1) {
  const random = mulberry32(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// One row per phrase: how it has gone so far.
export function phraseStats(notebook, practice = [], now = Date.now()) {
  const byId = new Map();
  const byText = new Map();
  for (const p of notebook.phrases) {
    byId.set(p.id, p);
    byText.set(fold(p.pt), p);
  }
  const grouped = new Map(notebook.phrases.map((p) => [p.id, []]));
  for (const a of practice) {
    const phrase = byId.get(a.phraseId) || byText.get(fold(a.pt));
    if (phrase) grouped.get(phrase.id).push(a);
  }
  return notebook.phrases.map((p, order) => {
    const all = grouped.get(p.id).sort((a, b) => (a.at || 0) - (b.at || 0));
    const tests = all.filter((a) => isTest(a) && isProduction(a));
    const meaning = all.filter((a) => isTest(a) && !isProduction(a));
    const unaided = tests.filter((a) => a.result === 'independent').length;
    let streak = 0;
    for (let i = tests.length - 1; i >= 0 && tests[i].result === 'independent'; i--) streak++;
    const last = tests.at(-1) || null;
    const lastFailed = !!last && FAILED.includes(last.result);
    const recentFails = tests.slice(-4).filter((a) => FAILED.includes(a.result)).length;
    const trouble = [...tests].reverse().find((a) => FAILED.includes(a.result)) || null;
    const days = (context) =>
      new Set(
        tests
          .filter(
            (a) =>
              a.result === 'independent' && a.context === context && a.pronunciation === 'clear',
          )
          .map((a) => a.date),
      ).size;
    let status;
    if (p.level === 'Planned' && !all.length) status = 'planned';
    else if (!tests.length) status = 'untested';
    else if (streak >= 2) status = 'working';
    else if (lastFailed && recentFails >= 2) status = 'struggling';
    else status = 'shaky';
    const lastAt = last?.at || (p.lastTested ? Date.parse(p.lastTested + 'T02:00:00Z') : 0);
    const idle = lastAt ? Math.max(0, Math.floor((now - lastAt) / DAY)) : 7;
    const base =
      status === 'struggling'
        ? 100
        : status === 'shaky'
          ? 70
          : status === 'working'
            ? 20
            : status === 'planned'
              ? 0
              : { New: 60, Developing: 60, Functional: 40, Mastered: 15, Automatic: 10 }[p.level] ||
                40;
    return {
      id: p.id,
      pt: p.pt,
      en: p.en,
      level: p.level,
      category: p.category || '',
      hint: p.cue || '',
      order,
      status,
      attempts: all.length,
      tests: tests.length,
      unaided,
      streak,
      recent: tests.slice(-5).map((a) => a.result),
      meaningTests: meaning.length,
      meaningRight: meaning.filter((a) => a.result === 'independent').length,
      pronunciationFlags: tests.slice(-4).filter((a) => a.pronunciation === 'needs_work').length,
      conversationDays: days('conversation'),
      isolatedDays: days('isolated'),
      lastResult: last?.result || null,
      lastDate: last?.date || p.lastTested || null,
      idleDays: idle,
      trouble: trouble
        ? { date: trouble.date, result: trouble.result, note: trouble.note || trouble.heard || '' }
        : null,
      priority: status === 'planned' ? -1 : base + Math.min(idle, 14) * 2 + (lastFailed ? 30 : 0),
    };
  });
}

// Notes from early sessions ran to several sentences; keep the first one.
const troubleText = (note) => {
  const first = String(note || '')
    .split(/(?<=[.;])\s/)[0]
    .trim();
  return first.length > 70 ? first.slice(0, 67).trimEnd() + '…' : first;
};
const toItem = (s, kind = 'say', extra = {}) => ({
  id: s.id,
  kind,
  pt: s.pt,
  en: s.en,
  hint: s.hint,
  // Set when the most recent real try went wrong: what was noted, or failing
  // that the result itself, so the phrase is always flagged.
  trouble:
    s.trouble && FAILED.includes(s.lastResult || '')
      ? troubleText(s.trouble.note) || s.lastResult.replace('_', ' ')
      : '',
  ...extra,
});
export const cueText = (item) => (item.kind === 'meaning' ? item.pt : item.en);

// The phrases most in need of a recall test, weakest first, opened with one
// confident phrase so the lesson starts on a win.
export function buildReviewQueue(
  notebook,
  practice,
  { count = 6, now = Date.now(), exclude } = {},
) {
  const skip = exclude || new Set();
  const stats = phraseStats(notebook, practice, now).filter(
    (s) => s.status !== 'planned' && !skip.has(s.id),
  );
  const ranked = [...stats].sort((a, b) => b.priority - a.priority || a.order - b.order);
  const picked = ranked.slice(0, count);
  const confident = (s) =>
    s.status === 'working' || (s.status === 'untested' && LEVEL_RANK[s.level] >= 2);
  const warm = [...stats]
    .filter(confident)
    .sort(
      (a, b) =>
        b.streak - a.streak || LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.order - b.order,
    )[0];
  if (warm && picked.length >= 3 && !confident(picked[0])) {
    const without = picked.filter((s) => s.id !== warm.id);
    return [warm, ...without.slice(0, count - 1)].map((s) => toItem(s));
  }
  return picked.map((s) => toItem(s));
}

// Planned phrases in notebook order: the curriculum's next new material.
export function pickNew(notebook, count = 1, exclude = new Set()) {
  return notebook.phrases
    .filter((p) => p.level === 'Planned' && !exclude.has(p.id))
    .slice(0, count)
    .map((p) => ({ id: p.id, kind: 'new', pt: p.pt, en: p.en, hint: p.cue || '', trouble: '' }));
}

const SCENE_NAMES = ['Camila', 'Rafael', 'Bia', 'Lucas'];
// Phrases for a short role-play: taught phrases that most need to be used in
// conversation. Never ones Dan has not been taught, and not ones he missed
// on his most recent try, because nothing is corrected during the scene.
export function buildScene(
  notebook,
  practice,
  { count = 4, now = Date.now(), round = 0, include = [] } = {},
) {
  const stats = phraseStats(notebook, practice, now).filter(
    (s) => s.status !== 'planned' && !FAILED.includes(s.lastResult || ''),
  );
  const ranked = [...stats].sort(
    (a, b) =>
      a.conversationDays - b.conversationDays || b.priority - a.priority || a.order - b.order,
  );
  const rotated =
    ranked.length > count ? [...ranked.slice((round * 2) % ranked.length), ...ranked] : ranked;
  const targets = [];
  for (const s of [
    ...include.map((id) => stats.find((x) => x.id === id)).filter(Boolean),
    ...rotated,
  ]) {
    if (targets.length >= count) break;
    if (!targets.some((t) => t.id === s.id)) targets.push(toItem(s, 'scene'));
  }
  return { name: SCENE_NAMES[round % SCENE_NAMES.length], targets };
}

// A mixed quiz: mostly "how do you say", every third one "what does it mean".
export function buildQuiz(notebook, practice, { count = 8, now = Date.now(), seed = 1 } = {}) {
  const stats = phraseStats(notebook, practice, now).filter((s) => s.status !== 'planned');
  const ranked = [...stats].sort((a, b) => b.priority - a.priority || a.order - b.order);
  const picked = shuffle(ranked.slice(0, count), seed);
  return picked.map((s, i) => toItem(s, i % 3 === 2 ? 'meaning' : 'say'));
}

export const MODES = {
  lesson: {
    label: 'Lesson',
    blurb: 'Recall, one new phrase when ready, then a short conversation.',
  },
  quiz: { label: 'Quick quiz', blurb: 'Rapid questions on what you know. Ends with a score.' },
  challenge: {
    label: 'Conversation challenge',
    blurb: 'Role-play in Portuguese. Hints only if you are stuck.',
  },
};
export const reviewCount = (minutes) => Math.max(3, Math.min(8, Math.round(minutes / 2.5)));
export const quizCount = (minutes, known) =>
  Math.max(4, Math.min(known, 16, Math.round(minutes * 1.6)));
export const newAllowance = (minutes) => (minutes >= 20 ? 2 : minutes >= 8 ? 1 : 0);

// What a session of this kind and length will cover. Used for the preview
// and as the starting point of the live flow.
export function buildLessonPlan(
  notebook,
  practice = [],
  { mode = 'lesson', minutes = 15, now = Date.now(), seed = 1 } = {},
) {
  const known = notebook.phrases.filter((p) => p.level !== 'Planned').length;
  if (mode === 'quiz')
    return {
      mode,
      minutes,
      quiz: buildQuiz(notebook, practice, { count: quizCount(minutes, known), now, seed }),
    };
  if (mode === 'challenge')
    return {
      mode,
      minutes,
      scene: buildScene(notebook, practice, { count: Math.min(5, known), now }),
    };
  return {
    mode: 'lesson',
    minutes,
    review: buildReviewQueue(notebook, practice, { count: reviewCount(minutes), now }),
    newPhrases: pickNew(notebook, newAllowance(minutes)),
    scene: buildScene(notebook, practice, { count: Math.min(4, known), now }),
  };
}

// Score for one session: the first real try at each phrase is what counts.
export function scoreAttempts(attempts = []) {
  const seen = new Set();
  const firsts = [];
  for (const a of attempts) {
    if (!isTest(a)) continue;
    const key = `${a.phraseId || fold(a.pt)}|${a.context === 'meaning' ? 'm' : a.context === 'conversation' ? 'c' : 'i'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    firsts.push(a);
  }
  const unaided = firsts.filter((a) => a.result === 'independent').length;
  const prompted = firsts.filter((a) => a.result === 'prompted').length;
  const missed = firsts.length - unaided - prompted;
  return {
    asked: firsts.length,
    unaided,
    prompted,
    missed,
    pct: firsts.length ? Math.round((unaided / firsts.length) * 100) : 0,
    conversation: firsts.filter((a) => a.context === 'conversation' && a.result === 'independent')
      .length,
    weakest: firsts.filter((a) => a.result !== 'independent').map((a) => a.pt),
    strongest: firsts.filter((a) => a.result === 'independent').map((a) => a.pt),
  };
}

export function progressGroups(notebook, practice = [], now = Date.now()) {
  const stats = phraseStats(notebook, practice, now);
  const group = (status) => stats.filter((s) => s.status === status);
  return {
    stats,
    working: group('working'),
    shaky: group('shaky'),
    struggling: group('struggling'),
    untested: group('untested'),
    planned: group('planned'),
  };
}

// Monday 00:00 Sydney time of the week containing `now`, as a date string.
export function weekStartDate(now = Date.now()) {
  const today = sydneyDate(new Date(now));
  const noon = new Date(today + 'T12:00:00Z');
  const back = (noon.getUTCDay() + 6) % 7;
  return new Date(noon.getTime() - back * DAY).toISOString().slice(0, 10);
}

// Small goals worked out from the record. Nothing is stored for them.
export function challenges(notebook, practice = [], lessons = [], now = Date.now()) {
  const { stats } = progressGroups(notebook, practice, now);
  const week = weekStartDate(now);
  const thisWeek = lessons.filter((l) => l.date >= week && (l.checkpoints || 0) > 0).length;
  const list = [
    {
      id: 'week',
      title: 'Three sessions this week',
      detail: `${thisWeek} of 3 done since Monday.`,
      progress: Math.min(thisWeek, 3),
      target: 3,
    },
  ];
  const sticky = stats
    .filter((s) => ['struggling', 'shaky', 'untested'].includes(s.status))
    .sort((a, b) => b.priority - a.priority || a.order - b.order)[0];
  if (sticky)
    list.push({
      id: 'stick',
      title: `Make “${sticky.pt}” stick`,
      detail: `Say it without help three times in a row. Now at ${Math.min(sticky.streak, 3)}.`,
      progress: Math.min(sticky.streak, 3),
      target: 3,
      phraseId: sticky.id,
    });
  const quizzes = lessons.filter((l) => l.mode === 'quiz' && l.score?.asked >= 4);
  const best = quizzes.reduce((m, l) => Math.max(m, l.score.pct), 0);
  list.push(
    quizzes.length
      ? {
          id: 'quiz',
          title: best >= 100 ? 'Hold a perfect quiz' : `Beat your best quiz: ${best}%`,
          detail: `${quizzes.length} quiz${quizzes.length === 1 ? '' : 'zes'} taken. Best score ${best}% without help.`,
          progress: best,
          target: 100,
        }
      : {
          id: 'quiz',
          title: 'Take your first quick quiz',
          detail: 'Five minutes, rapid questions, a score at the end.',
          progress: 0,
          target: 1,
        },
  );
  const bestScene = lessons.reduce((m, l) => Math.max(m, l.score?.conversation || 0), 0);
  list.push({
    id: 'scene',
    title: 'Four phrases in one conversation',
    detail: `Use four phrases in a role-play with no hints. Best so far: ${bestScene}.`,
    progress: Math.min(bestScene, 4),
    target: 4,
  });
  return list.map((c) => ({ ...c, done: c.progress >= c.target }));
}

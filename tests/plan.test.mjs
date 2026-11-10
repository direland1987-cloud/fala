import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../baseline/seed.js';
import {
  phraseStats,
  buildReviewQueue,
  buildQuiz,
  buildScene,
  buildLessonPlan,
  pickNew,
  scoreAttempts,
  progressGroups,
  challenges,
  weekStartDate,
  cueText,
} from '../public/lib/plan.js';
import { createFlow } from '../public/lib/flow.js';
import { attempt, history } from './helpers/fakes.mjs';

const NOW = Date.parse('2026-11-10T22:00:00Z');
const practice = [
  ...history('estou-bem', 'Estou bem', [
    ['2026-11-05', 'independent'],
    ['2026-11-08', 'independent'],
  ]),
  ...history('e-voce', 'E você?', [
    ['2026-11-05', 'not_recalled'],
    ['2026-11-05', 'repeated'],
    ['2026-11-08', 'prompted'],
  ]),
  ...history('como-esta', 'Como você está?', [['2026-11-08', 'independent']]),
];
const stat = (id, list = practice) => phraseStats(seed, list, NOW).find((s) => s.id === id);

test('each phrase gets a status from its own track record', () => {
  assert.equal(stat('estou-bem').status, 'working');
  assert.equal(stat('estou-bem').streak, 2);
  assert.equal(stat('e-voce').status, 'struggling');
  assert.deepEqual(stat('e-voce').recent, ['not_recalled', 'prompted'], 'repeats are not tests');
  assert.equal(stat('como-esta').status, 'shaky');
  assert.equal(stat('oi').status, 'untested');
  assert.equal(stat('tudo-bem').status, 'planned');
  assert.ok(stat('e-voce').priority > stat('como-esta').priority);
  assert.ok(stat('como-esta').priority > stat('estou-bem').priority);
  const g = progressGroups(seed, practice, NOW);
  assert.deepEqual(
    g.working.map((s) => s.id),
    ['estou-bem'],
  );
  assert.deepEqual(
    g.struggling.map((s) => s.id),
    ['e-voce'],
  );
});

test('the review queue opens on a confident phrase, then goes weakest first, and never includes untaught phrases', () => {
  const queue = buildReviewQueue(seed, practice, { count: 5, now: NOW });
  assert.equal(queue.length, 5);
  assert.equal(queue[0].id, 'estou-bem', 'opens on a win');
  assert.equal(queue[1].id, 'e-voce', 'then the phrase that is not sticking');
  const planned = new Set(seed.phrases.filter((p) => p.level === 'Planned').map((p) => p.id));
  assert.ok(queue.every((i) => !planned.has(i.id)));
  assert.equal(cueText(queue[1]), 'And you?');
  const without = buildReviewQueue(seed, practice, {
    count: 5,
    now: NOW,
    exclude: new Set(['e-voce']),
  });
  assert.ok(!without.some((i) => i.id === 'e-voce'));
});

test('new material comes from the Planned list in notebook order', () => {
  assert.deepEqual(
    pickNew(seed, 2).map((p) => p.id),
    ['tudo-bem', 'estou-animado'],
  );
  assert.deepEqual(
    pickNew(seed, 1, new Set(['tudo-bem'])).map((p) => p.id),
    ['estou-animado'],
  );
});

test('a quiz mixes saying and meaning questions and is stable for a given seed', () => {
  const a = buildQuiz(seed, practice, { count: 8, now: NOW, seed: 42 });
  const b = buildQuiz(seed, practice, { count: 8, now: NOW, seed: 42 });
  const c = buildQuiz(seed, practice, { count: 8, now: NOW, seed: 43 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(
    a.map((i) => i.id),
    c.map((i) => i.id),
  );
  assert.equal(a.length, 8);
  assert.equal(new Set(a.map((i) => i.id)).size, 8, 'no phrase twice');
  assert.ok(a.some((i) => i.kind === 'meaning') && a.some((i) => i.kind === 'say'));
  const meaning = a.find((i) => i.kind === 'meaning');
  assert.equal(cueText(meaning), meaning.pt);
});

test('a conversation avoids phrases that are not sticking and can include a phrase taught today', () => {
  const scene = buildScene(seed, practice, { count: 4, now: NOW });
  assert.equal(scene.targets.length, 4);
  assert.ok(!scene.targets.some((t) => t.id === 'e-voce'));
  assert.ok(scene.name);
  const plan = buildLessonPlan(seed, practice, { mode: 'lesson', minutes: 15, now: NOW });
  assert.equal(plan.review.length, 6);
  assert.deepEqual(
    plan.newPhrases.map((p) => p.id),
    ['tudo-bem'],
  );
  assert.equal(
    buildLessonPlan(seed, practice, { mode: 'lesson', minutes: 5, now: NOW }).newPhrases.length,
    0,
  );
});

test('a session is scored on the first real try at each phrase', () => {
  const score = scoreAttempts([
    attempt({ phraseId: 'oi', pt: 'Oi' }),
    attempt({ phraseId: 'e-voce', pt: 'E você?', result: 'not_recalled' }),
    attempt({ phraseId: 'e-voce', pt: 'E você?', result: 'repeated' }),
    attempt({ phraseId: 'e-voce', pt: 'E você?', result: 'independent' }),
    attempt({ phraseId: 'tchau', pt: 'Tchau', result: 'prompted' }),
    attempt({ phraseId: 'oi', pt: 'Oi', context: 'conversation' }),
  ]);
  assert.equal(score.asked, 4);
  assert.equal(score.unaided, 2);
  assert.equal(score.prompted, 1);
  assert.equal(score.missed, 1);
  assert.equal(score.pct, 50);
  assert.equal(score.conversation, 1);
  assert.deepEqual(score.weakest, ['E você?', 'Tchau']);
});

test('challenges are worked out from the record', () => {
  assert.equal(weekStartDate(NOW), '2026-11-09');
  const lessons = [
    {
      id: 'a',
      date: '2026-11-10',
      checkpoints: 5,
      mode: 'quiz',
      score: { asked: 8, pct: 75, conversation: 0 },
    },
    {
      id: 'b',
      date: '2026-11-03',
      checkpoints: 4,
      mode: 'lesson',
      score: { asked: 4, pct: 50, conversation: 2 },
    },
    { id: 'c', date: '2026-11-10', checkpoints: 0, mode: 'lesson' },
  ];
  const list = challenges(seed, practice, lessons, NOW);
  const by = Object.fromEntries(list.map((c) => [c.id, c]));
  assert.equal(by.week.progress, 1, 'only this week, only sessions with practice');
  assert.match(by.stick.title, /E você\?/);
  assert.match(by.quiz.title, /75%/);
  assert.equal(by.scene.progress, 2);
  assert.ok(list.every((c) => c.done === c.progress >= c.target));
  assert.match(
    challenges(seed, [], [], NOW).find((c) => c.id === 'quiz').title,
    /first quick quiz/,
  );
});

// ---- the step machine -------------------------------------------------------
const record = (flow, id, result = 'independent', context = 'isolated') => {
  const p = seed.phrases.find((x) => x.id === id);
  return flow.record(attempt({ phraseId: id, pt: p.pt, en: p.en, result, context }));
};

test('a lesson runs recall, then a new phrase when recall was secure, then a conversation', () => {
  const flow = createFlow({
    notebook: seed,
    practice,
    mode: 'lesson',
    minutes: 10,
    now: () => NOW,
  });
  const first = flow.start();
  assert.equal(first.name, 'review');
  assert.match(first.opener, /How do you say "I’m well"\?/);
  const ids = flow.step.queue.map((i) => i.id);
  assert.equal(ids.length, 4);
  let last;
  for (const id of ids) {
    last = record(flow, id);
    if (id !== ids.at(-1)) assert.equal(last.advance, false);
  }
  assert.equal(last.advance, true);
  assert.deepEqual(last.output.remaining, []);
  const next = flow.advance({ elapsedMinutes: 3, targetMinutes: 10 });
  assert.equal(next.name, 'new');
  assert.match(next.block, /Tudo bem\?/);
  assert.ok(flow.allowedIds.has('tudo-bem'), 'the new phrase is now allowed');
  assert.match(flow.instructions(), /tudo-bem: Tudo bem\?/);
  assert.equal(record(flow, 'tudo-bem', 'repeated').advance, false);
  assert.equal(record(flow, 'tudo-bem', 'independent').advance, true);
  const scene = flow.advance({ elapsedMinutes: 5, targetMinutes: 10 });
  assert.equal(scene.name, 'scene');
  assert.ok(flow.step.scene.targets.some((t) => t.id === 'tudo-bem'));
  let done;
  for (const t of flow.step.scene.targets) done = record(flow, t.id, 'independent', 'conversation');
  assert.equal(done.advance, true);
  const again = flow.advance({ elapsedMinutes: 6, targetMinutes: 10 });
  assert.equal(again.name, 'review', 'time left, so another round');
  assert.match(again.opener, /Next round/);
  assert.ok(
    !flow.step.queue.some((i) => ids.includes(i.id)),
    'phrases already recalled are not repeated',
  );
  assert.deepEqual(flow.introduced, ['tudo-bem']);
});

test('weak recall means no new phrase, and a missed phrase comes back once at the end', () => {
  const flow = createFlow({
    notebook: seed,
    practice,
    mode: 'lesson',
    minutes: 10,
    now: () => NOW,
  });
  flow.start();
  const ids = flow.step.queue.map((i) => i.id);
  const miss = record(flow, ids[0], 'not_recalled');
  assert.equal(miss.advance, false);
  assert.equal(flow.step.queue.at(-1).id, ids[0], 'queued for a second try');
  assert.equal(flow.step.queue.at(-1).retest, true);
  record(flow, ids[0], 'repeated');
  assert.equal(flow.step.queue.length, ids.length, 'a repeat after the model changes nothing');
  record(flow, ids[1], 'prompted');
  for (const id of ids.slice(2)) record(flow, id);
  record(flow, ids[0], 'not_recalled');
  const end = record(flow, ids[1], 'independent');
  assert.equal(end.advance, true);
  const next = flow.advance({ elapsedMinutes: 4, targetMinutes: 10 });
  assert.equal(next.name, 'scene', 'recall was not secure, so no new phrase');
  assert.deepEqual(flow.introduced, []);
});

test('a quiz ends with a score and a challenge ends each round at the wrap-up', () => {
  const quiz = createFlow({
    notebook: seed,
    practice,
    mode: 'quiz',
    minutes: 5,
    now: () => NOW,
    seed: 3,
  });
  const first = quiz.start();
  assert.equal(first.name, 'quiz');
  assert.match(first.opener, /Quick quiz, 8 questions/);
  const items = [...quiz.step.queue];
  items.forEach((item, i) => {
    const r = record(
      quiz,
      item.id,
      i === 0 ? 'not_recalled' : 'independent',
      item.kind === 'meaning' ? 'meaning' : 'isolated',
    );
    assert.equal(r.advance, i === items.length - 1);
  });
  const result = quiz.advance();
  assert.equal(result.name, 'result');
  assert.match(result.opener, /7 out of 8 without help/);
  assert.match(result.opener, /finish_lesson/);
  assert.equal(quiz.advance(), null);
  assert.equal(quiz.toWrap(), null, 'a quiz is never cut short by the clock');

  const challenge = createFlow({
    notebook: seed,
    practice,
    mode: 'challenge',
    minutes: 10,
    now: () => NOW,
  });
  const scene = challenge.start();
  assert.equal(scene.name, 'scene');
  assert.match(scene.block, /CONVERSATION CHALLENGE/);
  for (const t of challenge.step.scene.targets)
    record(challenge, t.id, 'independent', 'conversation');
  const wrap = challenge.advance({ elapsedMinutes: 3, targetMinutes: 10 });
  assert.equal(wrap.name, 'wrap');
  assert.match(wrap.opener, /5 of 5 phrases without a hint/);
  assert.equal(
    challenge.advance({ elapsedMinutes: 4, targetMinutes: 10 }).name,
    'scene',
    'keep going starts another round',
  );
});

test('when time is up the lesson moves to the wrap-up from any step', () => {
  const flow = createFlow({ notebook: seed, practice, mode: 'lesson', minutes: 5, now: () => NOW });
  flow.start();
  record(flow, flow.step.queue[0].id);
  const wrap = flow.toWrap();
  assert.equal(wrap.name, 'wrap');
  assert.match(wrap.opener, /1 of 1 without help/);
  assert.match(wrap.opener, /Keep going, or finish here\?/);
  assert.equal(flow.toWrap(), null);
});

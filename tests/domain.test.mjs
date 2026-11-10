import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../baseline/seed.js';
import {
  priceUsage,
  applyProgress,
  addJournalEntry,
  buildSummary,
  validSummary,
  validateAttempt,
  validateSettings,
  monthStart,
  DEFAULT_SETTINGS,
} from '../public/lib/domain.js';
import { scoreAttempts } from '../public/lib/plan.js';
import { attempt } from './helpers/fakes.mjs';

const session = {
  id: 'lesson-test',
  started: Date.parse('2026-09-16T00:00:00Z'),
  ended: Date.parse('2026-09-16T00:20:00Z'),
  status: 'complete',
};

test('cost calculation separates cached audio and text and includes reasoning output', () => {
  const usage = {
    input_tokens: 1500,
    output_tokens: 900,
    input_token_details: {
      audio_tokens: 1000,
      text_tokens: 500,
      cached_tokens: 700,
      cached_tokens_details: { audio_tokens: 600, text_tokens: 100 },
    },
    output_token_details: { audio_tokens: 500, text_tokens: 200 },
  };
  const result = priceUsage('gpt-realtime-2.1', usage);
  assert.ok(
    Math.abs(
      result.usd - (400 * 32 + 600 * 0.4 + 400 * 4 + 100 * 0.4 + 500 * 64 + 400 * 24) / 1e6,
    ) < 1e-10,
  );
  assert.equal(result.incomplete, false);
  assert.equal(
    priceUsage('gpt-5.6-luna', { input_tokens: 10000, output_tokens: 2000 }, false).usd,
    0.0044,
  );
});
test('incomplete usage is flagged rather than presented as a complete bill', () => {
  assert.equal(
    priceUsage('gpt-realtime-2.1', { input_tokens: 100, output_tokens: 10 }).incomplete,
    true,
  );
  assert.throws(() => priceUsage('unknown', {}));
});
test('month boundary follows Sydney, including daylight saving', () => {
  assert.equal(
    new Date(monthStart(Date.parse('2026-09-20T00:00:00Z'))).toISOString(),
    '2026-08-31T14:00:00.000Z',
  );
  assert.equal(
    new Date(monthStart(Date.parse('2026-12-20T00:00:00Z'))).toISOString(),
    '2026-11-30T13:00:00.000Z',
  );
});

test('an attempt is recorded by phrase id and takes its wording from the phrase list', () => {
  const a = validateAttempt(
    {
      id: 'e-voce',
      result: 'prompted',
      context: 'isolated',
      pronunciation: 'uncertain',
      note: 'needed first sound',
    },
    seed.phrases,
  );
  assert.deepEqual(a, {
    phraseId: 'e-voce',
    pt: 'E você?',
    en: 'And you?',
    heard: '',
    result: 'prompted',
    context: 'isolated',
    pronunciation: 'uncertain',
    note: 'needed first sound',
  });
  const base = { result: 'independent', context: 'isolated', pronunciation: 'clear' };
  assert.throws(
    () => validateAttempt({ ...base, id: 'not-a-phrase' }, seed.phrases),
    /Unknown phrase id/,
  );
  assert.throws(() => validateAttempt({ ...base, id: 'oi', result: 'mastered' }, seed.phrases));
  assert.equal(
    validateAttempt({ ...base, id: 'oi', context: 'meaning' }, seed.phrases).context,
    'meaning',
  );
});

test('a prompt in the same session keeps a phrase Developing; clean recall makes it Functional', () => {
  const mixed = [attempt({ result: 'prompted' }), attempt({ context: 'conversation' })];
  const a = applyProgress(seed, session, mixed).notebook;
  assert.equal(a.phrases.find((p) => p.id === 'estou-bem').level, 'Developing');
  assert.ok(a.issues.some((i) => i.phraseId === 'estou-bem' && i.status === 'Review'));
  const clean = [attempt(), attempt({ context: 'conversation' })];
  const b = applyProgress(seed, session, clean).notebook;
  assert.equal(b.phrases.find((p) => p.id === 'estou-bem').level, 'Functional');
  assert.equal(b.lessons.length, seed.lessons.length, 'progress alone writes no journal entry');
});

test('mastery needs unaided recall and conversation use on two separate days', () => {
  const clean = [attempt(), attempt({ context: 'conversation' })];
  const prior = clean.map((a) => ({ ...a, date: '2026-09-14', sessionId: 'prior' }));
  const first = applyProgress(seed, session, clean);
  assert.equal(first.notebook.phrases.find((p) => p.id === 'estou-bem').level, 'Functional');
  assert.deepEqual(first.learned, []);
  const second = applyProgress(seed, session, clean, prior);
  assert.equal(second.notebook.phrases.find((p) => p.id === 'estou-bem').level, 'Mastered');
  assert.deepEqual(second.learned, ['Estou bem']);
});

test('a phrase met for the first time stays Developing, and meaning checks do not move levels', () => {
  const tudo = { phraseId: 'tudo-bem', pt: 'Tudo bem?', en: 'All good?' };
  const fresh = [attempt({ ...tudo, result: 'repeated' }), attempt({ ...tudo })];
  const a = applyProgress(seed, session, fresh).notebook;
  const p = a.phrases.find((x) => x.id === 'tudo-bem');
  assert.equal(p.level, 'Developing');
  assert.equal(p.first, '2026-09-16');
  const meaning = [
    attempt({ phraseId: 'e-voce', pt: 'E você?', en: 'And you?', context: 'meaning' }),
  ];
  const b = applyProgress(seed, session, meaning).notebook;
  assert.equal(
    b.phrases.find((x) => x.id === 'e-voce').level,
    seed.phrases.find((x) => x.id === 'e-voce').level,
  );
});

test('the plain summary and journal entry are built from checkpoints only', () => {
  const attempts = [
    attempt(),
    attempt({
      phraseId: 'e-voce',
      pt: 'E você?',
      en: 'And you?',
      result: 'not_recalled',
      note: 'said el so',
    }),
  ];
  const score = scoreAttempts(attempts);
  const summary = buildSummary(session, attempts, score, 'quiz');
  assert.ok(validSummary(summary));
  assert.equal(summary.title, 'Quick quiz: 1 of 2 without help');
  assert.match(summary.mistakes, /E você\? \(not recalled: said el so\)/);
  assert.match(summary.next, /Keep practising: E você\?/);
  const withEntry = addJournalEntry(seed, session, summary, { mode: 'quiz' });
  const entry = withEntry.lessons.find((l) => l.voiceSessionId === 'lesson-test');
  assert.equal(entry.title, summary.title);
  assert.match(entry.duration, /20 minutes · quick quiz/);
  const again = addJournalEntry(
    withEntry,
    session,
    { ...summary, title: 'Rewritten' },
    { mode: 'quiz' },
  );
  assert.equal(again.lessons.filter((l) => l.voiceSessionId === 'lesson-test').length, 1);
  assert.equal(again.lessons.find((l) => l.voiceSessionId === 'lesson-test').title, 'Rewritten');
});

test('settings gain reply speed, microphone position and an optional recap', () => {
  const s = validateSettings({
    model: 'gpt-realtime-2.1',
    minutes: 15,
    budgetAud: 60,
    usdToAud: 1.4,
  });
  assert.equal(s.pace, 'quick');
  assert.equal(s.mic, 'near');
  assert.equal(s.recap, false);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, pace: 'instant' }), /reply speed/);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, mic: 'boom' }), /microphone/);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, model: 'gpt-5.6-luna' }));
});

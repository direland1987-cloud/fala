import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../baseline/seed.js';
import {
  priceUsage,
  applyLesson,
  fallbackSummary,
  validateAttempt,
  monthStart,
  realtimeSessionConfig,
  validSummary,
  validateSettings,
} from '../public/lib/domain.js';
import { attempt } from './helpers/fakes.mjs';

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
test('independent recall after a prompt in the same lesson stays developing', () => {
  const s = {
    id: 'lesson-test',
    started: Date.parse('2026-09-16T00:00:00Z'),
    ended: Date.parse('2026-09-16T00:20:00Z'),
    status: 'complete',
  };
  const attempts = [attempt({ result: 'prompted' }), attempt({ context: 'conversation' })];
  const next = applyLesson(seed, s, attempts, fallbackSummary(s, attempts));
  assert.equal(next.phrases.find((p) => p.pt === 'Estou bem').level, 'Developing');
  assert.equal(next.lessons.length, seed.lessons.length + 1);
  assert.equal(
    applyLesson(next, s, attempts, fallbackSummary(s, attempts)).lessons.length,
    next.lessons.length,
  );
});
test('mastery requires independent meaning cues and conversation on separate days', () => {
  const s = {
    id: 'lesson-test',
    started: Date.parse('2026-09-16T00:00:00Z'),
    ended: Date.parse('2026-09-16T00:20:00Z'),
    status: 'complete',
  };
  const attempts = [attempt(), attempt({ context: 'conversation' })];
  const first = applyLesson(seed, s, attempts, fallbackSummary(s, attempts));
  assert.equal(first.phrases.find((p) => p.pt === 'Estou bem').level, 'Functional');
  const prior = attempts.map((a) => ({ ...a, date: '2026-09-14', sessionId: 'prior' }));
  const second = applyLesson(seed, s, attempts, fallbackSummary(s, attempts), prior);
  assert.equal(second.phrases.find((p) => p.pt === 'Estou bem').level, 'Mastered');
});
test('empty interrupted lesson preserves the next plan and all earlier logs', () => {
  const s = { id: 'empty-test', started: Date.now(), last_seen: Date.now(), status: 'interrupted' };
  const next = applyLesson(seed, s, [], fallbackSummary(s, []));
  assert.deepEqual(next.next, seed.next);
  assert.deepEqual(next.lessons.slice(0, seed.lessons.length), seed.lessons);
  assert.throws(() => validateAttempt(attempt({ result: 'mastered' })));
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
test('realtime session config carries the notebook, tools and a held auto-response', () => {
  const config = realtimeSessionConfig(seed, 20, 'gpt-realtime-2.1');
  assert.equal(config.audio.input.turn_detection.create_response, false);
  assert.ok(config.instructions.includes('Estou bem'));
  assert.ok(config.tools.some((t) => t.name === 'record_practice'));
  assert.ok(validSummary(fallbackSummary({ status: 'complete' }, [attempt()])));
  assert.throws(() =>
    validateSettings({ ...seed, model: 'gpt-5.6-luna', minutes: 20, budgetAud: 60, usdToAud: 1.4 }),
  );
});

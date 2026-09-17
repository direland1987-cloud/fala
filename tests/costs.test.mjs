import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlyTotals, usageOverview } from '../public/lib/costs.js';
import { DEFAULT_SETTINGS } from '../public/lib/domain.js';

test('monthly totals count only this Sydney month and convert to AUD', () => {
  const now = Date.parse('2026-09-20T00:00:00Z');
  const usage = [
    { id: 'a', usd: 0.5, at: Date.parse('2026-09-02T00:00:00Z') },
    { id: 'b', usd: 0.25, at: Date.parse('2026-08-30T00:00:00Z') },
    { id: 'c', usd: 0.1, at: Date.parse('2026-09-19T00:00:00Z'), incomplete: true },
  ];
  const t = monthlyTotals(usage, DEFAULT_SETTINGS, now);
  assert.equal(t.usd, 0.6);
  assert.ok(Math.abs(t.aud - 0.6 / 0.7122) < 1e-9);
  assert.equal(t.responses, 2);
  assert.equal(t.incomplete, true);
});

test('usage overview merges pending lesson usage once and lists recent lessons', () => {
  const now = Date.parse('2026-09-20T00:00:00Z');
  const usage = [{ id: 'a', usd: 0.5, at: now - 1000 }];
  const pending = [
    { id: 'a', usd: 0.5, at: now - 1000 },
    { id: 'p', usd: 0.2, at: now },
  ];
  const lessons = [
    {
      id: 'l1',
      started: now - 20 * 60000,
      ended: now,
      model: 'gpt-realtime-2.1',
      status: 'complete',
      summaryStatus: 'saved',
      usd: 0.5,
      checkpoints: 3,
    },
  ];
  const o = usageOverview({ usage, lessons, settings: DEFAULT_SETTINGS, now, pending });
  assert.equal(o.usd, 0.7);
  assert.equal(o.lessons, 1);
  assert.equal(Math.round(o.minutes), 20);
  assert.equal(o.sessions[0].summary_status, 'saved');
  assert.match(o.period, /September 2026/);
});

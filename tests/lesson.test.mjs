import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../baseline/seed.js';
import { createGitHubStore, ConflictError } from '../public/lib/github.js';
import { createLocal, KEYS } from '../public/lib/local.js';
import { createLessonController, FILES, pretty } from '../public/lib/lesson.js';
import { fallbackSummary, DEFAULT_SETTINGS } from '../public/lib/domain.js';
import { createFakeGitHub } from './helpers/fake-github.mjs';
import { fakeStorage, fakeTimers, fakeRealtime, fakeMic, attempt } from './helpers/fakes.mjs';

const usageEvent = (id) => ({
  type: 'response.done',
  response: {
    id,
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      input_token_details: {
        audio_tokens: 600,
        text_tokens: 400,
        cached_tokens: 0,
        cached_tokens_details: { audio_tokens: 0, text_tokens: 0 },
      },
      output_token_details: { audio_tokens: 400, text_tokens: 100 },
    },
  },
});
const toolCall = (name, args, callId = 'call-1') => ({
  type: 'response.function_call_arguments.done',
  name,
  call_id: callId,
  arguments: JSON.stringify(args),
});

async function harness({
  files = {},
  notes,
  settings = DEFAULT_SETTINGS,
  secrets = { openaiKey: 'sk-test' },
  realtime = fakeRealtime(),
  clock,
} = {}) {
  const gh = await createFakeGitHub({
    files: {
      [FILES.notebook]: pretty(seed),
      [FILES.usage]: '[]\n',
      [FILES.practice]: '[]\n',
      [FILES.lessons]: '[]\n',
      ...files,
    },
  });
  const store = createGitHubStore({
    token: 'good-token',
    owner: 'dan',
    repo: 'fala',
    fetch: gh.fetch,
  });
  const storage = fakeStorage();
  const local = createLocal(storage);
  const timers = fakeTimers();
  const events = [];
  let now = clock ?? Date.parse('2026-09-18T22:00:00Z'); // 8am Sydney, 19 September
  const controller = createLessonController({
    store,
    local,
    getSecrets: () => secrets,
    getSettings: () => settings,
    getNotebook: () => seed,
    connect: realtime.connect,
    notes:
      notes === undefined
        ? async ({ attempts, previousPlan }) => ({
            summary: {
              ...fallbackSummary({ status: 'complete' }, attempts),
              title: 'AI recap',
              next: { ...previousPlan, title: 'AI next plan' },
            },
            usage: {
              id: 'notes-1',
              model: 'gpt-5.6-luna',
              category: 'notes',
              usd: 0.001,
              incomplete: false,
              breakdown: {},
              at: now,
              pricingVersion: 'test',
            },
            usageMissing: false,
          })
        : notes,
    getMic: async () => fakeMic(),
    now: () => now,
    timers,
    onUpdate: (type, payload) => events.push({ type, ...payload }),
    uuid: () => '00000000-0000-4000-8000-000000000001',
  });
  return {
    gh,
    store,
    local,
    storage,
    timers,
    events,
    controller,
    realtime,
    advance: (ms) => (now += ms),
    types: () => events.map((e) => e.type),
  };
}

test('a full lesson saves checkpoints, usage and notes to the repository in one commit', async () => {
  const h = await harness();
  const id = await h.controller.start({ minutes: 20 });
  const conn = h.realtime.last;
  assert.equal(conn.session.instructions.includes('Estou bem'), true);
  assert.equal(conn.mic, true);
  assert.deepEqual(
    conn.sent.map((e) => e.type),
    ['session.update', 'response.create'],
  );
  assert.equal(h.local.read(KEYS.lesson).status, 'active');

  conn.emit({ type: 'response.created' });
  conn.emit(toolCall('record_practice', attempt()));
  assert.equal(h.local.read(KEYS.lesson).attempts.length, 1);
  assert.deepEqual(conn.sent.at(-1).type, 'conversation.item.create'); // tool output returned, model still busy
  conn.emit(usageEvent('resp-1'));
  conn.emit(usageEvent('resp-1')); // duplicate response.done is counted once
  assert.equal(conn.sent.at(-1).type, 'response.create'); // continue after the tool result
  assert.equal(h.local.read(KEYS.lesson).usage.length, 1);

  h.advance(10 * 60000);
  h.timers.tick();
  assert.ok(h.events.some((e) => e.type === 'metrics' && e.elapsedSeconds === 600));

  const result = await h.controller.finish();
  assert.equal(result.saved, true);
  assert.equal(conn.closed, true);
  const files = h.gh.files();
  const notebook = JSON.parse(files[FILES.notebook]);
  const entry = notebook.lessons.find((l) => l.voiceSessionId === id);
  assert.ok(entry, 'journal entry written');
  assert.equal(entry.title, 'AI recap');
  assert.equal(notebook.next.title, 'AI next plan');
  assert.equal(notebook.phrases.find((p) => p.id === 'estou-bem').level, 'Functional');
  assert.equal(JSON.parse(files[FILES.practice]).length, 1);
  const usage = JSON.parse(files[FILES.usage]);
  assert.deepEqual(usage.map((u) => u.id).sort(), ['notes-1', 'resp-1']);
  assert.ok(usage.every((u) => u.sessionId === id));
  const index = JSON.parse(files[FILES.lessons]);
  assert.equal(index.length, 1);
  assert.equal(index[0].checkpoints, 1);
  assert.equal(index[0].date, '2026-09-19');
  assert.ok(files[`data/lessons/2026-09-19-00000000.json`]);
  assert.equal(h.gh.messages().at(-1), 'Voice lesson 2026-09-19: AI recap');
  assert.equal(h.local.read(KEYS.lesson), null);
  assert.equal(h.local.read(KEYS.lastLesson).id, id);
  assert.ok(h.types().includes('saved'));
  assert.equal(h.controller.active, false);
});

test('the tutor finishing the lesson waits for its audio to end, then saves once', async () => {
  const h = await harness();
  await h.controller.start({ minutes: 20 });
  const conn = h.realtime.last;
  conn.emit({ type: 'response.created' });
  conn.emit(toolCall('record_practice', attempt({ result: 'prompted' }), 'c1'));
  conn.emit(usageEvent('r1'));
  conn.emit({ type: 'output_audio_buffer.started' });
  conn.emit({ type: 'response.created' });
  conn.emit(toolCall('finish_lesson', {}, 'c2'));
  conn.emit(usageEvent('r2'));
  assert.ok(h.types().includes('ready_to_finish'));
  assert.equal(conn.mic, false, 'microphone closed while the recap plays');
  assert.equal(conn.closed, false, 'still playing the closing recap');
  conn.emit({ type: 'output_audio_buffer.stopped' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(conn.closed, true);
  await h.timers.runTimeouts(); // the safety timeout must not start a second finalisation
  await new Promise((r) => setTimeout(r, 20));
  const index = JSON.parse(h.gh.files()[FILES.lessons]);
  assert.equal(index.length, 1);
  assert.equal(h.gh.messages().filter((m) => m.startsWith('Voice lesson')).length, 1);
  assert.equal(
    JSON.parse(h.gh.files()[FILES.notebook]).phrases.find((p) => p.id === 'estou-bem').level,
    'Developing',
  );
});

test('a lesson interrupted by a closed tab is recovered and saved on the next visit', async () => {
  const h = await harness();
  await h.controller.start({ minutes: 15 });
  const conn = h.realtime.last;
  conn.emit({ type: 'response.created' });
  conn.emit(toolCall('record_practice', attempt()));
  conn.emit(usageEvent('r1'));
  // Simulate the tab dying: a fresh controller on the same device storage.
  const left = h.local.read(KEYS.lesson);
  assert.equal(left.status, 'active');
  const fresh = createLessonController({
    store: h.store,
    local: h.local,
    getSecrets: () => ({ openaiKey: 'sk' }),
    getSettings: () => DEFAULT_SETTINGS,
    getNotebook: () => seed,
    connect: async () => {
      throw new Error('should not reconnect');
    },
    notes: async () => {
      throw new Error('notes down');
    },
    getMic: async () => fakeMic(),
    timers: fakeTimers(),
  });
  await assert.rejects(fresh.start(), /Finish or recover/);
  const result = await fresh.recover();
  assert.equal(result.saved, true);
  assert.equal(result.record.status, 'interrupted');
  assert.equal(result.record.usageIncomplete, true);
  const notebook = JSON.parse(h.gh.files()[FILES.notebook]);
  const entry = notebook.lessons.find((l) => l.voiceSessionId === left.id);
  assert.match(entry.duration, /interrupted/);
  assert.match(entry.notes, /AI-written recap was unavailable/);
  assert.equal(await fresh.recover(), null);
});

test('a save conflict is retried against the fresh notebook without duplicating the entry', async () => {
  const h = await harness();
  let failed = false;
  const original = h.store.commit;
  h.store.commit = async (args) => {
    if (!failed) {
      failed = true;
      await h.gh.setFile(
        FILES.notebook,
        pretty({ ...seed, next: { ...seed.next, notes: 'Edited on the desktop meanwhile' } }),
      );
      throw new ConflictError('changed', FILES.notebook);
    }
    return original(args);
  };
  await h.controller.start({ minutes: 20 });
  const conn = h.realtime.last;
  conn.emit({ type: 'response.created' });
  conn.emit(toolCall('record_practice', attempt()));
  conn.emit(usageEvent('r1'));
  const result = await h.controller.finish();
  assert.equal(result.saved, true);
  const notebook = JSON.parse(h.gh.files()[FILES.notebook]);
  assert.equal(notebook.lessons.filter((l) => l.voiceSessionId === result.id).length, 1);
  assert.equal(notebook.next.title, 'AI next plan');
});

test('a failed save keeps the checkpoints on the device and can be retried', async () => {
  const h = await harness();
  await h.controller.start({ minutes: 20 });
  const conn = h.realtime.last;
  conn.emit({ type: 'response.created' });
  conn.emit(toolCall('record_practice', attempt()));
  conn.emit(usageEvent('r1'));
  const original = h.store.commit;
  h.store.commit = async () => {
    throw new Error('GitHub is temporarily unavailable.');
  };
  await assert.rejects(h.controller.finish(), /temporarily unavailable/);
  const left = h.local.read(KEYS.lesson);
  assert.equal(left.summaryStatus, 'pending');
  assert.equal(left.attempts.length, 1);
  assert.ok(h.types().includes('failure'));
  h.store.commit = original;
  const result = await h.controller.recover();
  assert.equal(result.saved, true);
  assert.equal(JSON.parse(h.gh.files()[FILES.usage]).length, 2);
});

test('the budget guard refuses to start and ends a running lesson', async () => {
  const spent = [
    { id: 'old', usd: 50, at: Date.parse('2026-09-10T00:00:00Z'), model: 'gpt-realtime-2.1' },
  ];
  const over = await harness({
    files: { [FILES.usage]: pretty(spent) },
    settings: { ...DEFAULT_SETTINGS, budgetAud: 60 },
  });
  await assert.rejects(over.controller.start(), /monthly API budget/);
  assert.equal(over.local.read(KEYS.lesson), null);

  const h = await harness({
    files: { [FILES.usage]: pretty([{ ...spent[0], usd: 42 }]) },
    settings: { ...DEFAULT_SETTINGS, budgetAud: 60 },
  });
  await h.controller.start({ minutes: 20 });
  const conn = h.realtime.last;
  conn.emit({ type: 'response.created' });
  conn.emit(toolCall('record_practice', attempt()));
  conn.emit({
    ...usageEvent('big'),
    response: {
      id: 'big',
      usage: {
        input_tokens: 0,
        output_tokens: 20000,
        output_token_details: { audio_tokens: 20000, text_tokens: 0 },
      },
    },
  });
  h.timers.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(h.events.some((e) => e.type === 'notice' && /budget/.test(e.message)));
  assert.equal(conn.closed, true);
  assert.equal(JSON.parse(h.gh.files()[FILES.lessons]).length, 1);
});

test('a lesson with nothing in it is discarded rather than logged', async () => {
  const h = await harness();
  await h.controller.start({ minutes: 20 });
  const result = await h.controller.finish();
  assert.equal(result.discarded, true);
  assert.equal(h.local.read(KEYS.lesson), null);
  assert.equal(JSON.parse(h.gh.files()[FILES.lessons]).length, 0);
});

test('microphone refusal and connection failure leave nothing behind', async () => {
  const denied = new Error('Permission denied');
  denied.name = 'NotAllowedError';
  const h = await harness({ realtime: fakeRealtime({ failWith: denied }) });
  await assert.rejects(h.controller.start(), /Microphone access was declined/);
  assert.equal(h.local.read(KEYS.lesson), null);
  assert.equal(h.controller.active, false);
  const again = await harness({
    realtime: fakeRealtime({ failWith: new Error('Voice could not connect (502)') }),
  });
  await assert.rejects(again.controller.start(), /502/);
  assert.equal(again.local.read(KEYS.lesson), null);
});

test('time changes from the tutor and the controls update the target', async () => {
  const h = await harness();
  await h.controller.start({ minutes: 20 });
  const conn = h.realtime.last;
  h.advance(5 * 60000);
  conn.emit({ type: 'response.created' });
  conn.emit(toolCall('set_lesson_time', { minutes: 5, mode: 'remaining' }, 'c1'));
  const output = JSON.parse(conn.sent.at(-1).item.output);
  assert.equal(output.targetMinutes, 10);
  assert.equal(Math.round(output.remainingMinutes), 5);
  assert.equal(h.local.read(KEYS.lesson).minutes, 10);
  h.advance(5 * 60000 + 1000);
  conn.emit(usageEvent('r1'));
  h.timers.tick();
  assert.equal(conn.sent.at(-1).response.instructions.includes('target lesson time'), true);
  h.timers.tick();
  assert.equal(
    conn.sent.filter((e) => e.response?.instructions?.includes('target lesson time')).length,
    1,
    'asked once',
  );
  assert.throws(() => h.controller.setTime(90, 'total'), /1–55/);
});

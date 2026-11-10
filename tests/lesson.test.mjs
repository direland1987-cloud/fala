import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../baseline/seed.js';
import { createGitHubStore, ConflictError } from '../public/lib/github.js';
import { createLocal, KEYS } from '../public/lib/local.js';
import { createLessonController, FILES, pretty } from '../public/lib/lesson.js';
import { DEFAULT_SETTINGS } from '../public/lib/domain.js';
import { createFakeGitHub } from './helpers/fake-github.mjs';
import { fakeStorage, fakeTimers, fakeRealtime, fakeMic, said } from './helpers/fakes.mjs';

let counter = 0;
const usage = (id) => ({
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
const call = (name, args = {}) => ({
  type: 'response.function_call_arguments.done',
  name,
  call_id: `call-${++counter}`,
  arguments: JSON.stringify(args),
});
// One tutor turn: what it said, then any tool calls, then the end of the response.
function turn(conn, text, ...calls) {
  const before = conn.sent.length;
  conn.emit({ type: 'response.created' });
  if (text) conn.emit({ type: 'response.output_audio_transcript.done', transcript: text });
  for (const c of calls) conn.emit(c);
  conn.emit(usage(`resp-${++counter}`));
  return conn.sent.slice(before);
}
const types = (events) => events.map((e) => e.type);
const direction = (event) => event?.response?.instructions?.split('RIGHT NOW: ')[1] || '';

async function harness({
  files = {},
  notes,
  settings = DEFAULT_SETTINGS,
  secrets = { openaiKey: 'sk-test' },
  realtime = fakeRealtime(),
  lessons = [],
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
  const local = createLocal(fakeStorage());
  const timers = fakeTimers();
  const events = [];
  const noteCalls = [];
  let now = Date.parse('2026-09-18T22:00:00Z'); // 8am Sydney, 19 September
  const controller = createLessonController({
    store,
    local,
    getSecrets: () => secrets,
    getSettings: () => settings,
    getNotebook: () => seed,
    getLessons: () => lessons,
    connect: realtime.connect,
    notes:
      notes === undefined
        ? async (args) => {
            noteCalls.push(args);
            return {
              summary: { ...args.base, title: 'AI recap title' },
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
            };
          }
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
    timers,
    events,
    noteCalls,
    controller,
    realtime,
    advance: (ms) => (now += ms),
    types: () => events.map((e) => e.type),
    json: (file) => JSON.parse(gh.files()[file]),
  };
}
const queueOf = (h) => h.controller.record.plan.queue.map((i) => i.id);
const settle = () => new Promise((r) => setTimeout(r, 20));

test('a lesson opens on the planned cue, records as it goes and saves progress without a written recap', async () => {
  const h = await harness();
  const id = await h.controller.start({ minutes: 10 });
  const conn = h.realtime.last;
  assert.match(conn.session.instructions, /CURRENT STEP: RECALL/);
  assert.match(conn.session.instructions, /DAN'S PHRASES/);
  assert.ok(!/tudo-bem/.test(conn.session.instructions), 'untaught phrases are not shown');
  assert.equal(conn.session.audio.input.turn_detection.eagerness, 'high');
  assert.equal(conn.session.audio.input.turn_detection.create_response, false);
  assert.deepEqual(types(conn.sent), ['session.update', 'response.create']);
  assert.match(
    direction(conn.sent[1]),
    /^Greet Dan in one short sentence, then ask exactly: How do you say "/,
  );
  assert.equal(conn.mic, true);

  const ids = queueOf(h);
  assert.equal(ids.length, 4);
  turn(conn, 'Morning Dan. How do you say "Hi"?');
  // Normal turn: reaction, model, next cue and the record in one response.
  const sent = turn(
    conn,
    'Yes, Oi. How do you say the next one?',
    call('record_practice', said(ids[0])),
  );
  assert.deepEqual(types(sent), ['conversation.item.create'], 'no extra spoken turn');
  assert.deepEqual(JSON.parse(sent[0].item.output).remaining.length, 3);
  assert.equal(h.local.read(KEYS.lesson).attempts.length, 1);
  turn(conn, 'Good. Next?', call('record_practice', said(ids[1])));
  turn(conn, 'Good. Next?', call('record_practice', said(ids[2])));
  // Last cue: the app moves the tutor on to the next step itself.
  const boundary = turn(conn, 'Yes.', call('record_practice', said(ids[3])));
  assert.deepEqual(types(boundary), [
    'conversation.item.create',
    'session.update',
    'response.create',
  ]);
  assert.deepEqual(JSON.parse(boundary[0].item.output).remaining, []);
  assert.match(boundary[1].session.instructions, /CURRENT STEP: ONE NEW PHRASE/);
  assert.ok(!/CURRENT STEP: RECALL/.test(boundary[1].session.instructions), 'the old step is gone');
  assert.match(direction(boundary[2]), /Start step 1 now for "Tudo bem\?"/);
  assert.equal(h.controller.step, 'new');

  h.advance(6 * 60000);
  const result = await h.controller.finish();
  assert.equal(result.saved, true);
  assert.deepEqual(result.score, {
    asked: 4,
    unaided: 4,
    prompted: 0,
    missed: 0,
    pct: 100,
    conversation: 0,
  });
  assert.equal(conn.closed, true);
  const notebook = h.json(FILES.notebook);
  assert.equal(notebook.lessons.length, seed.lessons.length, 'no journal entry unless asked for');
  assert.equal(h.noteCalls.length, 0, 'the notes model is not called');
  const practice = h.json(FILES.practice);
  assert.equal(practice.length, 4);
  assert.ok(
    practice.every((p) => p.sessionId === id && p.step === 'review' && p.date === '2026-09-19'),
  );
  const index = h.json(FILES.lessons);
  assert.equal(index.length, 1);
  assert.equal(index[0].mode, 'lesson');
  assert.equal(index[0].score.unaided, 4);
  assert.deepEqual(index[0].introduced, ['tudo-bem']);
  assert.equal(index[0].journal, false);
  assert.ok(h.gh.files()['data/lessons/2026-09-19-00000000.json']);
  assert.equal(h.gh.messages().at(-1), 'Lesson 2026-09-19: 4 of 4 without help');
  assert.equal(h.json(FILES.usage).length, 5, 'one usage row per tutor turn');
  assert.equal(h.local.read(KEYS.lesson), null);
  assert.ok(h.types().includes('saved'));
});

test('the written recap is opt-in and adds a journal entry when switched on', async () => {
  const h = await harness({ settings: { ...DEFAULT_SETTINGS, recap: true } });
  await h.controller.start({ minutes: 10 });
  const conn = h.realtime.last;
  turn(conn, 'Yes. Next?', call('record_practice', said(queueOf(h)[0])));
  const result = await h.controller.finish();
  assert.equal(h.noteCalls.length, 1);
  assert.equal(h.noteCalls[0].mode, 'lesson');
  assert.equal(h.noteCalls[0].score.unaided, 1);
  const entry = h.json(FILES.notebook).lessons.find((l) => l.voiceSessionId === result.id);
  assert.equal(entry.title, 'AI recap title');
  assert.equal(h.json(FILES.lessons)[0].journal, true);
  assert.ok(h.json(FILES.usage).some((u) => u.id === 'notes-1'));
});

test('the app prompts the tutor only when it has gone quiet without asking anything', async () => {
  const h = await harness();
  await h.controller.start({ minutes: 10 });
  const conn = h.realtime.last;
  const ids = queueOf(h);
  // Took a good answer but asked nothing: prompt it.
  let sent = turn(conn, 'Good.', call('record_practice', said(ids[0])));
  assert.deepEqual(types(sent), ['conversation.item.create', 'response.create']);
  assert.equal(sent[1].response, undefined, 'a plain continue, no override');
  // Dan missed it and is being asked to repeat: do not talk over him.
  sent = turn(
    conn,
    'Not quite. E você. Your turn.',
    call('record_practice', said(ids[1], 'not_recalled')),
  );
  assert.deepEqual(types(sent), ['conversation.item.create']);
  // Asked the next cue without a question mark: still counts as asked.
  const nextCue = seed.phrases.find((p) => p.id === ids[2]).en;
  sent = turn(conn, `Good. Now: ${nextCue}.`, call('record_practice', said(ids[1], 'repeated')));
  assert.deepEqual(types(sent), ['conversation.item.create']);
  // Recorded without saying anything at all: prompt it.
  sent = turn(conn, '', call('record_practice', said(ids[2])));
  assert.deepEqual(types(sent), ['conversation.item.create', 'response.create']);
});

test('a phrase outside the session is refused and never reaches the record', async () => {
  const h = await harness();
  await h.controller.start({ minutes: 10 });
  const conn = h.realtime.last;
  const sent = turn(
    conn,
    'What does Tudo bem mean?',
    call('record_practice', said('tudo-bem', 'not_recalled')),
  );
  assert.match(JSON.parse(sent[0].item.output).error, /not part of this session/);
  const unknown = turn(conn, 'Hm.', call('record_practice', said('onde-fica-o-banheiro')));
  assert.match(JSON.parse(unknown[0].item.output).error, /Unknown phrase id/);
  assert.equal(h.local.read(KEYS.lesson).attempts.length, 0);
});

test('silence gets two short prompts and then the tutor waits', async () => {
  const h = await harness();
  await h.controller.start({ minutes: 10 });
  const conn = h.realtime.last;
  conn.emit({ type: 'response.created' });
  conn.emit({ type: 'output_audio_buffer.started' });
  conn.emit({ type: 'response.output_audio_transcript.done', transcript: 'How do you say "Hi"?' });
  conn.emit(usage('r-open'));
  assert.equal(h.timers.pendingTimeouts, 0, 'not while the tutor is still audible');
  conn.emit({ type: 'output_audio_buffer.stopped' });
  assert.equal(h.timers.pendingTimeouts, 1);
  let before = conn.sent.length;
  await h.timers.runTimeouts();
  assert.match(direction(conn.sent[before]), /repeat your last cue/);
  turn(conn, 'How do you say "Hi"?');
  before = conn.sent.length;
  await h.timers.runTimeouts();
  assert.match(direction(conn.sent[before]), /first sound of the answer/);
  turn(conn, 'It starts with O.');
  before = conn.sent.length;
  await h.timers.runTimeouts();
  assert.equal(conn.sent.length, before, 'no third prompt');
  // Dan speaking clears the timer and resets the count.
  conn.emit({ type: 'input_audio_buffer.speech_started' });
  assert.equal(h.timers.pendingTimeouts, 0);
  turn(conn, 'Yes. Next?');
  before = conn.sent.length;
  await h.timers.runTimeouts();
  assert.match(direction(conn.sent[before]), /repeat your last cue/);
});

test('the tutor cannot skip ahead while cues are still waiting', async () => {
  const h = await harness();
  await h.controller.start({ minutes: 10 });
  const conn = h.realtime.last;
  const sent = turn(conn, 'Moving on.', call('next_step'));
  const output = JSON.parse(sent[0].item.output);
  assert.equal(output.not_finished, true);
  assert.equal(output.remaining.length, 3);
  assert.equal(h.controller.step, 'review');
  assert.ok(!types(sent).includes('session.update'));
});

test('a quick quiz asks its list, announces the score and finishes by itself', async () => {
  const h = await harness();
  await h.controller.start({ minutes: 5, mode: 'quiz' });
  const conn = h.realtime.last;
  assert.match(conn.session.instructions, /CURRENT STEP: QUICK QUIZ/);
  assert.match(direction(conn.sent[1]), /Say "Quick quiz, 8 questions\."/);
  const items = h.controller.record.plan.queue;
  items.forEach((item, i) => {
    const sent = turn(
      conn,
      i === items.length - 1 ? 'Yes.' : 'Yes. Next?',
      call(
        'record_practice',
        said(item.id, i === 0 ? 'not_recalled' : 'independent', {
          context: item.kind === 'meaning' ? 'meaning' : 'isolated',
        }),
      ),
    );
    if (i === items.length - 1) {
      assert.deepEqual(types(sent), [
        'conversation.item.create',
        'session.update',
        'response.create',
      ]);
      assert.match(direction(sent[2]), /Tell Dan: "7 out of 8 without help\."/);
    }
  });
  assert.equal(h.controller.step, 'result');
  conn.emit({ type: 'response.created' });
  conn.emit({ type: 'output_audio_buffer.started' });
  conn.emit({
    type: 'response.output_audio_transcript.done',
    transcript: '7 out of 8 without help.',
  });
  conn.emit(usage('r-score'));
  assert.equal(conn.closed, false, 'the score is still being spoken');
  assert.equal(conn.mic, false);
  conn.emit({ type: 'output_audio_buffer.stopped' });
  await settle();
  assert.equal(conn.closed, true);
  const index = h.json(FILES.lessons);
  assert.equal(index[0].mode, 'quiz');
  assert.equal(index[0].score.pct, 88);
  assert.equal(h.gh.messages().at(-1), 'Quick quiz 2026-09-19: 7 of 8 without help');
  assert.equal(h.json(FILES.notebook).lessons.length, seed.lessons.length);
  await h.timers.runTimeouts();
  await settle();
  assert.equal(h.gh.messages().filter((m) => m.startsWith('Quick quiz')).length, 1, 'saved once');
});

test('time changes and the target being reached are handled by the app', async () => {
  const h = await harness();
  await h.controller.start({ minutes: 10 });
  const conn = h.realtime.last;
  h.advance(4 * 60000);
  let sent = turn(conn, '', call('set_lesson_time', { minutes: 2, mode: 'remaining' }));
  assert.equal(JSON.parse(sent[0].item.output).targetMinutes, 6);
  assert.match(direction(sent[1]), /Acknowledge the new time/);
  assert.equal(h.local.read(KEYS.lesson).minutes, 6);
  turn(conn, 'Two minutes. How do you say "Hi"?');
  h.advance(2 * 60000 + 1000);
  const before = conn.sent.length;
  h.timers.tick();
  sent = conn.sent.slice(before);
  assert.deepEqual(types(sent), ['session.update', 'response.create']);
  assert.match(sent[0].session.instructions, /CURRENT STEP: WRAP UP/);
  assert.match(direction(sent[1]), /Keep going, or finish here\?/);
  h.timers.tick();
  assert.equal(conn.sent.length, before + 2, 'asked once');
  // Dan says keep going: the tutor asks for the next step and gets another round.
  turn(conn, 'Keep going or finish here?');
  sent = turn(conn, '', call('next_step'));
  assert.deepEqual(types(sent), ['conversation.item.create', 'session.update', 'response.create']);
  assert.match(sent[1].session.instructions, /CURRENT STEP: RECALL/);
  assert.throws(() => h.controller.setTime(90, 'total'), /1–55/);
});

test('the tutor finishing waits for its last words, then saves once', async () => {
  const h = await harness();
  await h.controller.start({ minutes: 10 });
  const conn = h.realtime.last;
  const first = queueOf(h)[0];
  turn(conn, 'Yes. Next?', call('record_practice', said(first, 'prompted')));
  conn.emit({ type: 'output_audio_buffer.started' });
  turn(conn, 'Nice work today.', call('finish_lesson'));
  assert.ok(h.types().includes('ready_to_finish'));
  assert.equal(conn.mic, false);
  assert.equal(conn.closed, false);
  conn.emit({ type: 'output_audio_buffer.stopped' });
  await settle();
  assert.equal(conn.closed, true);
  await h.timers.runTimeouts();
  await settle();
  assert.equal(h.json(FILES.lessons).length, 1);
  assert.equal(h.gh.messages().filter((m) => m.startsWith('Lesson')).length, 1);
  const phrase = h.json(FILES.notebook).phrases.find((p) => p.id === first);
  assert.equal(phrase.level, 'Developing', 'a prompted answer keeps the phrase Developing');
  assert.equal(phrase.lastTested, '2026-09-19');
});

test('a session interrupted by a closed tab is recovered and saved on the next visit', async () => {
  const h = await harness();
  await h.controller.start({ minutes: 15 });
  const conn = h.realtime.last;
  const first = queueOf(h)[0];
  turn(conn, 'Yes. Next?', call('record_practice', said(first)));
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
      throw new Error('notes should not be called');
    },
    getMic: async () => fakeMic(),
    timers: fakeTimers(),
  });
  await assert.rejects(fresh.start(), /Finish or recover/);
  const result = await fresh.recover();
  assert.equal(result.saved, true);
  assert.equal(result.record.status, 'interrupted');
  assert.equal(result.record.usageIncomplete, true);
  assert.equal(h.json(FILES.practice).length, 1);
  assert.equal(h.json(FILES.lessons)[0].status, 'interrupted');
  assert.equal(await fresh.recover(), null);
});

test('a record left by the previous version of the app is still saved', async () => {
  const h = await harness();
  const legacy = {
    id: 'aaaaaaaa-0000-4000-8000-000000000009',
    created: 1,
    started: Date.parse('2026-09-22T22:00:00Z'),
    lastSeen: Date.parse('2026-09-22T22:03:00Z'),
    ended: null,
    minutes: 5,
    model: 'gpt-realtime-2.1',
    status: 'active',
    previousPlan: seed.next,
    attempts: [
      {
        phraseId: 'estou-bem',
        pt: 'Estou bem',
        en: 'I’m well',
        heard: 'estou bem',
        result: 'independent',
        context: 'isolated',
        pronunciation: 'clear',
        note: 'Clear.',
        at: Date.parse('2026-09-22T22:01:00Z'),
      },
    ],
    transcript: [],
    usage: [{ id: 'old-1', model: 'gpt-realtime-2.1', category: 'voice', usd: 0.02, at: 5 }],
    toolOutputs: {},
    summary: null,
    summaryStatus: 'pending',
    usageIncomplete: false,
    error: null,
  };
  h.local.write(KEYS.lesson, legacy);
  const result = await h.controller.recover();
  assert.equal(result.saved, true);
  assert.equal(result.mode, 'lesson');
  assert.equal(h.json(FILES.lessons)[0].date, '2026-09-23');
  assert.equal(h.json(FILES.practice)[0].phraseId, 'estou-bem');
  assert.equal(h.local.read(KEYS.lesson), null);
});

test('a save conflict is retried against the fresh notebook without duplicating anything', async () => {
  const h = await harness();
  let failed = false;
  const original = h.store.commit;
  h.store.commit = async (args) => {
    if (!failed) {
      failed = true;
      await h.gh.setFile(
        FILES.notebook,
        pretty({ ...seed, tutorNotes: 'Edited on the desktop meanwhile' }),
      );
      throw new ConflictError('changed', FILES.notebook);
    }
    return original(args);
  };
  await h.controller.start({ minutes: 10 });
  turn(h.realtime.last, 'Yes. Next?', call('record_practice', said(queueOf(h)[0])));
  const result = await h.controller.finish();
  assert.equal(result.saved, true);
  assert.equal(h.json(FILES.notebook).tutorNotes, 'Edited on the desktop meanwhile');
  assert.equal(h.json(FILES.lessons).length, 1);
  assert.equal(h.json(FILES.practice).length, 1);
});

test('a failed save keeps the checkpoints on the device and can be retried', async () => {
  const h = await harness();
  await h.controller.start({ minutes: 10 });
  turn(h.realtime.last, 'Yes. Next?', call('record_practice', said(queueOf(h)[0])));
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
  assert.equal(h.json(FILES.practice).length, 1);
});

test('the budget guard refuses to start and ends a running session', async () => {
  const spent = [
    { id: 'old', usd: 50, at: Date.parse('2026-09-10T00:00:00Z'), model: 'gpt-realtime-2.1' },
  ];
  const over = await harness({ files: { [FILES.usage]: pretty(spent) } });
  await assert.rejects(over.controller.start(), /monthly API budget/);
  assert.equal(over.local.read(KEYS.lesson), null);

  const h = await harness({ files: { [FILES.usage]: pretty([{ ...spent[0], usd: 42 }]) } });
  await h.controller.start({ minutes: 20 });
  const conn = h.realtime.last;
  turn(conn, 'Yes. Next?', call('record_practice', said(queueOf(h)[0])));
  conn.emit({ type: 'response.created' });
  conn.emit({
    type: 'response.done',
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
  await settle();
  assert.ok(h.events.some((e) => e.type === 'notice' && /budget/.test(e.message)));
  assert.equal(conn.closed, true);
  assert.equal(h.json(FILES.lessons).length, 1);
});

test('nothing said means nothing saved; a cancelled session keeps only its cost', async () => {
  const empty = await harness();
  await empty.controller.start({ minutes: 20 });
  const none = await empty.controller.finish();
  assert.equal(none.discarded, true);
  assert.equal(empty.json(FILES.lessons).length, 0);

  const h = await harness();
  await h.controller.start({ minutes: 20 });
  turn(h.realtime.last, 'Morning Dan. How do you say "Hi"?');
  const result = await h.controller.finish();
  assert.equal(result.discarded, true);
  assert.equal(h.local.read(KEYS.lesson), null);
  const index = h.json(FILES.lessons);
  assert.equal(index.length, 1);
  assert.equal(index[0].checkpoints, 0);
  assert.equal(h.json(FILES.usage).length, 1);
  assert.equal(h.json(FILES.practice).length, 0);
  const file = JSON.parse(h.gh.files()[index[0].file]);
  assert.equal(
    file.transcript[0].text,
    'Morning Dan. How do you say "Hi"?',
    'what the tutor said is kept',
  );
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

test('any past session can be written up as a journal entry on request', async () => {
  const h = await harness();
  await h.controller.start({ minutes: 10 });
  turn(h.realtime.last, 'Yes. Next?', call('record_practice', said(queueOf(h)[0])));
  const saved = await h.controller.finish();
  assert.equal(h.json(FILES.notebook).lessons.length, seed.lessons.length);
  const written = await h.controller.writeUp(saved.id);
  assert.equal(written.summary.title, 'AI recap title');
  const notebook = h.json(FILES.notebook);
  assert.equal(notebook.lessons.filter((l) => l.voiceSessionId === saved.id).length, 1);
  assert.equal(h.json(FILES.lessons)[0].journal, true);
  assert.ok(h.json(FILES.usage).some((u) => u.id === 'notes-1'));
  assert.ok(h.events.some((e) => e.type === 'journal'));
  await h.controller.writeUp(saved.id);
  assert.equal(
    h.json(FILES.notebook).lessons.filter((l) => l.voiceSessionId === saved.id).length,
    1,
  );
  await assert.rejects(h.controller.writeUp('nope'), /not in the history/);
});

test('feedback from earlier sessions and Dan’s own note reach the tutor', async () => {
  const lessons = [
    {
      id: 'x',
      started: 5,
      feedback: { tags: ['too_chatty', 'off_track'], note: 'Stop asking if I want to finish.' },
    },
  ];
  const gh = await createFakeGitHub({
    files: {
      [FILES.notebook]: pretty({ ...seed, tutorNotes: 'Trip to São Paulo in March.' }),
      [FILES.usage]: '[]\n',
      [FILES.practice]: '[]\n',
      [FILES.lessons]: pretty(lessons),
    },
  });
  const store = createGitHubStore({
    token: 'good-token',
    owner: 'dan',
    repo: 'fala',
    fetch: gh.fetch,
  });
  const realtime = fakeRealtime();
  const controller = createLessonController({
    store,
    local: createLocal(fakeStorage()),
    getSecrets: () => ({ openaiKey: 'sk' }),
    getSettings: () => ({ ...DEFAULT_SETTINGS, pace: 'patient', mic: 'far' }),
    getNotebook: () => ({ ...seed, tutorNotes: 'Trip to São Paulo in March.' }),
    getLessons: () => lessons,
    connect: realtime.connect,
    getMic: async () => fakeMic(),
    timers: fakeTimers(),
  });
  await controller.start({ minutes: 10 });
  const session = realtime.last.session;
  assert.match(session.instructions, /ABOUT DAN/);
  assert.match(session.instructions, /too chatty/);
  assert.match(session.instructions, /went off track/);
  assert.match(session.instructions, /Stop asking if I want to finish/);
  assert.match(session.instructions, /Trip to São Paulo in March/);
  assert.equal(session.audio.input.turn_detection.eagerness, 'low');
  assert.equal(session.audio.input.noise_reduction.type, 'far_field');
});

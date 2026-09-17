import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import worker from '../worker/index.js';
import { seed } from '../public/seed.js';
import {
  priceUsage,
  applyLesson,
  fallbackSummary,
  validateAttempt,
  monthStart,
} from '../worker/domain.js';

function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(fs.readFileSync(new URL('../drizzle/0000_thin_the_order.sql', import.meta.url), 'utf8'));
  return {
    sql,
    prepare(query) {
      let params = [];
      const stmt = sql.prepare(query);
      return {
        bind(...p) {
          params = p;
          return this;
        },
        async first() {
          return stmt.get(...params) || null;
        },
        async all() {
          return { results: stmt.all(...params) };
        },
        async run() {
          const r = stmt.run(...params);
          return { meta: { changes: r.changes } };
        },
      };
    },
  };
}
function harness() {
  const DB = database(),
    pending = [];
  const env = { DB };
  const ctx = {
    waitUntil(p) {
      pending.push(p);
    },
  };
  return {
    env,
    DB,
    pending,
    async request(path, method = 'GET', data, owner = 'dan', extra = {}) {
      const h = { 'oai-authenticated-user-id': owner, ...extra };
      if (data !== undefined) h['Content-Type'] = 'application/json';
      const r = await worker.fetch(
        new Request('https://fala.example/api' + path, {
          method,
          headers: h,
          body: data === undefined ? undefined : JSON.stringify(data),
        }),
        env,
        ctx,
      );
      return { status: r.status, data: await r.json() };
    },
    async drain() {
      await Promise.allSettled(pending);
    },
  };
}
const attempt = (overrides = {}) => ({
  phraseId: 'estou-bem',
  pt: 'Estou bem',
  en: 'I’m well',
  heard: 'Estou bem',
  result: 'independent',
  context: 'isolated',
  pronunciation: 'clear',
  note: 'Correct from a meaning cue, without a model.',
  ...overrides,
});

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
test('private APIs reject anonymous requests and cross-site mutations', async () => {
  const h = harness();
  assert.equal((await h.request('/usage', 'GET', undefined, '')).status, 401);
  assert.equal(
    (
      await h.request('/bootstrap', 'POST', { state: seed }, 'dan', {
        origin: 'https://other.example',
      })
    ).status,
    403,
  );
});
test('migration imports existing personal notes once without overwriting from another device', async () => {
  const h = harness();
  const local = structuredClone(seed);
  local.next.notes = 'Dan’s personal next lesson note';
  const a = await h.request('/bootstrap', 'POST', { state: local });
  assert.equal(a.status, 200);
  assert.equal(a.data.state.next.notes, local.next.notes);
  assert.equal(a.data.configured, false);
  const b = await h.request('/bootstrap', 'POST', { state: seed });
  assert.equal(b.data.state.next.notes, local.next.notes);
});
test('concurrent notebook updates preserve the first save and return the conflicting draft', async () => {
  const h = harness();
  await h.request('/bootstrap', 'POST', { state: seed });
  const a = structuredClone(seed);
  a.next.notes = 'First edit';
  const b = structuredClone(seed);
  b.next.notes = 'Second edit';
  assert.equal((await h.request('/notebook', 'PUT', { state: a, revision: 1 })).status, 200);
  const conflict = await h.request('/notebook', 'PUT', { state: b, revision: 1 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.state.next.notes, 'First edit');
  assert.equal(conflict.data.revision, 2);
});
test('voice without a key does not fabricate a session or spend', async () => {
  const h = harness();
  await h.request('/bootstrap', 'POST', { state: seed });
  const r = await h.request('/voice', 'POST', { sdp: 'v=0', minutes: 20 });
  assert.equal(r.status, 503);
  assert.equal(h.DB.sql.prepare('SELECT COUNT(*) AS n FROM voice_sessions').get().n, 0);
  const usage = await h.request('/usage');
  assert.equal(usage.data.usd, 0);
  assert.equal(usage.data.lessons, 0);
});
test('lesson summary recovery is idempotent and updates the notebook from saved checkpoints', async () => {
  const h = harness();
  await h.request('/bootstrap', 'POST', { state: seed });
  const id = '00000000-0000-4000-8000-000000000001',
    now = Date.now();
  h.DB.sql
    .prepare(
      `INSERT INTO voice_sessions (id,owner,status,model,minutes,started,last_seen,ended,snapshot) VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      'dan',
      'interrupted',
      'gpt-realtime-2.1',
      20,
      now - 600000,
      now,
      now,
      JSON.stringify(seed),
    );
  h.DB.sql
    .prepare('INSERT INTO lesson_events (id,session_id,kind,body,at) VALUES (?,?,?,?,?)')
    .run('attempt-1', id, 'practice', JSON.stringify(attempt({ result: 'prompted' })), now);
  const one = await h.request('/voice/' + id + '/retry', 'POST', {});
  assert.equal(one.status, 200);
  assert.equal(one.data.saved, true);
  await h.request('/voice/' + id + '/retry', 'POST', {});
  const n = await h.request('/notebook');
  assert.equal(n.data.state.lessons.filter((l) => l.voiceSessionId === id).length, 1);
  assert.equal(n.data.state.phrases.find((p) => p.pt === 'Estou bem').level, 'Developing');
  assert.equal((await h.request('/voice/' + id, 'GET', undefined, 'another-user')).status, 404);
});
test('cost ledger is owner-scoped and duplicate API responses are counted once', async () => {
  const h = harness();
  await h.request('/bootstrap', 'POST', { state: seed });
  const now = Date.now();
  const stmt = h.DB.sql.prepare(
    'INSERT OR IGNORE INTO usage_events (id,session_id,owner,model,category,usd,details,at,pricing_version) VALUES (?,?,?,?,?,?,?,?,?)',
  );
  stmt.run('response1', 'session', 'dan', 'gpt-realtime-2.1', 'voice', 0.4, '{}', now, 'test');
  stmt.run('response1', 'session', 'dan', 'gpt-realtime-2.1', 'voice', 0.4, '{}', now, 'test');
  stmt.run('response2', 'session2', 'other', 'gpt-realtime-2.1', 'voice', 20, '{}', now, 'test');
  const r = await h.request('/usage');
  assert.equal(r.data.usd, 0.4);
  assert.equal(r.data.responses, 1);
});

test('voice session saves server-observed practice and usage, then finalizes exactly once', async (t) => {
  const h = harness();
  await h.request('/bootstrap', 'POST', { state: seed });
  h.env.OPENAI_API_KEY = 'test-key-never-returned';
  const originalFetch = globalThis.fetch,
    OriginalResponse = globalThis.Response,
    OriginalPair = globalThis.WebSocketPair;
  class Socket {
    constructor() {
      this.readyState = 1;
      this.events = {};
      this.sent = [];
    }
    accept() {}
    addEventListener(k, fn) {
      (this.events[k] ??= []).push(fn);
    }
    send(v) {
      this.sent.push(JSON.parse(v));
    }
    close() {
      this.readyState = 3;
      for (const fn of this.events.close || []) fn({});
    }
    emit(v) {
      for (const fn of this.events.message || []) fn({ data: JSON.stringify(v) });
    }
  }
  const upstream = new Socket();
  let browser;
  let configuration;
  globalThis.WebSocketPair = class {
    constructor() {
      this[0] = new Socket();
      this[1] = browser = new Socket();
    }
  };
  globalThis.Response = class extends OriginalResponse {
    constructor(body, init) {
      if (init?.status === 101) {
        super(null, { status: 200 });
        this.webSocket = init.webSocket;
      } else super(body, init);
    }
  };
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('/realtime/calls')) {
      configuration = JSON.parse(init.body.get('session'));
      return new OriginalResponse('v=0\r\n', {
        status: 201,
        headers: { location: 'https://api.openai.com/v1/realtime/calls/rtc_test_1' },
      });
    }
    if (url.includes('/realtime?call_id=')) return { webSocket: upstream };
    if (url.endsWith('/hangup')) return new OriginalResponse(null, { status: 200 });
    if (url.endsWith('/responses')) {
      const summary = fallbackSummary({ status: 'complete' }, [attempt()]);
      return OriginalResponse.json({
        id: 'summary_1',
        usage: { input_tokens: 100, output_tokens: 200 },
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(summary) }] }],
      });
    }
    throw new Error('Unexpected upstream request');
  };
  t.after(() => {
    browser?.close();
    upstream.close();
    globalThis.fetch = originalFetch;
    globalThis.Response = OriginalResponse;
    globalThis.WebSocketPair = OriginalPair;
  });
  const created = await h.request('/voice', 'POST', {
    sdp: 'v=0\r\n',
    minutes: 20,
    model: 'gpt-realtime-2.1',
  });
  assert.equal(created.status, 201);
  assert.ok(!JSON.stringify(created.data).includes('test-key'));
  assert.equal(configuration.audio.input.turn_detection.create_response, false);
  assert.ok(configuration.instructions.includes('Estou bem'));
  assert.equal((await h.request('/voice', 'POST', { sdp: 'v=0', minutes: 20 })).status, 409);
  const id = created.data.id;
  const control = await worker.fetch(
    new Request('https://fala.example/api/voice/' + id + '/control', {
      headers: {
        'oai-authenticated-user-id': 'dan',
        Upgrade: 'websocket',
        Origin: 'https://fala.example',
      },
    }),
    h.env,
    { waitUntil: (p) => h.pending.push(p) },
  );
  assert.ok(control.webSocket);
  const until = async (fn) => {
    for (let i = 0; i < 100; i++) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('Timed out waiting for session state');
  };
  browser.emit({ type: 'ready' });
  await until(() => browser.sent.some((e) => e.type === 'started'));
  upstream.emit({ type: 'response.created' });
  upstream.emit({
    type: 'response.function_call_arguments.done',
    name: 'record_practice',
    call_id: 'practice1',
    arguments: JSON.stringify(attempt()),
  });
  const done = {
    type: 'response.done',
    response: {
      id: 'response1',
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
  };
  upstream.emit(done);
  upstream.emit(done);
  await until(() => browser.sent.some((e) => e.type === 'checkpoint'));
  browser.emit({ type: 'finish' });
  await until(() => browser.sent.some((e) => e.type === 'saved'));
  const notebook = await h.request('/notebook');
  assert.equal(notebook.data.state.lessons.filter((l) => l.voiceSessionId === id).length, 1);
  const usage = await h.request('/usage');
  assert.equal(usage.data.responses, 2);
  assert.ok(usage.data.usd > 0);
  assert.equal(usage.data.sessions[0].summary_status, 'saved');
});

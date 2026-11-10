// Headless Chromium smoke test: connection screen, notebook loading from a
// fake GitHub API, an edit committed back, reload persistence, settings,
// the session picker and plan preview, progress and history, an on-demand
// write-up, and the voice error path when OpenAI cannot be reached.
//   npm run test:browser
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createFakeGitHub } from '../helpers/fake-github.mjs';
import { history } from '../helpers/fakes.mjs';
import { pretty, FILES } from '../../public/lib/lesson.js';
import { DEFAULT_SETTINGS } from '../../public/lib/domain.js';
import { seed } from '../../baseline/seed.js';

const PORT = 3123;
const ORIGIN = `http://localhost:${PORT}`;
const server = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(ORIGIN + '/index.html')).ok) break;
  } catch {}
  await sleep(100);
}
// One earlier session so the history and progress screens have something real.
const SESSION = '11111111-0000-4000-8000-000000000001';
const SESSION_FILE = 'data/lessons/2026-11-08-11111111.json';
const practice = [
  ...history('estou-bem', 'Estou bem', [['2026-11-08', 'independent']]),
  ...history('e-voce', 'E você?', [['2026-11-08', 'not_recalled']]),
].map((p) => ({ ...p, sessionId: SESSION, en: p.phraseId === 'e-voce' ? 'And you?' : 'I’m well' }));
const started = Date.parse('2026-11-08T00:00:00Z');
const sessionRecord = {
  id: SESSION,
  started,
  ended: started + 6 * 60000,
  lastSeen: started + 6 * 60000,
  minutes: 5,
  model: 'gpt-realtime-2.1',
  mode: 'lesson',
  status: 'complete',
  attempts: practice,
  transcript: [{ speaker: 'Tutor', text: 'Morning Dan. How do you say “I’m well”?', at: started }],
  usage: [],
};
const gh = await createFakeGitHub({
  owner: 'dan',
  repo: 'fala',
  files: {
    [FILES.notebook]: pretty(seed),
    [FILES.settings]: pretty(DEFAULT_SETTINGS),
    [FILES.usage]: '[]\n',
    [FILES.practice]: pretty(practice),
    [FILES.lessons]: pretty([
      {
        id: SESSION,
        date: '2026-11-08',
        started,
        ended: started + 6 * 60000,
        mode: 'lesson',
        status: 'complete',
        checkpoints: 2,
        usd: 0.1,
        score: { asked: 2, unaided: 1, prompted: 0, missed: 1, pct: 50, conversation: 0 },
        journal: false,
        file: SESSION_FILE,
      },
    ]),
    [SESSION_FILE]: pretty(sessionRecord),
  },
});
const json = (file) => JSON.parse(gh.files()[file]);
const waitFor = async (fn, label) => {
  for (let i = 0; i < 150; i++) {
    if (fn()) return;
    await sleep(100);
  }
  throw new Error('Timed out waiting for ' + label);
};
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const errors = [];
const step = (name) => console.log('•', name);
let voiceUp = false;
// Set FALA_SHOTS to a folder to keep screenshots of the main screens.
const shots = process.env.FALA_SHOTS;
try {
  const context = await browser.newContext();
  await context.grantPermissions(['microphone'], { origin: ORIGIN });
  await context.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    const headers = req.headers();
    const res = await gh.fetch(req.url(), {
      method: req.method(),
      headers: { Authorization: headers.authorization || '' },
      body: req.postData() || undefined,
    });
    await route.fulfill({
      status: res.status,
      contentType: 'application/json',
      body: await res.text(),
    });
  });
  await context.route('https://api.openai.com/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/v1/models'))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            { id: 'gpt-realtime-2.1' },
            { id: 'gpt-realtime-2.1-mini' },
            { id: 'gpt-5.6-luna' },
          ],
        }),
      });
    if (url.includes('/v1/realtime/calls') && voiceUp)
      return route.fulfill({
        status: 201,
        headers: { location: 'https://api.openai.com/v1/realtime/calls/rtc_test' },
        contentType: 'application/sdp',
        body: 'v=0\r\n',
      });
    // Otherwise voice and the notes model are both "down" in this test.
    return route.fulfill({
      status: url.includes('/v1/realtime/calls') ? 502 : 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'simulated outage' } }),
    });
  });
  // A stand-in for the browser's WebRTC connection, so a whole session can
  // be driven through the real screens. Events the app sends are collected
  // in window.__sent; the test feeds tutor events in through window.__tutor.
  await context.addInitScript(() => {
    window.__sent = [];
    class FakeChannel {
      constructor() {
        this.readyState = 'open';
        window.__tutor = (event) => this.onmessage?.({ data: JSON.stringify(event) });
      }
      send(data) {
        window.__sent.push(JSON.parse(data));
      }
      close() {
        this.readyState = 'closed';
      }
    }
    window.RTCPeerConnection = class {
      constructor() {
        this.iceGatheringState = 'complete';
        this.connectionState = 'connected';
        this.localDescription = null;
      }
      addTrack() {}
      addEventListener() {}
      createDataChannel() {
        return new FakeChannel();
      }
      async createOffer() {
        return { type: 'offer', sdp: 'v=0\r\n' };
      }
      async setLocalDescription(d) {
        this.localDescription = d;
      }
      async setRemoteDescription() {}
      close() {
        this.connectionState = 'closed';
      }
    };
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    // the deliberate 502 and 503 from the fake OpenAI endpoints log resource errors
    if (m.type() === 'error' && !/status of 50[23]/.test(m.text()))
      errors.push('console: ' + m.text());
  });
  const synced = () =>
    page.waitForFunction(
      () => document.querySelector('[data-sync-label]')?.textContent === 'Notebook synced',
      null,
      { timeout: 15000 },
    );
  const main = () => page.textContent('#main');

  step('connection screen appears first');
  await page.goto(ORIGIN + '/');
  await page.waitForSelector('#setup-form');
  assert.match(await page.textContent('h1'), /Welcome to Fala/);
  await page.fill('#setup-owner', 'dan');
  await page.fill('#setup-repo', 'fala');
  await page.fill('#setup-github', 'good-token');
  await page.fill('#setup-openai', 'sk-test-123');
  await page.click('#setup-form button[type=submit]');

  step('notebook loads and the front page shows costs and challenges');
  await page.waitForSelector('.cost-card', { timeout: 15000 });
  await synced();
  const overview = await main();
  assert.match(overview, /API cost tracker/);
  assert.match(overview, /Voice connected/);
  assert.match(overview, /Make “E você\?” stick/);
  assert.equal(await page.locator('.challenge-strip .challenge').count(), 3);
  await page.click('[data-nav="lessons"]');
  await page.waitForSelector('.journal-card');
  assert.equal(await page.locator('.journal-card').count(), seed.lessons.length);

  step('an edit is committed back to the repository');
  await page.click('[data-nav="next"]');
  assert.match(await main(), /Your next lesson, from your practice record/);
  await page.click('[data-action="edit-next"]');
  await page.fill('#field-notes', 'Smoke test note');
  await page.click('form[data-form="next"] button[type=submit]');
  await waitFor(() => gh.files()[FILES.notebook].includes('Smoke test note'), 'note commit');
  assert.equal(gh.messages().at(-1), 'Update notebook');
  await synced();

  step('reload keeps the connection and shows the committed note');
  await page.reload();
  await synced();
  assert.match(await main(), /Smoke test note/);

  step('cost settings are saved to data/settings.json');
  await page.click('[data-nav="costs"]');
  await page.click('.usage-settings summary');
  await page.fill('#cost-settings input[name="budgetAud"]', '45');
  await page.click('#cost-settings button[type=submit]');
  await waitFor(() => json(FILES.settings).budgetAud === 45, 'budget commit');

  step('the speak screen offers three session types with a plan built from the record');
  await page.click('[data-nav="voice"]');
  await page.waitForSelector('.mode-picker');
  assert.equal(await page.locator('.mode-picker .mode').count(), 3);
  const lessonPlan = await page.textContent('.voice-lesson-notes');
  assert.match(lessonPlan, /1\. Recall/);
  assert.match(lessonPlan, /And you\?\s*needs work/, 'the missed phrase is flagged');
  assert.match(await page.textContent('[data-voice="start"]'), /Start lesson/);
  await page.click('[data-mode="quiz"]');
  assert.match(await page.textContent('.voice-lesson-notes'), /quick questions/);
  assert.match(await page.textContent('[data-voice="start"]'), /Start quick quiz/);
  await page.click('[data-mode="challenge"]');
  assert.match(await page.textContent('.voice-lesson-notes'), /role-play/);
  await page.click('[data-mode="lesson"]');

  step('reply speed and a note for the tutor are saved');
  await page.selectOption('#voice-pace', 'balanced');
  await waitFor(() => json(FILES.settings).pace === 'balanced', 'pace commit');
  await page.fill('#tutor-notes', 'Café phrases matter most.');
  await page.click('[data-voice="save-tutor-notes"]');
  await waitFor(() => json(FILES.notebook).tutorNotes === 'Café phrases matter most.', 'note');
  await synced();

  step('a failed voice connection is reported and leaves nothing pending');
  await page.waitForSelector('[data-voice="start"]:not([disabled])');
  await page.click('[data-voice="start"]');
  await page.waitForFunction(
    () =>
      /Voice could not connect \(502/.test(
        document.getElementById('voice-message')?.textContent || '',
      ),
    null,
    { timeout: 30000 },
  );
  assert.equal(await page.evaluate(() => localStorage.getItem('fala-active-lesson-v1')), null);
  await page.waitForSelector('[data-voice="start"]:not([disabled])');

  step('progress shows what is working and what is not, with the session history');
  await page.click('[data-nav="progress"]');
  const progress = await main();
  assert.match(progress, /What’s working, what isn’t/);
  assert.match(progress, /1 of 2 recall tests without help/);
  assert.match(progress, /Not sticking 0/);
  assert.match(progress, /Nearly there 2/);
  assert.equal(await page.locator('.history-item').count(), 1);
  await page.click('[data-voice="toggle-session"]');
  assert.match(await page.textContent('.history-body'), /E você\?\s*not recalled/);
  await page.click('[data-voice="show-said"]');
  await page.waitForSelector('.said');
  assert.match(await page.textContent('.said'), /Morning Dan\. How do you say/);

  step('a past session can be written up on request, even with the notes model down');
  await page.click('[data-voice="write-up"]');
  await waitFor(
    () => json(FILES.notebook).lessons.some((l) => l.voiceSessionId === SESSION),
    'journal entry',
  );
  const entry = json(FILES.notebook).lessons.find((l) => l.voiceSessionId === SESSION);
  assert.equal(entry.title, 'Lesson: 1 of 2 without help');
  assert.equal(json(FILES.lessons)[0].journal, true);
  await page.waitForFunction(() => /Journal entry written/.test(document.body.textContent));
  await synced();

  step('a whole simulated session runs through the real screens and is saved');
  voiceUp = true;
  const shot = async (name) => {
    if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
  };
  const tutor = (event) => page.evaluate((e) => window.__tutor(e), event);
  let n = 0;
  const say = async (text, ...calls) => {
    await tutor({ type: 'response.created' });
    if (text) await tutor({ type: 'response.output_audio_transcript.done', transcript: text });
    for (const [name, args] of calls)
      await tutor({
        type: 'response.function_call_arguments.done',
        name,
        call_id: `call-${++n}`,
        arguments: JSON.stringify(args),
      });
    await tutor({
      type: 'response.done',
      response: {
        id: `resp-${++n}`,
        usage: {
          input_tokens: 400,
          output_tokens: 120,
          input_token_details: { audio_tokens: 40, text_tokens: 360, cached_tokens: 0 },
          output_token_details: { audio_tokens: 100, text_tokens: 20 },
        },
      },
    });
  };
  const heard = (id, result) => [
    'record_practice',
    { id, result, context: 'isolated', pronunciation: 'clear' },
  ];
  await page.click('[data-nav="voice"]');
  await page.selectOption('#voice-duration', '10');
  await waitFor(() => json(FILES.settings).minutes === 10, 'duration commit');
  await shot('1-speak-ready');
  await page.click('[data-voice="start"]');
  await page.waitForSelector('[data-voice="finish"].primary', { timeout: 20000 });
  assert.match(await page.textContent('#voice-phase'), /RECALL/);
  const sent = await page.evaluate(() => window.__sent);
  assert.deepEqual(
    sent.map((e) => e.type),
    ['session.update', 'response.create'],
  );
  assert.match(
    sent[1].response.instructions,
    /RIGHT NOW: Greet Dan in one short sentence, then ask exactly:/,
  );
  assert.match(
    sent[1].response.instructions,
    /Dan asked you to keep in mind: "Café phrases matter most\."/,
  );
  const queue = await page.evaluate(
    () => JSON.parse(localStorage.getItem('fala-active-lesson-v1')).plan.queue,
  );
  assert.equal(queue.length, 4);
  assert.equal(queue[1].id, 'e-voce', 'the phrase missed last time is asked early');
  await say('Morning Dan. How do you say “I’m well”?');
  await say('Yes, estou bem. How do you say “And you?”', heard(queue[0].id, 'independent'));
  await say('Not quite. E você. Your turn.', heard(queue[1].id, 'not_recalled'));
  await say('Good. Next one?', heard(queue[1].id, 'repeated'));
  await page.waitForFunction(() => document.getElementById('voice-score')?.textContent === '1/2');
  await shot('2-speak-active');
  await say('Yes. Next?', heard(queue[2].id, 'independent'));
  await say('Yes.', heard(queue[3].id, 'independent'));
  // The missed phrase comes back once the others are done.
  await say('Yes.', heard(queue[1].id, 'independent'));
  await page.waitForFunction(() =>
    /NEW PHRASE|CONVERSATION/.test(document.getElementById('voice-phase')?.textContent || ''),
  );
  const after = await page.evaluate(() => window.__sent.slice(-2));
  assert.equal(after[0].type, 'session.update');
  assert.match(after[0].session.instructions, /CURRENT STEP: (ONE NEW PHRASE|SHORT CONVERSATION)/);
  await page.click('[data-voice="finish"]');
  await page.waitForSelector('.session-result', { timeout: 20000 });
  assert.match(await page.textContent('.session-result h3'), /3 of 4 without help/);
  assert.match(await page.textContent('#voice-phase'), /SESSION SAVED/);
  const index = json(FILES.lessons);
  assert.equal(index.length, 2);
  assert.equal(index[1].score.unaided, 3);
  assert.equal(json(FILES.practice).filter((p) => p.sessionId === index[1].id).length, 6);
  assert.equal(await page.evaluate(() => localStorage.getItem('fala-active-lesson-v1')), null);
  await page.click('[data-tag="too_chatty"]');
  await page.fill('#fb-note', 'Shorter praise please');
  await shot('3-speak-result');
  await page.click('[data-voice="fb-send"]');
  await waitFor(
    () => json(FILES.lessons)[1].feedback?.note === 'Shorter praise please',
    'feedback',
  );
  assert.deepEqual(json(FILES.lessons)[1].feedback.tags, ['too_chatty']);
  await synced();
  await page.click('[data-nav="progress"]');
  assert.equal(await page.locator('.history-item').count(), 2);
  const progressAfter = await main();
  assert.match(progressAfter, /5 of 7 recall tests without help/, 'the new attempts are counted');
  assert.match(progressAfter, /Nearly there 5/);
  await page.locator('.history-head').first().click();
  assert.match(
    await page.textContent('.history-body'),
    /Your feedback: Too chatty · “Shorter praise please”/,
    'feedback shows against the session',
  );
  await shot('4-progress');
  await page.click('[data-nav="overview"]');
  await page.waitForSelector('.cost-card');
  await shot('5-overview');
  if (shots) {
    // The phone is the main device: keep the same screens at phone width.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('[data-voice="open"]');
    await page.waitForSelector('.mode-picker');
    await shot('6-phone-speak');
    await page.evaluate(() => (location.hash = 'progress'));
    await page.waitForSelector('.history-list');
    await shot('7-phone-progress');
    await page.setViewportSize({ width: 1280, height: 720 });
  }

  step('forgetting keys returns to the connection screen');
  await page.click('[data-nav="setup"]');
  assert.match(await main(), /App version\s*2026-11-10/);
  page.once('dialog', (d) => d.accept());
  await page.click('[data-voice="disconnect"]');
  await page.waitForSelector('#setup-form');
  assert.equal(await page.evaluate(() => localStorage.getItem('fala-vault-v1')), null);

  assert.deepEqual(errors, []);
  console.log('Browser smoke test passed.');
} finally {
  await browser.close();
  server.kill();
}

// Headless Chromium smoke test: connection screen, notebook loading from a
// fake GitHub API, an edit committed back, reload persistence, settings,
// and the voice error path when OpenAI cannot be reached.
//   npm run test:browser
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { createFakeGitHub } from '../helpers/fake-github.mjs';
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
const gh = await createFakeGitHub({
  owner: 'dan',
  repo: 'fala',
  files: {
    [FILES.notebook]: pretty(seed),
    [FILES.settings]: pretty(DEFAULT_SETTINGS),
    [FILES.usage]: '[]\n',
    [FILES.practice]: '[]\n',
    [FILES.lessons]: '[]\n',
  },
});
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const errors = [];
const step = (name) => console.log('•', name);
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
    if (url.includes('/v1/realtime/calls'))
      return route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'simulated outage' } }),
      });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    // the deliberate 502 from the fake OpenAI endpoint logs a resource error
    if (m.type() === 'error' && !/status of 502/.test(m.text()))
      errors.push('console: ' + m.text());
  });
  const synced = () =>
    page.waitForFunction(
      () => document.querySelector('[data-sync-label]')?.textContent === 'Notebook synced',
      null,
      { timeout: 15000 },
    );

  step('connection screen appears first');
  await page.goto(ORIGIN + '/');
  await page.waitForSelector('#setup-form');
  assert.match(await page.textContent('h1'), /Welcome to Fala/);
  await page.fill('#setup-owner', 'dan');
  await page.fill('#setup-repo', 'fala');
  await page.fill('#setup-github', 'good-token');
  await page.fill('#setup-openai', 'sk-test-123');
  await page.click('#setup-form button[type=submit]');

  step('notebook loads from the repository');
  await page.waitForSelector('.cost-card', { timeout: 15000 });
  await synced();
  const overview = await page.textContent('#main');
  assert.match(overview, /API cost tracker/);
  assert.match(overview, /Voice connected/);
  await page.click('[data-nav="lessons"]');
  await page.waitForSelector('.journal-card');
  assert.equal(await page.locator('.journal-card').count(), seed.lessons.length);

  step('an edit is committed back to the repository');
  await page.click('[data-nav="next"]');
  await page.click('[data-action="edit-next"]');
  await page.fill('#field-notes', 'Smoke test note');
  await page.click('form[data-form="next"] button[type=submit]');
  for (let i = 0; i < 100 && !gh.files()[FILES.notebook].includes('Smoke test note'); i++)
    await sleep(100);
  assert.ok(gh.files()[FILES.notebook].includes('Smoke test note'), 'note committed');
  assert.equal(gh.messages().at(-1), 'Update notebook');
  await synced();

  step('reload keeps the connection and shows the committed note');
  await page.reload();
  await synced();
  assert.match(await page.textContent('#main'), /Smoke test note/);
  await page.click('[data-nav="overview"]');
  await page.waitForSelector('.cost-card');

  step('cost settings are saved to data/settings.json');
  await page.click('[data-nav="costs"]');
  assert.match(await page.textContent('#main'), /No API lessons yet/);
  await page.click('.usage-settings summary');
  await page.fill('#cost-settings input[name="budgetAud"]', '45');
  await page.click('#cost-settings button[type=submit]');
  for (let i = 0; i < 100 && !gh.files()[FILES.settings].includes('"budgetAud": 45'); i++)
    await sleep(100);
  assert.ok(gh.files()[FILES.settings].includes('"budgetAud": 45'), 'budget committed');

  step('a failed voice connection is reported and leaves nothing pending');
  await page.click('[data-nav="voice"]');
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

  step('forgetting keys returns to the connection screen');
  await page.click('[data-nav="setup"]');
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

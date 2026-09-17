import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../baseline/seed.js';
import { createGitHubStore } from '../public/lib/github.js';
import { createLocal, KEYS } from '../public/lib/local.js';
import { createSync } from '../public/lib/sync.js';
import { FILES, pretty } from '../public/lib/lesson.js';
import { createFakeGitHub } from './helpers/fake-github.mjs';
import { fakeStorage, fakeTimers } from './helpers/fakes.mjs';

async function harness(files = {}, storageSeed = {}) {
  const gh = await createFakeGitHub({ files: { [FILES.notebook]: pretty(seed), ...files } });
  const store = createGitHubStore({
    token: 'good-token',
    owner: 'dan',
    repo: 'fala',
    fetch: gh.fetch,
  });
  const storage = fakeStorage(storageSeed);
  const local = createLocal(storage);
  const timers = fakeTimers();
  let changes = 0;
  const sync = createSync({ store, local, timers, onChange: () => changes++ });
  return { gh, store, storage, local, timers, sync, changes: () => changes };
}

test('loads the notebook, settings and ledgers from the repository', async () => {
  const h = await harness({
    [FILES.settings]: pretty({ minutes: 15 }),
    [FILES.usage]: '[{"id":"u","usd":1,"at":1}]\n',
  });
  await h.sync.load();
  assert.equal(h.sync.status, 'saved');
  assert.equal(h.sync.notebook.state.phrases.length, seed.phrases.length);
  assert.equal(h.sync.settings.minutes, 15);
  assert.equal(h.sync.settings.budgetAud, 60);
  assert.equal(h.sync.usage.length, 1);
  assert.equal(h.sync.lessons.length, 0);
  assert.equal(h.local.read(KEYS.notebook).sha, h.sync.notebook.sha);
});

test('edits are committed after the debounce and the draft is cleared', async () => {
  const h = await harness();
  await h.sync.load();
  const edited = structuredClone(seed);
  edited.next.notes = 'My note';
  await h.sync.save(edited);
  assert.equal(h.sync.status, 'saving');
  assert.equal(h.local.read(KEYS.draft).state.next.notes, 'My note');
  await h.timers.runTimeouts();
  assert.equal(h.sync.status, 'saved');
  assert.equal(JSON.parse(h.gh.files()[FILES.notebook]).next.notes, 'My note');
  assert.equal(h.local.read(KEYS.draft), null);
  assert.equal(h.gh.messages().at(-1), 'Update notebook');
});

test('an edit from another device is surfaced as a conflict and the draft is kept', async () => {
  const h = await harness();
  await h.sync.load();
  const remote = structuredClone(seed);
  remote.next.notes = 'From the phone';
  await h.gh.setFile(FILES.notebook, pretty(remote));
  const mine = structuredClone(seed);
  mine.next.notes = 'From the desktop';
  await h.sync.save(mine, { immediate: true });
  assert.equal(h.sync.status, 'conflict');
  assert.equal(h.sync.conflict.state.next.notes, 'From the phone');
  assert.equal(h.local.read(KEYS.draft).state.next.notes, 'From the desktop');
  assert.equal(JSON.parse(h.gh.files()[FILES.notebook]).next.notes, 'From the phone');
  h.sync.useRemote();
  assert.equal(h.sync.status, 'saved');
  assert.equal(h.sync.notebook.state.next.notes, 'From the phone');
  assert.equal(h.local.read(KEYS.draft), null);
});

test('a draft left behind is pushed on the next load when the notebook has not moved', async () => {
  const first = await harness();
  await first.sync.load();
  const mine = structuredClone(seed);
  mine.next.notes = 'Offline edit';
  const storageSeed = {
    [KEYS.draft]: JSON.stringify({ state: mine, sha: first.sync.notebook.sha }),
  };
  const gh = first.gh;
  const store = createGitHubStore({
    token: 'good-token',
    owner: 'dan',
    repo: 'fala',
    fetch: gh.fetch,
  });
  const sync = createSync({
    store,
    local: createLocal(fakeStorage(storageSeed)),
    timers: fakeTimers(),
  });
  await sync.load();
  assert.equal(sync.status, 'saved');
  assert.equal(JSON.parse(gh.files()[FILES.notebook]).next.notes, 'Offline edit');
});

test('when GitHub is unreachable the cached notebook is shown offline', async () => {
  const h = await harness();
  await h.sync.load();
  const cached = h.local.read(KEYS.notebook);
  const failing = createGitHubStore({
    token: 'good-token',
    owner: 'dan',
    repo: 'fala',
    fetch: async () => {
      throw new TypeError('network down');
    },
  });
  const sync = createSync({
    store: failing,
    local: createLocal(fakeStorage({ [KEYS.notebook]: JSON.stringify(cached) })),
    timers: fakeTimers(),
  });
  await sync.load();
  assert.equal(sync.status, 'offline');
  assert.equal(sync.notebook.state.phrases.length, seed.phrases.length);
  assert.match(sync.problem, /Could not reach GitHub/);
});

test('settings are validated and committed', async () => {
  const h = await harness();
  await h.sync.load();
  const next = await h.sync.saveSettings({ budgetAud: 40, usdToAud: 1.5 });
  assert.equal(next.budgetAud, 40);
  assert.equal(JSON.parse(h.gh.files()[FILES.settings]).usdToAud, 1.5);
  await assert.rejects(h.sync.saveSettings({ budgetAud: 1 }), /A\$5/);
});

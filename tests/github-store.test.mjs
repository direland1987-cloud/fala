import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGitHubStore,
  ConflictError,
  StoreError,
  blobSha,
  decodeBase64Utf8,
} from '../public/lib/github.js';
import { createFakeGitHub } from './helpers/fake-github.mjs';

const setup = async (files) => {
  const gh = await createFakeGitHub({ files });
  const store = createGitHubStore({
    token: 'good-token',
    owner: 'dan',
    repo: 'fala',
    fetch: gh.fetch,
  });
  return { gh, store };
};

test('reads files and JSON with their blob sha, and null when absent', async () => {
  const { store } = await setup({ 'data/notebook.json': '{"schema":1,"pt":"Olá, não"}\n' });
  const file = await store.readFile('data/notebook.json');
  assert.equal(file.sha, await blobSha('{"schema":1,"pt":"Olá, não"}\n'));
  const { data } = await store.readJson('data/notebook.json');
  assert.equal(data.pt, 'Olá, não');
  assert.deepEqual(await store.readJson('data/missing.json'), { data: null, sha: null });
  assert.equal(decodeBase64Utf8('w6E=\n'), 'á');
});

test('commits several files atomically and returns their new blob shas', async () => {
  const { gh, store } = await setup({ 'data/notebook.json': 'old' });
  const before = await store.readFile('data/notebook.json');
  const result = await store.commit({
    message: 'Voice lesson',
    files: { 'data/notebook.json': 'new', 'data/lessons/one.json': '{}' },
    base: { 'data/notebook.json': before.sha, 'data/lessons/one.json': null },
  });
  assert.equal(gh.files()['data/notebook.json'], 'new');
  assert.equal(gh.files()['data/lessons/one.json'], '{}');
  assert.equal(result.shas['data/notebook.json'], await blobSha('new'));
  assert.equal(gh.messages().at(-1), 'Voice lesson');
  assert.equal(result.sha, gh.head);
});

test('refuses to overwrite a file another device changed since it was loaded', async () => {
  const { gh, store } = await setup({ 'data/notebook.json': 'v1' });
  const loaded = await store.readFile('data/notebook.json');
  await gh.setFile('data/notebook.json', 'v2-from-phone');
  await assert.rejects(
    store.commit({
      message: 'x',
      files: { 'data/notebook.json': 'mine' },
      base: { 'data/notebook.json': loaded.sha },
    }),
    (e) => e instanceof ConflictError && e.path === 'data/notebook.json',
  );
  assert.equal(gh.files()['data/notebook.json'], 'v2-from-phone');
});

test('a commit to an unrelated file that moves the branch is retried on the new head', async () => {
  const { gh, store } = await setup({ 'data/notebook.json': 'v1', 'data/usage.json': '[]' });
  const loaded = await store.readFile('data/notebook.json');
  let patched = false;
  const racing = async (url, init) => {
    if (!patched && init?.method === 'PATCH') {
      patched = true;
      await gh.setFile('data/usage.json', '[1]'); // lands between our tree build and the ref update
    }
    return gh.fetch(url, init);
  };
  const store2 = createGitHubStore({
    token: 'good-token',
    owner: 'dan',
    repo: 'fala',
    fetch: racing,
  });
  await store2.commit({
    message: 'retry',
    files: { 'data/notebook.json': 'v2' },
    base: { 'data/notebook.json': loaded.sha },
  });
  assert.equal(gh.files()['data/notebook.json'], 'v2');
  assert.equal(gh.files()['data/usage.json'], '[1]');
  void store;
});

test('verify reports push access and surfaces auth failures clearly', async () => {
  const { store } = await setup({});
  assert.deepEqual(await store.verify(), { fullName: 'dan/fala', isPrivate: true, canPush: true });
  const gh = await createFakeGitHub({});
  const bad = createGitHubStore({ token: 'wrong', owner: 'dan', repo: 'fala', fetch: gh.fetch });
  await assert.rejects(
    bad.verify(),
    (e) => e instanceof StoreError && e.status === 401 && /token/i.test(e.message),
  );
});

test('listDir lists a folder and deletes are applied', async () => {
  const { gh, store } = await setup({ 'data/lessons/a.json': '{}', 'data/lessons/b.json': '{}' });
  assert.deepEqual(
    (await store.listDir('data/lessons')).map((x) => x.name),
    ['a.json', 'b.json'],
  );
  await store.commit({ message: 'rm', files: { 'data/lessons/a.json': null } });
  assert.deepEqual(Object.keys(gh.files()), ['data/lessons/b.json']);
});

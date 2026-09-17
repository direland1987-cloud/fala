import test from 'node:test';
import assert from 'node:assert/strict';
import { createVault, memoryKeyStore } from '../public/lib/vault.js';
import { fakeStorage } from './helpers/fakes.mjs';

test('secrets round-trip through the vault and are not stored in clear text', async () => {
  const storage = fakeStorage();
  const keys = memoryKeyStore();
  const vault = createVault({ storage, keyStore: keys });
  assert.equal(await vault.load(), null);
  await vault.save({
    openaiKey: 'sk-test-secret',
    githubToken: 'github_pat_secret',
    owner: 'dan',
    repo: 'fala',
  });
  const raw = storage.getItem('fala-vault-v1');
  assert.ok(raw && !raw.includes('sk-test-secret') && !raw.includes('github_pat_secret'));
  assert.deepEqual(await vault.load(), {
    openaiKey: 'sk-test-secret',
    githubToken: 'github_pat_secret',
    owner: 'dan',
    repo: 'fala',
  });
});

test('ciphertext without its device key cannot be read, and clear removes both halves', async () => {
  const storage = fakeStorage();
  const vault = createVault({ storage, keyStore: memoryKeyStore() });
  await vault.save({ openaiKey: 'a' });
  const other = createVault({ storage, keyStore: memoryKeyStore() });
  assert.equal(await other.load(), null);
  await vault.clear();
  assert.equal(storage.getItem('fala-vault-v1'), null);
  assert.equal(await vault.load(), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { looksWrong, explainOpenAI } from '../public/lib/keys.js';

const REAL = 'sk-proj-' + 'a1B2c3D4'.repeat(12);

test('obvious mistakes with the OpenAI key are named before anything is sent', () => {
  assert.equal(looksWrong('openai', REAL), '');
  assert.equal(looksWrong('openai', ''), '');
  assert.match(looksWrong('openai', 'sk-...AbCd'), /shortened key from OpenAI’s key list/);
  assert.match(looksWrong('openai', 'sk-proj-****************wxyz'), /shortened key/);
  assert.match(looksWrong('openai', 'github_pat_11ABCDEFG0abcdefgh'), /GitHub token/);
  assert.match(looksWrong('openai', 'Fala key'), /space or line break/);
  assert.match(looksWrong('openai', 'FalaKey'), /starts with “sk-”/);
  assert.match(looksWrong('openai', 'sk-short'), /too short/);
});

test('obvious mistakes with the GitHub token are named too', () => {
  assert.equal(looksWrong('github', 'github_pat_11ABCDEFG0abcdefghijklmnop'), '');
  assert.match(looksWrong('github', REAL), /OpenAI key/);
  assert.match(looksWrong('github', 'github_pat_11AB…wxyz'), /shortened token/);
  assert.match(looksWrong('github', 'github_pat_11AB cdef'), /space or line break/);
});

test('OpenAI’s reply to the key check is turned into what to do', () => {
  const ok = explainOpenAI(200, { data: [{ id: 'gpt-realtime-2.1' }, { id: 'gpt-5.6-luna' }] });
  assert.deepEqual(ok, { ok: true, models: ['gpt-realtime-2.1', 'gpt-5.6-luna'] });

  const wrong = explainOpenAI(401, {
    error: {
      code: 'invalid_api_key',
      message:
        'Incorrect API key provided: sk-proj-********************************wxyz. You can find your API key at https://platform.openai.com/account/api-keys.',
    },
  });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /^OpenAI rejected that API key\. OpenAI does not recognise it/);
  assert.match(wrong.error, /OpenAI said: “Incorrect API key provided: sk-…\./);
  assert.ok(!wrong.error.includes('wxyz'), 'no part of the key is echoed');

  // A restricted key that cannot list models is still a working key.
  const scoped = explainOpenAI(401, {
    error: {
      message:
        'You have insufficient permissions for this operation. Missing scopes: api.model.read.',
    },
  });
  assert.equal(scoped.ok, true);
  assert.equal(scoped.models, null);
  assert.match(scoped.note, /not allowed to list models/);

  const archived = explainOpenAI(401, { error: { message: 'The project has been archived.' } });
  assert.match(archived.error, /archived or gone/);

  const quota = explainOpenAI(429, { error: { message: 'You exceeded your current quota.' } });
  assert.equal(quota.ok, true);
  assert.match(quota.note, /Add credit under Billing/);

  const other = explainOpenAI(503, {});
  assert.equal(other.ok, true);
  assert.match(other.note, /answered 503/);
});

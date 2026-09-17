// Rebuilds the two pre-update notebook snapshots that the lesson-update tests
// originally read from git history (commits 2fb8453 and bd7af9d of the old
// ChatGPT Sites repository). That history was not included in the handoff
// archive, so the snapshots are reconstructed here by reversing each
// published update against the bundled seed. The reversal is the exact
// inverse of applyOneUpdate in migrations.js.
//
// Run:  node tests/fixtures/reconstruct.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from '../../baseline/seed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '../../baseline/migrations.js'), 'utf8');
const updates = new Function(
  source.replace(/^export function[\s\S]*$/m, '') + '\nreturn updates;',
)();

function reverse(notebook, update) {
  const result = structuredClone(notebook);
  result.lessons = result.lessons.filter((l) => l.id !== update.lesson.id);
  for (const [key, entries] of Object.entries(update.collections)) {
    for (const { before, after } of entries) {
      const index = result[key].findIndex((x) => x.id === after.id);
      if (index < 0) continue;
      if (!before) {
        result[key].splice(index, 1);
        continue;
      }
      const item = { ...result[key][index] };
      for (const k of Object.keys(after)) {
        if (k in before) item[k] = structuredClone(before[k]);
        else delete item[k];
      }
      result[key][index] = item;
    }
  }
  result.next = structuredClone(update.next.before);
  result.sources = structuredClone(update.sources.before);
  result.appliedUpdates = (result.appliedUpdates || []).filter((id) => id !== update.id);
  if (!result.appliedUpdates.length) delete result.appliedUpdates;
  return result;
}

const beforeSep11 = reverse(seed, updates[1]);
const beforeSep9 = reverse(beforeSep11, updates[0]);
const write = (name, data) =>
  fs.writeFileSync(path.join(here, name), JSON.stringify(data, null, 2) + '\n');
write('notebook-before-sep11.json', beforeSep11);
write('notebook-before-sep9.json', beforeSep9);
console.log('lessons before sep 9:', beforeSep9.lessons.map((l) => l.id).join(', '));
console.log('lessons before sep 11:', beforeSep11.lessons.map((l) => l.id).join(', '));

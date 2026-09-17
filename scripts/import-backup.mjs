// Imports a notebook backup downloaded from the previous Fala site
// ("Download backup" in its Backup & data panel) into data/notebook.json.
//
//   node scripts/import-backup.mjs ~/Downloads/Fala-Notebook-2026-09-17.json
//
// The backup is validated, any published lesson updates it predates are
// merged without touching personal edits, and a before/after comparison is
// printed. Commit and push data/notebook.json afterwards.
import fs from 'node:fs';
import { validNotebook } from '../public/lib/domain.js';
import { applyPublishedUpdates } from '../baseline/migrations.js';

const [, , file, flag] = process.argv;
if (!file) {
  console.error('Usage: node scripts/import-backup.mjs <backup.json> [--write]');
  process.exit(2);
}
const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!validNotebook(backup)) {
  console.error('That file is not a valid Fala notebook backup (schema 1).');
  process.exit(1);
}
const current = fs.existsSync('data/notebook.json')
  ? JSON.parse(fs.readFileSync('data/notebook.json', 'utf8'))
  : null;
const merged = applyPublishedUpdates(structuredClone(backup));
merged.sources = {
  ...merged.sources,
  migrated: new Date().toISOString().slice(0, 10),
  note: `${merged.sources.note} Imported into the GitHub-hosted Fala on ${new Date().toISOString().slice(0, 10)} from the previous site's backup${backup.updatedAt ? ` (last edited ${backup.updatedAt})` : ''}.`,
};
const count = (nb, key) => (nb ? nb[key].length : 0);
const ids = (nb, key) => new Set(nb ? nb[key].map((x) => x.id) : []);
console.log('                     current   backup   result');
for (const key of ['lessons', 'phrases', 'issues', 'curriculum', 'patterns', 'reviews'])
  console.log(
    `${key.padEnd(20)} ${String(count(current, key)).padStart(7)} ${String(count(backup, key)).padStart(8)} ${String(count(merged, key)).padStart(8)}`,
  );
for (const key of ['lessons', 'phrases', 'issues']) {
  const lost = [...ids(current, key)].filter((id) => !ids(merged, key).has(id));
  if (lost.length)
    console.log(`WARNING: ${key} present now but absent from the backup: ${lost.join(', ')}`);
}
console.log('backup last edited:', backup.updatedAt || 'unknown');
console.log('backup next plan:  ', merged.next.title);
console.log('current next plan: ', current?.next.title || '(none)');
const dates = (nb) =>
  nb
    ? nb.lessons
        .map((l) => l.date)
        .sort()
        .at(-1)
    : '-';
console.log('latest lesson date: current', dates(current), '· backup', dates(merged));
if (flag === '--write') {
  fs.writeFileSync('data/notebook.json', JSON.stringify(merged, null, 2) + '\n');
  console.log(
    '\nWrote data/notebook.json. Review `git diff data/notebook.json`, then commit and push.',
  );
} else console.log('\nDry run. Add --write to replace data/notebook.json.');

// One-off: writes data/*.json from the bundled baseline (seed + published
// updates). Only used to create the initial repository data; a newer backup
// from the previous site should be imported with scripts/import-backup.mjs.
import fs from 'node:fs';
import { seed } from '../baseline/seed.js';
import { applyPublishedUpdates } from '../baseline/migrations.js';
import { DEFAULT_SETTINGS } from '../public/lib/domain.js';

const notebook = applyPublishedUpdates(structuredClone(seed));
notebook.updatedAt = '2026-09-17T00:00:00.000Z';
notebook.sources = {
  ...notebook.sources,
  migrated: '2026-09-17',
  note:
    notebook.sources.note +
    ' Carried into the GitHub-hosted Fala on 17 September 2026 from the bundled baseline (seed plus the published 9 and 11 September updates), not from a live export of the previous site; restore a newer backup from the old site if you have one.',
};
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
fs.mkdirSync('data/lessons', { recursive: true });
write('data/notebook.json', notebook);
write('data/settings.json', DEFAULT_SETTINGS);
write('data/usage.json', []);
write('data/practice.json', []);
write('data/lessons.json', []);
fs.writeFileSync('data/lessons/.gitkeep', '');
console.log(
  `notebook: ${notebook.lessons.length} lessons, ${notebook.phrases.length} phrases, ${notebook.issues.length} sticky points, ${notebook.patterns.length} patterns`,
);

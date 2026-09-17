// Renders JOURNAL.md from the notebook so the journal is readable on GitHub
// itself. Run by the journal workflow after every data commit.
import fs from 'node:fs';

const nb = JSON.parse(fs.readFileSync('data/notebook.json', 'utf8'));
const index = fs.existsSync('data/lessons.json')
  ? JSON.parse(fs.readFileSync('data/lessons.json', 'utf8'))
  : [];
const pretty = (s) => {
  const d = new Date(s + 'T12:00:00');
  return isNaN(d)
    ? s
    : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
};
const line = (k, v) => `**${k}:** ${v || 'Not recorded.'}`;
const lessons = [...nb.lessons].sort((a, b) => b.date.localeCompare(a.date));
const n = nb.next;
const out = `# Dan’s Brazilian Portuguese notebook

Rendered automatically from \`data/notebook.json\`. Edit in the Fala app, not here.

## Next lesson · ${n.title}

${line('Goal', n.goal)}

${line('Pattern', n.pattern)}

${line('Retrieve first', n.recap)}

${line('Warm-up', n.warmup)}

${line('Only if ready', n.newMaterial)}

${line('Role-play', n.roleplay)}

${line('Adapt', n.adapt)}

${line('Close', n.close)}
${n.notes ? `\n${line('Notes', n.notes)}\n` : ''}
## Living curriculum

${nb.curriculum.map((p) => `### ${p.title} · ${p.status}\n\n${p.range} · ${p.goal}\n\n${p.topics.map((t) => '- ' + t).join('\n')}${p.notes ? `\n\n${p.notes}` : ''}`).join('\n\n')}

## Lesson journal

${lessons
  .map(
    (l) =>
      `### ${pretty(l.date)} — ${l.title} [${l.source}]\n\n${l.duration ? `_${l.duration}_\n\n` : ''}${[
        ['Focus', l.focus],
        ['Practised', l.practised],
        ['Mastered independently', l.mastered],
        ['Recurring mistakes', l.mistakes],
        ['Pronunciation', l.pronunciation],
        ['Role-play', l.roleplay],
        ['Next priority', l.next],
        ['Notes', l.notes],
      ]
        .map(([k, v]) => line(k, v))
        .join('\n\n')}`,
  )
  .join('\n\n')}

## Phrases

| Portuguese | English | Level | Last tested | Note |
|---|---|---|---|---|
${nb.phrases.map((p) => `| ${p.pt} | ${p.en} | ${p.level} | ${p.lastTested || ''} | ${(p.note || '').replace(/\|/g, '/')} |`).join('\n')}

## Sticky points

${nb.issues.map((i) => `- **${i.title}** [${i.status}; ${i.evidence}]: ${i.description}\n  Practice: ${i.cue}`).join('\n')}

## Voice lessons recorded by Fala

${index.length ? index.map((l) => `- ${l.date} · ${l.title} · ${l.checkpoints} checkpoints · US$${(l.usd || 0).toFixed(2)} · ${l.status}`).join('\n') : 'None yet.'}

## Sources

${nb.sources.note}
`;
fs.writeFileSync('JOURNAL.md', out);
console.log(`JOURNAL.md: ${lessons.length} lessons, ${nb.phrases.length} phrases`);

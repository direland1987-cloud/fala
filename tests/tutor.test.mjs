import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from '../baseline/seed.js';
import {
  baseInstructions,
  stepText,
  sessionConfig,
  feedbackLines,
  VOICE_TOOLS,
  FEEDBACK_TAGS,
} from '../public/lib/tutor.js';
import { createFlow } from '../public/lib/flow.js';
import { planPreview, progressPage, challengeCards } from '../public/progress.js';
import { history } from './helpers/fakes.mjs';

const NOW = Date.parse('2026-11-10T22:00:00Z');
const taught = seed.phrases.filter((p) => p.level !== 'Planned');

test('the standing instructions are short, list only taught phrases and forbid narration', () => {
  const text = baseInstructions({ phrases: taught });
  assert.ok(text.length < 2600, `instructions are ${text.length} characters`);
  assert.match(text, /estou-bem: Estou bem = I’m well/);
  assert.ok(!/Tudo bem|Estou animado/.test(text), 'nothing untaught is listed');
  assert.match(text, /Never mention notes, records, saving/);
  assert.match(text, /say the correct Portuguese once at natural speed, then ask the next cue/);
  assert.match(text, /Never accept an answer you are unsure about/);
  assert.ok(!/ABOUT DAN/.test(text));
});

test('each step block tells the tutor exactly what to do and how to begin', () => {
  const flow = createFlow({ notebook: seed, mode: 'lesson', minutes: 10, now: () => NOW });
  const review = flow.start();
  assert.match(review.block, /^CURRENT STEP: RECALL/);
  assert.match(review.block, /Never say the Portuguese before he tries/);
  assert.equal((review.block.match(/^\d\. /gm) || []).length, 4);
  assert.match(review.opener, /ask exactly: How do you say "/);
  const item = { id: 'tudo-bem', kind: 'new', pt: 'Tudo bem?', en: 'All good?', hint: '' };
  const fresh = stepText({
    name: 'new',
    item,
    distractor: { kind: 'say', en: 'Hi', pt: 'Oi', id: 'oi' },
  });
  assert.match(fresh.block, /Teach exactly this and nothing else: Tudo bem\? = All good\?/);
  assert.match(fresh.block, /Ask one phrase he already knows: How do you say "Hi"\?/);
  const scene = stepText({
    name: 'scene',
    challenge: true,
    scene: {
      name: 'Bia',
      targets: [
        { id: 'oi', pt: 'Oi' },
        { id: 'tchau', pt: 'Tchau' },
      ],
    },
  });
  assert.match(scene.block, /CONVERSATION CHALLENGE/);
  assert.match(scene.block, /using only DAN'S PHRASES/);
  assert.match(scene.opener, /I'm Bia/);
  const wrap = stepText({ name: 'wrap', line: '3 of 4 without help.' });
  assert.match(
    wrap.opener,
    /Tell Dan: "3 of 4 without help\." Then ask: "Keep going, or finish here\?"/,
  );
});

test('the tools are compact and the session config follows the settings', () => {
  assert.deepEqual(
    VOICE_TOOLS.map((t) => t.name),
    ['record_practice', 'next_step', 'set_lesson_time', 'finish_lesson'],
  );
  const record = VOICE_TOOLS[0].parameters;
  assert.deepEqual(record.required, ['id', 'result', 'context', 'pronunciation']);
  assert.ok(!('heard' in record.properties) && !('pt' in record.properties));
  assert.deepEqual(record.properties.context.enum, ['isolated', 'conversation', 'meaning']);
  const quick = sessionConfig({ model: 'gpt-realtime-2.1', instructions: 'x' });
  assert.equal(quick.audio.input.turn_detection.eagerness, 'high');
  assert.equal(quick.audio.input.turn_detection.create_response, false);
  assert.equal(quick.audio.input.noise_reduction.type, 'near_field');
  assert.equal(quick.max_output_tokens, 600);
  const slow = sessionConfig({ model: 'm', instructions: 'x', pace: 'patient', mic: 'far' });
  assert.equal(slow.audio.input.turn_detection.eagerness, 'low');
  assert.equal(slow.audio.input.noise_reduction.type, 'far_field');
});

test('feedback becomes standing instructions, newest three sessions only', () => {
  const lessons = [
    { started: 1, feedback: { tags: ['too_fast'], note: '' } },
    { started: 2, feedback: { tags: ['too_slow'], note: 'old note' } },
    { started: 3, feedback: { rating: 'good', tags: [], note: '' } },
    { started: 4, feedback: { tags: ['misheard'], note: 'It took “el so” as right.' } },
    { started: 5, feedback: { tags: ['misheard', 'cut_off'], note: '' } },
    { started: 6 },
  ];
  const lines = feedbackLines(lessons);
  assert.equal(lines.length, 4);
  assert.ok(lines.some((l) => /wrong answers were accepted/.test(l)));
  assert.ok(lines.some((l) => /cut in before he finished/.test(l)));
  assert.ok(lines.some((l) => /too slow/.test(l)));
  assert.ok(!lines.some((l) => /too fast/.test(l)), 'older than the last three');
  assert.ok(lines.at(-1).includes('It took “el so” as right.'));
  assert.deepEqual(feedbackLines([]), []);
  assert.ok(Object.keys(FEEDBACK_TAGS).every((tag) => typeof FEEDBACK_TAGS[tag] === 'string'));
  const text = baseInstructions({
    phrases: taught,
    feedback: lines,
    tutorNotes: 'Café phrases matter.',
  });
  assert.match(text, /ABOUT DAN\n- /);
  assert.match(text, /Dan asked you to keep in mind: "Café phrases matter\."/);
});

test('the progress, plan and challenge screens render from the record', () => {
  const practice = [
    ...history('estou-bem', 'Estou bem', [
      ['2026-11-05', 'independent'],
      ['2026-11-08', 'independent'],
    ]),
    ...history('e-voce', 'E você?', [
      ['2026-11-05', 'not_recalled'],
      ['2026-11-08', 'prompted'],
    ]),
  ];
  const lessons = [
    {
      id: 's-2026-11-08',
      date: '2026-11-08',
      started: Date.parse('2026-11-08T00:00:00Z'),
      ended: Date.parse('2026-11-08T00:09:00Z'),
      mode: 'quiz',
      checkpoints: 2,
      usd: 0.2,
      score: { asked: 2, unaided: 1, pct: 50, conversation: 0 },
      feedback: { tags: ['too_chatty'], note: 'Less talk <b>please</b>' },
      file: 'data/lessons/x.json',
    },
  ];
  const html = progressPage({
    notebook: seed,
    practice,
    lessons,
    fx: 1.4,
    now: NOW,
    open: 's-2026-11-08',
  });
  assert.match(html, /What’s working, what isn’t/);
  assert.match(html, /2 of 4 recall tests without help/);
  assert.match(html, /Working <span class="count">1<\/span>/);
  assert.match(html, /Not sticking <span class="count">1<\/span>/);
  assert.match(html, /Quick quiz/);
  assert.match(html, /1 of 2 without help/);
  assert.match(html, /9 min · A\$0\.28/);
  assert.match(html, /Too chatty/);
  assert.ok(html.includes('Less talk &lt;b&gt;please&lt;/b&gt;'), 'notes are escaped');
  assert.match(html, /data-voice="write-up"/);
  assert.match(
    planPreview(seed, practice, { mode: 'lesson', minutes: 15, now: NOW }),
    /1\. Recall/,
  );
  assert.match(
    planPreview(seed, practice, { mode: 'quiz', minutes: 5, now: NOW }),
    /8 quick questions/,
  );
  assert.match(
    planPreview(seed, practice, { mode: 'challenge', minutes: 10, now: NOW }),
    /role-play/,
  );
  assert.equal(
    (challengeCards(seed, practice, lessons, NOW, 3).match(/class="challenge/g) || []).length,
    4,
  );
});

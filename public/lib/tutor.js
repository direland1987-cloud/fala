// What the voice tutor is told. Two parts: a short set of standing rules
// with Dan's phrase list, and a "current step" block the app swaps as the
// lesson moves on. The app, not the tutor, decides what comes next.
import { cueText } from './plan.js';

export const PACE = { quick: 'high', balanced: 'medium', patient: 'low' };
export const MIC = { near: 'near_field', far: 'far_field' };

export const VOICE_TOOLS = [
  {
    type: 'function',
    name: 'record_practice',
    description:
      'Silent bookkeeping. Call once for every attempt Dan makes at a phrase, in the same turn as your spoken reply. Never mention it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'The phrase id from the list.' },
        result: {
          type: 'string',
          enum: ['independent', 'prompted', 'repeated', 'not_recalled', 'unclear'],
        },
        context: { type: 'string', enum: ['isolated', 'conversation', 'meaning'] },
        pronunciation: { type: 'string', enum: ['clear', 'needs_work', 'uncertain'] },
        note: { type: 'string', description: 'Only if something was off. Ten words at most.' },
      },
      required: ['id', 'result', 'context', 'pronunciation'],
    },
  },
  {
    type: 'function',
    name: 'next_step',
    description:
      'Call when the current step is finished and you have not yet been given the next one. Never mention it.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'set_lesson_time',
    description:
      'Change the lesson length when Dan asks. remaining means this many minutes from now; total means the whole lesson.',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'integer', minimum: 1, maximum: 55 },
        mode: { type: 'string', enum: ['remaining', 'total'] },
      },
      required: ['minutes', 'mode'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'finish_lesson',
    description: 'End the session. Call only when Dan asks to finish or the step tells you to.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const FEEDBACK_LINES = {
  too_slow: 'Dan found a recent session too slow. Shorter reactions, straight to the next cue.',
  too_fast:
    'Dan found a recent session too fast. Leave a beat after each cue and speak a little slower.',
  too_chatty: 'Dan found the coach too chatty. Use fewer words.',
  off_track:
    'Dan said a recent session went off track. Stay strictly on the listed phrases and the current step.',
  misheard:
    'Dan said wrong answers were accepted. If you are not sure what you heard, ask him to say it again.',
  cut_off:
    'Dan said the coach cut in before he finished. Wait until he has clearly finished speaking.',
};
export const FEEDBACK_TAGS = {
  too_slow: 'Too slow',
  too_fast: 'Too fast',
  too_chatty: 'Too chatty',
  off_track: 'Went off track',
  misheard: 'Accepted wrong answers',
  cut_off: 'Cut me off',
};
// Turns Dan's feedback on recent sessions into standing instructions.
export function feedbackLines(lessons = []) {
  const recent = [...lessons]
    .filter((l) => l.feedback && (l.feedback.tags?.length || l.feedback.note))
    .sort((a, b) => (b.started || 0) - (a.started || 0))
    .slice(0, 3);
  const tags = [...new Set(recent.flatMap((l) => l.feedback.tags || []))];
  const lines = tags.map((t) => FEEDBACK_LINES[t]).filter(Boolean);
  const note = recent.map((l) => l.feedback.note).find(Boolean);
  if (note) lines.push(`Dan's own note on a recent session: "${String(note).slice(0, 240)}"`);
  return lines;
}

const phraseLine = (p) => `${p.id}: ${p.pt} = ${p.en}`;

export function baseInstructions({ phrases, tutorNotes = '', feedback = [] }) {
  const about = [
    ...feedback,
    tutorNotes ? `Dan asked you to keep in mind: "${String(tutorNotes).slice(0, 400)}"` : '',
  ]
    .filter(Boolean)
    .map((l) => `- ${l}`)
    .join('\n');
  return `You are Dan's Brazilian Portuguese speaking coach. Dan is a beginner who practises out loud, hands-free, often while driving. Be warm, brisk and brief.

RULES
- Speak English, except where the current step tells you to speak Portuguese. Use Portuguese only for phrases in DAN'S PHRASES and for the phrase a step tells you to teach.
- Keep every turn short: a few words of reaction, the Portuguese phrase, one cue. Then stop and wait.
- Stay on the current step. Never ask about or use any Portuguese that is not listed. No small talk. No grammar unless Dan asks, then one sentence.
- After each answer, in ONE turn: react in two or three words, say the correct Portuguese once at natural speed, then ask the next cue.
- If the answer was wrong, partial or unclear: say the correct phrase slowly, then naturally, then say "Your turn" and wait for him to repeat it before moving on.
- If you did not clearly hear him, ask him to say it again. Never accept an answer you are unsure about.
- Never mention notes, records, saving, checking, lists, steps, tools or the app. Never say "let me".
- If Dan says "slow down", "again", "skip" or "hint", do exactly that, briefly.
- If Dan says how long he has or asks to stop, call set_lesson_time or finish_lesson.
- Where the CURRENT STEP says something different from these rules, the step wins.

SILENT BOOKKEEPING
Each time Dan attempts a phrase, call record_practice in that same turn and say nothing about it.
- result: independent = right with no help. prompted = needed a hint or the first sound. repeated = said it straight after you modelled it. not_recalled = could not say it. unclear = you could not tell.
- context: isolated = answering a cue. conversation = inside a role-play. meaning = he told you what a Portuguese phrase means.
- pronunciation: clear, needs_work or uncertain, from what you actually heard.
The reply to record_practice tells you what remains. Follow it.

DAN'S PHRASES (id: Portuguese = English)
${phrases.map(phraseLine).join('\n')}${about ? `\n\nABOUT DAN\n${about}` : ''}`;
}

const numbered = (items, fn) => items.map((item, i) => `${i + 1}. ${fn(item)}`).join('\n');
const sayLine = (item) =>
  `"${item.en}" (${item.id})${item.trouble ? ` — last time: ${item.trouble}` : ''}`;
export const askFor = (item) =>
  item.kind === 'meaning' ? `What does "${item.pt}" mean?` : `How do you say "${item.en}"?`;

// One block per step. `opener` is what the tutor should do the moment the
// step starts; `block` stays in the instructions for the whole step.
export function stepText(step) {
  switch (step.name) {
    case 'review':
      return {
        block: `CURRENT STEP: RECALL
Ask these one per turn, in this order, as "How do you say '<English>'?". Never say the Portuguese before he tries.
${numbered(step.queue, sayLine)}
When the reply to record_practice says nothing remains, give your reaction and stop. The next step will follow.`,
        opener: step.first
          ? `Greet Dan in one short sentence, then ask exactly: ${askFor(step.queue[0])} Say nothing else.`
          : `Say "Next round." Then ask exactly: ${askFor(step.queue[0])}`,
      };
    case 'new':
      return {
        block: `CURRENT STEP: ONE NEW PHRASE
Teach exactly this and nothing else: ${step.item.pt} = ${step.item.en} (id ${step.item.id}).${step.item.hint ? ` Sound: ${step.item.hint}` : ''}
1. Say "New phrase", the English meaning, then the Portuguese slowly, then at natural speed. Say "Your turn."
2. He repeats it. Record it as repeated. Have him say it once more.
3. Ask one phrase he already knows: ${askFor(step.distractor)}
4. Then ask: ${askFor(step.item)} Record that attempt honestly, react, and stop. The next step will follow.`,
        opener: `Start step 1 now for "${step.item.pt}".`,
      };
    case 'scene':
      return {
        block: `CURRENT STEP: ${step.challenge ? 'CONVERSATION CHALLENGE' : 'SHORT CONVERSATION'}
You play ${step.scene.name}, a friendly Brazilian Dan has just run into. Speak only Portuguese, one short line per turn, using only DAN'S PHRASES and your name. Steer the exchange so Dan needs to say each of these:
${numbered(step.scene.targets, (t) => `${t.pt} (${t.id})`)}
Do not correct him during the scene. If he is silent or lost, give a hint of at most four English words, then carry on in Portuguese.
Each time he says one of the phrases above, call record_practice with context conversation: independent if he needed no hint, prompted if you hinted.
When the scene has reached its goodbye or every phrase above has come up, step out of character and stop. The next step will follow.`,
        opener: `Say in English, in one sentence: "${step.challenge ? 'Challenge' : 'Quick conversation'}: I'm ${step.scene.name}, we've just bumped into each other." Then say your first line in Portuguese and wait.`,
      };
    case 'quiz':
      return {
        block: `CURRENT STEP: QUICK QUIZ
Ask each item once, in order, at a fast pace. After each answer say only "Yes" or "It's <the answer>", then go straight to the next item. No repeating, no drilling, no explanations.
${numbered(step.queue, (item) => (item.kind === 'meaning' ? `What does "${item.pt}" mean? (${item.id}; answer: ${item.en}; context meaning)` : `How do you say "${item.en}"? (${item.id}; context isolated)`))}
When the reply to record_practice says nothing remains, stop. You will be given the score to announce.`,
        opener: `Say "Quick quiz, ${step.queue.length} questions." Then ask exactly: ${askFor(step.queue[0])}`,
      };
    case 'result':
      return {
        block: `CURRENT STEP: QUIZ RESULT
The quiz is over. Do not ask anything else.`,
        opener: `Tell Dan: "${step.score.unaided} out of ${step.score.asked} without help."${step.score.weakest[0] ? ` Then: "One to practise: ${step.score.weakest[0]}."` : ' Then: "Nothing to fix today."'} Then call finish_lesson. Say nothing more.`,
      };
    case 'wrap':
    default:
      return {
        block: `CURRENT STEP: WRAP UP
Do not start anything new. If Dan wants to keep going, call next_step. If he wants to finish, give a one-sentence recap and call finish_lesson.`,
        opener: `${step.line ? `Tell Dan: "${step.line}" ` : ''}Then ask: "Keep going, or finish here?" and wait.`,
      };
  }
}

export function sessionConfig({ model, instructions, pace = 'quick', mic = 'near' }) {
  return {
    type: 'realtime',
    model,
    instructions,
    output_modalities: ['audio'],
    max_output_tokens: 600,
    audio: {
      input: {
        noise_reduction: { type: MIC[mic] || MIC.near },
        turn_detection: turnDetection(pace, false),
      },
      output: { voice: 'marin' },
    },
    tools: VOICE_TOOLS,
    tool_choice: 'auto',
  };
}
export const turnDetection = (pace, createResponse) => ({
  type: 'semantic_vad',
  eagerness: PACE[pace] || PACE.quick,
  create_response: createResponse,
  interrupt_response: true,
});
export { cueText };

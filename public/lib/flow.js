// The lesson as a sequence of steps that the app controls. The tutor works
// inside one step at a time; when a step's items are done the app moves on
// and tells the tutor what the next step is. Three kinds of session:
//   lesson     recall -> one new phrase (only if recall went well) -> short conversation -> repeat or wrap
//   quiz       a fixed list of quick questions -> score -> finish
//   challenge  role-play rounds -> wrap
import {
  buildReviewQueue,
  buildScene,
  buildQuiz,
  pickNew,
  scoreAttempts,
  reviewCount,
  quizCount,
  newAllowance,
  cueText,
  FAILED,
  isTest,
} from './plan.js';
import { baseInstructions, stepText, feedbackLines } from './tutor.js';

export function createFlow({
  notebook,
  practice = [],
  lessons = [],
  mode = 'lesson',
  minutes = 15,
  now = () => Date.now(),
  seed = 1,
}) {
  const taughtIds = new Set(notebook.phrases.filter((p) => p.level !== 'Planned').map((p) => p.id));
  const introduced = []; // ids taught during this session
  const session = []; // every attempt recorded this session
  const feedback = feedbackLines(lessons);
  let step = null;
  let stepStarted = now();
  let cycle = 0;
  let round = 0;
  let allowance = mode === 'lesson' ? newAllowance(minutes) : 0;

  const phraseById = (id) => notebook.phrases.find((p) => p.id === id);
  const allowed = () =>
    notebook.phrases.filter((p) => taughtIds.has(p.id) || introduced.includes(p.id));
  // Practice so far including this session, so later rounds adapt to it.
  const combined = () => [
    ...practice,
    ...session.map((a) => ({ ...a, sessionId: 'current', at: a.at || now() })),
  ];
  const testedWell = () =>
    new Set(session.filter((a) => a.result === 'independent').map((a) => a.phraseId));

  function setStep(next) {
    step = next;
    stepStarted = now();
    return describe();
  }
  function describe() {
    const text = stepText(step);
    return { name: step.name, opener: text.opener, block: text.block };
  }
  function instructions() {
    return `${baseInstructions({ phrases: allowed(), tutorNotes: notebook.tutorNotes, feedback })}\n\n${stepText(step).block}`;
  }

  function reviewStep(first = false) {
    const count = reviewCount(minutes);
    let queue = buildReviewQueue(notebook, combined(), {
      count,
      now: now(),
      exclude: cycle ? testedWell() : undefined,
    });
    if (!queue.length) return null;
    return { name: 'review', queue, first, asked: 0, startIndex: session.length };
  }
  function sceneStep(challenge = false) {
    const count = challenge ? 5 : 4;
    const scene = buildScene(notebook, combined(), {
      count,
      now: now(),
      round,
      include: introduced.slice(-1),
    });
    round++;
    if (scene.targets.length < 2) return null;
    return { name: 'scene', scene, challenge, hit: new Set(), startIndex: session.length };
  }
  function wrapStep(line = '') {
    return { name: 'wrap', line };
  }

  function start() {
    if (mode === 'quiz') {
      const known = taughtIds.size;
      const queue = buildQuiz(notebook, practice, {
        count: quizCount(minutes, known),
        now: now(),
        seed,
      });
      return setStep({ name: 'quiz', queue, startIndex: 0 });
    }
    if (mode === 'challenge')
      return setStep(
        sceneStep(true) || wrapStep('There are not enough phrases yet for a conversation.'),
      );
    return setStep(reviewStep(true) || wrapStep('There is nothing to review yet.'));
  }

  const remainingCues = () => step.queue.slice(0, 3).map(cueText);

  // Records one attempt and says whether the step is now complete.
  function record(attempt) {
    session.push(attempt);
    const test = isTest(attempt);
    if (step.name === 'review' || step.name === 'quiz') {
      const index = step.queue.findIndex((item) => item.id === attempt.phraseId);
      if (index < 0)
        return {
          output: step.queue.length
            ? { saved: true, remaining: remainingCues() }
            : {
                saved: true,
                remaining: [],
                next: 'Stop after your reaction. The next step follows.',
              },
          advance: false,
        };
      if (!test) return { output: { saved: true, remaining: remainingCues() }, advance: false };
      const [item] = step.queue.splice(index, 1);
      // A missed phrase comes back once, after the others, so the second try
      // is real recall rather than an echo of the model.
      if (
        step.name === 'review' &&
        FAILED.includes(attempt.result) &&
        !item.retest &&
        step.queue.length >= 2
      )
        step.queue.push({ ...item, retest: true });
      if (step.queue.length)
        return { output: { saved: true, remaining: remainingCues() }, advance: false };
      return {
        output: {
          saved: true,
          remaining: [],
          next: 'Stop after your reaction. The next step follows.',
        },
        advance: true,
      };
    }
    if (step.name === 'new') {
      const done = test && attempt.phraseId === step.item.id && attempt.context !== 'conversation';
      return {
        output: done
          ? { saved: true, next: 'Stop after your reaction. The next step follows.' }
          : { saved: true },
        advance: done,
      };
    }
    if (step.name === 'scene') {
      if (attempt.context === 'conversation' && test) step.hit.add(attempt.phraseId);
      const left = step.scene.targets.filter((t) => !step.hit.has(t.id)).map((t) => t.pt);
      return {
        output: left.length
          ? { saved: true, still_to_come: left }
          : { saved: true, next: 'End the scene with a goodbye, step out of character and stop.' },
        advance: !left.length,
      };
    }
    return { output: { saved: true }, advance: false };
  }

  const sinceStep = () => scoreAttempts(session.slice(step.startIndex || 0));

  // Moves to the next step. `elapsedMinutes` and `targetMinutes` decide
  // whether there is time for another round.
  function advance({ elapsedMinutes = 0, targetMinutes = minutes } = {}) {
    const timeLeft = targetMinutes - elapsedMinutes;
    if (step.name === 'quiz') return setStep({ name: 'result', score: scoreAttempts(session) });
    if (step.name === 'result') return null;
    if (step.name === 'review') {
      const score = sinceStep();
      const secure = score.asked >= 2 && score.unaided / score.asked >= 0.7 && score.missed <= 1;
      const candidate = pickNew(notebook, 1, new Set(introduced))[0];
      if (secure && candidate && allowance > 0 && timeLeft >= 3) {
        allowance--;
        introduced.push(candidate.id);
        const known = buildReviewQueue(notebook, combined(), {
          count: 3,
          now: now(),
          exclude: new Set([candidate.id]),
        });
        const distractor = known.find((k) => testedWell().has(k.id)) || known[0] || step.queue[0];
        return setStep({ name: 'new', item: candidate, distractor, startIndex: session.length });
      }
      return setStep(sceneStep(false) || wrapStep(summaryLine()));
    }
    if (step.name === 'new') return setStep(sceneStep(false) || wrapStep(summaryLine()));
    if (step.name === 'scene') {
      if (step.challenge) {
        const score = sinceStep();
        return setStep(
          wrapStep(`${score.conversation} of ${step.scene.targets.length} phrases without a hint.`),
        );
      }
      cycle++;
      if (timeLeft >= 3) {
        const next = reviewStep(false);
        if (next) return setStep(next);
      }
      return setStep(wrapStep(summaryLine()));
    }
    if (step.name === 'wrap') {
      // Dan chose to keep going.
      if (mode === 'challenge') return setStep(sceneStep(true) || wrapStep());
      cycle++;
      return setStep(
        reviewStep(false) || sceneStep(false) || wrapStep('That is everything for now.'),
      );
    }
    return null;
  }

  function summaryLine() {
    const score = scoreAttempts(session);
    if (!score.asked) return '';
    return `${score.unaided} of ${score.asked} without help${score.weakest[0] ? `. One to keep practising: ${score.weakest[0]}` : ''}.`;
  }
  // Time is up: stop whatever is running and ask whether to continue.
  function toWrap() {
    if (step.name === 'wrap' || step.name === 'result' || step.name === 'quiz') return null;
    return setStep(wrapStep(summaryLine()));
  }

  return {
    start,
    record,
    advance,
    toWrap,
    instructions,
    describe,
    phraseById,
    get mode() {
      return mode;
    },
    get step() {
      return step;
    },
    get stepName() {
      return step?.name || null;
    },
    get stepAgeMs() {
      return now() - stepStarted;
    },
    get introduced() {
      return [...introduced];
    },
    // True while the tutor is working through a list of cues, where a turn
    // that asks nothing means it is waiting to be prompted.
    get cueDriven() {
      return step?.name === 'review' || step?.name === 'quiz';
    },
    get nextCue() {
      return step?.queue?.[0] ? cueText(step.queue[0]) : '';
    },
    get waitingCues() {
      return (step?.name === 'review' || step?.name === 'quiz') && step.queue.length
        ? step.queue.slice(0, 3).map(cueText)
        : [];
    },
    get allowedIds() {
      return new Set(allowed().map((p) => p.id));
    },
    score: () => scoreAttempts(session),
    snapshot: () => ({
      mode,
      minutes,
      step: step?.name || null,
      queue: step?.queue?.map((i) => ({ id: i.id, kind: i.kind })) || [],
      targets: step?.scene?.targets?.map((t) => t.id) || [],
      introduced: [...introduced],
    }),
  };
}

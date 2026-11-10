// The voice session controller. It runs the Realtime call, hands the tutor
// one step at a time (see flow.js), keeps every checkpoint on this device as
// it happens, and at the end commits the practice record, progress and
// costs to GitHub in one go. A written journal entry is optional. Saving is
// idempotent and can be retried after a crash.
import {
  priceUsage,
  validateAttempt,
  applyProgress,
  addJournalEntry,
  buildSummary,
  validateSettings,
  sydneyDate,
  PRICING_VERSION,
  MAX_LESSON_MINUTES,
  NOTES_MODEL,
} from './domain.js';
import { monthlyTotals } from './costs.js';
import { KEYS } from './local.js';
import { ConflictError } from './github.js';
import { createFlow } from './flow.js';
import { scoreAttempts, MODES } from './plan.js';
import { sessionConfig, turnDetection } from './tutor.js';

export const FILES = {
  notebook: 'data/notebook.json',
  settings: 'data/settings.json',
  usage: 'data/usage.json',
  practice: 'data/practice.json',
  lessons: 'data/lessons.json',
  lessonDir: 'data/lessons',
};
const TICK_MS = 15000;
const AUDIO_TAIL_MS = 15000;
const SILENCE_MS = { quiz: 12000, default: 18000 };
const STEP_LIMIT_MS = { scene: 4 * 60000, new: 3 * 60000 };
const BENIGN_ERRORS = ['response_cancel_not_active', 'conversation_already_has_active_response'];
// What the tutor is asked to do when Dan has gone quiet. Two tries, then it
// waits rather than talking to an empty car.
const NUDGES = {
  cue: [
    'Dan has been quiet for a while. In one short sentence, repeat your last cue.',
    'Dan is still quiet. In one short sentence, give him the first sound of the answer as a hint.',
  ],
  scene: [
    'Dan has been quiet for a while. Repeat your last line once, slowly.',
    'Dan is still quiet. Give him a hint of at most four English words, then wait.',
  ],
};
const fold = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export const pretty = (value) => JSON.stringify(value, null, 2) + '\n';
export const lessonFileName = (record) =>
  `${FILES.lessonDir}/${sydneyDate(new Date(record.started))}-${record.id.slice(0, 8)}.json`;
const stripAttempt = ({ phraseId, pt, en, heard, result, context, pronunciation, note }) => ({
  phraseId,
  pt,
  en,
  heard: heard || '',
  result,
  context,
  pronunciation,
  note: note || '',
});
const compactScore = ({ asked, unaided, prompted, missed, pct, conversation }) => ({
  asked,
  unaided,
  prompted,
  missed,
  pct,
  conversation,
});
const modeLabel = (mode) => (MODES[mode] || MODES.lesson).label;

export function createLessonController({
  store,
  local,
  getSecrets,
  getSettings,
  getNotebook,
  getLessons = () => [],
  connect,
  notes,
  getMic,
  now = () => Date.now(),
  timers = globalThis,
  onUpdate = () => {},
  uuid = () => crypto.randomUUID(),
}) {
  let record = null;
  let conn = null;
  let timer = null;
  let flow = null;
  let phrases = [];
  let monthUsage = [];
  let busy = false;
  let finishRequested = false;
  let closing = false;
  let targetNotified = false;
  let endAfterAudio = false;
  let audioPlaying = false;
  let pendingAdvance = false;
  let timeChanged = false;
  let silenceTimer = null;
  let silenceWanted = false;
  let nudges = 0;
  let turn = newTurn();
  let finalizing = null;

  function newTurn() {
    return { text: '', recorded: [], tools: [] };
  }
  const emit = (type, payload = {}) => {
    try {
      onUpdate(type, payload);
    } catch {}
  };
  const save = () => {
    if (record) local.write(KEYS.lesson, record);
  };
  const usd = (rec) => (rec ? rec.usage.reduce((sum, u) => sum + (u.usd || 0), 0) : 0);
  const stats = () => ({
    elapsedSeconds: record ? Math.max(0, Math.round((now() - record.started) / 1000)) : 0,
    targetMinutes: record ? record.minutes : 0,
    checkpoints: record ? record.attempts.length : 0,
    usd: usd(record),
    mode: record?.mode || 'lesson',
    step: flow?.stepName || null,
    score: record ? compactScore(scoreAttempts(record.attempts)) : null,
  });
  const pending = () => local.read(KEYS.lesson);
  const budget = (settings) => {
    const totals = monthlyTotals([...monthUsage, ...(record ? record.usage : [])], settings, now());
    return { ...totals, over: totals.aud >= settings.budgetAud };
  };

  // One-off direction for the next thing the tutor says. The full
  // instructions are repeated so the rules always apply.
  function say(direction) {
    conn?.send({
      type: 'response.create',
      response: { instructions: `${flow.instructions()}\n\nRIGHT NOW: ${direction}` },
    });
  }
  // Moves the tutor to a new step: the standing instructions are replaced
  // so the old step's list is gone, then the tutor is told how to begin.
  function enterStep(step) {
    record.steps.push({ name: step.name, at: now() });
    record.introduced = flow.introduced;
    save();
    conn?.send({
      type: 'session.update',
      session: { type: 'realtime', instructions: flow.instructions() },
    });
    say(step.opener);
    emit('step', { name: step.name, ...stats() });
  }
  function advance() {
    const elapsedMinutes = (now() - record.started) / 60000;
    const step = flow.advance({ elapsedMinutes, targetMinutes: record.minutes });
    if (step) enterStep(step);
    return step;
  }

  function clearSilence() {
    timers.clearTimeout(silenceTimer);
    silenceTimer = null;
    silenceWanted = false;
  }
  function startSilence() {
    timers.clearTimeout(silenceTimer);
    silenceTimer = timers.setTimeout(onSilence, SILENCE_MS[record?.mode] || SILENCE_MS.default);
  }
  function armSilence() {
    silenceWanted = true;
    if (!audioPlaying) startSilence();
  }
  function onSilence() {
    silenceTimer = null;
    if (!record || closing || busy || endAfterAudio) return;
    const lines = flow.stepName === 'scene' ? NUDGES.scene : NUDGES.cue;
    if (nudges >= lines.length) return;
    say(lines[nudges]);
    nudges++;
  }

  async function start({ minutes, model, mode = 'lesson' } = {}) {
    if (record || conn) throw new Error('A session is already running.');
    if (pending())
      throw new Error('Finish or recover the previous session before starting another.');
    if (!MODES[mode]) throw new Error('Choose lesson, quiz or challenge.');
    const secrets = getSecrets();
    if (!secrets?.openaiKey)
      throw new Error('Add your OpenAI API key in Connection settings first.');
    const settings = validateSettings({
      ...getSettings(),
      ...(model ? { model } : {}),
      ...(minutes ? { minutes: Number(minutes) } : {}),
    });
    const notebook = getNotebook();
    if (!notebook) throw new Error('Your notebook has not loaded yet.');
    const [usageFile, practiceFile] = await Promise.all([
      store.readJson(FILES.usage),
      store.readJson(FILES.practice),
    ]);
    monthUsage = usageFile.data || [];
    if (budget(settings).over)
      throw new Error(
        'Your estimated monthly API budget has been reached. Review costs or adjust the budget before starting.',
      );
    phrases = notebook.phrases;
    flow = createFlow({
      notebook,
      practice: practiceFile.data || [],
      lessons: getLessons() || [],
      mode,
      minutes: settings.minutes,
      now,
      seed: now(),
    });
    const first = flow.start();
    record = {
      id: uuid(),
      created: now(),
      started: now(),
      lastSeen: now(),
      ended: null,
      minutes: settings.minutes,
      model: settings.model,
      mode,
      recap: !!settings.recap && mode === 'lesson',
      status: 'starting',
      plan: flow.snapshot(),
      steps: [{ name: first.name, at: now() }],
      introduced: [],
      attempts: [],
      transcript: [],
      usage: [],
      toolOutputs: {},
      summary: null,
      summaryStatus: 'pending',
      usageIncomplete: false,
      error: null,
    };
    busy = finishRequested = closing = targetNotified = endAfterAudio = audioPlaying = false;
    pendingAdvance = timeChanged = false;
    nudges = 0;
    turn = newTurn();
    clearSilence();
    save();
    emit('connecting', { id: record.id, mode });
    let mic;
    try {
      mic = await getMic();
      if (closing) throw new Error('cancelled');
      conn = await connect({
        apiKey: secrets.openaiKey,
        session: sessionConfig({
          model: settings.model,
          instructions: flow.instructions(),
          pace: settings.pace,
          mic: settings.mic,
        }),
        mic,
        onEvent: handleEvent,
        onTrack: (stream) => emit('audio', { stream }),
        onState: (state) => {
          if (['failed', 'disconnected'].includes(state) && record && !closing) {
            emit('notice', {
              message: 'Connection interrupted. Saving the practice already completed…',
            });
            void end('interrupted', true);
          }
        },
      });
      if (closing) {
        conn.close();
        throw new Error('cancelled');
      }
    } catch (e) {
      try {
        mic?.getTracks().forEach((t) => t.stop());
      } catch {}
      conn = null;
      record = null;
      flow = null;
      local.remove(KEYS.lesson);
      if (e.message === 'cancelled') {
        emit('cancelled');
        return null;
      }
      const message =
        e.name === 'NotAllowedError'
          ? 'Microphone access was declined. Allow the microphone for this site, then start again.'
          : e.message;
      emit('error', { message });
      throw new Error(message);
    }
    record.status = 'active';
    record.started = now();
    record.lastSeen = record.started;
    record.steps[0].at = record.started;
    save();
    conn.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: { input: { turn_detection: turnDetection(settings.pace, true) } },
      },
    });
    say(first.opener);
    conn.setMicEnabled(true);
    timer = timers.setInterval(tick, TICK_MS);
    emit('started', { id: record.id, ...stats() });
    return record.id;
  }

  function tick() {
    if (!record || closing) return;
    record.lastSeen = now();
    save();
    const s = stats();
    emit('metrics', s);
    if (s.elapsedSeconds >= MAX_LESSON_MINUTES * 60) return void end('complete');
    if (budget(getSettings()).over) {
      emit('notice', {
        message: 'Your estimated monthly budget has been reached. Saving this session.',
      });
      return void end('complete');
    }
    if (busy || endAfterAudio) return;
    if (s.elapsedSeconds >= record.minutes * 60 && !targetNotified) {
      targetNotified = true;
      const step = flow.toWrap();
      if (step) {
        clearSilence();
        enterStep(step);
      }
      return;
    }
    const limit = STEP_LIMIT_MS[flow.stepName];
    if (limit && flow.stepAgeMs > limit) {
      clearSilence();
      advance();
    }
  }

  function setTime(minutes, mode) {
    if (!record) throw new Error('No session is running.');
    if (
      !Number.isFinite(minutes) ||
      minutes < 1 ||
      minutes > MAX_LESSON_MINUTES ||
      !['remaining', 'total'].includes(mode)
    )
      throw new Error('Choose 1–55 minutes.');
    const elapsed = (now() - record.started) / 60000;
    record.minutes = Math.min(
      MAX_LESSON_MINUTES,
      Math.max(1, mode === 'remaining' ? elapsed + minutes : minutes),
    );
    save();
    targetNotified = false;
    emit('target', { minutes: record.minutes });
    return {
      targetMinutes: record.minutes,
      remainingMinutes: Math.max(0, record.minutes - elapsed),
    };
  }

  function requestFinish() {
    if (!record || closing || endAfterAudio) return;
    endAfterAudio = true;
    clearSilence();
    conn?.setMicEnabled(false);
    emit('ready_to_finish');
    if (!audioPlaying) return void end('complete');
    timers.setTimeout(() => {
      if (!closing) void end('complete');
    }, AUDIO_TAIL_MS);
  }

  function handleTool(e) {
    if (closing) return;
    const callId = e.call_id;
    let args;
    try {
      args = JSON.parse(e.arguments || '{}');
    } catch {
      args = {};
    }
    let output = record.toolOutputs[callId];
    if (!output) {
      try {
        if (e.name === 'record_practice') {
          const attempt = validateAttempt(args, phrases);
          if (!flow.allowedIds.has(attempt.phraseId))
            throw new Error(
              'That phrase is not part of this session. Go back to the current step.',
            );
          const stamped = { ...attempt, at: now(), step: flow.stepName };
          record.attempts.push(stamped);
          const result = flow.record(stamped);
          output = result.output;
          if (result.advance) pendingAdvance = true;
          turn.recorded.push(stamped);
          save();
          emit('checkpoint', { attempt, ...stats() });
        } else if (e.name === 'next_step') {
          const waiting = flow.waitingCues;
          if (waiting.length) output = { ok: false, not_finished: true, remaining: waiting };
          else {
            pendingAdvance = true;
            output = { ok: true };
          }
        } else if (e.name === 'set_lesson_time') {
          output = setTime(Number(args.minutes), args.mode);
          timeChanged = true;
        } else if (e.name === 'finish_lesson') {
          finishRequested = true;
          output = { finishing: true };
        } else output = { error: 'Unknown tool' };
      } catch (err) {
        output = { error: err.message };
      }
      record.toolOutputs[callId] = output;
      save();
    }
    turn.tools.push(e.name);
    conn.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
    });
    if (!busy) afterResponse();
  }

  // Runs when the tutor has finished generating a turn. Decides whether the
  // app needs to prompt it again or can simply wait for Dan.
  function afterResponse() {
    const done = turn;
    turn = newTurn();
    if (!record || closing) return;
    emit('metrics', stats());
    if (finishRequested) return requestFinish();
    if (flow.stepName === 'result' && done.text.trim()) return requestFinish();
    if (pendingAdvance) {
      pendingAdvance = false;
      timeChanged = false;
      if (advance()) return;
    }
    if (timeChanged) {
      timeChanged = false;
      return say('Acknowledge the new time in a few words, then carry on with the current step.');
    }
    if (done.tools.length) {
      // The tutor normally reacts, asks the next cue and records the attempt
      // in one turn. If it said nothing at all, or (while working through a
      // list of cues) took a good answer but asked nothing next, prompt it
      // so Dan is not left in silence.
      const last = done.recorded.at(-1);
      const tookAnswer = !!last && ['independent', 'repeated'].includes(last.result);
      const next = fold(flow.nextCue);
      const asked = done.text.includes('?') || (next && fold(done.text).includes(next));
      if (!done.text.trim() || (flow.cueDriven && tookAnswer && !asked))
        return conn.send({ type: 'response.create' });
    }
    armSilence();
  }

  function handleEvent(e) {
    if (!record || !e || typeof e.type !== 'string') return;
    switch (e.type) {
      case 'response.created':
        busy = true;
        timers.clearTimeout(silenceTimer);
        silenceTimer = null;
        silenceWanted = false;
        return;
      case 'response.done': {
        busy = false;
        const usage = e.response?.usage;
        const id = e.response?.id;
        if (usage && id) {
          if (!record.usage.some((u) => u.id === id)) {
            const priced = priceUsage(record.model, usage, true);
            record.usage.push({
              id,
              model: record.model,
              category: 'voice',
              usd: priced.usd,
              incomplete: priced.incomplete,
              breakdown: priced.breakdown,
              at: now(),
              pricingVersion: PRICING_VERSION,
            });
            if (priced.incomplete) record.usageIncomplete = true;
          }
        } else record.usageIncomplete = true;
        save();
        return afterResponse();
      }
      case 'response.output_audio.delta':
      case 'response.output_audio_transcript.delta':
        emit('tutor_speaking');
        return;
      case 'response.output_audio_transcript.done':
        turn.text += ` ${e.transcript || ''}`;
        record.transcript.push({
          speaker: 'Tutor',
          text: e.transcript || '',
          at: now(),
          step: flow.stepName,
        });
        save();
        emit('transcript', { speaker: 'Tutor', text: e.transcript || '' });
        return;
      case 'response.function_call_arguments.done':
        return handleTool(e);
      case 'input_audio_buffer.speech_started':
        nudges = 0;
        clearSilence();
        emit('listening');
        return;
      case 'output_audio_buffer.started':
        audioPlaying = true;
        return;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        audioPlaying = false;
        if (endAfterAudio && !closing) return void end('complete');
        if (silenceWanted && !busy) startSilence();
        return;
      case 'error': {
        const code = e.error?.code || '';
        if (BENIGN_ERRORS.includes(code)) return;
        record.transcript.push({
          speaker: 'System',
          text: `Voice service error: ${e.error?.message || code}`,
          at: now(),
        });
        save();
        emit('notice', {
          message: 'The voice service reported a problem. Your saved checkpoints are safe.',
        });
        return;
      }
      default:
        return;
    }
  }

  function setMuted(muted) {
    conn?.setMicEnabled(!muted);
  }

  function cancel() {
    if (record && record.status === 'starting') closing = true;
  }

  function finish() {
    if (!record) return null;
    return end('complete', busy);
  }

  async function end(status = 'complete', incomplete = false) {
    if (!record || closing) return finalizing;
    closing = true;
    timers.clearInterval(timer);
    timer = null;
    clearSilence();
    if (busy) conn?.send({ type: 'response.cancel' });
    record.status = status;
    record.ended = now();
    record.lastSeen = record.ended;
    record.usageIncomplete = record.usageIncomplete || incomplete || busy;
    record.introduced = flow?.introduced || record.introduced || [];
    save();
    emit('finishing', stats());
    try {
      conn?.close();
    } catch {}
    conn = null;
    const rec = record;
    record = null;
    flow = null;
    return finalize(rec);
  }

  const sessionOf = (rec) => ({
    id: rec.id,
    started: rec.started,
    ended: rec.ended,
    last_seen: rec.lastSeen,
    status: rec.status,
  });
  const indexEntry = (rec, extra) => ({
    id: rec.id,
    date: sydneyDate(new Date(rec.started)),
    started: rec.started,
    ended: rec.ended,
    lastSeen: rec.lastSeen,
    minutes: rec.minutes,
    model: rec.model,
    mode: rec.mode || 'lesson',
    status: rec.status,
    summaryStatus: 'saved',
    usageIncomplete: rec.usageIncomplete,
    checkpoints: rec.attempts.length,
    usd: usd(rec),
    file: lessonFileName(rec),
    ...extra,
  });
  const mergeUsage = (existing, rec) => [
    ...existing,
    ...rec.usage
      .filter((u) => !existing.some((x) => x.id === u.id))
      .map((u) => ({ ...u, sessionId: rec.id })),
  ];

  async function finalize(rec) {
    if (!rec) return null;
    if (finalizing) return finalizing;
    finalizing = (async () => {
      try {
        if (rec.summaryStatus === 'saved') return { saved: true, alreadySaved: true, record: rec };
        if (!rec.attempts.length && !rec.usage.length) {
          // Nothing happened (for example the microphone was closed straight
          // away). There is nothing worth recording.
          local.remove(KEYS.lesson);
          emit('discarded', { id: rec.id });
          return { saved: false, discarded: true, record: rec };
        }
        if (!rec.attempts.length) return await recordWithoutPractice(rec);
        const mode = rec.mode || 'lesson';
        const attempts = rec.attempts.map(stripAttempt);
        const score = scoreAttempts(attempts);
        rec.score = compactScore(score);
        const secrets = getSecrets();
        if (!rec.summary) {
          let summary = buildSummary(rec, attempts, score, mode);
          if (rec.recap && secrets?.openaiKey && notes) {
            try {
              const result = await notes({
                apiKey: secrets.openaiKey,
                model: NOTES_MODEL,
                mode,
                score: rec.score,
                interrupted: rec.status === 'interrupted',
                attempts,
                base: summary,
              });
              summary = result.summary;
              if (result.usage && !rec.usage.some((u) => u.id === result.usage.id))
                rec.usage.push(result.usage);
              if (result.usageMissing) rec.usageIncomplete = true;
            } catch (e) {
              rec.notesError = e.message;
            }
          }
          rec.summary = summary;
          local.write(KEYS.lesson, rec);
        }
        const date = sydneyDate(new Date(rec.started));
        for (let attempt = 0; attempt < 3; attempt++) {
          const [nb, practice, usage, lessons] = await Promise.all([
            store.readJson(FILES.notebook),
            store.readJson(FILES.practice),
            store.readJson(FILES.usage),
            store.readJson(FILES.lessons),
          ]);
          if (!nb.data) throw new Error('data/notebook.json is missing from the repository.');
          const prior = (practice.data || []).filter((p) => p.sessionId !== rec.id);
          const progress = applyProgress(nb.data, sessionOf(rec), attempts, prior);
          const nextNotebook = rec.recap
            ? addJournalEntry(progress.notebook, sessionOf(rec), rec.summary, {
                mode,
                learned: progress.learned,
              })
            : progress.notebook;
          const newPractice = [
            ...prior,
            ...rec.attempts.map((a) => ({
              sessionId: rec.id,
              date,
              ...stripAttempt(a),
              at: a.at,
              step: a.step || null,
            })),
          ];
          const index = (lessons.data || []).filter((l) => l.id !== rec.id);
          const previous = (lessons.data || []).find((l) => l.id === rec.id);
          const entry = indexEntry(rec, {
            title: rec.summary.title,
            score: rec.score,
            introduced: rec.introduced || [],
            learned: progress.learned,
            journal: !!rec.recap,
            feedback: previous?.feedback || null,
          });
          index.push(entry);
          const files = {
            [FILES.notebook]: pretty(nextNotebook),
            [FILES.practice]: pretty(newPractice),
            [FILES.usage]: pretty(mergeUsage(usage.data || [], rec)),
            [FILES.lessons]: pretty(index),
            [lessonFileName(rec)]: pretty({ ...rec, summaryStatus: 'saved' }),
          };
          const base = {
            [FILES.notebook]: nb.sha,
            [FILES.practice]: practice.sha,
            [FILES.usage]: usage.sha,
            [FILES.lessons]: lessons.sha,
          };
          try {
            const result = await store.commit({
              message: `${modeLabel(mode)} ${date}: ${rec.score.unaided} of ${rec.score.asked} without help`,
              files,
              base,
            });
            rec.summaryStatus = 'saved';
            rec.commit = result.sha;
            local.remove(KEYS.lesson);
            local.write(KEYS.lastLesson, { ...entry, commit: result.sha });
            const payload = {
              id: rec.id,
              notebook: nextNotebook,
              shas: result.shas,
              checkpoints: rec.attempts.length,
              usd: usd(rec),
              score: rec.score,
              mode,
              entry,
              record: rec,
            };
            emit('saved', payload);
            return { saved: true, ...payload };
          } catch (e) {
            if (e instanceof ConflictError && attempt < 2) continue;
            throw e;
          }
        }
        throw new Error('The notebook kept changing while saving. Please retry.');
      } catch (e) {
        rec.summaryStatus = 'pending';
        rec.error = 'Your checkpoints are saved on this device. Retry saving the session.';
        local.write(KEYS.lesson, rec);
        emit('failure', { id: rec.id, message: e.message });
        throw e;
      } finally {
        finalizing = null;
      }
    })();
    return finalizing;
  }

  // A session that was cancelled before any practice was assessed: the spend
  // is real and goes into the ledger, but progress is left untouched.
  async function recordWithoutPractice(rec) {
    const date = sydneyDate(new Date(rec.started));
    for (let attempt = 0; attempt < 3; attempt++) {
      const [usage, lessons] = await Promise.all([
        store.readJson(FILES.usage),
        store.readJson(FILES.lessons),
      ]);
      const index = (lessons.data || []).filter((l) => l.id !== rec.id);
      index.push(indexEntry(rec, { checkpoints: 0, title: 'Cancelled before any practice' }));
      try {
        const result = await store.commit({
          message: `${modeLabel(rec.mode)} ${date}: cancelled before any practice`,
          files: {
            [FILES.usage]: pretty(mergeUsage(usage.data || [], rec)),
            [FILES.lessons]: pretty(index),
            [lessonFileName(rec)]: pretty({ ...rec, summaryStatus: 'saved' }),
          },
          base: { [FILES.usage]: usage.sha, [FILES.lessons]: lessons.sha },
        });
        rec.summaryStatus = 'saved';
        rec.commit = result.sha;
        local.remove(KEYS.lesson);
        emit('discarded', { id: rec.id, usd: usd(rec) });
        return { saved: false, discarded: true, record: rec, shas: result.shas };
      } catch (e) {
        if (e instanceof ConflictError && attempt < 2) continue;
        throw e;
      }
    }
    throw new Error('The ledger kept changing while saving. Please retry.');
  }

  // Finishes a session left behind by a closed tab or a failed save.
  async function recover() {
    const rec = pending();
    if (!rec) return null;
    if (record && record.id === rec.id) return finalizing;
    if (['starting', 'active', 'finishing'].includes(rec.status)) {
      rec.status = 'interrupted';
      rec.ended = rec.ended || rec.lastSeen || now();
      rec.usageIncomplete = true;
      local.write(KEYS.lesson, rec);
    }
    return finalize(rec);
  }

  // Writes a journal entry for a past session on request. Uses the notes
  // model when it is available and the plain record otherwise.
  async function writeUp(id) {
    const lessons = await store.readJson(FILES.lessons);
    const entry = (lessons.data || []).find((l) => l.id === id);
    if (!entry) throw new Error('That session is not in the history.');
    const file = await store.readJson(entry.file);
    if (!file.data) throw new Error('The record for that session could not be found.');
    const rec = file.data;
    const mode = rec.mode || 'lesson';
    const attempts = (rec.attempts || []).map(stripAttempt);
    if (!attempts.length) throw new Error('Nothing was practised in that session.');
    const score = scoreAttempts(attempts);
    let summary = buildSummary(rec, attempts, score, mode);
    let usage = null;
    const secrets = getSecrets();
    if (secrets?.openaiKey && notes) {
      try {
        const result = await notes({
          apiKey: secrets.openaiKey,
          model: NOTES_MODEL,
          mode,
          score: compactScore(score),
          interrupted: rec.status === 'interrupted',
          attempts,
          base: summary,
        });
        summary = result.summary;
        usage = result.usage;
      } catch {}
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const [nb, usageFile, index] = await Promise.all([
        store.readJson(FILES.notebook),
        store.readJson(FILES.usage),
        store.readJson(FILES.lessons),
      ]);
      if (!nb.data) throw new Error('data/notebook.json is missing from the repository.');
      const notebook = addJournalEntry(nb.data, sessionOf(rec), summary, { mode });
      const existing = usageFile.data || [];
      const newUsage =
        usage && !existing.some((u) => u.id === usage.id)
          ? [...existing, { ...usage, sessionId: rec.id }]
          : existing;
      const newIndex = (index.data || []).map((l) => (l.id === id ? { ...l, journal: true } : l));
      try {
        const result = await store.commit({
          message: `Write up ${entry.date} session`,
          files: {
            [FILES.notebook]: pretty(notebook),
            [FILES.usage]: pretty(newUsage),
            [FILES.lessons]: pretty(newIndex),
          },
          base: {
            [FILES.notebook]: nb.sha,
            [FILES.usage]: usageFile.sha,
            [FILES.lessons]: index.sha,
          },
        });
        emit('journal', { id, notebook, shas: result.shas });
        return { notebook, shas: result.shas, summary };
      } catch (e) {
        if (e instanceof ConflictError && attempt < 2) continue;
        throw e;
      }
    }
    throw new Error('The notebook kept changing while saving. Please retry.');
  }

  return {
    start,
    finish,
    cancel,
    setTime,
    setMuted,
    recover,
    writeUp,
    pending,
    stats,
    get active() {
      return !!record;
    },
    get record() {
      return record;
    },
    get step() {
      return flow?.stepName || null;
    },
    get finalizing() {
      return !!finalizing;
    },
  };
}

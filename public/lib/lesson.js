// The voice lesson controller. This is the browser-side port of the old
// Worker's control loop: it drives the Realtime session, executes the
// tutor's tools, keeps every checkpoint on this device as it happens, and
// at the end writes the journal entry, progress and next plan to GitHub in
// one commit. Finalisation is idempotent and can be retried after a crash.
import {
  priceUsage,
  validateAttempt,
  applyLesson,
  fallbackSummary,
  realtimeSessionConfig,
  validateSettings,
  sydneyDate,
  PRICING_VERSION,
  MAX_LESSON_MINUTES,
  NOTES_MODEL,
} from './domain.js';
import { monthlyTotals } from './costs.js';
import { KEYS } from './local.js';
import { ConflictError } from './github.js';

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
const BENIGN_ERRORS = ['response_cancel_not_active', 'conversation_already_has_active_response'];
const GREETING =
  'Begin now. Briefly greet Dan, then ask ONE English meaning cue from the next plan. Do not give its Portuguese answer.';
const CONTINUE = {
  record_practice:
    'Continue the lesson directly from where you were. Do not mention saving, noting or checking anything.',
  set_lesson_time: 'Acknowledge the new time in a few words and continue the lesson.',
  default: 'Continue the lesson directly.',
};
const TARGET_REACHED =
  'The target lesson time has been reached. Briefly ask Dan if he wants to finish and save, or continue. Do not end until he answers.';

export const pretty = (value) => JSON.stringify(value, null, 2) + '\n';
export const lessonFileName = (record) =>
  `${FILES.lessonDir}/${sydneyDate(new Date(record.started))}-${record.id.slice(0, 8)}.json`;
const stripAttempt = ({ phraseId, pt, en, heard, result, context, pronunciation, note }) => ({
  phraseId,
  pt,
  en,
  heard,
  result,
  context,
  pronunciation,
  note,
});

export function createLessonController({
  store,
  local,
  getSecrets,
  getSettings,
  getNotebook,
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
  let monthUsage = [];
  let busy = false;
  let finishRequested = false;
  let closing = false;
  let targetNotified = false;
  let endAfterAudio = false;
  let audioPlaying = false;
  let audioInResponse = false;
  let followUp = null;
  let finalizing = null;

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
  });
  const pending = () => local.read(KEYS.lesson);
  const budget = (settings) => {
    const totals = monthlyTotals([...monthUsage, ...(record ? record.usage : [])], settings, now());
    return { ...totals, over: totals.aud >= settings.budgetAud };
  };

  async function start({ minutes, model } = {}) {
    if (record || conn) throw new Error('A lesson is already running.');
    if (pending())
      throw new Error('Finish or recover the previous lesson before starting another.');
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
    const usageFile = await store.readJson(FILES.usage);
    monthUsage = usageFile.data || [];
    if (budget(settings).over)
      throw new Error(
        'Your estimated monthly API budget has been reached. Review costs or adjust the budget before starting.',
      );
    record = {
      id: uuid(),
      created: now(),
      started: now(),
      lastSeen: now(),
      ended: null,
      minutes: settings.minutes,
      model: settings.model,
      status: 'starting',
      previousPlan: structuredClone(notebook.next),
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
    audioInResponse = false;
    followUp = null;
    save();
    emit('connecting', { id: record.id });
    let mic;
    try {
      mic = await getMic();
      if (closing) throw new Error('cancelled');
      conn = await connect({
        apiKey: secrets.openaiKey,
        session: realtimeSessionConfig(notebook, settings.minutes, settings.model),
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
    save();
    conn.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: {
          input: {
            turn_detection: {
              type: 'semantic_vad',
              eagerness: 'medium',
              create_response: true,
              interrupt_response: true,
            },
          },
        },
      },
    });
    conn.send({ type: 'response.create', response: { instructions: GREETING } });
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
        message: 'Your estimated monthly budget has been reached. Saving this lesson.',
      });
      return void end('complete');
    }
    if (s.elapsedSeconds >= record.minutes * 60 && !targetNotified && !busy) {
      targetNotified = true;
      conn.send({ type: 'response.create', response: { instructions: TARGET_REACHED } });
    }
  }

  function setTime(minutes, mode) {
    if (!record) throw new Error('No lesson is running.');
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
          const attempt = validateAttempt(args);
          record.attempts.push({ ...attempt, at: now() });
          output = { saved: true };
          save();
          emit('checkpoint', { attempt, ...stats() });
        } else if (e.name === 'set_lesson_time') output = setTime(Number(args.minutes), args.mode);
        else if (e.name === 'finish_lesson') {
          finishRequested = true;
          output = { finishing: true };
        } else output = { error: 'Unknown tool' };
      } catch (err) {
        output = { error: err.message };
      }
      record.toolOutputs[callId] = output;
      save();
    }
    conn.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
    });
    if (e.name === 'finish_lesson') {
      if (!busy) requestFinish();
      return;
    }
    // The model normally speaks and calls the tool in the same response. A
    // second response is only needed when it called the tool without saying
    // anything, otherwise every checkpoint would cost an extra spoken turn.
    if (busy) followUp = e.name;
    else
      conn.send({
        type: 'response.create',
        response: { instructions: CONTINUE[e.name] || CONTINUE.default },
      });
  }

  function handleEvent(e) {
    if (!record || !e || typeof e.type !== 'string') return;
    switch (e.type) {
      case 'response.created':
        busy = true;
        audioInResponse = false;
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
              raw: usage,
              at: now(),
              pricingVersion: PRICING_VERSION,
            });
            if (priced.incomplete) record.usageIncomplete = true;
          }
        } else record.usageIncomplete = true;
        save();
        if (closing) return;
        emit('metrics', stats());
        if (finishRequested) return requestFinish();
        if (followUp) {
          const name = followUp;
          followUp = null;
          if (!(name === 'record_practice' && audioInResponse))
            conn.send({
              type: 'response.create',
              response: { instructions: CONTINUE[name] || CONTINUE.default },
            });
        }
        return;
      }
      case 'response.output_audio.delta':
      case 'response.output_audio_transcript.delta':
        audioInResponse = true;
        emit('tutor_speaking');
        return;
      case 'response.output_audio_transcript.done':
        record.transcript.push({ speaker: 'Tutor', text: e.transcript || '', at: now() });
        save();
        emit('transcript', { speaker: 'Tutor', text: e.transcript || '' });
        return;
      case 'response.function_call_arguments.done':
        return handleTool(e);
      case 'input_audio_buffer.speech_started':
        emit('listening');
        return;
      case 'output_audio_buffer.started':
        audioPlaying = true;
        return;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        audioPlaying = false;
        if (endAfterAudio && !closing) void end('complete');
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
    if (busy) conn?.send({ type: 'response.cancel' });
    record.status = status;
    record.ended = now();
    record.lastSeen = record.ended;
    record.usageIncomplete = record.usageIncomplete || incomplete || busy;
    save();
    emit('finishing', stats());
    try {
      conn?.close();
    } catch {}
    conn = null;
    const rec = record;
    record = null;
    return finalize(rec);
  }

  async function finalize(rec) {
    if (!rec) return null;
    if (finalizing) return finalizing;
    finalizing = (async () => {
      try {
        if (rec.summaryStatus === 'saved') return { saved: true, alreadySaved: true, record: rec };
        if (!rec.attempts.length && !rec.usage.length) {
          // Nothing happened (for example the microphone was closed straight
          // away). There is nothing worth a journal entry.
          local.remove(KEYS.lesson);
          emit('discarded', { id: rec.id });
          return { saved: false, discarded: true, record: rec };
        }
        const secrets = getSecrets();
        if (!rec.summary) {
          let summary = null;
          if (rec.attempts.length && secrets?.openaiKey && notes) {
            try {
              const result = await notes({
                apiKey: secrets.openaiKey,
                model: NOTES_MODEL,
                previousPlan: rec.previousPlan,
                interrupted: rec.status === 'interrupted',
                attempts: rec.attempts.map(stripAttempt),
              });
              summary = result.summary;
              if (result.usage && !rec.usage.some((u) => u.id === result.usage.id))
                rec.usage.push(result.usage);
              if (result.usageMissing) rec.usageIncomplete = true;
            } catch (e) {
              rec.usageIncomplete = true;
              rec.notesError = e.message;
            }
          }
          if (!summary) {
            summary = fallbackSummary(rec, rec.attempts);
            if (rec.attempts.length)
              summary.notes +=
                ' The AI-written recap was unavailable; these saved checkpoints remain the source of truth.';
          }
          rec.summary = summary;
          local.write(KEYS.lesson, rec);
        }
        const sessionLike = {
          id: rec.id,
          started: rec.started,
          ended: rec.ended,
          last_seen: rec.lastSeen,
          status: rec.status,
        };
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
          const nextNotebook = applyLesson(
            nb.data,
            sessionLike,
            rec.attempts.map(stripAttempt),
            rec.summary,
            prior,
          );
          const newPractice = [
            ...prior,
            ...rec.attempts.map((a) => ({ sessionId: rec.id, date, ...stripAttempt(a), at: a.at })),
          ];
          const existingUsage = usage.data || [];
          const newUsage = [
            ...existingUsage,
            ...rec.usage
              .filter((u) => !existingUsage.some((x) => x.id === u.id))
              .map((u) => ({ ...u, sessionId: rec.id })),
          ];
          const index = (lessons.data || []).filter((l) => l.id !== rec.id);
          const entry = {
            id: rec.id,
            date,
            started: rec.started,
            ended: rec.ended,
            lastSeen: rec.lastSeen,
            minutes: rec.minutes,
            model: rec.model,
            status: rec.status,
            summaryStatus: 'saved',
            usageIncomplete: rec.usageIncomplete,
            checkpoints: rec.attempts.length,
            usd: usd(rec),
            title: rec.summary.title,
            file: lessonFileName(rec),
          };
          index.push(entry);
          const files = {
            [FILES.notebook]: pretty(nextNotebook),
            [FILES.practice]: pretty(newPractice),
            [FILES.usage]: pretty(newUsage),
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
              message: `Voice lesson ${date}: ${rec.summary.title}`,
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
        rec.error = 'Your checkpoints are saved on this device. Retry the lesson summary.';
        local.write(KEYS.lesson, rec);
        emit('failure', { id: rec.id, message: e.message });
        throw e;
      } finally {
        finalizing = null;
      }
    })();
    return finalizing;
  }

  // Finishes a lesson left behind by a closed tab or a failed save.
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

  return {
    start,
    finish,
    cancel,
    setTime,
    setMuted,
    recover,
    pending,
    stats,
    get active() {
      return !!record;
    },
    get record() {
      return record;
    },
    get finalizing() {
      return !!finalizing;
    },
  };
}

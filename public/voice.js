// Voice lesson screens, cost tracker, connection screen and the glue between
// the hub (app.js), the repository sync layer and the lesson controller.
import { createVault } from './lib/vault.js';
import { createGitHubStore } from './lib/github.js';
import { createLocal, KEYS } from './lib/local.js';
import { createSync } from './lib/sync.js';
import { createLessonController, FILES } from './lib/lesson.js';
import { connectRealtime } from './lib/realtime.js';
import { generateNotes } from './lib/notes.js';
import { usageOverview } from './lib/costs.js';
import { RATES, DEFAULT_SETTINGS, NOTES_MODEL } from './lib/domain.js';
import { MODES } from './lib/plan.js';
import { FEEDBACK_TAGS } from './lib/tutor.js';
import {
  progressPage as renderProgress,
  planPreview,
  challengeCards,
  scoreLine,
} from './progress.js';
import { CONFIG } from './config.js';

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const money = (n, c = 'AUD') =>
  new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: c,
    currencyDisplay: 'narrowSymbol',
  }).format(Number(n) || 0);
const clock = (s) =>
  `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
const modelName = (m) => (m?.endsWith('-mini') ? 'Realtime 2.1 Mini' : 'Realtime 2.1');
const button = (text, action, cls = '', attrs = '') =>
  `<button class="btn ${cls}" data-voice="${action}" ${attrs}>${text}</button>`;
const VOICE_MODELS = Object.keys(RATES).filter((m) => m.startsWith('gpt-realtime-'));
const STEP_LABEL = {
  review: 'RECALL',
  new: 'NEW PHRASE',
  scene: 'CONVERSATION',
  quiz: 'QUICK QUIZ',
  result: 'YOUR SCORE',
  wrap: 'KEEP GOING OR FINISH?',
};
const IDLE_LABEL = {
  idle: 'READY WHEN YOU ARE',
  connecting: 'CONNECTING',
  finishing: 'SAVING YOUR SESSION',
  complete: 'SESSION SAVED',
  error: 'LET’S RECONNECT',
};

export function createVoiceHub({
  getState,
  setState,
  render,
  toast,
  navigate,
  stopAudio,
  onReview,
}) {
  const local = createLocal();
  const vault = createVault();
  let secrets = null;
  let store = null;
  let sync = null;
  let lesson = null;
  let adoptedSha;
  let info = null;
  let setupStatus = { text: '', kind: '' };
  let recovering = false;
  let ready = false; // true once the vault has been read on this device
  let lastSaved = local.read(KEYS.lastLesson);
  // lesson screen state
  let phase = 'idle';
  let message = '';
  let transcript = [];
  let started = 0;
  let elapsed = 0;
  let sessionUSD = 0;
  let checkpoints = 0;
  let muted = false;
  let target = DEFAULT_SETTINGS.minutes;
  let model = DEFAULT_SETTINGS.model;
  let audio = null;
  let wake = null;
  let timer = null;
  let mode = 'lesson';
  let step = null;
  let liveScore = null;
  let result = null; // the session just saved
  let fb = { good: false, tags: new Set(), note: '', sent: false };
  let openSession = null;
  const said = {}; // tutor transcripts loaded on the history screen
  let busyAction = '';

  const safeRender = () => {
    if (!document.querySelector('dialog[open]')) render();
  };
  const connected = () => !!secrets?.githubToken;
  const configured = () => !!secrets?.openaiKey;
  const fx = () => sync?.settings.usdToAud || DEFAULT_SETTINGS.usdToAud;
  const overview = () =>
    sync
      ? {
          ...usageOverview({
            usage: sync.usage,
            lessons: sync.lessons,
            settings: sync.settings,
            pending: lesson?.record?.usage || [],
          }),
          configured: configured(),
        }
      : null;

  function onSyncChange() {
    if (sync.notebook.state && sync.notebook.sha !== adoptedSha) {
      adoptedSha = sync.notebook.sha;
      setState(structuredClone(sync.notebook.state));
    }
    info = overview();
    updateSyncLabel();
    safeRender();
  }

  async function getMic() {
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
      throw new Error(
        'This browser does not support live microphone lessons. Try a current Safari, Chrome or Edge browser.',
      );
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }

  async function boot() {
    secrets = await vault.load();
    ready = true;
    if (!connected()) {
      sync = null;
      lesson = null;
      info = null;
      safeRender();
      return;
    }
    try {
      store = createGitHubStore({
        token: secrets.githubToken,
        owner: secrets.owner || CONFIG.owner,
        repo: secrets.repo || CONFIG.repo,
        branch: secrets.branch || CONFIG.branch,
      });
    } catch (e) {
      toast(e.message);
      return;
    }
    sync = createSync({ store, local, onChange: onSyncChange });
    lesson = createLessonController({
      store,
      local,
      getSecrets: () => secrets,
      getSettings: () => sync.settings,
      getNotebook: () => getState(),
      getLessons: () => sync.lessons,
      connect: connectRealtime,
      notes: generateNotes,
      getMic,
      onUpdate: onLessonUpdate,
    });
    await sync.load();
    target = sync.settings.minutes;
    model = sync.settings.model;
    info = overview();
    registerServiceWorker();
    safeRender();
    await recoverPending();
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || location.protocol !== 'https:') return;
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  async function recoverPending() {
    if (!lesson || !lesson.pending() || recovering) return;
    recovering = true;
    safeRender();
    try {
      const recovered = await lesson.recover();
      if (recovered?.saved) {
        sync.adopt({ notebook: recovered.notebook, shas: recovered.shas });
        lastSaved = local.read(KEYS.lastLesson);
        toast('Your last session was saved.');
      } else if (recovered?.discarded) toast('An empty session from last time was cleared.');
    } catch (e) {
      toast('Your last session still needs saving: ' + e.message);
    } finally {
      recovering = false;
      info = overview();
      safeRender();
    }
  }

  // ---- lesson controller events -------------------------------------------------
  function setMessage(text) {
    message = text;
    const el = document.getElementById('voice-message');
    if (el) el.textContent = text;
  }
  function onLessonUpdate(type, payload) {
    switch (type) {
      case 'connecting':
        phase = 'connecting';
        message = 'Connecting your microphone and saved notebook…';
        transcript = [];
        elapsed = 0;
        sessionUSD = 0;
        checkpoints = 0;
        muted = false;
        step = null;
        liveScore = null;
        result = null;
        safeRender();
        break;
      case 'step':
        step = payload.name;
        liveScore = payload.score || liveScore;
        safeRender();
        break;
      case 'journal':
        sync.adopt({ notebook: payload.notebook, shas: payload.shas });
        break;
      case 'audio':
        attachAudio(payload.stream);
        break;
      case 'started':
        phase = 'active';
        started = Date.now();
        target = payload.targetMinutes;
        step = payload.step;
        message = 'Answer out loud. Say “hint”, “again” or “finish here” at any time.';
        clearInterval(timer);
        timer = setInterval(updateMetrics, 1000);
        navigator.wakeLock
          ?.request('screen')
          .then((w) => (wake = w))
          .catch(() => {});
        safeRender();
        break;
      case 'metrics':
        sessionUSD = payload.usd;
        checkpoints = payload.checkpoints;
        elapsed = payload.elapsedSeconds;
        target = payload.targetMinutes;
        liveScore = payload.score || liveScore;
        updateMetrics();
        break;
      case 'checkpoint':
        checkpoints = payload.checkpoints;
        sessionUSD = payload.usd;
        liveScore = payload.score || liveScore;
        transcript.push({
          speaker: payload.attempt.pt,
          text: `${payload.attempt.result.replaceAll('_', ' ')}${payload.attempt.note ? ' · ' + payload.attempt.note : ''}`,
        });
        updateMetrics();
        updateTranscript();
        break;
      case 'transcript':
        transcript.push({ speaker: payload.speaker, text: payload.text });
        updateTranscript();
        break;
      case 'target': {
        target = payload.minutes;
        const el = document.getElementById('voice-target');
        if (el)
          el.textContent = `Target: ${Math.ceil(target)} minutes · say “keep going” or “finish here”.`;
        break;
      }
      case 'notice':
        setMessage(payload.message);
        toast(payload.message);
        break;
      case 'listening':
        setMessage('Listening…');
        break;
      case 'tutor_speaking':
        setMessage('Your tutor is speaking…');
        break;
      case 'ready_to_finish':
        setMessage('Wrapping up. Your session saves in a moment.');
        break;
      case 'finishing':
        phase = 'finishing';
        message = 'Saving your session…';
        clearInterval(timer);
        timer = null;
        safeRender();
        break;
      case 'saved':
        phase = 'complete';
        sync.adopt({ notebook: payload.notebook, shas: payload.shas });
        lastSaved = local.read(KEYS.lastLesson);
        checkpoints = payload.checkpoints;
        sessionUSD = payload.usd;
        liveScore = payload.score;
        result = {
          id: payload.id,
          mode: payload.mode,
          score: payload.score,
          summary: payload.record?.summary || null,
        };
        fb = { good: false, tags: new Set(), note: '', sent: false };
        message = `${scoreLine(payload.score)}. Progress saved.`;
        cleanup();
        void sync.refresh();
        safeRender();
        break;
      case 'discarded':
        phase = 'idle';
        message = 'Nothing was practised, so nothing was added to your progress.';
        cleanup();
        safeRender();
        break;
      case 'failure':
        phase = 'error';
        message = 'Your checkpoints are kept on this device. Use “Retry saving” below.';
        cleanup();
        safeRender();
        break;
      case 'error':
        phase = 'error';
        message = payload.message;
        cleanup();
        safeRender();
        break;
      case 'cancelled':
        phase = 'idle';
        message = '';
        cleanup();
        safeRender();
        break;
    }
  }
  function attachAudio(stream) {
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.setAttribute('playsinline', '');
      document.body.appendChild(audio);
    }
    audio.srcObject = stream;
    audio.play().catch(() => {
      const el = document.getElementById('audio-unlock');
      if (el) el.hidden = false;
    });
  }
  function cleanup() {
    clearInterval(timer);
    timer = null;
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
      audio = null;
    }
    wake?.release().catch(() => {});
    wake = null;
  }
  function updateMetrics() {
    if (started && phase === 'active') elapsed = Math.floor((Date.now() - started) / 1000);
    const values = {
      'voice-time': clock(elapsed),
      'voice-score': liveScore?.asked ? `${liveScore.unaided}/${liveScore.asked}` : '—',
      'voice-cost': money(sessionUSD * fx()),
    };
    for (const [id, value] of Object.entries(values)) {
      const e = document.getElementById(id);
      if (e) e.textContent = value;
    }
  }
  function updateTranscript() {
    const el = document.getElementById('voice-transcript');
    if (el) el.innerHTML = transcriptBody();
    else safeRender();
  }

  // ---- actions -------------------------------------------------------------------
  async function start() {
    if (!lesson || lesson.active || phase === 'connecting') return;
    if (!configured()) {
      toast('Add your OpenAI API key in Connection settings first.');
      navigate('setup');
      return;
    }
    if (sync.pendingSave) await sync.flush();
    if (sync.status !== 'saved') {
      toast('Sync your notebook before starting a session.');
      return;
    }
    stopAudio();
    navigate('voice');
    try {
      await lesson.start({ minutes: target, model, mode });
    } catch (e) {
      toast(e.message);
    }
  }
  async function finish() {
    if (!lesson) return;
    if (phase === 'connecting') {
      lesson.cancel();
      setMessage('Cancelling connection…');
      return;
    }
    try {
      await lesson.finish();
    } catch (e) {
      toast(e.message);
    }
  }
  async function retrySummary(el) {
    if (!lesson?.pending()) return;
    el.disabled = true;
    await recoverPending();
  }
  function downloadDraft() {
    const data = sync?.draft?.state || local.read(KEYS.notebook)?.state || getState();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    a.download = 'Fala-preserved-notebook.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function save() {
    if (!sync) {
      toast('Connect your GitHub repository first so notes can be saved.');
      return Promise.resolve(false);
    }
    return sync.save(getState());
  }
  async function refresh() {
    if (!sync) return;
    await sync.refresh();
    info = overview();
    safeRender();
  }

  async function checkOpenAI(key) {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(12000),
    });
    if (res.status === 401) throw new Error('OpenAI rejected that API key.');
    if (!res.ok) throw new Error(`OpenAI returned ${res.status} while checking the key.`);
    const data = await res.json();
    return (data.data || []).map((m) => m.id);
  }

  async function connect(form) {
    const values = Object.fromEntries(
      [...new FormData(form)].map(([k, v]) => [k, String(v).trim()]),
    );
    const merged = {
      owner: values.owner || CONFIG.owner,
      repo: values.repo || CONFIG.repo,
      branch: values.branch || CONFIG.branch,
      githubToken: values.githubToken || secrets?.githubToken || '',
      openaiKey: values.openaiKey || secrets?.openaiKey || '',
    };
    if (!merged.githubToken) {
      setupStatus = { text: 'A GitHub token is needed to open your notebook.', kind: 'bad' };
      safeRender();
      return;
    }
    setupStatus = { text: 'Checking GitHub…', kind: '' };
    safeRender();
    const notes = [];
    try {
      const probe = createGitHubStore({
        token: merged.githubToken,
        owner: merged.owner,
        repo: merged.repo,
        branch: merged.branch,
      });
      const v = await probe.verify();
      const nb = await probe.readJson(FILES.notebook);
      notes.push(
        `Connected to ${v.fullName}${v.isPrivate ? ' (private)' : ' — WARNING: this repository is public'}.`,
      );
      notes.push(
        nb.data
          ? `Notebook found with ${nb.data.lessons?.length || 0} lessons.`
          : 'No notebook yet; restore a backup after connecting.',
      );
      if (merged.openaiKey) {
        setupStatus = { text: notes.join(' ') + ' Checking OpenAI…', kind: '' };
        safeRender();
        try {
          const models = await checkOpenAI(merged.openaiKey);
          const missing = [...VOICE_MODELS, NOTES_MODEL].filter((m) => !models.includes(m));
          notes.push(
            missing.length
              ? `OpenAI key accepted, but these configured models are not listed for your project: ${missing.join(', ')}. Voice may fail until the model IDs are updated.`
              : 'OpenAI key accepted and the configured models are available.',
          );
        } catch (e) {
          if (/rejected/.test(e.message)) throw e;
          notes.push('OpenAI could not be checked right now; the key was saved anyway.');
        }
      } else
        notes.push('No OpenAI key yet: the notebook works, voice lessons wait until you add one.');
      await vault.save(merged);
      secrets = merged;
      setupStatus = { text: notes.join(' '), kind: 'ok' };
      toast('Connection saved on this device.');
      await boot();
      navigate('overview');
    } catch (e) {
      setupStatus = { text: [...notes, e.message].join(' '), kind: 'bad' };
      safeRender();
    }
  }

  async function disconnect() {
    if (lesson?.pending()) {
      toast(
        'Finish or retry your last lesson before forgetting the keys, so its checkpoints are not lost.',
      );
      return;
    }
    if (!confirm('Forget the GitHub token, OpenAI key and cached notebook on this device?')) return;
    await vault.clear();
    for (const key of Object.values(KEYS)) local.remove(key);
    secrets = null;
    sync = null;
    lesson = null;
    store = null;
    info = null;
    setupStatus = { text: 'Keys removed from this device.', kind: '' };
    setState(null);
    navigate('setup');
  }

  // ---- templates -----------------------------------------------------------------
  function updateSyncLabel() {
    document.querySelectorAll('[data-sync-label]').forEach((e) => (e.textContent = syncLabel()));
  }
  function syncLabel() {
    return sync ? sync.label() : 'Not connected';
  }
  function syncBanner() {
    if (!sync) return '';
    const s = sync.status;
    if (s === 'conflict')
      return `<div class="voice-notice warning" role="status"><div><strong>Your notebook changed elsewhere</strong><p>${esc(sync.problem)}</p></div><div class="voice-actions">${button('Download local draft', 'download-draft')}${button('Use saved notebook', 'use-cloud')}</div></div>`;
    if (s === 'offline')
      return `<div class="voice-notice warning" role="status"><div><strong>Notebook sync needs attention</strong><p>${esc(sync.problem)}</p></div><div class="voice-actions">${button('Download local draft', 'download-draft')}${button('Retry sync', 'retry-sync')}</div></div>`;
    if (s === 'empty')
      return `<div class="voice-notice warning" role="status"><div><strong>No notebook in the repository yet</strong><p>${esc(sync.problem)} Use Backup &amp; data → Restore a backup, or run <code>npm run import</code> with your backup file.</p></div></div>`;
    if (s === 'error')
      return `<div class="voice-notice warning" role="status"><div><strong>Notebook needs attention</strong><p>${esc(sync.problem)}</p></div><div class="voice-actions">${button('Retry', 'retry-sync')}${button('Connection settings', 'go-setup')}</div></div>`;
    return '';
  }
  function setupNotice() {
    if (!sync) return '';
    return info && !info.configured
      ? `<div class="voice-notice"><div><strong>One key before your first voice lesson</strong><p>Your notebook is connected. Add an OpenAI API key in Connection settings to switch on live voice. Never paste your API key into a lesson or chat.</p></div><div class="voice-actions">${button('Connection settings', 'go-setup')}</div></div>`
      : '';
  }
  function dashboard() {
    const count = info?.lessons || 0,
      budget = info?.settings.budgetAud || 60,
      spend = info?.aud || 0;
    const last = info?.sessions.find((s) => s.status !== 'error');
    const display = info ? money(spend) : '—';
    return `<section class="voice-dashboard" aria-label="Voice lessons and API costs"><div class="voice-launch"><div class="eyebrow">YOUR DAILY CONVERSATION</div><h1>Let’s speak Portuguese.</h1><p>Short questions, straight answers. What you get right and wrong decides what comes next.</p><div class="voice-actions">${button(lesson?.active ? 'Return to your lesson' : 'Open voice lesson', 'open', 'primary')}${button('Quick phrase review', 'review')}</div><span class="voice-meta">${info?.configured ? 'Voice connected · progress tracked as you speak' : 'Voice setup pending'} · ${esc(modelName(info?.settings.model || model))}</span></div><div class="cost-card"><div class="cost-heading"><h2>API cost tracker</h2>${button('Details', 'costs', 'text')}</div><div class="cost-value">${display}<span>AUD estimated this month</span></div><div class="cost-track" role="progressbar" aria-label="Monthly API budget" aria-valuemin="0" aria-valuemax="${budget}" aria-valuenow="${Math.min(budget, spend)}"><i style="width:${Math.min(100, (spend / budget) * 100)}%"></i></div><div class="cost-budget"><span>${money(budget)} monthly budget</span><span>${info ? money(Math.max(0, budget - spend)) : '—'} left</span></div><div class="cost-mini"><div><strong>${count}</strong><span>lessons</span></div><div><strong>${info ? Math.round(info.minutes) : '—'}</strong><span>minutes</span></div><div><strong>${last ? money(last.usd * fx()) : '—'}</strong><span>latest lesson</span></div></div><p class="cost-caption">${info?.incomplete ? 'Some usage is incomplete; this total may be understated.' : 'Calculated from API usage. Excludes tax and hosting.'}</p></div></section>${syncBanner()}${setupNotice()}${recoveries()}${challengeStrip()}`;
  }
  function recoveries() {
    if (!lesson) return '';
    const rec = lesson.pending();
    if (!rec || lesson.active) return '';
    if (recovering)
      return `<div class="voice-notice info"><div><strong>Saving your last session</strong><p>Working from the checkpoints kept on this device…</p></div></div>`;
    return `<div class="voice-notice warning"><div><strong>Your last session still needs saving</strong><p>${esc(rec.error || 'Saved practice checkpoints are retained on this device. Finish this entry before starting another lesson.')}</p><p class="recovery-detail">${rec.attempts.length} saved checkpoints · started ${esc(new Date(rec.started).toLocaleString('en-AU'))}</p></div>${button('Retry saving', 'retry-summary')}</div>`;
  }
  function transcriptBody() {
    return transcript.length
      ? `<h2>Saved along the way</h2><p>Practice notes are the tutor’s assessment; unclear speech stays unverified.</p><ol>${transcript
          .slice(-8)
          .map((t) => `<li><strong>${esc(t.speaker)}</strong><span>${esc(t.text)}</span></li>`)
          .join('')}</ol>`
      : '';
  }
  function resultPanel() {
    if (phase !== 'complete' || !result) return '';
    const s = result.summary;
    const detail = s
      ? `<p><strong>Went well:</strong> ${esc(s.mastered)}</p><p><strong>Keep practising:</strong> ${esc(s.mistakes)}</p>`
      : '';
    const chips = Object.entries(FEEDBACK_TAGS)
      .map(
        ([id, label]) =>
          `<button class="chip ${fb.tags.has(id) ? 'on' : ''}" data-voice="fb-tag" data-tag="${id}" aria-pressed="${fb.tags.has(id)}">${label}</button>`,
      )
      .join('');
    const feedback = fb.sent
      ? '<p class="voice-small">Thanks. Your tutor will be told at the start of the next session.</p>'
      : `<div class="feedback-box"><strong>How was that session?</strong><div class="feedback-tags"><button class="chip ${fb.good ? 'on' : ''}" data-voice="fb-good" aria-pressed="${fb.good}">Good</button>${chips}</div><input id="fb-note" type="text" maxlength="240" placeholder="Anything else? Optional." value="${esc(fb.note)}" aria-label="Feedback note">${button('Send feedback', 'fb-send', 'small')}</div>`;
    return `<div class="session-result"><h3>${esc(scoreLine(result.score))}</h3>${detail}${feedback}</div>`;
  }
  function page() {
    const active = ['connecting', 'active', 'finishing'].includes(phase);
    const state = getState();
    const settings = sync?.settings || DEFAULT_SETTINGS;
    const canStart =
      !!info?.configured && sync?.status === 'saved' && !lesson?.pending() && !recovering;
    const modes = Object.entries(MODES)
      .map(
        ([id, m]) =>
          `<button class="mode ${mode === id ? 'active' : ''}" data-voice="mode" data-mode="${id}" aria-pressed="${mode === id}" ${active ? 'disabled' : ''}><strong>${m.label}</strong><span>${m.blurb}</span></button>`,
      )
      .join('');
    const option = (value, label, current) =>
      `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`;
    const label =
      phase === 'active'
        ? muted
          ? 'MICROPHONE MUTED'
          : STEP_LABEL[step] || 'LISTEN · THINK · SPEAK'
        : IDLE_LABEL[phase];
    const heading = active
      ? clock(elapsed)
      : phase === 'complete'
        ? 'Até a próxima, Dan.'
        : 'Out loud, at your pace.';
    const controls = active
      ? phase === 'active'
        ? button(muted ? 'Unmute microphone' : 'Mute microphone', 'mute') +
          button('Finish & save', 'finish', 'primary')
        : button(phase === 'connecting' ? 'Cancel connection' : 'Close audio', 'finish')
      : button(
          phase === 'complete' ? 'Start another' : `Start ${MODES[mode].label.toLowerCase()}`,
          'start',
          'primary',
          canStart ? '' : 'disabled',
        );
    const score = liveScore?.asked ? `${liveScore.unaided}/${liveScore.asked}` : '—';
    const preview =
      state && sync
        ? planPreview(state, sync.practice, { mode, minutes: Math.round(target) })
        : '<p class="subtle">Your plan appears once the notebook has loaded.</p>';
    return `<div class="page-heading"><div><h1>Speak.</h1><p>Short questions, straight answers. What you get right and wrong is recorded as you go and decides what comes next.</p></div></div>${syncBanner()}${setupNotice()}${recoveries()}<section class="voice-room" aria-label="Voice session"><div class="voice-controls"><div class="mode-picker" role="group" aria-label="Session type">${modes}</div><div class="voice-fields"><label>Time available<select id="voice-duration" ${active ? 'disabled' : ''}>${[5, 10, 15, 20, 30, 45, 55].map((n) => option(n, `${n} minutes`, Math.round(target))).join('')}</select></label><label>Reply speed<select id="voice-pace" ${active ? 'disabled' : ''}>${option('quick', 'Quick', settings.pace)}${option('balanced', 'Balanced', settings.pace)}${option('patient', 'Patient · longer pauses', settings.pace)}</select></label></div><div class="voice-stage ${phase === 'active' ? 'is-active' : ''}"><div class="voice-mic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="8" y="2" width="8" height="13" rx="4"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg></div><span class="eyebrow" id="voice-phase">${label}</span><h2 id="voice-time">${heading}</h2><p id="voice-message" role="status">${esc(message || (info?.configured ? 'Your microphone turns on when you start.' : 'Voice is waiting for its OpenAI key.'))}</p><div class="voice-actions primary-controls">${controls}</div>${phase === 'active' ? `<div class="voice-actions">${button('+5 minutes', 'extend')}${button('Finish in 2 minutes', 'shorten')}</div>` : ''}<div class="voice-session-stats"><span><b id="voice-score">${score}</b> without help</span><span><b id="voice-cost">${money(sessionUSD * fx())}</b> estimated</span></div><p class="voice-small" id="voice-target">${active ? `Target: ${Math.ceil(target)} minutes · say “keep going” or “finish here”.` : 'Start while parked. Keep this page open during the session.'}</p><div id="audio-unlock" hidden>${button('Tap to hear tutor', 'unlock-audio')}</div></div>${resultPanel()}<details class="usage-settings"><summary>More options</summary><div class="voice-fields"><label>Voice model<select id="voice-model" ${active ? 'disabled' : ''}>${VOICE_MODELS.map((m) => option(m, `${modelName(m)}${m.endsWith('-mini') ? ' · lower cost' : ''}`, model)).join('')}</select></label><label>Where is the phone?<select id="voice-mic" ${active ? 'disabled' : ''}>${option('near', 'Close to me', settings.mic)}${option('far', 'On the dash or speaker', settings.mic)}</select></label></div><label class="check"><input type="checkbox" id="voice-recap" ${settings.recap ? 'checked' : ''} ${active ? 'disabled' : ''}> Write a journal entry after each lesson</label><p class="voice-small">Off by default. Progress is tracked either way, and any session can be written up later from Progress &amp; history.</p></details></div><aside class="voice-lesson-notes"><div class="eyebrow">${active ? 'STEER WITH YOUR VOICE' : 'THIS SESSION WILL COVER'}</div>${active ? '<div class="voice-rule"><p>“Hint.”<br>“Again.”<br>“Slow down.”<br>“Skip.”<br>“Five minutes left.”<br>“Finish here.”</p></div>' : preview}<div class="voice-rule"><strong>Notes for your tutor</strong><textarea id="tutor-notes" rows="3" maxlength="400" placeholder="For example: I’m visiting São Paulo in March, so café and taxi phrases matter most." ${active ? 'disabled' : ''}>${esc(state?.tutorNotes || '')}</textarea>${button('Save note', 'save-tutor-notes', 'small', active ? 'disabled' : '')}</div><p class="voice-small">Audio goes directly from this device to OpenAI. Fala keeps what you got right and wrong, not recordings. The microphone stops if the phone locks.</p></aside></section><section class="panel voice-transcript" id="voice-transcript" ${transcript.length ? '' : 'hidden'}>${transcriptBody()}</section>`;
  }
  function progressPage() {
    return renderProgress({
      notebook: getState(),
      practice: sync?.practice || [],
      lessons: sync?.lessons || [],
      fx: fx(),
      open: openSession,
      loaded: said,
      busy: busyAction,
    });
  }
  // Shown on the Next lesson screen: the plan the tutor will actually follow.
  function planPanel() {
    const state = getState();
    if (!state || !sync) return '';
    return `<section class="panel panel-body plan-panel"><div class="section-head"><h2>Your next lesson, from your practice record</h2>${button('Open voice', 'open', 'small')}</div>${planPreview(state, sync.practice, { mode: 'lesson', minutes: Math.round(target) })}<p class="voice-small">Worked out from every recorded attempt: phrases you missed and phrases not tested for longest come first. It updates itself after each session.</p></section>`;
  }
  function challengeStrip() {
    const state = getState();
    if (!state || !sync) return '';
    return `<section class="challenge-strip"><div class="section-head"><h2>Challenges</h2>${button('Progress &amp; history', 'go-progress', 'text')}</div>${challengeCards(state, sync.practice, sync.lessons, Date.now(), 3)}</section>`;
  }
  async function sendFeedback(el) {
    if (!result || !sync) return;
    el.disabled = true;
    const tags = [...fb.tags];
    const feedback = {
      rating: tags.length ? 'issues' : fb.good ? 'good' : 'none',
      tags,
      note: fb.note.trim(),
      at: Date.now(),
    };
    await sync.saveFeedback(result.id, feedback);
    fb.sent = true;
    const tip = tags.includes('cut_off')
      ? ' Tip: set Reply speed to Balanced.'
      : tags.includes('too_slow') && sync.settings.pace !== 'quick'
        ? ' Tip: set Reply speed to Quick.'
        : '';
    toast('Feedback saved.' + tip);
    safeRender();
  }
  async function showSaid(id) {
    const entry = sync?.lessons.find((l) => l.id === id);
    if (!entry || !store) return;
    busyAction = 'said:' + id;
    safeRender();
    try {
      const file = await store.readJson(entry.file);
      said[id] = (file.data?.transcript || [])
        .filter((t) => t.text)
        .map(({ speaker, text }) => ({ speaker, text }));
    } finally {
      busyAction = '';
      safeRender();
    }
  }
  async function writeUp(id) {
    if (!lesson) return;
    busyAction = 'write:' + id;
    safeRender();
    try {
      await lesson.writeUp(id);
      await sync.refresh();
      toast('Journal entry written. It is in the Lesson journal.');
    } finally {
      busyAction = '';
      safeRender();
    }
  }
  async function saveTutorNotes() {
    const state = getState();
    const field = document.getElementById('tutor-notes');
    if (!state || !field) return;
    const next = structuredClone(state);
    next.tutorNotes = field.value.trim().slice(0, 400);
    next.updatedAt = new Date().toISOString();
    setState(next);
    await save();
    toast('Your tutor will keep that in mind.');
  }
  function costs(full = true) {
    const s = info?.settings || DEFAULT_SETTINGS;
    return `${full ? '<div class="page-heading"><div><h1>Your API costs</h1><p>Voice lessons and automatic notes, tracked together.</p></div></div>' : ''}<section class="panel usage-panel"><div class="cost-heading"><h2>${esc(info?.period || 'This month')}</h2>${button('Refresh costs', 'refresh', 'small')}</div><div class="usage-totals"><div><span>Estimated API spend</span><strong>${info ? money(info.aud) : '—'} AUD</strong></div><div><span>Original USD amount</span><strong>${info ? money(info.usd, 'USD') : '—'} USD</strong></div><div><span>Lesson time</span><strong>${Math.round(info?.minutes || 0)} minutes</strong></div></div>${info?.incomplete ? '<div class="voice-notice warning">Some API usage could not be confirmed after an interruption. The total may be understated; check the OpenAI billing dashboard for the final charge.</div>' : ''}<p class="voice-small">Estimates use API-reported tokens, including cached context and note generation. Rates dated 16 September 2026 (${esc(info?.pricingVersion || '')}). USD is the billing currency; the AUD conversion is an estimate dated ${esc(s.fxDate)}. Tax, hosting and activity outside Fala are excluded. <a href="https://platform.openai.com/usage" target="_blank" rel="noopener">OpenAI usage dashboard</a></p><details class="usage-settings"><summary>Budget &amp; currency settings</summary><form id="cost-settings"><div class="voice-fields"><label>Monthly API budget (AUD)<input name="budgetAud" type="number" min="5" max="500" step="1" value="${s.budgetAud}" required></label><label>AUD per US$1<input name="usdToAud" type="number" min="0.1" max="10" step="0.0001" value="${Number(s.usdToAud).toFixed(4)}" required></label></div><p class="voice-small">Fala checks this estimated budget before starting and during lessons. A response already in progress and the final notes can take it slightly over the limit. Set a hard monthly limit on the OpenAI project as well; this does not cap other API activity.</p><button class="btn" type="submit" ${sync ? '' : 'disabled'}>Save cost settings</button><span id="cost-settings-status" role="status"></span></form></details><div class="usage-table-wrap"><table class="usage-table"><thead><tr><th>Lesson</th><th>Model</th><th>Status</th><th>USD</th><th>AUD estimate</th></tr></thead><tbody>${info?.sessions.length ? info.sessions.map((l) => `<tr><td>${esc(new Date(l.started).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }))}</td><td>${esc(modelName(l.model))}</td><td>${esc(l.status === 'error' ? 'Connection failed' : l.summary_status !== 'saved' ? 'Summary pending' : l.status)}${l.usage_incomplete ? ' · partial usage' : ''}</td><td>${money(l.usd, 'USD')}</td><td>${money(l.usd * s.usdToAud)}</td></tr>`).join('') : '<tr><td colspan="5">No API lessons yet. Your earlier lesson logs are preserved and have no Fala API charges.</td></tr>'}</tbody></table></div></section>`;
  }
  function setupPage() {
    const s = secrets || {};
    const status = setupStatus.text
      ? `<div class="setup-status ${setupStatus.kind}" role="status">${esc(setupStatus.text)}</div>`
      : '<div class="setup-status" role="status"></div>';
    return `<div class="page-heading"><div><h1>${connected() ? 'Connection' : 'Welcome to Fala.'}</h1><p>${connected() ? 'Your notebook lives in your private GitHub repository. Keys stay on this device.' : 'Connect the private repository that holds your notebook. Nothing is stored on a server: keys stay on this device, notes live in your repository.'}</p></div></div><div class="setup-wrap">${
      connected()
        ? `<div class="setup-card"><div class="connected-strip"><span>Repository <b>${esc(s.owner)}/${esc(s.repo)}</b> · branch <b>${esc(s.branch)}</b></span><span>GitHub token <b>saved</b></span><span>OpenAI key <b>${s.openaiKey ? 'saved' : 'not added'}</b></span><span data-sync-label>${esc(syncLabel())}</span><span>App version <b>${esc(CONFIG.appVersion)}</b></span></div></div>`
        : ''
    }<form id="setup-form" class="setup-card" autocomplete="off"><h2>${connected() ? 'Update the connection' : 'Connect your notebook'}</h2><p>Paste a token or key only into this screen, never into a lesson or a chat.</p><div class="form-grid"><div class="field"><label for="setup-owner">GitHub owner</label><input id="setup-owner" name="owner" value="${esc(s.owner || CONFIG.owner)}" required></div><div class="field"><label for="setup-repo">Repository</label><input id="setup-repo" name="repo" value="${esc(s.repo || CONFIG.repo)}" required></div><div class="field"><label for="setup-branch">Branch</label><input id="setup-branch" name="branch" value="${esc(s.branch || CONFIG.branch)}" required></div><div class="field full"><label for="setup-github">GitHub fine-grained token</label><input id="setup-github" name="githubToken" type="password" autocomplete="off" spellcheck="false" placeholder="${s.githubToken ? 'Saved on this device · paste a new one to replace it' : 'github_pat_…'}" ${s.githubToken ? '' : 'required'}><small>GitHub → Settings → Developer settings → Personal access tokens → Fine-grained. Repository access: only this repository. Permission: Contents, Read and write.</small></div><div class="field full"><label for="setup-openai">OpenAI API key</label><input id="setup-openai" name="openaiKey" type="password" autocomplete="off" spellcheck="false" placeholder="${s.openaiKey ? 'Saved on this device · paste a new one to replace it' : 'sk-…'}"><small>platform.openai.com → API keys, inside a project that has a monthly spending limit set. Optional until your first voice lesson.</small></div></div><div class="modal-actions"><button class="btn primary" type="submit">Test &amp; save on this device</button>${connected() ? button('Forget keys on this device', 'disconnect') : ''}</div>${status}</form><div class="info-box"><strong>How this stays private.</strong><br>Both secrets are encrypted with a key that never leaves this browser and are only ever sent to api.github.com and api.openai.com. If you lose the device, revoke the token on GitHub and the key on OpenAI. On iPhone, add Fala to the Home Screen so Safari does not clear its storage after a week without use.</div><ol class="setup-steps"><li>Create the private repository <code>${esc(CONFIG.owner)}/${esc(CONFIG.repo)}</code> if it does not exist and push this app to it.</li><li>Create the fine-grained token for that one repository with Contents: Read and write.</li><li>Create an OpenAI project with a monthly budget, then an API key in it.</li><li>Paste both here, on each device you use.</li></ol></div>`;
  }

  // ---- DOM events ----------------------------------------------------------------
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-voice]');
    if (!el) return;
    e.preventDefault();
    const action = el.dataset.voice;
    try {
      if (action === 'open') navigate('voice');
      else if (action === 'review') onReview();
      else if (action === 'costs') navigate('costs');
      else if (action === 'go-setup') navigate('setup');
      else if (action === 'start') await start();
      else if (action === 'finish') await finish();
      else if (action === 'mute') {
        muted = !muted;
        lesson?.setMuted(muted);
        safeRender();
      } else if (action === 'extend' || action === 'shorten') {
        if (!lesson?.active) return;
        const result =
          action === 'shorten'
            ? lesson.setTime(2, 'remaining')
            : lesson.setTime(Math.min(55, Math.ceil(Math.max(target, elapsed / 60)) + 5), 'total');
        toast(`Target is now ${Math.ceil(result.targetMinutes)} minutes.`);
      } else if (action === 'refresh') await refresh();
      else if (action === 'download-draft') downloadDraft();
      else if (action === 'use-cloud') {
        downloadDraft();
        sync?.useRemote();
      } else if (action === 'retry-sync') {
        if (sync) {
          await sync.retry();
          await refresh();
        }
      } else if (action === 'unlock-audio') {
        await audio?.play();
        document.getElementById('audio-unlock').hidden = true;
      } else if (action === 'retry-summary') await retrySummary(el);
      else if (action === 'go-progress') navigate('progress');
      else if (action === 'mode') {
        if (lesson?.active || !MODES[el.dataset.mode]) return;
        mode = el.dataset.mode;
        safeRender();
      } else if (action === 'fb-good') {
        fb.good = !fb.good;
        if (fb.good) fb.tags.clear();
        safeRender();
      } else if (action === 'fb-tag') {
        const tag = el.dataset.tag;
        if (fb.tags.has(tag)) fb.tags.delete(tag);
        else fb.tags.add(tag);
        fb.good = false;
        safeRender();
      } else if (action === 'fb-send') await sendFeedback(el);
      else if (action === 'toggle-session') {
        openSession = openSession === el.dataset.id ? null : el.dataset.id;
        safeRender();
      } else if (action === 'show-said') await showSaid(el.dataset.id);
      else if (action === 'write-up') await writeUp(el.dataset.id);
      else if (action === 'save-tutor-notes') await saveTutorNotes();
      else if (action === 'disconnect') await disconnect();
    } catch (err) {
      toast(err.message);
      el.disabled = false;
    }
  });
  document.addEventListener('change', async (e) => {
    if (e.target.id === 'voice-duration') {
      target = Number(e.target.value);
      try {
        await sync?.saveSettings({ minutes: target });
      } catch (err) {
        toast(err.message);
      }
    }
    if (e.target.id === 'voice-model') {
      model = e.target.value;
      try {
        await sync?.saveSettings({ model });
      } catch (err) {
        toast(err.message);
      }
    }
    const setting = { 'voice-pace': 'pace', 'voice-mic': 'mic' }[e.target.id];
    if (setting || e.target.id === 'voice-recap') {
      try {
        await sync?.saveSettings(
          setting ? { [setting]: e.target.value } : { recap: e.target.checked },
        );
      } catch (err) {
        toast(err.message);
      }
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'fb-note') fb.note = e.target.value;
  });
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'setup-form') {
      e.preventDefault();
      if (!e.target.reportValidity()) return;
      await connect(e.target);
      return;
    }
    if (e.target.id !== 'cost-settings') return;
    e.preventDefault();
    const form = e.target;
    if (!form.reportValidity() || !sync) return;
    const values = new FormData(form);
    const submit = form.querySelector('button');
    submit.disabled = true;
    try {
      const fxValue = Number(values.get('usdToAud'));
      await sync.saveSettings({
        budgetAud: Number(values.get('budgetAud')),
        usdToAud: fxValue,
        fxDate:
          Math.abs(fxValue - sync.settings.usdToAud) > 0.0001
            ? new Date().toISOString().slice(0, 10)
            : sync.settings.fxDate,
      });
      info = overview();
      toast('Cost settings saved.');
      safeRender();
    } catch (err) {
      toast(err.message);
      submit.disabled = false;
    }
  });
  window.addEventListener('online', () => {
    if (sync?.pendingSave) void sync.flush();
  });
  window.addEventListener('pagehide', () => {
    if (lesson?.active) void lesson.finish();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && sync && !lesson?.active) void refresh();
  });

  return {
    boot,
    save,
    dashboard,
    page,
    costs,
    progressPage,
    planPanel,
    setupPage,
    syncLabel,
    syncBanner,
    refresh,
    get connected() {
      return connected();
    },
    get ready() {
      return ready;
    },
    get version() {
      return CONFIG.appVersion;
    },
    get active() {
      return !!lesson?.active;
    },
    get syncStatus() {
      return sync?.status || 'disconnected';
    },
  };
}

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
const DRAFT = 'fala-cloud-draft-v2',
  LEGACY = 'fala-pre-cloud-backup-v2',
  SYNCED = 'fala-cloud-revision-v2';
const read = (k) => {
  try {
    return JSON.parse(localStorage.getItem(k));
  } catch {
    return null;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
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
  let info = null,
    revision = 0,
    sync = 'loading',
    problem = '',
    draft = read(DRAFT),
    saving = null,
    queued = null,
    conflict = null;
  let session = null,
    phase = 'idle',
    message = '',
    transcript = [],
    pc = null,
    ws = null,
    dc = null,
    mic = null,
    audio = null,
    wake = null;
  let timer = null,
    pollTimer = null,
    started = 0,
    elapsed = 0,
    sessionUSD = 0,
    checkpoints = 0,
    muted = false,
    finishing = false,
    target = 20,
    model = 'gpt-realtime-2.1';
  let audioPlaying = false,
    endAfterAudio = false,
    audioEndTimer = null;
  const safeRender = () => {
    if (!document.querySelector('dialog[open]')) render();
  };
  async function api(path, method = 'GET', data) {
    const res = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(25000),
    });
    const result = await res
      .json()
      .catch(() => ({ error: 'Could not reach your saved notebook.' }));
    if (!res.ok) {
      const e = new Error(result.error || 'Request failed');
      e.status = res.status;
      e.data = result;
      throw e;
    }
    return result;
  }
  async function boot() {
    try {
      const local = getState();
      if (!read(LEGACY)) write(LEGACY, local);
      const result = await api('/bootstrap', 'POST', { state: local });
      info = result;
      revision = result.revision;
      target = result.settings.minutes;
      model = result.settings.model;
      if (draft) {
        if (draft.revision === revision) {
          queued = draft.state;
          setState(draft.state);
          sync = 'saving';
          await flush();
        } else {
          conflict = result;
          sync = 'conflict';
          problem =
            'A local draft and the saved notebook differ. Your local draft is kept until you choose what to use.';
        }
      } else if (
        !read(SYNCED) &&
        local.updatedAt &&
        JSON.stringify(local) !== JSON.stringify(result.state)
      ) {
        draft = { state: local, revision: 0 };
        write(DRAFT, draft);
        conflict = result;
        sync = 'conflict';
        problem =
          'This device has earlier personal edits that differ from your saved notebook. Download them before choosing the saved version.';
      } else {
        setState(result.state);
        sync = 'saved';
        write(SYNCED, revision);
      }
    } catch (e) {
      sync = 'offline';
      problem = e.message;
    }
    safeRender();
  }
  function save() {
    queued = structuredClone(getState());
    draft = { state: queued, revision };
    write(DRAFT, draft);
    if (sync === 'conflict') return;
    sync = 'saving';
    void flush();
  }
  async function flush() {
    if (saving) return saving;
    if (sync === 'conflict') return false;
    saving = (async () => {
      while (queued) {
        const state = queued;
        queued = null;
        try {
          const result = await api('/notebook', 'PUT', { state, revision });
          revision = result.revision;
          write(SYNCED, revision);
          sync = 'saved';
          problem = '';
          if (queued) {
            draft = { state: queued, revision };
            write(DRAFT, draft);
          } else {
            draft = null;
            try {
              localStorage.removeItem(DRAFT);
            } catch {}
          }
        } catch (e) {
          queued = queued || state;
          draft = { state: queued, revision };
          write(DRAFT, draft);
          problem = e.message;
          sync = e.status === 409 ? 'conflict' : 'offline';
          conflict = e.status === 409 ? e.data : null;
          toast('Your draft is kept on this device. ' + e.message);
          return false;
        }
      }
      return true;
    })();
    const result = await saving;
    saving = null;
    updateSyncLabel();
    return result;
  }
  function updateSyncLabel() {
    document.querySelectorAll('[data-sync-label]').forEach((e) => (e.textContent = syncLabel()));
  }
  function syncLabel() {
    return {
      loading: 'Opening saved notebook…',
      saving: 'Saving notebook…',
      saved: 'Notebook synced',
      offline: 'Offline · local draft retained',
      conflict: 'Notebook conflict · draft retained',
    }[sync];
  }
  async function refresh() {
    try {
      info = await api('/usage');
      if (!session) {
        const n = await api('/notebook');
        if (n && sync === 'saved' && n.revision !== revision) {
          revision = n.revision;
          setState(n.state);
        }
      }
      problem = '';
      safeRender();
    } catch (e) {
      problem = e.message;
      safeRender();
    }
  }
  function syncBanner() {
    return ['offline', 'conflict'].includes(sync)
      ? `<div class="voice-notice warning" role="status"><div><strong>${sync === 'conflict' ? 'Your notebook changed elsewhere' : 'Notebook sync needs attention'}</strong><p>${esc(problem)}</p></div><div class="voice-actions">${button('Download local draft', 'download-draft')}${button(sync === 'conflict' ? 'Use saved notebook' : 'Retry sync', sync === 'conflict' ? 'use-cloud' : 'retry-sync')}</div></div>`
      : '';
  }
  function setupNotice() {
    return info && !info.configured
      ? `<div class="voice-notice"><div><strong>One connection before your first voice lesson</strong><p>An OpenAI API key still needs to be connected securely to this site. The notebook and cost tracker are ready; live voice starts once that connection is configured. Never paste your API key into a lesson or chat.</p></div></div>`
      : '';
  }
  function dashboard() {
    const count = info?.lessons || 0,
      budget = info?.settings.budgetAud || 60,
      spend = info?.aud || 0;
    const last = info?.sessions.find((s) => s.status !== 'error');
    const display = info ? money(spend) : '—';
    return `<section class="voice-dashboard" aria-label="Voice lessons and API costs"><div class="voice-launch"><div class="eyebrow">YOUR DAILY CONVERSATION</div><h1>Let’s speak Portuguese.</h1><p>Pick up your next priority. Finish early or keep going—your notes follow the lesson.</p><div class="voice-actions">${button(session ? 'Return to your lesson' : 'Open voice lesson', 'open', 'primary')}${button('Quick phrase review', 'review')}</div><span class="voice-meta">${info?.configured ? 'Voice connected · automatic lesson notes' : 'Voice setup pending'} · ${esc(modelName(info?.settings.model || model))}</span></div><div class="cost-card"><div class="cost-heading"><h2>API cost tracker</h2>${button('Details', 'costs', 'text')}</div><div class="cost-value">${display}<span>AUD estimated this month</span></div><div class="cost-track" role="progressbar" aria-label="Monthly API budget" aria-valuemin="0" aria-valuemax="${budget}" aria-valuenow="${Math.min(budget, spend)}"><i style="width:${Math.min(100, (spend / budget) * 100)}%"></i></div><div class="cost-budget"><span>${money(budget)} monthly budget</span><span>${info ? money(Math.max(0, budget - spend)) : '—'} left</span></div><div class="cost-mini"><div><strong>${count}</strong><span>lessons</span></div><div><strong>${info ? Math.round(info.minutes) : '—'}</strong><span>minutes</span></div><div><strong>${last ? money(last.usd * info.settings.usdToAud) : '—'}</strong><span>latest lesson</span></div></div><p class="cost-caption">${info?.incomplete ? 'Some usage is incomplete; this total may be understated.' : 'Calculated from API usage. Excludes tax and hosting.'}</p></div></section>${syncBanner()}${setupNotice()}`;
  }
  function recoveries() {
    const unfinished =
      info?.sessions.filter(
        (s) =>
          ['starting', 'active', 'finishing'].includes(s.status) || s.summary_status !== 'saved',
      ) || [];
    return unfinished
      .filter((s) => s.id !== session?.id)
      .map(
        (s) =>
          `<div class="voice-notice warning"><div><strong>${['starting', 'active'].includes(s.status) ? 'A previous lesson is still open' : 'Your last lesson needs a summary'}</strong><p>Saved practice checkpoints are retained. Finish this entry before starting another lesson.</p></div>${button(['starting', 'active'].includes(s.status) ? 'Finish saved lesson' : 'Retry summary', ['starting', 'active'].includes(s.status) ? 'recover' : 'retry-summary', '', 'data-id="' + esc(s.id) + '"')}</div>`,
      )
      .join('');
  }
  function page() {
    const active = ['connecting', 'active', 'finishing'].includes(phase);
    return `<div class="page-heading"><div><h1>Your voice lesson</h1><p>One question at a time. Your latest notes are loaded before the first question.</p></div></div>${syncBanner()}${setupNotice()}${recoveries()}<section class="voice-room" aria-label="Voice lesson"><div class="voice-controls"><div class="voice-fields"><label>Time available<select id="voice-duration" ${active ? 'disabled' : ''}>${[5, 10, 15, 20, 30, 45, 55].map((n) => `<option value="${n}" ${n === target ? 'selected' : ''}>${n} minutes</option>`).join('')}</select></label><label>Voice model<select id="voice-model" ${active ? 'disabled' : ''}><option value="gpt-realtime-2.1" ${model === 'gpt-realtime-2.1' ? 'selected' : ''}>Realtime 2.1</option><option value="gpt-realtime-2.1-mini" ${model.endsWith('-mini') ? 'selected' : ''}>Realtime 2.1 Mini · lower cost</option></select></label></div><div class="voice-stage ${phase === 'active' ? 'is-active' : ''}"><div class="voice-mic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="8" y="2" width="8" height="13" rx="4"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg></div><span class="eyebrow" id="voice-phase">${{ idle: 'READY WHEN YOU ARE', connecting: 'CONNECTING YOUR LESSON', active: muted ? 'MICROPHONE MUTED' : 'LISTEN · THINK · SPEAK', finishing: 'SAVING YOUR LESSON', complete: 'LESSON SAVED', error: 'LET’S RECONNECT' }[phase]}</span><h2 id="voice-time">${active ? clock(elapsed) : phase === 'complete' ? 'Até a próxima, Dan.' : 'A conversation, at your pace.'}</h2><p id="voice-message" role="status">${esc(message || (info?.configured ? 'Your microphone will turn on when you start.' : 'Voice is waiting for its secure API connection.'))}</p><div class="voice-actions primary-controls">${active ? (phase === 'active' ? button(muted ? 'Unmute microphone' : 'Mute microphone', 'mute') + button('Finish & save', 'finish', 'primary') : button(phase === 'connecting' ? 'Cancel connection' : 'Close audio', 'finish')) : button(phase === 'complete' ? 'Start another lesson' : 'Start voice lesson', 'start', 'primary', !info?.configured || sync !== 'saved' ? 'disabled' : '')}</div>${phase === 'active' ? `<div class="voice-actions">${button('+5 minutes', 'extend')}${button('Finish in 2 minutes', 'shorten')}</div>` : ''}<div class="voice-session-stats"><span><b id="voice-checkpoints">${checkpoints}</b> saved checkpoints</span><span><b id="voice-cost">${money(sessionUSD * (info?.settings.usdToAud || 1.4041))}</b> estimated this lesson</span></div><p class="voice-small" id="voice-target">${active ? `Target: ${Math.ceil(target)} minutes · say “keep going” or “finish here”.` : 'Start while parked. Keep this page open during the lesson.'}</p><div id="audio-unlock" hidden>${button('Tap to hear tutor', 'unlock-audio')}</div></div></div><aside class="voice-lesson-notes"><div class="eyebrow">FIRST PRIORITY</div><h2>${esc(getState().next.title)}</h2><p>${esc(getState().next.recap)}</p><div class="voice-rule"><strong>Recall comes first.</strong><p>Prompts and repetition are recorded separately. Independent use on separate days is needed for mastery.</p></div><div class="voice-rule"><strong>Use your voice to steer.</strong><p>“Slow down.”<br>“I’ve got five minutes left.”<br>“Let’s keep going.”<br>“Finish here.”</p></div><p class="voice-small">Audio is processed by OpenAI to deliver the lesson. Fala saves practice evidence and notes, not audio recordings. Phone lock and Bluetooth behaviour depend on your device.</p></aside></section>${
      transcript.length
        ? `<section class="panel voice-transcript"><h2>Saved along the way</h2><p>Practice notes are the tutor’s assessment; unclear speech stays unverified.</p><ol>${transcript
            .slice(-8)
            .map((t) => `<li><strong>${esc(t.speaker)}</strong><span>${esc(t.text)}</span></li>`)
            .join('')}</ol></section>`
        : ''
    }${costs(false)}`;
  }
  function costs(full = true) {
    const s = info?.settings || { budgetAud: 60, usdToAud: 1 / 0.7122, fxDate: '2026-09-15' };
    return `${full ? '<div class="page-heading"><div><h1>Your API costs</h1><p>Voice lessons and automatic notes, tracked together.</p></div></div>' : ''}<section class="panel usage-panel"><div class="cost-heading"><h2>${esc(info?.period || 'This month')}</h2>${button('Refresh costs', 'refresh', 'small')}</div><div class="usage-totals"><div><span>Estimated API spend</span><strong>${info ? money(info.aud) : '—'} AUD</strong></div><div><span>Original USD amount</span><strong>${info ? money(info.usd, 'USD') : '—'} USD</strong></div><div><span>Lesson time</span><strong>${Math.round(info?.minutes || 0)} minutes</strong></div></div>${info?.incomplete ? '<div class="voice-notice warning">Some API usage could not be confirmed after an interruption. The total may be understated; check the OpenAI billing dashboard for the final charge.</div>' : ''}<p class="voice-small">Estimates use API-reported tokens, including cached context and note generation. Rates dated 16 September 2026. USD is the billing currency; the AUD conversion is an estimate dated ${esc(s.fxDate)}. Tax, hosting and activity outside Fala are excluded. <a href="https://platform.openai.com/usage" target="_blank" rel="noopener">OpenAI usage dashboard</a></p><details class="usage-settings"><summary>Budget & currency settings</summary><form id="cost-settings"><div class="voice-fields"><label>Monthly API budget (AUD)<input name="budgetAud" type="number" min="5" max="500" step="1" value="${s.budgetAud}" required></label><label>AUD per US$1<input name="usdToAud" type="number" min="0.1" max="10" step="0.0001" value="${Number(s.usdToAud).toFixed(4)}" required></label></div><p class="voice-small">Fala checks this estimated budget before starting and during lessons. A response already in progress and the final notes can take it slightly over the limit. This does not cap other API activity.</p><button class="btn" type="submit">Save cost settings</button><span id="cost-settings-status" role="status"></span></form></details><div class="usage-table-wrap"><table class="usage-table"><thead><tr><th>Lesson</th><th>Model</th><th>Status</th><th>USD</th><th>AUD estimate</th></tr></thead><tbody>${info?.sessions.length ? info.sessions.map((l) => `<tr><td>${esc(new Date(l.started).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }))}</td><td>${esc(modelName(l.model))}</td><td>${esc(l.status === 'error' ? 'Connection failed' : l.summary_status !== 'saved' ? 'Summary pending' : l.status)}${l.usage_incomplete ? ' · partial usage' : ''}</td><td>${money(l.usd, 'USD')}</td><td>${money(l.usd * s.usdToAud)}</td></tr>`).join('') : '<tr><td colspan="5">No API lessons yet. Your earlier lesson logs are preserved and have no Fala API charges.</td></tr>'}</tbody></table></div></section>`;
  }
  function updateMetrics() {
    if (started && phase === 'active') elapsed = Math.floor((Date.now() - started) / 1000);
    const values = {
      'voice-time': clock(elapsed),
      'voice-checkpoints': checkpoints,
      'voice-cost': money(sessionUSD * (info?.settings.usdToAud || 1.4041)),
    };
    for (const [id, value] of Object.entries(values)) {
      const e = document.getElementById(id);
      if (e) e.textContent = value;
    }
  }
  async function cleanup() {
    clearInterval(timer);
    clearInterval(pollTimer);
    clearTimeout(audioEndTimer);
    timer = null;
    pollTimer = null;
    audioPlaying = false;
    endAfterAudio = false;
    mic?.getTracks().forEach((t) => t.stop());
    mic = null;
    try {
      dc?.close();
      pc?.close();
      ws?.close();
    } catch {}
    dc = null;
    pc = null;
    ws = null;
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
      audio = null;
    }
    try {
      await wake?.release();
    } catch {}
    wake = null;
  }
  async function start() {
    if (session || phase === 'connecting' || !info?.configured) return;
    if (queued && !(await flush())) return;
    if (sync !== 'saved') {
      toast('Sync your notebook before starting a lesson.');
      return;
    }
    stopAudio();
    navigate('voice');
    phase = 'connecting';
    message = 'Connecting your microphone and saved notebook…';
    transcript = [];
    sessionUSD = 0;
    elapsed = 0;
    checkpoints = 0;
    muted = false;
    finishing = false;
    safeRender();
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
        throw new Error(
          'This browser does not support live microphone lessons. Try a current Safari, Chrome or Edge browser.',
        );
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (finishing) {
        await cleanup();
        phase = 'idle';
        safeRender();
        return;
      }
      const connection = new RTCPeerConnection();
      pc = connection;
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.setAttribute('playsinline', '');
      document.body.appendChild(audio);
      connection.ontrack = (e) => {
        if (!audio) return;
        audio.srcObject = e.streams[0] || new MediaStream([e.track]);
        audio.play().catch(() => {
          const el = document.getElementById('audio-unlock');
          if (el) el.hidden = false;
        });
      };
      // Mute until the server confirms checkpoint saving is connected.
      mic.getAudioTracks().forEach((t) => {
        t.enabled = false;
        connection.addTrack(t, mic);
      });
      dc = connection.createDataChannel('oai-events');
      dc.onmessage = ({ data }) => {
        try {
          const e = JSON.parse(data);
          if (e.type === 'output_audio_buffer.started') audioPlaying = true;
          if (
            e.type === 'output_audio_buffer.stopped' ||
            e.type === 'output_audio_buffer.cleared'
          ) {
            audioPlaying = false;
            if (endAfterAudio) void finish();
          }
          if (e.type === 'input_audio_buffer.speech_started') {
            message = 'Listening…';
            const el = document.getElementById('voice-message');
            if (el) el.textContent = message;
          }
          if (e.type === 'response.output_audio_transcript.delta') {
            message = 'Your tutor is speaking…';
            const el = document.getElementById('voice-message');
            if (el) el.textContent = message;
          }
        } catch {}
      };
      connection.onconnectionstatechange = () => {
        if (['failed', 'disconnected'].includes(connection.connectionState) && phase === 'active') {
          message = 'Connection interrupted. Saving the practice already completed…';
          void finish(true);
        }
      };
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      if (connection.iceGatheringState !== 'complete')
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Microphone connection timed out. Please try again.')),
            10000,
          );
          connection.addEventListener('icegatheringstatechange', () => {
            if (connection.iceGatheringState === 'complete') {
              clearTimeout(timeout);
              resolve();
            }
          });
        });
      if (finishing) {
        await cleanup();
        phase = 'idle';
        safeRender();
        return;
      }
      session = await api('/voice', 'POST', {
        sdp: connection.localDescription.sdp,
        minutes: target,
        model,
      });
      if (finishing) {
        await api('/voice/' + session.id + '/finish', 'POST', {});
        await cleanup();
        phase = 'idle';
        session = null;
        safeRender();
        return;
      }
      await connection.setRemoteDescription({ type: 'answer', sdp: session.sdp });
      ws = new WebSocket(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/voice/${session.id}/control`,
      );
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Lesson saving could not connect. Please try again.')),
          15000,
        );
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'ready' }));
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error('Lesson saving could not connect. Please try again.'));
        };
        ws.onmessage = ({ data }) => {
          let e;
          try {
            e = JSON.parse(data);
          } catch {
            return;
          }
          if (e.type === 'ping') {
            ws?.send(JSON.stringify({ type: 'pong' }));
            return;
          }
          if (e.type === 'started') {
            clearTimeout(timeout);
            phase = 'active';
            started = Date.now();
            message = 'Take your time. You can interrupt or ask to repeat.';
            mic?.getAudioTracks().forEach((t) => (t.enabled = true));
            resolve();
            safeRender();
          } else if (e.type === 'metrics') {
            sessionUSD = e.usd;
            checkpoints = e.checkpoints;
            elapsed = e.elapsedSeconds;
            target = e.targetMinutes;
            updateMetrics();
          } else if (e.type === 'checkpoint') {
            checkpoints = e.checkpoints;
            sessionUSD = e.usd;
            transcript.push({
              speaker: e.attempt.pt,
              text: `${e.attempt.result.replaceAll('_', ' ')} · ${e.attempt.note || e.attempt.en}`,
            });
            updateMetrics();
          } else if (e.type === 'target') {
            target = e.minutes;
            const el = document.getElementById('voice-target');
            if (el)
              el.textContent = `Target: ${Math.ceil(target)} minutes · say “keep going” or “finish here”.`;
          } else if (e.type === 'transcript') {
            transcript.push({ speaker: e.speaker, text: e.text });
          } else if (e.type === 'notice') {
            message = e.message;
            toast(message);
          } else if (e.type === 'ready_to_finish') {
            endAfterAudio = true;
            mic?.getTracks().forEach((t) => t.stop());
            if (!audioPlaying) void finish();
            else audioEndTimer = setTimeout(() => finish(), 15000);
          } else if (e.type === 'finishing') {
            finishing = true;
            phase = 'finishing';
            message = 'Writing your lesson log and next priorities…';
            mic?.getTracks().forEach((t) => t.stop());
            safeRender();
          } else if (e.type === 'saved') {
            sessionUSD = e.usd;
            checkpoints = e.checkpoints;
            void completed();
          } else if (e.type === 'failure') {
            message = e.message;
            toast(message);
            void finish(true);
          }
        };
        ws.onclose = () => {
          clearTimeout(timeout);
          if (phase === 'connecting')
            reject(new Error('Voice connection closed before the lesson started.'));
          else if (phase === 'active' || phase === 'finishing') void waitForSaved();
        };
      });
      try {
        wake = await navigator.wakeLock?.request('screen');
      } catch {}
      timer = setInterval(updateMetrics, 1000);
    } catch (e) {
      if (session) {
        try {
          await api('/voice/' + session.id + '/finish', 'POST', {});
        } catch {}
      }
      await cleanup();
      session = null;
      phase = 'error';
      message =
        e.name === 'NotAllowedError'
          ? 'Microphone access was declined. Allow the microphone for this site, then start again.'
          : e.message;
      safeRender();
      void refresh();
    }
  }
  async function completed() {
    if (phase === 'complete') return;
    phase = 'complete';
    finishing = true;
    await cleanup();
    session = null;
    message = checkpoints
      ? 'Lesson log saved. Your phrase progress, sticky points and next priorities are ready.'
      : 'Session saved. No assessed practice was recorded, so your previous next-lesson plan is preserved.';
    try {
      const n = await api('/notebook');
      revision = n.revision;
      setState(n.state);
      sync = 'saved';
      info = await api('/usage');
    } catch {
      message = 'Lesson saved. Refresh to load your latest notebook.';
    }
    safeRender();
  }
  async function waitForSaved() {
    if (!session || pollTimer) return;
    const id = session.id;
    phase = 'finishing';
    message = 'Checking that your lesson was saved…';
    safeRender();
    let polls = 0;
    pollTimer = setInterval(async () => {
      try {
        const s = await api('/voice/' + id);
        if (s.summaryStatus === 'saved') {
          await completed();
          return;
        }
        if (++polls >= 20) {
          clearInterval(pollTimer);
          pollTimer = null;
          await cleanup();
          session = null;
          phase = 'error';
          message =
            'Your checkpoints are retained. Use Retry summary below to finish the journal update.';
          await refresh();
        }
      } catch {
        if (++polls >= 20) {
          clearInterval(pollTimer);
          pollTimer = null;
          await cleanup();
          session = null;
          phase = 'error';
          message = 'The connection is unavailable. Reopen Fala to recover your saved checkpoints.';
          safeRender();
        }
      }
    }, 1500);
  }
  async function finish(interrupted = false) {
    if (phase === 'connecting' && !session) {
      finishing = true;
      message = 'Cancelling connection…';
      safeRender();
      return;
    }
    if (!session) return;
    finishing = true;
    phase = 'finishing';
    message = interrupted
      ? 'Connection interrupted. Keeping the saved practice…'
      : 'Saving your lesson and next priorities…';
    mic?.getTracks().forEach((t) => t.stop());
    safeRender();
    if (ws?.readyState === 1 && !interrupted) ws.send(JSON.stringify({ type: 'finish' }));
    else
      try {
        await api('/voice/' + session.id + '/finish', 'POST', {});
      } catch (e) {
        message = e.message;
      }
    void waitForSaved();
  }
  function downloadDraft() {
    const data = draft?.state || read(LEGACY) || getState();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    a.download = 'Fala-preserved-notebook.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-voice]');
    if (!el) return;
    e.preventDefault();
    const action = el.dataset.voice;
    try {
      if (action === 'open') navigate('voice');
      else if (action === 'review') onReview();
      else if (action === 'costs') navigate('costs');
      else if (action === 'start') await start();
      else if (action === 'finish') await finish();
      else if (action === 'mute') {
        muted = !muted;
        mic?.getAudioTracks().forEach((t) => (t.enabled = !muted));
        safeRender();
      } else if (action === 'extend' || action === 'shorten') {
        if (ws?.readyState === 1)
          ws.send(
            JSON.stringify({
              type: 'set_time',
              mode: action === 'shorten' ? 'remaining' : 'total',
              minutes:
                action === 'shorten'
                  ? 2
                  : Math.min(55, Math.ceil(Math.max(target, elapsed / 60)) + 5),
            }),
          );
      } else if (action === 'refresh') await refresh();
      else if (action === 'download-draft') downloadDraft();
      else if (action === 'use-cloud') {
        if (!conflict) return;
        downloadDraft();
        revision = conflict.revision;
        write(SYNCED, revision);
        setState(conflict.state);
        draft = null;
        queued = null;
        conflict = null;
        localStorage.removeItem(DRAFT);
        sync = 'saved';
        problem = '';
        safeRender();
      } else if (action === 'retry-sync') {
        if (!revision) await boot();
        else {
          sync = 'saving';
          await flush();
          await refresh();
        }
      } else if (action === 'unlock-audio') {
        await audio?.play();
        document.getElementById('audio-unlock').hidden = true;
      } else if (action === 'retry-summary' || action === 'recover') {
        el.disabled = true;
        await api(
          '/voice/' + el.dataset.id + '/' + (action === 'recover' ? 'finish' : 'retry'),
          'POST',
          {},
        );
        toast('Checking saved lesson notes…');
        await refresh();
        setTimeout(refresh, 3000);
      }
    } catch (err) {
      toast(err.message);
      el.disabled = false;
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'voice-duration') target = Number(e.target.value);
    if (e.target.id === 'voice-model') model = e.target.value;
  });
  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'cost-settings') return;
    e.preventDefault();
    const form = e.target;
    if (!form.reportValidity()) return;
    const values = new FormData(form);
    const submit = form.querySelector('button');
    submit.disabled = true;
    try {
      const fx = Number(values.get('usdToAud'));
      const result = await api('/settings', 'PUT', {
        budgetAud: Number(values.get('budgetAud')),
        usdToAud: fx,
        fxDate:
          Math.abs(fx - info.settings.usdToAud) > 0.0001
            ? new Date().toISOString().slice(0, 10)
            : info.settings.fxDate,
      });
      info.settings = result.settings;
      info.aud = info.usd * result.settings.usdToAud;
      toast('Cost settings saved.');
      safeRender();
    } catch (err) {
      toast(err.message);
      submit.disabled = false;
    }
  });
  window.addEventListener('online', () => {
    if (queued && sync !== 'conflict') {
      sync = 'saving';
      void flush();
    }
  });
  window.addEventListener('pagehide', () => {
    if (session)
      fetch('/api/voice/' + session.id + '/finish', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        keepalive: true,
      }).catch(() => {});
    mic?.getTracks().forEach((t) => t.stop());
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !session) void refresh();
  });
  return {
    boot,
    save,
    dashboard,
    page,
    costs,
    syncLabel,
    syncBanner,
    refresh,
    get active() {
      return !!session;
    },
  };
}

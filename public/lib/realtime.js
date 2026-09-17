// Browser-to-OpenAI Realtime over WebRTC. The microphone track and the
// tutor's audio travel peer to peer; the "oai-events" data channel carries
// every session event (tool calls, usage, transcripts) to lesson.js.
const API = 'https://api.openai.com/v1';

export async function createCall({
  apiKey,
  sdp,
  session,
  fetch = globalThis.fetch,
  timeoutMs = 20000,
}) {
  const form = new FormData();
  form.set('sdp', sdp);
  form.set('session', JSON.stringify(session));
  let res;
  try {
    res = await fetch(API + '/realtime/calls', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('Could not reach OpenAI to start the voice call.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const code = body?.error?.code;
    const detail = body?.error?.message ? `: ${body.error.message}` : '';
    if (code === 'insufficient_quota')
      throw new Error(
        'Your OpenAI project needs available credit. Check billing in the OpenAI dashboard.',
      );
    if (res.status === 401)
      throw new Error('OpenAI rejected the API key. Check it in Connection settings.');
    if (res.status === 429)
      throw new Error(
        'The voice service is busy or a usage limit was reached. Please try again shortly.',
      );
    throw new Error(`Voice could not connect (${res.status}${detail}). Your notebook is safe.`);
  }
  const answer = await res.text();
  if (!answer.startsWith('v='))
    throw new Error('OpenAI did not return a usable connection answer.');
  const location = res.headers.get('location') || '';
  return { sdp: answer, callId: location.split('/').pop() || null };
}

function waitForIce(pc, ms) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

export async function connectRealtime({
  apiKey,
  session,
  mic,
  onEvent,
  onTrack,
  onState,
  fetch = globalThis.fetch,
  RTCPeerConnection = globalThis.RTCPeerConnection,
  iceTimeoutMs = 5000,
  openTimeoutMs = 15000,
}) {
  if (!RTCPeerConnection)
    throw new Error(
      'This browser does not support live microphone lessons. Try a current Safari, Chrome or Edge.',
    );
  const pc = new RTCPeerConnection();
  const tracks = mic.getAudioTracks();
  for (const track of tracks) {
    track.enabled = false; // stays muted until the lesson is fully connected
    pc.addTrack(track, mic);
  }
  pc.ontrack = (e) => onTrack?.(e.streams[0] || new MediaStream([e.track]));
  pc.onconnectionstatechange = () => onState?.(pc.connectionState);
  const channel = pc.createDataChannel('oai-events');
  channel.onmessage = ({ data }) => {
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    onEvent?.(event);
  };
  const close = () => {
    try {
      channel.close();
    } catch {}
    try {
      pc.close();
    } catch {}
    for (const track of mic.getTracks()) track.stop();
  };
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIce(pc, iceTimeoutMs);
    const call = await createCall({ apiKey, sdp: pc.localDescription.sdp, session, fetch });
    await pc.setRemoteDescription({ type: 'answer', sdp: call.sdp });
    await new Promise((resolve, reject) => {
      if (channel.readyState === 'open') return resolve();
      const timer = setTimeout(
        () => reject(new Error('The voice connection did not open in time. Please try again.')),
        openTimeoutMs,
      );
      channel.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      channel.onerror = () => {
        clearTimeout(timer);
        reject(new Error('The voice connection failed to open. Please try again.'));
      };
    });
    return {
      callId: call.callId,
      send(event) {
        if (channel.readyState === 'open') channel.send(JSON.stringify(event));
      },
      setMicEnabled(on) {
        for (const track of tracks) track.enabled = !!on;
      },
      close,
      get connectionState() {
        return pc.connectionState;
      },
    };
  } catch (e) {
    close();
    throw e;
  }
}

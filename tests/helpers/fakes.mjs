export function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    get size() {
      return map.size;
    },
    keys: () => [...map.keys()],
  };
}
export function fakeTimers() {
  const intervals = new Map();
  const timeouts = new Map();
  let id = 0;
  return {
    setInterval(fn) {
      intervals.set(++id, fn);
      return id;
    },
    clearInterval(i) {
      intervals.delete(i);
    },
    setTimeout(fn) {
      timeouts.set(++id, fn);
      return id;
    },
    clearTimeout(i) {
      timeouts.delete(i);
    },
    tick() {
      for (const fn of [...intervals.values()]) fn();
    },
    async runTimeouts() {
      const fns = [...timeouts.values()];
      timeouts.clear();
      for (const fn of fns) await fn();
    },
    get intervals() {
      return intervals.size;
    },
    get pendingTimeouts() {
      return timeouts.size;
    },
  };
}
export function fakeRealtime({ failWith = null } = {}) {
  const conns = [];
  async function connect({ session, onEvent, onTrack, onState }) {
    if (failWith) throw failWith;
    const conn = {
      session,
      sent: [],
      mic: null,
      closed: false,
      connectionState: 'connected',
      send(e) {
        this.sent.push(e);
      },
      setMicEnabled(on) {
        this.mic = on;
      },
      close() {
        this.closed = true;
      },
      emit: (e) => onEvent(e),
      state: (s) => onState?.(s),
      track: (stream) => onTrack?.(stream),
    };
    conns.push(conn);
    return conn;
  }
  return {
    connect,
    conns,
    get last() {
      return conns.at(-1);
    },
  };
}
export const fakeMic = () => ({ getAudioTracks: () => [], getTracks: () => [] });
export const attempt = (overrides = {}) => ({
  phraseId: 'estou-bem',
  pt: 'Estou bem',
  en: 'I’m well',
  heard: 'Estou bem',
  result: 'independent',
  context: 'isolated',
  pronunciation: 'clear',
  note: 'Correct from a meaning cue, without a model.',
  ...overrides,
});
export const until = async (fn, label = 'condition') => {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('Timed out waiting for ' + label);
};

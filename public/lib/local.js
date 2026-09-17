// Small JSON helpers over localStorage. Everything here is a cache or a
// draft; the repository on GitHub is the record.
export const KEYS = {
  notebook: 'fala-notebook-cache-v2',
  draft: 'fala-notebook-draft-v2',
  lesson: 'fala-active-lesson-v1',
  lastLesson: 'fala-last-lesson-v1',
  meta: 'fala-meta-cache-v1',
  legacy: 'fala-dan-v1',
};
export function createLocal(storage = globalThis.localStorage) {
  return {
    read(key) {
      try {
        const raw = storage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    write(key, value) {
      try {
        storage.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      try {
        storage.removeItem(key);
      } catch {}
    },
  };
}

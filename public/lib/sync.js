// Keeps the notebook, settings and ledgers in step with the repository.
// Edits are committed after a short pause; a draft stays on this device
// until GitHub confirms it, and a conflicting edit from another device is
// surfaced rather than overwritten.
import { KEYS } from './local.js';
import { FILES, pretty } from './lesson.js';
import { validNotebook, DEFAULT_SETTINGS, validateSettings } from './domain.js';
import { ConflictError } from './github.js';

const LABELS = {
  loading: 'Opening saved notebook…',
  saving: 'Saving notebook…',
  saved: 'Notebook synced',
  offline: 'Offline · local draft retained',
  conflict: 'Notebook conflict · draft retained',
  empty: 'No notebook in repository yet',
  error: 'Notebook needs attention',
  disconnected: 'Not connected',
};

export function createSync({
  store,
  local,
  onChange = () => {},
  debounceMs = 1500,
  timers = globalThis,
}) {
  let notebook = { state: null, sha: null };
  let settings = { data: { ...DEFAULT_SETTINGS }, sha: null };
  let usage = { data: [], sha: null };
  let lessons = { data: [], sha: null };
  let status = store ? 'loading' : 'disconnected';
  let problem = '';
  let draft = local.read(KEYS.draft);
  let queued = null;
  let saving = null;
  let conflict = null;
  let timer = null;
  const notify = () => {
    try {
      onChange();
    } catch {}
  };

  async function loadMeta() {
    const [st, us, ls] = await Promise.all([
      store.readJson(FILES.settings),
      store.readJson(FILES.usage),
      store.readJson(FILES.lessons),
    ]);
    settings = { data: { ...DEFAULT_SETTINGS, ...(st.data || {}) }, sha: st.sha };
    usage = { data: Array.isArray(us.data) ? us.data : [], sha: us.sha };
    lessons = { data: Array.isArray(ls.data) ? ls.data : [], sha: ls.sha };
    local.write(KEYS.meta, { settings, usage, lessons });
  }

  async function load() {
    if (!store) {
      status = 'disconnected';
      notify();
      return;
    }
    status = 'loading';
    problem = '';
    notify();
    try {
      const [nb] = await Promise.all([store.readJson(FILES.notebook), loadMeta()]);
      if (!nb.data) {
        notebook = { state: null, sha: null };
        status = 'empty';
        problem = 'No notebook was found in the repository yet. Restore a backup to create it.';
      } else if (!validNotebook(nb.data)) {
        status = 'error';
        problem = 'data/notebook.json in the repository is not a valid Fala notebook.';
      } else {
        notebook = { state: nb.data, sha: nb.sha };
        local.write(KEYS.notebook, notebook);
        if (draft && draft.sha === nb.sha) {
          queued = draft.state;
          status = 'saving';
          notify();
          await flush();
          return;
        }
        if (draft) {
          conflict = { state: nb.data, sha: nb.sha };
          status = 'conflict';
          problem =
            'A local draft and the saved notebook differ. Your local draft is kept until you choose what to use.';
        } else status = 'saved';
      }
    } catch (e) {
      const cached = local.read(KEYS.notebook);
      const meta = local.read(KEYS.meta);
      if (meta) ({ settings, usage, lessons } = meta);
      if (cached?.state) {
        notebook = cached;
        status = 'offline';
      } else status = 'error';
      problem = e.message;
    }
    notify();
  }

  function save(state, { immediate = false } = {}) {
    queued = structuredClone(state);
    draft = { state: queued, sha: notebook.sha };
    local.write(KEYS.draft, draft);
    if (['conflict', 'error', 'disconnected'].includes(status)) {
      notify();
      return Promise.resolve(false);
    }
    status = 'saving';
    notify();
    timers.clearTimeout(timer);
    if (immediate) return flush();
    timer = timers.setTimeout(() => flush(), debounceMs);
    return Promise.resolve(true);
  }

  async function flush() {
    if (saving) return saving;
    if (!store || ['conflict', 'error'].includes(status)) return false;
    timers.clearTimeout(timer);
    saving = (async () => {
      let ok = true;
      while (queued) {
        const state = queued;
        queued = null;
        try {
          const result = await store.commit({
            message: 'Update notebook',
            files: { [FILES.notebook]: pretty(state) },
            base: { [FILES.notebook]: notebook.sha },
          });
          notebook = { state, sha: result.shas[FILES.notebook] };
          local.write(KEYS.notebook, notebook);
          status = 'saved';
          problem = '';
          if (queued) {
            draft = { state: queued, sha: notebook.sha };
            local.write(KEYS.draft, draft);
          } else {
            draft = null;
            local.remove(KEYS.draft);
          }
        } catch (e) {
          queued = queued || state;
          draft = { state: queued, sha: notebook.sha };
          local.write(KEYS.draft, draft);
          problem = e.message;
          if (e instanceof ConflictError) {
            status = 'conflict';
            try {
              const remote = await store.readJson(FILES.notebook);
              conflict = { state: remote.data, sha: remote.sha };
            } catch {}
          } else status = 'offline';
          ok = false;
          break;
        }
      }
      notify();
      return ok;
    })();
    const result = await saving;
    saving = null;
    return result;
  }

  function useRemote() {
    if (!conflict) return;
    notebook = { state: conflict.state, sha: conflict.sha };
    local.write(KEYS.notebook, notebook);
    draft = null;
    queued = null;
    conflict = null;
    local.remove(KEYS.draft);
    status = 'saved';
    problem = '';
    notify();
  }

  async function retry() {
    if (!store) return false;
    if (status === 'conflict') return false;
    if (!notebook.sha && status !== 'offline') {
      await load();
      return status === 'saved';
    }
    if (queued || draft) {
      queued = queued || draft.state;
      status = 'saving';
      notify();
      const ok = await flush();
      if (ok) await refresh();
      return ok;
    }
    await refresh();
    return status === 'saved';
  }

  async function refresh() {
    if (!store) return;
    try {
      await loadMeta();
      if (status === 'saved' && !queued && !saving) {
        const nb = await store.readJson(FILES.notebook);
        if (nb.data && nb.sha !== notebook.sha && validNotebook(nb.data)) {
          notebook = { state: nb.data, sha: nb.sha };
          local.write(KEYS.notebook, notebook);
        }
      }
      if (status === 'offline') status = queued || draft ? 'saving' : 'saved';
      problem = '';
    } catch (e) {
      problem = e.message;
    }
    notify();
  }

  async function saveSettings(patch) {
    const next = validateSettings({ ...settings.data, ...patch });
    const result = await store.commit({
      message: 'Update settings',
      files: { [FILES.settings]: pretty(next) },
      base: { [FILES.settings]: settings.sha },
    });
    settings = { data: next, sha: result.shas[FILES.settings] };
    local.write(KEYS.meta, { settings, usage, lessons });
    notify();
    return next;
  }

  // After a lesson commit, adopt the committed notebook without another save.
  function adopt({ notebook: state, shas }) {
    notebook = { state, sha: shas[FILES.notebook] };
    local.write(KEYS.notebook, notebook);
    draft = null;
    queued = null;
    conflict = null;
    local.remove(KEYS.draft);
    status = 'saved';
    problem = '';
    notify();
  }

  return {
    load,
    save,
    flush,
    useRemote,
    retry,
    refresh,
    saveSettings,
    adopt,
    label: () => LABELS[status] || status,
    get status() {
      return status;
    },
    get problem() {
      return problem;
    },
    get notebook() {
      return notebook;
    },
    get settings() {
      return settings.data;
    },
    get usage() {
      return usage.data;
    },
    get lessons() {
      return lessons.data;
    },
    get conflict() {
      return conflict;
    },
    get draft() {
      return draft;
    },
    get pendingSave() {
      return !!(queued || saving);
    },
  };
}

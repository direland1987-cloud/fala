// Secrets (the OpenAI key and the GitHub token) stay on this device only.
// They are encrypted with a non-extractable AES-GCM key that lives in
// IndexedDB, and the ciphertext lives in localStorage. Nothing here ever
// leaves the browser except to api.openai.com and api.github.com.
const STORAGE_KEY = 'fala-vault-v1';

const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export function memoryKeyStore() {
  let key = null;
  return {
    ephemeral: true,
    async get() {
      return key;
    },
    async set(k) {
      key = k;
    },
    async clear() {
      key = null;
    },
  };
}

export function indexedDbKeyStore(indexedDB = globalThis.indexedDB, name = 'fala-vault') {
  const open = () =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('keys');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Vault storage is blocked.'));
    });
  const run = async (mode, fn) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('keys', mode);
        const req = fn(tx.objectStore('keys'));
        tx.oncomplete = () => resolve(req?.result ?? null);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  };
  return {
    ephemeral: false,
    get: () => run('readonly', (s) => s.get('device')),
    set: (key) => run('readwrite', (s) => s.put(key, 'device')),
    clear: () => run('readwrite', (s) => s.delete('device')),
  };
}

export function createVault({
  storage = globalThis.localStorage,
  keyStore = globalThis.indexedDB ? indexedDbKeyStore() : memoryKeyStore(),
  crypto = globalThis.crypto,
} = {}) {
  let store = keyStore;
  const fallback = () => {
    if (!store.ephemeral) store = memoryKeyStore();
    return store;
  };
  async function deviceKey(create) {
    let key = null;
    try {
      key = await store.get();
    } catch {
      key = await fallback().get();
    }
    if (!key && create) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]);
      try {
        await store.set(key);
      } catch {
        await fallback().set(key);
      }
    }
    return key;
  }
  async function save(secrets) {
    const key = await deviceKey(true);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify(secrets));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ v: 1, iv: toB64(iv), data: toB64(new Uint8Array(cipher)) }),
    );
  }
  async function load() {
    let raw = null;
    try {
      raw = storage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
    if (!raw) return null;
    const key = await deviceKey(false);
    if (!key) return null;
    try {
      const { iv, data } = JSON.parse(raw);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64(iv) },
        key,
        fromB64(data),
      );
      return JSON.parse(new TextDecoder().decode(plain));
    } catch {
      return null;
    }
  }
  async function clear() {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch {}
    try {
      await store.clear();
    } catch {}
  }
  return {
    save,
    load,
    clear,
    get ephemeral() {
      return store.ephemeral;
    },
  };
}

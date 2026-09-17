// GitHub is Fala's database. Each save is one commit on the data branch,
// built with the Git Data API so several files change atomically. Writes are
// compare-and-swap: the caller passes the blob SHAs it loaded, and the commit
// is refused if any of those files changed on GitHub in the meantime.
const API = 'https://api.github.com';

export class StoreError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}
export class ConflictError extends StoreError {
  constructor(message, path = '') {
    super(message, 409);
    this.name = 'ConflictError';
    this.path = path;
  }
}

const encoder = new TextEncoder();
const hex = (buffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

// Git's blob identity: sha1("blob <byte length>\0<content>").
export async function blobSha(content, crypto = globalThis.crypto) {
  const bytes = encoder.encode(content);
  const header = encoder.encode(`blob ${bytes.length}\0`);
  const joined = new Uint8Array(header.length + bytes.length);
  joined.set(header);
  joined.set(bytes, header.length);
  return hex(await crypto.subtle.digest('SHA-1', joined));
}

export function decodeBase64Utf8(text) {
  const binary = atob(String(text).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

function describe(status, data) {
  const detail = data?.message ? ` (${data.message})` : '';
  if (status === 401) return 'GitHub rejected the token. Check it in Connection settings.';
  if (status === 403)
    return `GitHub refused the request${detail}. The token may lack Contents write access or the rate limit was reached.`;
  if (status === 404) return `GitHub could not find the repository or branch${detail}.`;
  if (status === 422) return `GitHub could not apply the change${detail}.`;
  if (status >= 500) return 'GitHub is temporarily unavailable. Your draft is kept on this device.';
  return `GitHub request failed (${status})${detail}.`;
}

export function createGitHubStore({
  token,
  owner,
  repo,
  branch = 'main',
  fetch = globalThis.fetch,
  crypto = globalThis.crypto,
  timeoutMs = 20000,
}) {
  if (!token || !owner || !repo)
    throw new StoreError('GitHub token, owner and repository are required.');
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  async function api(path, init = {}) {
    let res;
    try {
      res = await fetch(API + path, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers || {}),
        },
        signal: init.signal || AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new StoreError(
        'Could not reach GitHub. Check the connection; your draft is kept on this device.',
      );
    }
    if (res.status === 404) return { status: 404, data: null };
    const data = res.status === 204 ? null : await res.json().catch(() => ({}));
    if (!res.ok) throw new StoreError(describe(res.status, data), res.status);
    return { status: res.status, data };
  }

  async function readFile(path, ref = branch) {
    const r = await api(`${base}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
    if (r.status === 404) return { content: null, sha: null };
    if (Array.isArray(r.data) || r.data.type !== 'file')
      throw new StoreError(`Expected a file at ${path}.`);
    if (r.data.encoding !== 'base64')
      throw new StoreError(`${path} is too large to read through the API.`);
    return { content: decodeBase64Utf8(r.data.content), sha: r.data.sha };
  }

  async function readJson(path, ref = branch) {
    const file = await readFile(path, ref);
    if (file.content === null) return { data: null, sha: null };
    try {
      return { data: JSON.parse(file.content), sha: file.sha };
    } catch {
      throw new StoreError(`${path} in the repository is not valid JSON.`);
    }
  }

  async function listDir(path) {
    const r = await api(`${base}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
    if (r.status === 404) return [];
    if (!Array.isArray(r.data)) throw new StoreError(`Expected a folder at ${path}.`);
    return r.data.map((x) => ({ name: x.name, path: x.path, sha: x.sha, type: x.type }));
  }

  async function head() {
    const ref = await api(`${base}/git/ref/heads/${encodeURIComponent(branch)}`);
    if (ref.status === 404)
      throw new StoreError(`Branch ${branch} was not found in ${owner}/${repo}.`, 404);
    const sha = ref.data.object.sha;
    const commit = await api(`${base}/git/commits/${sha}`);
    return { sha, tree: commit.data.tree.sha };
  }

  async function shaAt(path, ref) {
    const r = await api(`${base}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
    return r.status === 404 ? null : r.data.sha;
  }

  // files: { "data/notebook.json": "<content>" | null (delete) }
  // base:  { "data/notebook.json": "<blob sha loaded earlier>" | null (expected absent) }
  async function commit({ message, files, base: expected = {} }) {
    const entries = Object.entries(files);
    if (!entries.length) throw new StoreError('Nothing to save.');
    for (let attempt = 0; attempt < 3; attempt++) {
      const h = await head();
      for (const [path, sha] of Object.entries(expected)) {
        const current = await shaAt(path, h.sha);
        if ((current || null) !== (sha || null))
          throw new ConflictError(`${path} changed in the repository since it was loaded.`, path);
      }
      const tree = entries.map(([path, content]) =>
        content === null
          ? { path, mode: '100644', type: 'blob', sha: null }
          : { path, mode: '100644', type: 'blob', content },
      );
      const t = await api(`${base}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({ base_tree: h.tree, tree }),
      });
      const c = await api(`${base}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({ message, tree: t.data.sha, parents: [h.sha] }),
      });
      try {
        await api(`${base}/git/refs/heads/${encodeURIComponent(branch)}`, {
          method: 'PATCH',
          body: JSON.stringify({ sha: c.data.sha, force: false }),
        });
      } catch (e) {
        if (e.status === 422 && attempt < 2) continue; // branch moved; rebuild on the new head
        throw e;
      }
      const shas = {};
      for (const [path, content] of entries)
        shas[path] = content === null ? null : await blobSha(content, crypto);
      return { sha: c.data.sha, shas };
    }
    throw new ConflictError('The repository kept changing while saving. Please try again.');
  }

  async function verify() {
    const r = await api(base);
    if (r.status === 404)
      throw new StoreError(
        `Repository ${owner}/${repo} was not found, or the token cannot see it.`,
        404,
      );
    const canPush = !!r.data.permissions?.push;
    if (!canPush)
      throw new StoreError(
        'The token can read the repository but cannot write to it. Grant Contents: Read and write.',
        403,
      );
    const ref = await api(`${base}/git/ref/heads/${encodeURIComponent(branch)}`);
    if (ref.status === 404)
      throw new StoreError(`Branch ${branch} does not exist in ${owner}/${repo}.`, 404);
    return { fullName: r.data.full_name, isPrivate: !!r.data.private, canPush };
  }

  return { readFile, readJson, listDir, head, commit, verify, owner, repo, branch };
}

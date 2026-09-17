// An in-memory stand-in for the parts of the GitHub REST API that
// public/lib/github.js uses: refs, commits, trees, contents. Commits are
// real fast-forward checks, so the compare-and-swap paths are exercised.
import { blobSha } from '../../public/lib/github.js';

export async function createFakeGitHub({
  owner = 'dan',
  repo = 'fala',
  branch = 'main',
  files = {},
  token = 'good-token',
} = {}) {
  const trees = new Map();
  const commits = new Map();
  let counter = 0;
  const nextSha = (prefix) => (prefix + String(++counter).padStart(4, '0')).padEnd(40, '0');
  const requests = [];

  async function makeTree(fileMap) {
    const entries = {};
    for (const [path, content] of Object.entries(fileMap))
      entries[path] = { content, sha: await blobSha(content) };
    const sha = nextSha('tree');
    trees.set(sha, entries);
    return sha;
  }
  async function makeCommit(treeSha, parent, message = '') {
    const sha = nextSha('commit');
    commits.set(sha, { tree: treeSha, parents: parent ? [parent] : [], message });
    return sha;
  }
  let head = await makeCommit(await makeTree(files), null, 'init');
  const filesAt = (commitSha) => trees.get(commits.get(commitSha).tree);
  const plain = (entries) =>
    Object.fromEntries(Object.entries(entries).map(([p, e]) => [p, e.content]));

  async function setFile(path, content, message = 'external edit') {
    const current = plain(filesAt(head));
    if (content === null) delete current[path];
    else current[path] = content;
    head = await makeCommit(await makeTree(current), head, message);
    return head;
  }

  const json = (status, data) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  async function fetch(url, init = {}) {
    const u = new URL(url);
    const method = init.method || 'GET';
    requests.push({ method, path: u.pathname + u.search });
    if (init.headers?.Authorization !== `Bearer ${token}`)
      return json(401, { message: 'Bad credentials' });
    const base = `/repos/${owner}/${repo}`;
    const p = u.pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    if (p === base)
      return json(200, {
        full_name: `${owner}/${repo}`,
        private: true,
        permissions: { push: true },
        default_branch: branch,
      });
    if (p === `${base}/git/ref/heads/${branch}`) return json(200, { object: { sha: head } });
    if (p.startsWith(`${base}/git/commits/`) && method === 'GET') {
      const sha = p.split('/').pop();
      const c = commits.get(sha);
      return c ? json(200, { sha, tree: { sha: c.tree } }) : json(404, { message: 'Not Found' });
    }
    if (p.startsWith(`${base}/contents/`)) {
      const path = decodeURIComponent(p.slice(`${base}/contents/`.length));
      const ref = u.searchParams.get('ref') || branch;
      const at = ref === branch ? head : ref;
      if (!commits.has(at)) return json(404, { message: 'No commit found for the ref' });
      const entries = filesAt(at);
      const entry = entries[path];
      if (entry)
        return json(200, {
          type: 'file',
          path,
          sha: entry.sha,
          encoding: 'base64',
          content: Buffer.from(entry.content, 'utf8')
            .toString('base64')
            .replace(/(.{60})/g, '$1\n'),
        });
      const prefix = path.replace(/\/?$/, '/');
      const children = Object.keys(entries).filter((k) => k.startsWith(prefix));
      if (children.length)
        return json(
          200,
          children.map((k) => ({
            name: k.slice(prefix.length).split('/')[0],
            path: k,
            sha: entries[k].sha,
            type: 'file',
          })),
        );
      return json(404, { message: 'Not Found' });
    }
    if (p === `${base}/git/trees` && method === 'POST') {
      const baseTree = trees.get(body.base_tree);
      if (!baseTree) return json(404, { message: 'Not Found' });
      const merged = plain(baseTree);
      for (const item of body.tree) {
        if (item.sha === null) delete merged[item.path];
        else merged[item.path] = item.content;
      }
      return json(201, { sha: await makeTree(merged) });
    }
    if (p === `${base}/git/commits` && method === 'POST') {
      if (!trees.has(body.tree)) return json(422, { message: 'Tree SHA does not exist' });
      return json(201, { sha: await makeCommit(body.tree, body.parents[0], body.message) });
    }
    if (p === `${base}/git/refs/heads/${branch}` && method === 'PATCH') {
      const c = commits.get(body.sha);
      if (!c) return json(422, { message: 'Object does not exist' });
      if (c.parents[0] !== head && !body.force)
        return json(422, { message: 'Update is not a fast forward' });
      head = body.sha;
      return json(200, { object: { sha: head } });
    }
    return json(404, { message: `Unhandled ${method} ${p}` });
  }

  return {
    fetch,
    requests,
    setFile,
    get head() {
      return head;
    },
    files: () => plain(filesAt(head)),
    messages: () => [...commits.values()].map((c) => c.message),
  };
}

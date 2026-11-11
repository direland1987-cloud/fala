// Plain-language checks on the two secrets: obvious mistakes are caught
// before anything is sent, and OpenAI's answer to the key test is turned
// into what to do about it.
const hasMask = (v) => /[*•…]|\.{3}/.test(v);

export function looksWrong(kind, value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (kind === 'openai') {
    if (/^(github_pat_|gh[pousr]_)/.test(v))
      return 'That is a GitHub token. It goes in the GitHub field. An OpenAI key starts with “sk-”.';
    if (hasMask(v))
      return 'That is the shortened key from OpenAI’s key list, not the key itself. OpenAI shows the full key only once, when it is created. Create a new key and press its Copy button.';
    if (/\s/.test(v))
      return 'The OpenAI key has a space or line break in the middle. Copy it again with the Copy button.';
    if (!v.startsWith('sk-'))
      return 'An OpenAI key starts with “sk-”. Check that you copied the key itself, not its name.';
    if (v.length < 40)
      return 'That OpenAI key is too short to be complete. Create a new key and press its Copy button.';
  }
  if (kind === 'github') {
    if (v.startsWith('sk-'))
      return 'That is an OpenAI key. It goes in the OpenAI field. A GitHub token starts with “github_pat_”.';
    if (hasMask(v))
      return 'That is a shortened token, not the token itself. GitHub shows the full token only once. Regenerate it and copy it straight away.';
    if (/\s/.test(v))
      return 'The GitHub token has a space or line break in the middle. Copy it again.';
  }
  return '';
}

const quote = (message) => {
  const text = String(message || '')
    .replace(/sk-[A-Za-z0-9_*-]{6,}/g, 'sk-…')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? ` OpenAI said: “${text.slice(0, 260)}”` : '';
};

// status and body are OpenAI's reply to "list models" made with the key.
// ok:false means the key itself is unusable and must not be saved.
export function explainOpenAI(status, body) {
  const message = String(body?.error?.message || '');
  const code = String(body?.error?.code || '');
  if (status === 200) return { ok: true, models: (body?.data || []).map((m) => m.id) };
  if (status === 401 && /insufficient permissions|missing scopes/i.test(message))
    return {
      ok: true,
      models: null,
      note: 'OpenAI accepted the key, but the key is not allowed to list models, so the model check was skipped. For voice the key needs Realtime set to Request and Responses set to Write.',
    };
  if (status === 401) {
    const why =
      code === 'invalid_api_key' || /incorrect api key/i.test(message)
        ? 'OpenAI does not recognise it: it is mistyped, incomplete, or has been deleted. Create a new key and press its Copy button.'
        : /archived|no such project/i.test(message)
          ? 'The project it belongs to is archived or gone. Create a key in an active project.'
          : /organization/i.test(message)
            ? 'The account behind it has no active organisation or project for the API.'
            : 'OpenAI would not authorise it.';
    return { ok: false, error: `OpenAI rejected that API key. ${why}${quote(message)}` };
  }
  if (status === 429)
    return {
      ok: true,
      models: null,
      note: `OpenAI accepted the key but reports a limit, usually no credit on the account. Add credit under Billing before a voice session.${quote(message)}`,
    };
  return {
    ok: true,
    models: null,
    note: `OpenAI answered ${status} to the key check, so the models could not be confirmed. The key was saved anyway.${quote(message)}`,
  };
}

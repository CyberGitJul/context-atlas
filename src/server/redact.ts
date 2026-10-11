// Masks secret-looking values before text is shown in the UI or sent to the AI.
// Over-masking is acceptable; letting a secret through is not.

const MASK = '***';
// Quoted value or bare value; a bare value stops at URL separators so `?key=` inside a URL is still found.
const VALUE = String.raw`("[^"]*"|'[^']*'|[^\s,;&}'"?#]+)`;

/** Names that usually hold credentials: *api_key*, *_key, key, token, secret, password, auth, credential, *_pat. */
export function isSecretName(name: string): boolean {
  const n = name.toLowerCase().replace(/^[-"']+|["']+$/g, '');
  return (
    /api[_-]?key|token|secret|passw(?:or)?d|pwd|auth|credential|private[_-]?key/.test(n) ||
    /(?:^|[_-])key$/.test(n) ||
    /^key(?:[_-]|$)/.test(n) ||
    /(?:^|[_-])pat(?:$|[_-])/.test(n)
  );
}

type Rule = [RegExp, (...m: string[]) => string];

// Every rule starts only at a token boundary and bounds its name part, so long tokens
// are processed in linear time (an unanchored name pattern backtracks quadratically).
const RULES: Rule[] = [
  // Authorization headers: mask everything after the colon (Bearer, Basic, …)
  [/\b((?:proxy-)?authorization)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\r\n,;}]+)/gi, (_m, name, sep) => `${name}${sep}${MASK}`],
  // URL userinfo: scheme://user:password@host
  [/(\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s/@:]{1,256}:)([^\s/@]+)@/gi, (_m, head) => `${head}${MASK}@`],
  // name=value / "name": "value" / ?name=value for secret-like names
  [
    new RegExp(String.raw`(?<![A-Za-z0-9_.-])(["']?)([A-Za-z0-9_.-]{1,64})(["']?\s*[:=]\s*)` + VALUE, 'g'),
    (m, q, name, sep) => (isSecretName(name) ? `${q}${name}${sep}${MASK}` : m),
  ],
  // --flag value for secret-like flags
  [
    new RegExp(String.raw`(?<![A-Za-z0-9_-])(--?[A-Za-z0-9_-]{1,64})(\s+)` + VALUE, 'g'),
    (m, flag, sep) => (isSecretName(flag.replace(/^-+/, '')) ? `${flag}${sep}${MASK}` : m),
  ],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, () => `Bearer ${MASK}`],
  // Well-known key shapes and long opaque strings (at least 3 digits, so long words and paths survive)
  [/\bsk-[A-Za-z0-9_-]{10,}/g, () => MASK],
  [/\b[A-Fa-f0-9]{32,}\b/g, () => MASK],
  [/(?<![A-Za-z0-9+_=-])[A-Za-z0-9+_-]{40,}={0,2}/g, (m) => ((m.match(/\d/g)?.length ?? 0) >= 3 ? MASK : m)],
];

export function redact(text: string): string {
  return RULES.reduce((acc, [re, fn]) => acc.replace(re, fn as (substring: string, ...args: string[]) => string), text);
}

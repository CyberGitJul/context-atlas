import { describe, expect, it } from 'vitest';
import { redact } from '../src/server/redact.js';

describe('redact', () => {
  it('masks an inline API key assignment but keeps the command', () => {
    const out = redact('API_KEY=sk-abcdefghijklmnop123 node x.js');
    expect(out).not.toContain('sk-abcdefghijklmnop123');
    expect(out).not.toContain('abcdefghijklmnop');
    expect(out).toContain('API_KEY=***');
    expect(out).toContain('node x.js');
  });

  it('masks bearer tokens', () => {
    expect(redact('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi');
  });

  it('masks long hex strings', () => {
    expect(redact('token: 0123456789abcdef0123456789abcdef')).not.toContain('0123456789abcdef0123456789abcdef');
  });

  it.each([
    ['flag with space', 'npx srv --api-key plainSecret123', 'plainSecret123'],
    ['token flag', 'tool --token tok_live_42 --verbose', 'tok_live_42'],
    ['password flag', 'mysql --password hunter2', 'hunter2'],
    ['any *_KEY variable', 'ROUTER_KEY=abc999 node app.js', 'abc999'],
    ['OPENAI_KEY', 'export OPENAI_KEY=xyz777', 'xyz777'],
    ['quoted JSON key', '{"api_key": "json-secret-1"}', 'json-secret-1'],
    ['quoted header in script', "headers: {'x-api-key': 'hdr-secret-2'}", 'hdr-secret-2'],
    ['quoted token field', '"token": "tok-secret-3"', 'tok-secret-3'],
    ['basic auth header', 'Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['url userinfo', 'curl https://user:pw-secret-4@host/x', 'pw-secret-4'],
    ['key query param', 'https://api.example/x?key=q-secret-5&a=1', 'q-secret-5'],
    ['GitHub PAT variable', 'GITHUB_PAT=ghp_secret6 gh api', 'ghp_secret6'],
  ])('masks %s', (_label, input, secret) => {
    expect(redact(input)).not.toContain(secret);
  });

  it.each([
    ['echo hi'],
    ['PATH=/usr/bin:/bin node x.js'],
    ['tool --path /home/x/.claude/hooks'],
    ['bash "$HOME/.claude/hooks/auto-progress.sh" stop'],
    ["input=$(cat); sid=$(printf '%s' \"$input\" | jq -r '.session_id // \"unknown\"')"],
  ])('leaves harmless text untouched: %s', (input) => {
    expect(redact(input)).toBe(input);
  });

  it('stays fast on very long tokens (no quadratic backtracking)', () => {
    const start = performance.now();
    redact('x'.repeat(200_000));
    redact(`KEY=${'a'.repeat(100_000)} --token ${'b'.repeat(100_000)}`);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

import { describe, expect, it } from 'vitest';
import { aiFromEnv, aiOffText, providerLabel, type ProviderFactories } from '../../src/server/ai/provider.js';
import type { AiClient } from '../../src/server/ai/router-client.js';

/** Factories that only record what they were built with. */
function factories() {
  const made: { kind: string; opts: unknown }[] = [];
  const fake = (kind: string) => (opts: unknown) => (made.push({ kind, opts }), { kind } as unknown as AiClient);
  return { made, make: { router: fake('router'), anthropic: fake('anthropic'), agentSdk: fake('agent-sdk') } as unknown as ProviderFactories };
}

describe('aiFromEnv', () => {
  it('is off without any setting and says how to turn it on', () => {
    expect(aiFromEnv({}, factories().make)).toEqual({ ok: false, reason: { code: 'none' } });
    expect(aiOffText({ code: 'none' })).toContain('AI_PROVIDER');
  });

  it('keeps the router for an existing .env with only the router key', () => {
    const { made, make } = factories();
    const res = aiFromEnv({ ROUTER_API_KEY: 'k', ROUTER_URL: 'http://r', ROUTER_MODEL: 'sonnet' }, make);
    expect(res).toMatchObject({ ok: true, setup: { kind: 'router', model: 'sonnet', editModel: 'opus' } });
    expect(made).toEqual([{ kind: 'router', opts: { url: 'http://r', apiKey: 'k', model: 'sonnet' } }]);
  });

  it('names what the router still needs instead of guessing an address', () => {
    const res = aiFromEnv({ AI_PROVIDER: 'router', ROUTER_API_KEY: 'k' }, factories().make);
    expect(res).toEqual({ ok: false, reason: { code: 'router-missing', missing: ['ROUTER_URL'] } });
    expect(!res.ok && aiOffText(res.reason)).toBe('AI off: the AI router still needs ROUTER_URL in .env.');
  });

  it('builds the Agent SDK and the Anthropic API by AI_PROVIDER, with AI_MODEL before the old names', () => {
    const { made, make } = factories();
    expect(aiFromEnv({ AI_PROVIDER: 'agent-sdk', AI_MODEL: 'haiku', AI_MODEL_EDIT: 'sonnet', ROUTER_MODEL: 'opus' }, make)).toMatchObject({ ok: true, setup: { kind: 'agent-sdk', model: 'haiku', editModel: 'sonnet' } });
    expect(aiFromEnv({ AI_PROVIDER: ' anthropic ' }, make)).toMatchObject({ ok: true, setup: { kind: 'anthropic' } });
    expect([providerLabel('anthropic'), providerLabel('router')]).toEqual(['Anthropic API', 'AI router']);
    expect(made.map((m) => m.kind)).toEqual(['agent-sdk', 'anthropic']);
  });

  it('refuses an unknown provider by name', () => {
    const res = aiFromEnv({ AI_PROVIDER: 'openai' }, factories().make);
    expect(res.ok).toBe(false);
    expect(!res.ok && aiOffText(res.reason)).toContain('“openai”');
  });
});

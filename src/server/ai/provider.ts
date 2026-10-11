import { createAgentSdkClient } from './agent-sdk-client.js';
import { createAnthropicClient } from './anthropic-client.js';
import { createRouterClient, DEFAULT_MODEL, type AiClient } from './router-client.js';
import { msg } from '../messages/index.js';

/** The model providers the app can talk to; their names for the user are in the server messages. */
export const PROVIDERS = ['agent-sdk', 'anthropic', 'router'] as const;
export type ProviderKind = (typeof PROVIDERS)[number];

/** Why AI is off, worded by `aiOffText`. */
export type AiOff =
  | { code: 'none' }
  | { code: 'unknown'; kind: string }
  | { code: 'router-missing'; missing: string[] }
  | { code: 'anthropic'; error: string };

export function aiOffText(off: AiOff): string {
  const m = msg.provider;
  if (off.code === 'unknown') return m.offUnknown(off.kind, PROVIDERS.join(', '));
  if (off.code === 'router-missing') return m.offRouterMissing(off.missing);
  if (off.code === 'anthropic') return m.offAnthropic(off.error);
  return m.offNone;
}

export const providerLabel = (kind: ProviderKind): string => msg.provider.labels[kind];

export interface AiSetup {
  kind: ProviderKind;
  /** One client for everything; background explanations use `model`, actions and chat name `editModel` per request. */
  client: AiClient;
  model: string;
  editModel: string;
}

type Env = Record<string, string | undefined>;
const val = (env: Env, key: string) => env[key]?.trim() || undefined;

/** Constructors, replaceable in tests. */
export interface ProviderFactories {
  router: typeof createRouterClient;
  anthropic: typeof createAnthropicClient;
  agentSdk: typeof createAgentSdkClient;
}
const FACTORIES: ProviderFactories = { router: createRouterClient, anthropic: createAnthropicClient, agentSdk: createAgentSdkClient };

/**
 * Picks the provider from .env: AI_PROVIDER names it; without it, a ROUTER_API_KEY keeps the router as before.
 * Models: AI_MODEL / AI_MODEL_EDIT (short names opus, sonnet, haiku or full ids), ROUTER_MODEL* still read.
 */
export function aiFromEnv(env: Env, make: ProviderFactories = FACTORIES): { ok: true; setup: AiSetup } | { ok: false; reason: AiOff } {
  const kind = val(env, 'AI_PROVIDER') ?? (val(env, 'ROUTER_API_KEY') ? 'router' : undefined);
  if (!kind) return { ok: false, reason: { code: 'none' } };
  if (!(PROVIDERS as readonly string[]).includes(kind)) return { ok: false, reason: { code: 'unknown', kind } };
  const model = val(env, 'AI_MODEL') ?? val(env, 'ROUTER_MODEL') ?? DEFAULT_MODEL;
  const editModel = val(env, 'AI_MODEL_EDIT') ?? val(env, 'ROUTER_MODEL_EDIT') ?? 'opus';
  const k = kind as ProviderKind;
  const setup = (client: AiClient) => ({ ok: true as const, setup: { kind: k, client, model, editModel } });

  if (k === 'router') {
    const apiKey = val(env, 'ROUTER_API_KEY');
    const url = val(env, 'ROUTER_URL');
    if (!apiKey || !url) return { ok: false, reason: { code: 'router-missing', missing: [!url && 'ROUTER_URL', !apiKey && 'ROUTER_API_KEY'].filter((x): x is string => !!x) } };
    return setup(make.router({ url, apiKey, model }));
  }
  if (k === 'anthropic') {
    try {
      // The SDK finds ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile itself.
      return setup(make.anthropic({ model }));
    } catch (e) {
      return { ok: false, reason: { code: 'anthropic', error: (e as Error).message } };
    }
  }
  return setup(make.agentSdk({ model }));
}

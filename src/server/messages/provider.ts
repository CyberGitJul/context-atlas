/** AI provider names and the reasons AI is off. */
export const provider = {
  labels: { 'agent-sdk': 'Agent SDK (Claude Code login)', anthropic: 'Anthropic API', router: 'AI router' },
  offNone: 'AI off: no AI provider set up. Set AI_PROVIDER in .env (agent-sdk, anthropic or router, see README).',
  offUnknown: (kind: string, allowed: string) => `AI off: unknown AI_PROVIDER “${kind}”. Allowed: ${allowed}.`,
  offRouterMissing: (missing: string[]) => `AI off: the AI router still needs ${missing.join(' and ')} in .env.`,
  offAnthropic: (error: string) => `AI off: the Anthropic API cannot be used (${error}). Set ANTHROPIC_API_KEY in .env.`,
};

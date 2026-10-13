import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createExplanationCache, defaultCacheFile } from './ai/cache.js';
import { createExplainQueue } from './ai/queue.js';
import { createConflictChecker } from './conflicts/checker.js';
import { createConflictStore, defaultConflictsFile } from './conflicts/store.js';
import { defaultPersonalDir } from './ai/prompts.js';
import { aiFromEnv, aiOffText, providerLabel } from './ai/provider.js';
import { DEFAULT_MODEL } from './ai/router-client.js';
import { CHAT_LOG_DAYS, createChatLog, defaultChatLogDir } from './ai/chat-log.js';
import { allowedHostsFor, createApp, DEFAULT_PORT } from './app.js';
import { createClaudeGit } from './edit/claude-git.js';
import { createEventHub } from './events.js';
import { defaultContext } from './scan/context.js';
import { migrateLegacyDirs } from './paths.js';

const HOST = '127.0.0.1';

const ENV_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
/** PORT in .env or the environment, e.g. when 8795 is taken or for a second instance. */
const PORT = Number(process.env.PORT) || DEFAULT_PORT;

// Prompts, explanations, backups, chat logs and the git history of ~/.claude move over from the former name once.
for (const dir of await migrateLegacyDirs()) console.log(`Moved data of the former app name to ${dir}`);

// One provider for explanations, quick actions and chat: Agent SDK, Anthropic API or the KI-Router (see README).
const ai = aiFromEnv(process.env);
const model = ai.ok ? ai.setup.model : DEFAULT_MODEL;
const cache = createExplanationCache(defaultCacheFile(model));
await cache.load();
const events = createEventHub();
const queue = ai.ok ? createExplainQueue({ client: ai.setup.client, cache, onEvent: events.publish }) : null;

const ctx = defaultContext();
const backupRoot = join(dirname(defaultCacheFile(model)), 'backups');
const edit = ai.ok
  ? { client: ai.setup.client, model: ai.setup.editModel, promptsDir: join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'prompts'), personalDir: defaultPersonalDir() }
  : null;
// Own instructions against plugin skills, checked in the background on the same queue (after the explanations).
const conflictStore = createConflictStore(defaultConflictsFile());
await conflictStore.load();
const conflicts = createConflictChecker({
  ctx,
  store: conflictStore,
  ai: ai.ok && queue && edit ? { queue, client: ai.setup.client, model: edit.model, prompts: { generic: edit.promptsDir, personal: edit.personalDir } } : null,
  onChange: () => events.publish({ type: 'conflicts' }),
});
const chatLog = createChatLog({ dir: defaultChatLogDir() });
const pruned = await chatLog.prune();
if (pruned.length) console.log(`Chat log: removed ${pruned.length} old daily file(s).`);
const app = createApp({ ctx, ai: { cache, queue, events, provider: ai.ok ? ai.setup.kind : null, off: ai.ok ? undefined : ai.reason }, backupRoot, git: createClaudeGit(ctx.claudeDir), edit, replay: {}, conflicts, chatLog, allowedHosts: allowedHostsFor(PORT) });
serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  console.log(`Context Atlas: http://${HOST}:${info.port} (${ai.ok ? `AI on: ${providerLabel(ai.setup.kind)}, models ${model}/${ai.setup.editModel}` : aiOffText(ai.reason)})`);
  console.log(`Chat log: ${chatLog.dir} (${CHAT_LOG_DAYS} days)`);
});

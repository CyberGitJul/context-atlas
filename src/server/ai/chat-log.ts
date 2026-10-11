import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { redact } from '../redact.js';
import type { ChatMessage } from './router-client.js';
import { appDirs } from '../paths.js';

/** Chat turns are kept this many days, then deleted (decided 2026-10-10). */
export const CHAT_LOG_DAYS = 5;
const DAY_MS = 86_400_000;
const LOG_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** Logs are state, not cache: ~/.local/state/context-atlas/chat-logs. */
export function defaultChatLogDir(): string {
  return path.join(appDirs().state, 'chat-logs');
}

export interface ChatTurn {
  page: { id: string | null; file: string | null; area: string | null };
  model: string;
  /** Empty when the request was refused before a prompt was built. */
  system: string;
  messages: ChatMessage[];
  reply: string;
  /** What Opus read with read_component during the answer (labels, not texts). */
  reads?: string[];
  /** refused: never reached the router (e.g. page not found). */
  outcome: 'ok' | 'error' | 'aborted' | 'refused';
  error?: string;
  ms: number;
}

export interface ChatLog {
  readonly dir: string;
  record(turn: ChatTurn): Promise<void>;
  /** Deletes day files older than the retention; returns their names. */
  prune(): Promise<string[]>;
}

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * One JSON line per chat turn in a file per day. The earlier messages of a conversation are
 * written once, the first time this server sees it; every text is masked like everything sent to the router.
 */
export function createChatLog(opts: { dir: string; days?: number; now?: () => Date }): ChatLog {
  const { dir, days = CHAT_LOG_DAYS, now = () => new Date() } = opts;
  const seen = new Set<string>();
  let prunedOn = '';

  const prune = async () => {
    const limit = now().getTime() - days * DAY_MS;
    const gone: string[] = [];
    for (const name of (await readdir(dir).catch(() => [] as string[])).filter((n) => LOG_FILE.test(n))) {
      const file = path.join(dir, name);
      const st = await stat(file).catch(() => null);
      if (st && st.mtimeMs < limit) {
        await rm(file, { force: true });
        gone.push(name);
      }
    }
    prunedOn = localDay(now());
    return gone;
  };

  const record = async (t: ChatTurn) => {
    const at = now();
    if (prunedOn !== localDay(at)) await prune();
    const first = t.messages.find((m) => m.role === 'user')?.content ?? '';
    const conversation = createHash('sha256').update(first).digest('hex').slice(0, 12);
    const earlier = t.messages.slice(0, -1);
    const history = !seen.has(conversation) && earlier.length ? earlier.map((m) => ({ role: m.role, content: redact(m.content) })) : undefined;
    seen.add(conversation);
    const entry = {
      ts: at.toISOString(),
      conversation,
      turn: t.messages.filter((m) => m.role === 'user').length,
      page: { id: t.page.id && redact(t.page.id), file: t.page.file && redact(t.page.file), area: t.page.area },
      model: t.model,
      outcome: t.outcome,
      ...(t.error ? { error: redact(t.error) } : {}),
      ms: t.ms,
      ...(history ? { history } : {}),
      user: redact(t.messages.at(-1)?.content ?? ''),
      reply: redact(t.reply),
      ...(t.reads?.length ? { reads: t.reads.map(redact) } : {}),
      system: redact(t.system),
    };
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendFile(path.join(dir, `${localDay(at)}.jsonl`), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  };

  return { dir, record, prune };
}

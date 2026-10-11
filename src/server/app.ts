import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { stream, streamSSE } from 'hono/streaming';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Component, Explanation, Overview } from '../shared/model.js';
import { isNewKind } from '../shared/model.js';
import { actionDef, estimateActions, isAvailable, localOnlyEstimates, runAction, validateResult, type ActionConfig, type PairedText } from './ai/actions.js';
import { createSkill, skillifyBlockText } from './edit/create-skill.js';
import { findStale, knownNamesFrom } from './edit/stale.js';
import type { ExplanationCache } from './ai/cache.js';
import { buildContext } from './ai/context.js';
import type { ChatMessage, RouterChatClient, RouterJsonClient, ToolCall } from './ai/router-client.js';
import { createReader, runChat, type ReadResult } from './ai/chat-tools.js';
import { areaFor, areaForFile, assembleSystem, chatPromptRel, detailContext, extraFilesLine, fileContext, isChatPromptFile, loadChatPrompts, newContext, overviewContext, PERSONAL_PROMPT, type ChatArea } from './ai/chat.js';
import { checkProposedFile } from './edit/file-check.js';
import { resolveProposedFile, saveProposedFile } from './edit/files.js';
import type { ChatLog, ChatTurn } from './ai/chat-log.js';
import type { GlobalScan } from './scan/index.js';
import { redact } from './redact.js';
import { aiOffText, providerLabel, type AiOff, type ProviderKind } from './ai/provider.js';
import { msg } from './messages/index.js';
import { genericPromptPath, personalAddition, personalPromptPath, readPrompt, withAddition } from './ai/prompts.js';
import { checkCondensed, PROPOSE_SCHEMA, proposePrompt, REPAIR_SCHEMA, repairPrompt, type Section, splitSections, TEST_SCHEMA, testPrompt, words } from './ai/condense.js';
import type { ExplainQueue } from './ai/queue.js';
import type { EventHub } from './events.js';
import { computeHints } from './hints.js';
import type { ScanContext } from './scan/context.js';
import type { ClaudeGit } from './edit/claude-git.js';
import { loadComponentText, resolveEditable } from './edit/resolve.js';
import { saveComponentPair, saveComponentText } from './edit/save.js';
import { scanGlobal } from './scan/index.js';
import { keepPointers, linksFor, resolveLinks, skillifyBlock, skillPointers, sourceKeyOf } from '../shared/skill-links.js';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
const SSE_PING_MS = 25_000;
/** All messages of one chat request together (characters); beyond that the user starts a new conversation. */
const CHAT_HISTORY_LIMIT = 400_000;

/** Host headers the server answers to; anything else is refused (DNS rebinding). */
export const DEFAULT_PORT = 8795;
/** This machine's names on the server port and on Vite's dev port. */
export const allowedHostsFor = (port: number) => [`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1:5173', 'localhost:5173'];
export const DEFAULT_ALLOWED_HOSTS = allowedHostsFor(DEFAULT_PORT);

export interface AppDeps {
  ctx: ScanContext;
  allowedHosts?: string[];
  /** Where backups go before every write; omitted in read-only setups. */
  backupRoot?: string;
  git?: ClaudeGit | null;
  /** Every chat turn as a log line (kept a few days); absent in tests that don't need it. */
  chatLog?: ChatLog | null;
  /** AI quick actions (best model, manual only); null/absent without an AI provider. */
  edit?: (ActionConfig & { client: RouterJsonClient & Partial<RouterChatClient> }) | null;
  ai: {
    cache: ExplanationCache;
    /** null when no AI provider is configured. */
    queue: ExplainQueue | null;
    events: EventHub;
    /** The AI provider in use; its name is shown in the status line. */
    provider?: ProviderKind | null;
    /** Why AI is off (missing or broken setting), shown instead of the features. */
    off?: AiOff;
  };
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { cache, queue, events } = deps.ai;
  const aiOff = () => aiOffText(deps.ai.off ?? { code: 'none' });
  const allowedHosts = new Set(deps.allowedHosts ?? DEFAULT_ALLOWED_HOSTS);

  // Only this machine's host name (blocks DNS rebinding) on every route.
  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    if (!allowedHosts.has(host)) return c.text('Forbidden', 403);
    await next();
  });
  // The API only for this app's own pages: other sites must not read data or start router calls.
  // The page itself may be opened from anywhere (links, browser extension).
  app.use('/api/*', async (c, next) => {
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return c.text('Forbidden', 403);
    // A cross-site HTML form cannot send JSON without a CORS preflight — writes require it.
    if (c.req.method === 'POST' && !(c.req.header('content-type') ?? '').startsWith('application/json')) return c.text('Unsupported Media Type', 415);
    await next();
  });

  const hintsOf = (scan: GlobalScan) => computeHints(scan.components, { projectScopedPlugins: scan.projectScopedPlugins, latentFiles: scan.latentFiles, problems: scan.problems });
  const explanationsOf = (components: Component[]) => {
    const out: Record<string, Explanation> = {};
    for (const comp of components) {
      const e = cache.get(comp.hash);
      if (e) out[comp.hash] = e;
    }
    return out;
  };

  app.get('/api/overview', async (c) => {
    const scan = await scanGlobal(deps.ctx);
    queue?.enqueue(
      [...scan.internal.values()].map((h) => ({
        hash: h.hash,
        kind: h.kind,
        name: h.name,
        event: String(h.detail.event),
        matcher: String(h.detail.matcher),
        input: h.explainInput,
      })),
    );
    const overview: Overview = {
      scannedAt: new Date().toISOString(),
      components: scan.components,
      hints: hintsOf(scan),
      explanations: explanationsOf(scan.components),
      ai: { enabled: queue !== null, provider: deps.ai.provider ? providerLabel(deps.ai.provider) : null, off: queue ? null : aiOff(), ...(queue?.state() ?? { pending: 0, running: false, failed: 0, failedHashes: [] }) },
    };
    return c.json(overview);
  });

  /** Other sources for comparison actions (masked, within budget). */
  const contextFor = (components: Component[], exceptId: string) => {
    const explained: Record<string, Explanation> = {};
    for (const comp of components) {
      const e = cache.get(comp.hash);
      if (e) explained[comp.hash] = e;
    }
    return buildContext(components, explained, exceptId, (x) => loadComponentText(x, deps.ctx).then((t) => t.text));
  };

  /**
   * The skill a section or rule is paired with for "Align with skill": exactly one pointer line in the text,
   * to an existing skill that can be edited here.
   */
  const pairedSkill = async (component: Component, text: string, components: Component[]): Promise<(PairedText & { file: string | null }) | { error: string }> => {
    const m = msg.app.align;
    if (component.kind !== 'instruction' && component.kind !== 'rule') return { error: m.onlyInstructions };
    const ok = resolveLinks(skillPointers(text), components).filter((l) => l.state === 'ok' && l.skillId);
    if (ok.length !== 1) {
      return { error: ok.length ? m.several : m.needsLine };
    }
    const skill = components.find((x) => x.id === ok[0].skillId)!;
    const loaded = await loadComponentText(skill, deps.ctx);
    if (!loaded.editable) return { error: m.skillNotEditable(skill.name, loaded.readOnlyReason ?? m.readOnly) };
    return { component: skill, text: loaded.text, file: loaded.file };
  };

  app.get('/api/component', async (c) => {
    const id = c.req.query('id') ?? '';
    const scan = await scanGlobal(deps.ctx);
    const component = scan.components.find((x) => x.id === id);
    if (!component) return c.json({ error: msg.app.component.notFound }, 404);
    const text = await loadComponentText(component, deps.ctx);
    const paired = await pairedSkill(component, text.text, scan.components);
    const actions = deps.edit
      ? await estimateActions(component, text.text, deps.edit, await contextFor(scan.components, component.id), 'error' in paired ? undefined : paired)
      : localOnlyEstimates(component);
    // The page shows ~/… instead of the home folder: screenshots and shared links don't carry the user name.
    return c.json({ ...text, file: text.file && tildePath(text.file), actions, links: linksFor(component, scan.components) });
  });

  app.post('/api/component/action', async (c) => {
    const def = actionDef(c.req.query('action') ?? '');
    if (!def || !isAvailable(def)) return c.json({ error: msg.app.action.unknown }, 400);
    if (def.ai && !deps.edit) return c.json({ error: aiOff() }, 503);
    const scan = await scanGlobal(deps.ctx);
    const component = scan.components.find((x) => x.id === (c.req.query('id') ?? ''));
    if (!component) return c.json({ error: msg.app.component.notFound }, 404);
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    if (typeof body?.text !== 'string') return c.json({ error: msg.app.request.textMissing }, 400);
    // Local checks: nothing leaves the machine, no AI.
    if (def.id === 'stale') return c.json({ action: def.id, model: null, result: await findStale(body.text, knownNamesFrom(scan.components), deps.ctx) });
    if (!deps.edit) return c.json({ error: aiOff() }, 503);
    // Converting twice would create a second skill next to the first: pointer in the text, saved pointer, or atlas-source.
    const block = def.id === 'skillify' ? skillifyBlock(body.text, linksFor(component, scan.components)) : null;
    if (block) return c.json({ error: msg.app.action.alreadyConverted(skillifyBlockText(block)) }, 409);
    const paired = def.id === 'align' ? await pairedSkill(component, body.text, scan.components) : undefined;
    if (paired && 'error' in paired) return c.json({ error: paired.error }, 409);
    const current = await loadComponentText(component, deps.ctx);
    // A proposal built from masked text would write *** over the secret on save.
    if (current.hasSecrets || redact(body.text) !== body.text) return c.json({ error: msg.app.action.secrets }, 409);
    const edit = deps.edit;
    const context = def.context ? await contextFor(scan.components, component.id) : undefined;
    const run = () => runAction(def.id, component, body.text as string, { ...edit, context, paired });
    try {
      const result = queue ? await queue.runExclusive(run) : await run();
      const invalid = validateResult(def, result);
      if (invalid) return c.json({ error: invalid }, 502);
      if (paired) {
        // The link is never cut as a side effect; the new SKILL.md gets the same fixed check as on the file page.
        const r = result as { instruction: string; skill: string };
        const kept = keepPointers(body.text, r.instruction);
        r.instruction = kept.text;
        const check = checkProposedFile(paired.component.sourcePath ?? '', deps.ctx.claudeDir, r.skill, scan.components);
        const home = `${deps.ctx.homeDir}/`;
        const skillFile = paired.file?.startsWith(home) ? `~/${paired.file.slice(home.length)}` : paired.file;
        const pair = { skillId: paired.component.id, skillName: paired.component.name, skillFile, skillBefore: paired.text, restored: kept.restored, check };
        return c.json({ action: def.id, model: edit.model, result: r, pair });
      }
      return c.json({ action: def.id, model: edit.model, result });
    } catch (e) {
      return c.json({ error: msg.app.action.routerFailed((e as Error).message) }, 502);
    }
  });

  app.post('/api/component/save', async (c) => {
    const id = c.req.query('id') ?? '';
    const component = (await scanGlobal(deps.ctx)).components.find((x) => x.id === id);
    if (!component) return c.json({ error: msg.app.component.notFound }, 404);
    const current = await loadComponentText(component, deps.ctx);
    const target = await resolveEditable(component, deps.ctx);
    if (!current.editable || 'readOnly' in target || !deps.backupRoot) return c.json({ error: current.readOnlyReason ?? msg.app.component.notEditable }, 403);
    const body = (await c.req.json().catch(() => null)) as { before?: unknown; after?: unknown } | null;
    if (typeof body?.before !== 'string' || typeof body.after !== 'string') return c.json({ error: msg.app.request.beforeAfterMissing }, 400);
    const res = await saveComponentText(target, body.before, body.after, { backupRoot: deps.backupRoot, git: deps.git ?? null });
    if (!res.ok && 'invalid' in res) return c.json({ error: res.invalid }, 400);
    if (!res.ok) return c.json({ error: msg.app.component.changed }, 409);
    return c.json(res);
  });

  /** "Align with skill": the section (or rule) and the skill it points to, saved as one change. */
  app.post('/api/pair/save', async (c) => {
    const m = msg.app.pair;
    if (!deps.backupRoot) return c.json({ error: m.readOnlyMode }, 403);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const [id, before, after, skillId, skillBefore, skillAfter] = ['id', 'before', 'after', 'skillId', 'skillBefore', 'skillAfter'].map((k) => body?.[k]);
    if (![id, before, after, skillId, skillBefore, skillAfter].every((v) => typeof v === 'string')) return c.json({ error: msg.app.request.pairFieldsMissing }, 400);
    const components = (await scanGlobal(deps.ctx)).components;
    const section = components.find((x) => x.id === id);
    const skill = components.find((x) => x.id === skillId);
    if (!section || !skill) return c.json({ error: m.componentNotFound }, 404);
    // Only the pair the saved text actually links, and the link stays.
    const paired = await pairedSkill(section, before as string, components);
    if ('error' in paired || paired.component.id !== skill.id) return c.json({ error: m.notPaired }, 409);
    if (!skillPointers(after as string).includes(skill.name)) return c.json({ error: m.mustKeepPointer(skill.name) }, 400);
    const sectionTarget = await resolveEditable(section, deps.ctx);
    const skillTarget = await resolveEditable(skill, deps.ctx);
    if ('readOnly' in sectionTarget || 'readOnly' in skillTarget) return c.json({ error: m.notEditable }, 403);
    // The heading names the section in the skill's back-reference (atlas-source) and in the undo of a failed pair.
    if (sectionTarget.section && (after as string).split('\n')[0] !== `## ${sectionTarget.section.heading}`) return c.json({ error: m.keepHeading }, 400);
    if (redact(after as string) !== after || redact(skillAfter as string) !== skillAfter) return c.json({ error: m.secrets }, 409);
    const check = checkProposedFile(skill.sourcePath ?? '', deps.ctx.claudeDir, skillAfter as string, components);
    if (check.errors.length) return c.json({ error: m.skillRules(check.errors.join(' ')) }, 400);
    const res = await saveComponentPair(
      { target: sectionTarget, before: before as string, after: after as string },
      { target: skillTarget, before: skillBefore as string, after: skillAfter as string },
      { backupRoot: deps.backupRoot, git: deps.git ?? null },
    );
    if (!res.ok && 'invalid' in res) return c.json({ error: res.invalid }, 400);
    if (!res.ok) return c.json({ error: m.changed }, 409);
    return c.json({ section: res.first, skill: res.second });
  });

  app.post('/api/skill/create', async (c) => {
    if (!deps.backupRoot) return c.json({ error: msg.app.skill.readOnlyMode }, 403);
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; description?: unknown; body?: unknown; sourceId?: unknown } | null;
    if (typeof body?.name !== 'string' || typeof body.description !== 'string' || typeof body.body !== 'string') return c.json({ error: msg.app.request.skillFieldsMissing }, 400);
    // The section it came from, derived here from the id, so the client cannot write arbitrary metadata.
    const from = typeof body.sourceId === 'string' ? (await scanGlobal(deps.ctx)).components.find((x) => x.id === body.sourceId) : undefined;
    const res = await createSkill(deps.ctx, body.name, body.description, body.body, { git: deps.git ?? null }, from ? sourceKeyOf(from) : null);
    if (!res.ok) return c.json({ error: res.error }, res.exists ? 409 : 400);
    return c.json(res, 201);
  });

  /**
   * Single files outside ~/.claude a chat may propose: chat-files.json in the personal config dir, else the generic
   * one next to the prompts (config/chat-files.json, empty by default).
   */
  const extraFiles = async (): Promise<string[]> => {
    if (!deps.edit) return [];
    const files = [deps.edit.personalDir && path.join(deps.edit.personalDir, 'chat-files.json'), path.join(path.dirname(deps.edit.promptsDir), 'chat-files.json')];
    for (const file of files.filter((f): f is string => !!f)) {
      const raw = await readFile(file, 'utf8').catch(() => null);
      if (raw === null) continue;
      try {
        const json = JSON.parse(raw) as { extraFiles?: unknown };
        return Array.isArray(json.extraFiles) ? json.extraFiles.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        return [];
      }
    }
    return [];
  };

  const chatPage = async (page: unknown): Promise<{ area: ChatArea; context: string; editable: boolean } | null> => {
    const found = await chatPageContext(page);
    return found && { ...found, context: `${found.context}\n\n${extraFilesLine(await extraFiles())}` };
  };

  /**
   * Chat context of the page the user is on: the overview (no id), a component or a proposed file,
   * with the editor text (draft) instead of the file when it is editable. A draft with secrets is never editable here.
   */
  const chatPageContext = async (page: unknown): Promise<{ area: ChatArea; context: string; editable: boolean } | null> => {
    const p = (page ?? {}) as { id?: unknown; draft?: unknown; file?: unknown; new?: unknown };
    if (typeof p.file === 'string') {
      const t = await resolveProposedFile(p.file, deps.ctx, await extraFiles());
      if ('refused' in t) return null;
      const text = typeof p.draft === 'string' ? p.draft : (t.current ?? '');
      return { area: areaForFile(t.abs, deps.ctx.claudeDir), context: fileContext({ display: t.display, exists: t.exists, warning: t.warning, text, savedText: t.current }), editable: true };
    }
    const scan = await scanGlobal(deps.ctx);
    const hints = hintsOf(scan);
    const explanations = explanationsOf(scan.components);
    if (isNewKind(p.new)) return { area: `new-${p.new}`, context: newContext(p.new, { components: scan.components, hints, explanations }), editable: false };
    if (typeof p.id !== 'string') return { area: 'overview', context: overviewContext({ components: scan.components, hints, explanations }), editable: false };
    const component = scan.components.find((x) => x.id === p.id);
    if (!component) return null;
    const loaded = await loadComponentText(component, deps.ctx);
    const draft = loaded.editable && typeof p.draft === 'string' ? p.draft : loaded.text;
    const editable = loaded.editable && redact(draft) === draft;
    // Links as in the editor: a pointer typed but not yet saved already counts for the chat.
    const saved = linksFor(component, scan.components);
    const links = component.kind === 'instruction' || component.kind === 'rule' ? { ...saved, pointers: resolveLinks(skillPointers(draft), scan.components) } : saved;
    const linkedIds = [...links.pointers.map((l) => l.skillId), ...links.referencedBy.map((r) => r.id)].filter((x): x is string => !!x);
    const linked = await Promise.all(
      [...new Set(linkedIds)].flatMap((lid) => {
        const other = scan.components.find((x) => x.id === lid);
        return other ? [loadComponentText(other, deps.ctx).then((t) => ({ component: other, text: t.text }))] : [];
      }),
    );
    return {
      area: areaFor(component, editable),
      editable,
      context: detailContext({
        component, text: draft, savedText: loaded.text, editable, readOnlyReason: editable ? null : (loaded.readOnlyReason ?? 'The text contains secret-like values.'),
        file: loaded.file, links, hints, others: scan.components, explanations, linked,
      }),
    };
  };

  /**
   * Only user/assistant turns, ending with the user; size-capped so one request stays sane.
   * Masked like everything else that goes to the router: a token pasted into the chat stays here.
   */
  const parseMessages = (v: unknown): ChatMessage[] | null => {
    if (!Array.isArray(v) || !v.length || v.length > 80) return null;
    const ok = v.every((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.length <= 100_000);
    if (!ok || v[v.length - 1].role !== 'user' || v.reduce((n, m) => n + m.content.length, 0) > CHAT_HISTORY_LIMIT) return null;
    return v.map((m) => ({ role: m.role, content: redact(m.content) }));
  };
  const promptDirs = () => ({ generic: deps.edit!.promptsDir, personal: deps.edit!.personalDir ?? null });
  /** Prompt files are config: a missing one is a clear message, not a bare 500. */
  const prompts = (area: ChatArea) =>
    loadChatPrompts(promptDirs(), area).catch((e: NodeJS.ErrnoException) => {
      throw new Error(msg.app.chat.promptUnreadable(e.code ?? e.message));
    });

  app.post('/api/chat/prompt', async (c) => {
    if (!deps.edit) return c.json({ error: aiOff() }, 503);
    const body = (await c.req.json().catch(() => null)) as { page?: unknown } | null;
    const page = await chatPage(body?.page);
    if (!page) return c.json({ error: msg.app.chat.pageNotFound }, 404);
    const loaded = await prompts(page.area).catch((e: Error) => e);
    if (loaded instanceof Error) return c.json({ error: loaded.message }, 500);
    return c.json({ area: page.area, areaLabel: msg.app.areas[page.area], prompts: loaded, context: page.context, system: assembleSystem(loaded, page.area, page.context), model: deps.edit.model, editable: page.editable });
  });

  app.post('/api/chat', async (c) => {
    const edit = deps.edit;
    if (!edit?.client.chat) return c.json({ error: aiOff() }, 503);
    const started = Date.now();
    const body = (await c.req.json().catch(() => null)) as { page?: unknown; messages?: unknown } | null;
    const messages = parseMessages(body?.messages);
    if (!messages) return c.json({ error: msg.app.chat.badHistory }, 400);
    const raw = (body?.page ?? {}) as { id?: unknown; file?: unknown };
    const logTurn = (t: Pick<ChatTurn, 'outcome' | 'reply' | 'system' | 'error' | 'reads'> & { area: string | null }) =>
      deps.chatLog
        ?.record({
          page: { id: typeof raw.id === 'string' ? raw.id : null, file: typeof raw.file === 'string' ? raw.file : null, area: t.area },
          model: edit.model, system: t.system, messages, reply: t.reply, reads: t.reads, outcome: t.outcome, error: t.error, ms: Date.now() - started,
        })
        .catch((e: Error) => console.error(`Chat log not written: ${e.message}`));
    const page = await chatPage(body?.page);
    if (!page) {
      const error = msg.app.chat.pageNotFound;
      await logTurn({ area: null, system: '', reply: '', outcome: 'refused', error });
      return c.json({ error }, 404);
    }
    const loaded = await prompts(page.area).catch((e: Error) => e);
    if (loaded instanceof Error) {
      await logTurn({ area: page.area, system: '', reply: '', outcome: 'refused', error: loaded.message });
      return c.json({ error: loaded.message }, 500);
    }
    const system = assembleSystem(loaded, page.area, page.context);
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('Cache-Control', 'no-store');
    return stream(c, async (out) => {
      const abort = new AbortController();
      out.onAbort(() => abort.abort());
      const write = (o: object) => out.write(`${JSON.stringify(o)}\n`);
      let reply = '';
      const reads: string[] = [];
      // First line: whether proposals may be applied, as the server judged the page (a secret in the draft makes it no).
      await write({ editable: page.editable });
      // Full texts on demand: scanned only when Opus actually reads, shown as ~/… paths.
      let reader: ((call: ToolCall) => Promise<ReadResult>) | null = null;
      const read = async (call: ToolCall) =>
        (reader ??= createReader((await scanGlobal(deps.ctx)).components, async (comp) => {
          const t = await loadComponentText(comp, deps.ctx);
          return { text: t.text, file: t.file && tildePath(t.file) };
        }))(call);
      // Background explanations pause while the chat answers, reading rounds included (one router slot).
      const run = () =>
        runChat({
          client: edit.client as RouterChatClient, system, messages, model: edit.model, signal: abort.signal, read,
          onText: async (t) => void ((reply += t), await write({ t })),
          onRead: async (label) => void (reads.push(label), await write({ read: label })),
          onNote: async (note) => void (await write({ note })),
        });
      try {
        await (queue ? queue.runExclusive(run) : run());
        await write({ done: true, model: edit.model });
        await logTurn({ area: page.area, system, reply, reads, outcome: 'ok' });
      } catch (e) {
        if (abort.signal.aborted) return void (await logTurn({ area: page.area, system, reply, reads, outcome: 'aborted' }));
        const error = msg.app.chat.routerSilent((e as Error).message);
        await logTurn({ area: page.area, system, reply, reads, outcome: 'error', error });
        await write({ error });
      }
    });
  });

  /**
   * Edits a chat prompt: the change becomes the user's own version (personal config dir), the generic file stays.
   * Without a personal dir (tests, read-only setups) the generic file itself is edited. Refused when the prompt
   * changed since the user loaded it.
   */
  app.post('/api/chat/prompt/save', async (c) => {
    if (!deps.edit) return c.json({ error: aiOff() }, 503);
    const body = (await c.req.json().catch(() => null)) as { file?: unknown; before?: unknown; after?: unknown } | null;
    if (!isChatPromptFile(body?.file)) return c.json({ error: msg.app.chat.unknownPrompt }, 400);
    if (typeof body.before !== 'string' || typeof body.after !== 'string') return c.json({ error: msg.app.request.beforeAfterMissing }, 400);
    const rel = chatPromptRel(body.file);
    // The personal addition may be empty (no addition); every other prompt needs text.
    if (body.file !== PERSONAL_PROMPT && !body.after.trim()) return c.json({ error: msg.app.chat.emptyPrompt }, 400);
    const dirs = promptDirs();
    const current = await readPrompt(dirs, rel).then((p) => p.text, () => (body.file === PERSONAL_PROMPT ? '' : null));
    if (current === null) return c.json({ error: msg.app.chat.promptFileMissing(rel) }, 404);
    if (current !== body.before) return c.json({ error: msg.app.chat.promptChanged }, 409);
    const file = personalPromptPath(dirs, rel) ?? genericPromptPath(dirs, rel);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(tmp, body.after);
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true });
      return c.json({ error: msg.app.chat.notSaved((e as Error).message.split('\n')[0]) }, 500);
    }
    const home = `${deps.ctx.homeDir}/`;
    return c.json({ ok: true, file: file.startsWith(home) ? `~/${file.slice(home.length)}` : path.relative(process.cwd(), file), personal: !!dirs.personal });
  });

  /** Drops the user's own version of a prompt, so the generic one applies again. */
  app.post('/api/chat/prompt/reset', async (c) => {
    if (!deps.edit) return c.json({ error: aiOff() }, 503);
    const body = (await c.req.json().catch(() => null)) as { file?: unknown } | null;
    if (!isChatPromptFile(body?.file)) return c.json({ error: msg.app.chat.unknownPrompt }, 400);
    const own = personalPromptPath(promptDirs(), chatPromptRel(body.file));
    if (!own) return c.json({ error: msg.app.chat.noPersonal }, 400);
    await rm(own, { force: true });
    return c.json({ ok: true });
  });

  /** The global CLAUDE.md as the chat's file pages read it: refused when it holds secrets (a masked rewrite would destroy them). */
  const globalClaudeMd = async (): Promise<{ text: string } | { error: string }> => {
    const t = await resolveProposedFile('~/.claude/CLAUDE.md', deps.ctx, []);
    if ('refused' in t) return { error: t.refused };
    return t.current === null ? { error: msg.app.condense.noGlobal } : { text: t.current };
  };
  const promptWithAddition = async (name: string) => {
    const [p, a] = await Promise.all([readPrompt(promptDirs(), `${name}.md`), personalAddition(promptDirs())]);
    return withAddition(p.text, a.text);
  };

  /**
   * A new text for a section: the pointer line is never lost on the side, the trailing blank lines stay (an unchanged
   * section stays byte-identical), and the fixed checks run on the result.
   */
  const condensed = (s: Section, proposed: string | null) => {
    const kept = proposed === null ? { text: s.text, restored: [] as string[] } : keepPointers(s.text, proposed);
    const after = proposed === null ? s.text : kept.text.replace(/\s*$/, '') + s.text.match(/\s*$/)![0];
    return { after, restored: kept.restored, words: { before: words(s.text), after: words(after) }, check: checkCondensed(s, after) };
  };
  const tildePath = (f: string) => (f.startsWith(`${deps.ctx.homeDir}/`) ? `~/${f.slice(deps.ctx.homeDir.length + 1)}` : f);
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : []);

  /** "CLAUDE.md verdichten", step 1: a condensed version of every section, checked without AI. Nothing is written. */
  app.post('/api/condense/propose', async (c) => {
    if (!deps.edit) return c.json({ error: aiOff() }, 503);
    const file = await globalClaudeMd();
    if ('error' in file) return c.json({ error: file.error }, 409);
    const { preamble, sections } = splitSections(file.text);
    if (!sections.length) return c.json({ error: msg.app.condense.noSections }, 400);
    const edit = deps.edit;
    type Proposal = { summary?: string; sections?: { index?: number; after?: unknown; changes?: unknown; outsource?: unknown }[] };
    const run = async () => edit.client.json<Proposal>({ prompt: proposePrompt(sections), system: await promptWithAddition('condense'), schema: PROPOSE_SCHEMA, model: edit.model, effort: 'high' });
    try {
      const { result, model } = queue ? await queue.runExclusive(run) : await run();
      if (!Array.isArray(result?.sections)) return c.json({ error: msg.app.condense.incomplete }, 502);
      const byIndex = new Map(result.sections.filter((r) => typeof r?.after === 'string').map((r) => [r.index, r]));
      const out = sections.map((s) => {
        const r = byIndex.get(s.index);
        const { after, restored, words: w, check } = condensed(s, r ? (r.after as string) : null);
        return { index: s.index, heading: s.heading, before: s.text, after, changes: strings(r?.changes), outsource: typeof r?.outsource === 'string' ? r.outsource : '', restored, words: w, check };
      });
      return c.json({ file: file.text, preamble, summary: typeof result.summary === 'string' ? result.summary : '', sections: out, model });
    } catch (e) {
      return c.json({ error: msg.app.condense.providerFailed((e as Error).message) }, 502);
    }
  });

  /** Step 2, the test afterwards: an independent pass lists the rules of each changed section and how each one fares. */
  app.post('/api/condense/test', async (c) => {
    if (!deps.edit) return c.json({ error: aiOff() }, 503);
    const body = (await c.req.json().catch(() => null)) as { file?: unknown; sections?: unknown } | null;
    if (typeof body?.file !== 'string' || !Array.isArray(body.sections)) return c.json({ error: msg.app.request.fileSectionsMissing }, 400);
    const file = await globalClaudeMd();
    if ('error' in file) return c.json({ error: file.error }, 409);
    if (file.text !== body.file) return c.json({ error: msg.app.condense.fileChanged }, 409);
    const { sections } = splitSections(file.text);
    const pairs = (body.sections as { index?: unknown; after?: unknown }[]).flatMap((p) => {
      const s = sections.find((x) => x.index === p.index);
      return s && typeof p.after === 'string' && p.after !== s.text ? [{ section: s, after: redact(p.after) }] : [];
    });
    if (!pairs.length) return c.json({ sections: [], model: null });
    const edit = deps.edit;
    const run = async () => edit.client.json<{ sections?: unknown }>({ prompt: testPrompt(pairs), system: await promptWithAddition('condense-test'), schema: TEST_SCHEMA, model: edit.model, effort: 'high' });
    try {
      const { result, model } = queue ? await queue.runExclusive(run) : await run();
      if (!Array.isArray(result?.sections)) return c.json({ error: msg.app.condense.incomplete }, 502);
      return c.json({ sections: result.sections, model });
    } catch (e) {
      return c.json({ error: msg.app.condense.providerFailed((e as Error).message) }, 502);
    }
  });

  /**
   * Step 3, the reviewer: sections with findings (the rule test's from the page, the fixed checks' added here) get
   * exactly those fixed. The page then tests the repaired sections again. Nothing is written.
   */
  app.post('/api/condense/repair', async (c) => {
    if (!deps.edit) return c.json({ error: aiOff() }, 503);
    const body = (await c.req.json().catch(() => null)) as { file?: unknown; sections?: unknown } | null;
    if (typeof body?.file !== 'string' || !Array.isArray(body.sections)) return c.json({ error: msg.app.request.fileSectionsMissing }, 400);
    const file = await globalClaudeMd();
    if ('error' in file) return c.json({ error: file.error }, 409);
    if (file.text !== body.file) return c.json({ error: msg.app.condense.fileChanged }, 409);
    const { sections } = splitSections(file.text);
    const items = (body.sections as { index?: unknown; after?: unknown; findings?: unknown }[]).flatMap((p) => {
      const s = sections.find((x) => x.index === p.index);
      if (!s || typeof p.after !== 'string' || p.after === s.text) return [];
      const check = checkCondensed(s, p.after);
      const findings = [...strings(p.findings), ...check.errors, ...check.warnings];
      return findings.length ? [{ section: s, after: redact(p.after), findings }] : [];
    });
    if (!items.length) return c.json({ sections: [], model: null });
    const edit = deps.edit;
    type Repair = { sections?: { index?: number; after?: unknown; changes?: unknown }[] };
    const run = async () => edit.client.json<Repair>({ prompt: repairPrompt(items), system: await promptWithAddition('condense-repair'), schema: REPAIR_SCHEMA, model: edit.model, effort: 'high' });
    try {
      const { result, model } = queue ? await queue.runExclusive(run) : await run();
      if (!Array.isArray(result?.sections)) return c.json({ error: msg.app.condense.incomplete }, 502);
      const byIndex = new Map(result.sections.filter((r) => typeof r?.after === 'string').map((r) => [r.index, r]));
      const out = items.flatMap(({ section }) => {
        const r = byIndex.get(section.index);
        // The reviewer saw masked text; a mask in its answer would be saved over the real value.
        if (!r || ((r.after as string).includes('***') && !section.text.includes('***'))) return [];
        return [{ index: section.index, changes: strings(r.changes), ...condensed(section, r.after as string) }];
      });
      return c.json({ sections: out, model });
    } catch (e) {
      return c.json({ error: msg.app.condense.providerFailed((e as Error).message) }, 502);
    }
  });

  app.post('/api/file/preview', async (c) => {
    if (!deps.edit) return c.json({ error: aiOff() }, 503);
    const body = (await c.req.json().catch(() => null)) as { path?: unknown } | null;
    const t = await resolveProposedFile(body?.path, deps.ctx, await extraFiles());
    if ('refused' in t) return c.json({ error: t.refused }, 403);
    return c.json({ path: t.display, exists: t.exists, text: t.current ?? '', warning: t.warning, inRepo: t.inRepo });
  });

  /** Writes a file proposed in the chat after the user reviewed it; before null = must be new. */
  /** Rules a proposed file must meet (SKILL.md: name, description), checked while the user reviews it. */
  app.post('/api/file/check', async (c) => {
    if (!deps.edit) return c.json({ error: aiOff() }, 503);
    const body = (await c.req.json().catch(() => null)) as { path?: unknown; text?: unknown } | null;
    if (typeof body?.text !== 'string') return c.json({ error: msg.app.request.textMissing }, 400);
    const t = await resolveProposedFile(body.path, deps.ctx, await extraFiles());
    if ('refused' in t) return c.json({ error: t.refused }, 403);
    return c.json(checkProposedFile(t.abs, deps.ctx.claudeDir, body.text, (await scanGlobal(deps.ctx)).components));
  });

  app.post('/api/file/save', async (c) => {
    if (!deps.edit) return c.json({ error: aiOff() }, 503);
    if (!deps.backupRoot) return c.json({ error: msg.app.file.readOnlyMode }, 403);
    const body = (await c.req.json().catch(() => null)) as { path?: unknown; before?: unknown; after?: unknown } | null;
    if ((body?.before !== null && typeof body?.before !== 'string') || typeof body.after !== 'string' || !body.after.trim()) return c.json({ error: msg.app.request.beforeAfterMissing }, 400);
    const t = await resolveProposedFile(body.path, deps.ctx, await extraFiles());
    if ('refused' in t) return c.json({ error: t.refused }, 403);
    const check = checkProposedFile(t.abs, deps.ctx.claudeDir, body.after, (await scanGlobal(deps.ctx)).components);
    if (check.errors.length) return c.json({ error: msg.app.file.notSaved(check.errors.join(' ')) }, 400);
    const res = await saveProposedFile(t, body.before as string | null, body.after, { backupRoot: deps.backupRoot, git: deps.git ?? null }).catch((e: NodeJS.ErrnoException) => e);
    if (res instanceof Error) return c.json({ error: msg.app.file.refused(res.code ?? res.message.split('\n')[0]) }, 500);
    if (!res.ok && 'invalid' in res) return c.json({ error: res.invalid }, 400);
    if (!res.ok) return c.json({ error: body.before === null ? msg.app.file.existsNow : msg.app.file.changed }, 409);
    return c.json(res);
  });

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = events.subscribe((e) => void stream.writeSSE({ event: e.type, data: JSON.stringify(e) }));
      stream.onAbort(unsubscribe);
      while (!stream.aborted) {
        await stream.sleep(SSE_PING_MS);
        await stream.writeSSE({ event: 'ping', data: '' });
      }
    }),
  );

  // The page must always be revalidated (else a rebuild shows the old UI); hashed bundles never change.
  app.use('/*', async (c, next) => {
    await next();
    if (c.req.path.startsWith('/api/')) return;
    c.header('Cache-Control', c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  });
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), DIST) || '.' }));
  return app;
}

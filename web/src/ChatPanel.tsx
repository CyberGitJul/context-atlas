import { ArrowRight, BookOpen, FilePlus2, FileText, MessageSquare, RotateCcw, Send, Square, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { maskedCount, splitProposals } from '../../src/shared/chat-proposals';
import { Markdown } from './Markdown';
import { t as texts } from './text';
import { hrefOf, openProposal, useChatPage, usePendingProposal, type ChatPage } from './PageContext';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  /** Page the message was written on; its proposals belong there. */
  pageId: string | null;
  pageName: string;
  pageHref: string;
  /** Server's verdict for the page when the question was sent (false: e.g. a secret in the draft). */
  editable?: boolean;
  /** Editor text when the question was sent; applying later replaces what was typed since. */
  draftAtSend?: string;
  error?: string;
  /** Components Opus read in full while answering (read_component). */
  reads?: string[];
  /** Read and not yet answered: Opus works with what it read. */
  reading?: boolean;
  /** Server note on the answer, e.g. the read tool being off. */
  note?: string;
}

/** personal: the user's own version (personal config dir) applies; generic: the app's standard prompt. */
type PromptSource = 'personal' | 'generic';

interface Preview {
  area: string;
  areaLabel: string;
  prompts: { base: string; area: string; personal: string; sources: { base: PromptSource; area: PromptSource; personal: PromptSource } };
  context: string;
  system: string;
  model: string;
}

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
/** Roughly 1.6 tokens per word. */
const tokens = (n: number, locale: string) => Math.round(n * 1.6).toLocaleString(locale);
const pageOf = (p: ChatPage) => (p.create ? { new: p.create } : p.file ? { file: p.file, draft: p.draft } : { id: p.id ?? undefined, draft: p.editable ? p.draft : undefined });

/** A proposal for the page the message was written on: applied here, or from elsewhere it takes you there. */
function Proposal({ text, complete, message, page }: { text: string; complete: boolean; message: Message; page: ChatPage }) {
  const t = texts.chat.proposal;
  const { setPending } = usePendingProposal();
  const here = message.pageId === page.id;
  const why = !complete
    ? t.writing
    : message.editable === false
      ? t.notEditableAtSend
      : !here
        ? message.pageHref === '#/'
          ? t.overviewNotEditable
          : null
        : !page.editable || !page.apply
          ? t.pageNotEditable
          : page.hasSecrets
            ? t.hasSecrets
            : maskedCount(text) > maskedCount(page.draft ?? '')
              ? t.masked
              : null;
  // Typed after sending: applying replaces it (the comparison shows it against the saved text, not the draft).
  const typedSince = here && !why && message.draftAtSend !== undefined && page.draft !== undefined && page.draft !== message.draftAtSend;
  const open = () => (here ? page.apply?.(text) : openProposal(setPending, { target: message.pageHref, text, from: null }));
  return (
    <div className="chat-proposal">
      <p className="chat-proposal-head">{t.head(message.pageName, words(text))}</p>
      <pre>{text}</pre>
      <button type="button" className="primary" disabled={!!why} title={why ?? undefined} onClick={open}>
        {here ? (
          t.applyHere
        ) : (
          <>
            <ArrowRight className="icon" aria-hidden="true" /> {t.goTo(message.pageName)}
          </>
        )}
      </button>
      {why && complete && <small>{why}</small>}
      {typedSince && <small>{t.typedSince}</small>}
    </div>
  );
}

/** A proposal for another or a new file: opens it in its own before/after review page. */
function FileCard({ path, text, complete, message }: { path: string; text: string; complete: boolean; message: Message }) {
  const t = texts.chat.proposal;
  const { setPending } = usePendingProposal();
  const target = hrefOf({ id: null, file: path });
  // The way back leads to where the proposal was written (e.g. the CLAUDE.md section), not to this file.
  const from = message.pageHref !== target ? { href: message.pageHref, name: message.pageName } : null;
  return (
    <div className="chat-proposal">
      <p className="chat-proposal-head">{t.fileHead(path, words(text))}</p>
      <pre>{text}</pre>
      <button
        type="button"
        className="primary"
        disabled={!complete}
        title={complete ? undefined : t.writing}
        onClick={() => openProposal(setPending, { target, text, from })}
      >
        <FilePlus2 className="icon" aria-hidden="true" /> {t.openComparison}
      </button>
    </div>
  );
}

function PromptEditor({ label, file, text, source, hint, onSaved }: { label: string; file: string; text: string; source: PromptSource; hint?: string; onSaved: () => void }) {
  const t = texts.chat.promptEditor;
  const [draft, setDraft] = useState(text);
  const [state, setState] = useState<{ busy: boolean; note: string | null; error: boolean }>({ busy: false, note: null, error: false });
  useEffect(() => setDraft(text), [text]);
  const send = async (url: string, body: object, done: (r: { file?: string; personal?: boolean }) => string) => {
    setState({ busy: true, note: null, error: false });
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const res = (await r.json().catch(() => ({}))) as { error?: string; file?: string; personal?: boolean };
    if (!r.ok) return setState({ busy: false, note: res.error ?? `HTTP ${r.status}`, error: true });
    setState({ busy: false, note: done(res), error: false });
    onSaved();
  };
  const save = () =>
    send('/api/chat/prompt/save', { file, before: text, after: draft }, (r) =>
      r.personal ? t.savedPersonal(r.file) : t.savedRepo(r.file),
    );
  const reset = () => send('/api/chat/prompt/reset', { file }, () => t.resetDone);
  const id = `prompt-${file}`;
  return (
    <section className="chat-prompt-part">
      <label htmlFor={id}>
        {label} <span className={`prompt-source ${source}`}>{source === 'personal' ? t.sourcePersonal : t.sourceDefault}</span>
      </label>
      {hint && <p className="lede">{hint}</p>}
      <textarea id={id} value={draft} onChange={(e) => setDraft(e.target.value)} rows={10} spellCheck={false} />
      <div className="button-row">
        <button type="button" onClick={save} disabled={state.busy || draft === text}>
          {state.busy ? t.saving : t.save}
        </button>
        <button type="button" onClick={() => setDraft(text)} disabled={state.busy || draft === text}>
          {t.discard}
        </button>
        {source === 'personal' && (
          <button type="button" onClick={reset} disabled={state.busy}>
            {t.reset}
          </button>
        )}
        <span className="edit-state">{t.words(words(draft))}</span>
      </div>
      {state.note && <p className={`notice ${state.error ? 'error' : 'ok'}`}>{state.note}</p>}
    </section>
  );
}

/** Collapsible chat with the edit model, on every page; one conversation, the context follows the page. */
export function ChatPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = texts.chat;
  const p = t.panel;
  const page = useChatPage();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [version, setVersion] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const list = useRef<HTMLDivElement>(null);

  // The system prompt follows the page and the editor text (debounced while typing); a slower old answer never wins.
  useEffect(() => {
    if (!open) return;
    const stale = new AbortController();
    const t = setTimeout(() => {
      fetch('/api/chat/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page: pageOf(page) }), signal: stale.signal })
        .then(async (r) => {
          const body = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
          setPreview(body as Preview);
          setPreviewError(null);
        })
        .catch((e: Error) => !stale.signal.aborted && setPreviewError(e.message));
    }, 500);
    return () => (clearTimeout(t), stale.abort());
  }, [open, page.id, page.draft, page.editable, version]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    const at = { pageId: page.id, pageName: page.name, pageHref: hrefOf(page) };
    // A failed turn stays visible with its error but is left out of what Opus sees, together with its question.
    const sent = messages.flatMap((m, i) => (m.error || (m.role === 'user' && messages[i + 1]?.error) ? [] : [{ role: m.role, content: m.content }]));
    sent.push({ role: 'user', content: text });
    setMessages([...messages, { role: 'user', content: text, ...at }, { role: 'assistant', content: '', ...at, draftAtSend: page.draft }]);
    setInput('');
    setStreaming(true);
    const controller = new AbortController();
    abort.current = controller;
    const update = (fn: (m: Message) => Message) => setMessages((all) => [...all.slice(0, -1), fn(all[all.length - 1])]);
    let answered = false;
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page: pageOf(page), messages: sent }),
        signal: controller.signal,
      });
      if (!r.ok || !r.body) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n');
        buffer = done ? '' : lines.pop()!;
        for (const l of lines.filter(Boolean)) {
          const ev = JSON.parse(l) as { t?: string; error?: string; editable?: boolean; read?: string; note?: string };
          if (typeof ev.editable === 'boolean') update((m) => ({ ...m, editable: ev.editable }));
          if (ev.read) update((m) => ({ ...m, reads: [...(m.reads ?? []), ev.read!], reading: true }));
          if (ev.note) update((m) => ({ ...m, note: ev.note }));
          if (ev.t) update((m) => ({ ...m, content: m.content + ev.t, reading: false }));
          if (ev.error) update((m) => ({ ...m, error: ev.error }));
          if (ev.t || ev.error) answered = true;
        }
        if (done) break;
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        update((m) => ({ ...m, error: (e as Error).message }));
        answered = true;
      }
    } finally {
      // A stopped answer keeps what arrived. Stopped before the first word: question back into the input, nothing in the history.
      if (!answered) {
        setMessages((all) => all.slice(0, -2));
        setInput((cur) => cur || text);
      }
      setStreaming(false);
      abort.current = null;
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  if (!open) return null;
  const systemWords = preview ? words(preview.system) : 0;
  const historyWords = messages.reduce((n, m) => n + words(m.content), 0) + words(input);
  return (
    <aside className="chat" aria-label={p.title}>
      <header className="chat-head">
        <div className="chat-head-row">
          <h2>{p.title}</h2>
          <div className="chat-tools">
            <button type="button" aria-pressed={showPrompt} onClick={() => setShowPrompt((v) => !v)} title={p.systemPromptTitle}>
              <FileText className="icon" aria-hidden="true" /> {p.systemPrompt}
            </button>
            <button type="button" onClick={() => setMessages([])} disabled={streaming || !messages.length} title={p.newChatTitle}>
              <RotateCcw className="icon" aria-hidden="true" /> {p.newChat}
            </button>
            <button type="button" onClick={onClose} aria-label={p.close}>
              <X className="icon" aria-hidden="true" />
            </button>
          </div>
        </div>
        <p className="lede">
          {preview && p.area(preview.areaLabel)}
          {p.pageLine(page.name)}
        </p>
      </header>

      {previewError && <p className="notice error chat-note">{previewError}</p>}

      {showPrompt ? (
        <div className="chat-body chat-prompt">
          {!preview ? (
            <p className="status">{p.loading}</p>
          ) : (
            <>
              <p className="lede">
                {p.intro(systemWords.toLocaleString(t.locale), tokens(systemWords, t.locale))}
              </p>
              <PromptEditor label={p.baseLabel} file="_basis" text={preview.prompts.base} source={preview.prompts.sources.base} onSaved={() => setVersion((v) => v + 1)} />
              <PromptEditor
                label={p.personalLabel}
                file="_persoenlich"
                text={preview.prompts.personal}
                source={preview.prompts.sources.personal}
                hint={p.personalHint}
                onSaved={() => setVersion((v) => v + 1)}
              />
              <PromptEditor label={p.areaLabel(preview.areaLabel)} file={preview.area} text={preview.prompts.area} source={preview.prompts.sources.area} onSaved={() => setVersion((v) => v + 1)} />
              <details className="chat-prompt-part">
                <summary>{p.context(words(preview.context).toLocaleString(t.locale))}</summary>
                <pre>{preview.context}</pre>
              </details>
            </>
          )}
        </div>
      ) : (
        <div className="chat-body" ref={list} aria-live="polite">
          {!messages.length && (
            <p className="chat-empty">
              {page.create
                ? texts.create.kinds[page.create].chat
                : page.id
                ? p.emptyPage
                : p.emptyOverview}
            </p>
          )}
          {messages.map((m, i) => (
            <div key={i}>
              {(i === 0 || messages[i - 1].pageId !== m.pageId) && <p className="chat-divider">{p.divider(m.pageName)}</p>}
              <div className={`chat-msg ${m.role}`}>
                {m.note && <p className="chat-msg-note">{m.note}</p>}
                {!!m.reads?.length && (
                  <ul className="chat-reads" aria-label={p.readsLabel}>
                    {m.reads.map((r, k) => (
                      <li key={k}>
                        <BookOpen className="icon" aria-hidden="true" /> {p.read(r)}
                      </li>
                    ))}
                  </ul>
                )}
                {m.role === 'user' ? (
                  <p>{m.content}</p>
                ) : (
                  splitProposals(m.content).map((s, k) =>
                    s.kind === 'text' ? (
                      <Markdown key={k} text={s.text} />
                    ) : s.kind === 'file' ? (
                      <FileCard key={k} path={s.path} text={s.text} complete={s.complete} message={m} />
                    ) : (
                      <Proposal key={k} text={s.text} complete={s.complete} message={m} page={page} />
                    ),
                  )
                )}
                {m.role === 'assistant' && streaming && i === messages.length - 1 && (!m.content || m.reading) && (
                  <p className="status">{m.reading ? p.evaluating : p.thinking}</p>
                )}
                {m.error && <p className="notice error">{m.error}</p>}
              </div>
            </div>
          ))}
        </div>
      )}

      <form
        className="chat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label htmlFor="chat-input" className="sr-only">
          {p.composeLabel}
        </label>
        <textarea id="chat-input" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} rows={3} placeholder={p.composePlaceholder} disabled={!!previewError && !preview} />
        <div className="chat-compose-row">
          <small>
            {p.tokensHint(tokens(systemWords + historyWords, t.locale))}
          </small>
          {streaming ? (
            <button type="button" onClick={() => abort.current?.abort()}>
              <Square className="icon" aria-hidden="true" /> {p.stop}
            </button>
          ) : (
            <button type="submit" className="primary" disabled={!input.trim()}>
              <Send className="icon" aria-hidden="true" /> {p.send}
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}

/** Floating button that opens the chat. */
export function ChatToggle({ onOpen }: { onOpen: () => void }) {
  const t = texts.chat.panel;
  return (
    <button type="button" className="chat-toggle" onClick={onOpen}>
      <MessageSquare className="icon" aria-hidden="true" /> {t.open}
    </button>
  );
}

import { ArrowLeft, MessageSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Component, NewKind, Overview } from '../../src/shared/model';
import { t } from './text';
import { usePublishPage } from './PageContext';

/**
 * Starting point for a new skill, rule, subagent or command. The page has no text of its own: the chat (own area
 * and prompt per kind) clarifies, checks against what exists and proposes the file, which the user creates on the file page.
 */
export function NewPage({ kind, onOpenChat }: { kind: NewKind; onOpenChat: () => void }) {
  const copy = t.create.kinds[kind];
  usePublishPage({ id: `new:${kind}`, create: kind, href: `#/new/${kind}`, name: copy.title, editable: false, hasSecrets: false });
  const [existing, setExisting] = useState<Component[] | null>(null);

  useEffect(() => {
    onOpenChat();
    fetch('/api/overview')
      .then((r) => (r.ok ? (r.json() as Promise<Overview>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((o) => setExisting(o.components.filter((c) => c.kind === kind)))
      .catch(() => setExisting([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once per visit; the route remounts the page per kind

  const own = (existing ?? []).filter((c) => c.origin.type !== 'plugin').sort((a, b) => a.name.localeCompare(b.name));
  const fromPlugins = (existing ?? []).length - own.length;
  return (
    <main className="detail new-page">
      <a className="back" href="#/">
        <ArrowLeft className="icon" aria-hidden="true" /> {t.create.page.back}
      </a>
      <header className="detail-head">
        <h1>{copy.title}</h1>
        <p className="lede">{copy.lede}</p>
      </header>

      <section className="new-page-steps" aria-labelledby="new-page-how">
        <h2 id="new-page-how">{t.create.page.how}</h2>
        <ol>
          {copy.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <button type="button" className="primary" onClick={onOpenChat}>
          <MessageSquare className="icon" aria-hidden="true" /> {t.create.page.openChat}
        </button>
      </section>

      <section className="new-page-existing" aria-labelledby="new-page-own">
        <h2 id="new-page-own">
          {copy.own}
          {existing ? ` (${own.length})` : ''}
        </h2>
        {!existing ? (
          <p className="status">{t.create.page.loading}</p>
        ) : own.length ? (
          <ul>
            {own.map((c) => (
              <li key={c.id}>
                <a href={`#/c/${encodeURIComponent(c.id)}`}>{c.name}</a>
                {!c.enabled && <span className="muted"> {t.create.page.off}</span>}
                {c.summary && <span className="muted">: {c.summary.length > 140 ? `${c.summary.slice(0, 140)} …` : c.summary}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="lede">{copy.none}</p>
        )}
        {fromPlugins > 0 && (
          <p className="lede">
            {t.create.page.fromPlugins(fromPlugins, copy.plural)}
          </p>
        )}
      </section>
    </main>
  );
}

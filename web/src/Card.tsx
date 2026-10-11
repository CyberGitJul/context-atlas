import { CornerDownRight, TriangleAlert } from 'lucide-react';
import type { Component, Explanation, Hint, Origin } from '../../src/shared/model';
import { t, type Messages } from './text';

function originLabel(o: Origin, t: Messages): string {
  if (o.type === 'plugin') return t.card.plugin(o.plugin.split('@')[0]);
  if (o.type === 'live') return t.card.live(o.via);
  return t.card.own;
}

interface Props {
  component: Component;
  explanation?: Explanation;
  /** AI is on and will explain this card later. */
  explaining: boolean;
  /** The last explanation attempt failed. */
  failed: boolean;
  warnings: Hint[];
  highlighted: boolean;
  dimmed: boolean;
}

export function Card({ component: c, explanation, explaining, failed, warnings, highlighted, dimmed }: Props) {
  const cls = ['card', c.enabled ? '' : 'off', highlighted ? 'highlighted' : '', dimmed ? 'dimmed' : ''].filter(Boolean).join(' ');
  const isHook = c.kind === 'hook';
  const matcher = String(c.detail.matcher ?? '*');
  return (
    <article className={cls}>
      <div className="card-head">
        <h3 title={c.name}>
          <a href={`#/c/${encodeURIComponent(c.id)}`}>{explanation?.title ?? c.name}</a>
        </h3>
        <span className="origin">{originLabel(c.origin, t)}</span>
      </div>
      {warnings.length > 0 && (
        <p className="card-warn" title={warnings.map((w) => w.text).join('\n')}>
          <TriangleAlert className="icon" aria-hidden="true" />
          <span>{t.card.warning(warnings.map((w) => w.text).join(' '))}</span>
        </p>
      )}
      {isHook && (
        <p className="when">
          {String(c.detail.event)}
          {matcher !== '*' && t.card.matcher(matcher)}
        </p>
      )}
      {explanation && <p className="what">{explanation.summary}</p>}
      {!explanation && isHook && explaining && !failed && <p className="what pending">{t.card.explaining}</p>}
      {!explanation && isHook && failed && <p className="what pending">{t.card.failed}</p>}
      {explanation?.injects && (
        <p className="injects">
          <CornerDownRight className="icon" aria-hidden="true" />
          <span>{t.card.injects(explanation.injects)}</span>
        </p>
      )}
      {!isHook && c.summary && <p className="what">{c.summary}</p>}
      {isHook && c.summary && (
        <code className="cmd" title={String(c.detail.command ?? c.summary)}>
          {c.summary}
        </code>
      )}
      {c.contextWords > 0 && c.kind !== 'skill' && <p className="cost">{t.card.words(c.contextWords)}</p>}
      {!c.enabled && <span className="tag-off">{t.card.off}</span>}
    </article>
  );
}

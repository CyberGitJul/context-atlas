import { Info, TriangleAlert } from 'lucide-react';
import type { Hint } from '../../src/shared/model';
import { t, type Messages } from './text';

interface Props {
  hints: Hint[];
  selected: string | null;
  onSelect: (hint: Hint | null) => void;
}

/** Hints that come with a way to act on them. */
const ACTIONS: Record<string, { label: (t: Messages) => string; href: string }> = {
  'claude-md-long': { label: (t) => t.hints.condense, href: '#/condense' },
};

export function HintBar({ hints, selected, onSelect }: Props) {
  if (!hints.length) return null;
  const sorted = [...hints].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1));
  return (
    <ul className="hints" aria-label={t.hints.label}>
      {sorted.map((h) => (
        <li key={h.id}>
          <button
            type="button"
            className={`hint ${h.severity}`}
            disabled={!h.componentIds.length}
            aria-pressed={selected === h.id}
            onClick={() => onSelect(selected === h.id ? null : h)}
          >
            {h.severity === 'warn' ? <TriangleAlert className="icon" aria-label={t.hints.warn} /> : <Info className="icon" aria-label={t.hints.info} />}
            <span>{h.text}</span>
          </button>
          {ACTIONS[h.id] && (
            <a className="hint-action" href={ACTIONS[h.id].href}>
              {ACTIONS[h.id].label(t)}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

import { useEffect, useRef } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, highlightSpecialChars } from '@codemirror/view';
import { t as texts } from './text';

/** Invisible characters that can hide what a line does (bidi overrides, zero-width): shown as placeholders. */
const HIDDEN = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

/** Side-by-side before/after view (read-only) for reviewing a change before saving. */
export function DiffView({ before, after }: { before: string; after: string }) {
  const t = texts.chat.diff;
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const common = [EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false), highlightSpecialChars({ addSpecialChars: HIDDEN })];
    const view = new MergeView({
      a: { doc: before, extensions: [...common, EditorView.contentAttributes.of({ 'aria-label': t.before })] },
      b: { doc: after, extensions: [...common, EditorView.contentAttributes.of({ 'aria-label': t.after })] },
      parent: host.current!,
      collapseUnchanged: { margin: 3, minSize: 6 },
    });
    return () => view.destroy();
  }, [before, after, t]);
  return (
    <div className="diff">
      <div className="diff-labels" aria-hidden="true">
        <span>{t.before}</span>
        <span>{t.after}</span>
      </div>
      <div ref={host} />
    </div>
  );
}

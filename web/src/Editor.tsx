import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

interface Props {
  /** Text when the editor is created or reset; typing does not recreate the editor. */
  value: string;
  /** Bump to replace the document with `value` (reload, discard). */
  version: number;
  readOnly: boolean;
  onChange: (text: string) => void;
  label: string;
}

/** CodeMirror 6 editor for markdown and scripts; owns its document, reports changes upward. */
export function Editor({ value, version, readOnly, onChange, label }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          basicSetup,
          markdown(),
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) changeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // Recreate only on reset or mode change, never per keystroke (keeps cursor and undo history).
  }, [version, readOnly, label]);

  return <div className="editor" ref={host} />;
}

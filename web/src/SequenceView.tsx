import { Zap } from 'lucide-react';
import type { KeyboardEvent, ReactElement } from 'react';
import type { HookCounts } from '../../src/shared/flow';
import { countLabel } from './FlowTrack';
import { t, type Messages } from './text';

type Actor = 'you' | 'cc' | 'model' | 'tools';
const X: Record<Actor, number> = { you: 110, cc: 370, model: 630, tools: 880 };
const ACTORS: Actor[] = ['you', 'cc', 'model', 'tools'];

type Label = keyof Messages['sequence']['rows'];
type Row =
  | { type: 'msg'; from: Actor; to: Actor; label: Label; events?: string[] }
  | { type: 'self'; at: Actor; label: Label }
  | { type: 'note'; label: Label; events?: string[] }
  | { type: 'loop-start' }
  | { type: 'loop-end' };

const ROWS: Row[] = [
  { type: 'msg', from: 'you', to: 'cc', label: 'start', events: ['SessionStart'] },
  { type: 'msg', from: 'cc', to: 'model', label: 'system' },
  { type: 'msg', from: 'you', to: 'cc', label: 'message', events: ['UserPromptSubmit'] },
  { type: 'msg', from: 'cc', to: 'model', label: 'injected' },
  { type: 'self', at: 'model', label: 'skill' },
  { type: 'loop-start' },
  { type: 'msg', from: 'model', to: 'cc', label: 'toolCall', events: ['PermissionRequest', 'PreToolUse'] },
  { type: 'msg', from: 'cc', to: 'tools', label: 'run' },
  { type: 'msg', from: 'tools', to: 'cc', label: 'result', events: ['PostToolUse'] },
  { type: 'msg', from: 'cc', to: 'model', label: 'result' },
  { type: 'loop-end' },
  { type: 'msg', from: 'model', to: 'cc', label: 'done', events: ['Stop', 'SubagentStop'] },
  { type: 'msg', from: 'cc', to: 'you', label: 'answer' },
  { type: 'note', label: 'compact', events: ['PreCompact'] },
  { type: 'msg', from: 'you', to: 'cc', label: 'end', events: ['SessionEnd'] },
];

const ROW_H = 46;
const TOP = 70;
const MARKER_W = 200;

interface Props {
  counts: HookCounts;
  onEvent: (event: string) => void;
}

export function SequenceView({ counts, onEvent }: Props) {
  let y = TOP;
  let loopTop = 0;
  const parts: ReactElement[] = [];
  ROWS.forEach((row, i) => {
    if (row.type === 'loop-start') {
      loopTop = y - 28;
      return;
    }
    if (row.type === 'loop-end') {
      parts.push(
        <g key={`loop-${i}`}>
          <rect className="loopbox" x={X.cc - 230} y={loopTop} width={X.tools - X.cc + 290} height={y - loopTop - 18} />
          <text className="loop-label" x={X.cc - 222} y={y - 24}>
            {t.sequence.loop}
          </text>
        </g>,
      );
      y += 10;
      return;
    }
    const markers = (row.type === 'msg' || row.type === 'note' ? row.events : undefined) ?? [];
    if (row.type === 'msg') {
      const dir = X[row.to] > X[row.from] ? 1 : -1;
      const x2 = X[row.to] - dir * 6;
      parts.push(
        <g key={`m-${i}`}>
          <line className="msg" x1={X[row.from]} y1={y} x2={x2} y2={y} />
          <path className="arrow" d={`M${x2},${y - 5} L${X[row.to]},${y} L${x2},${y + 5} z`} />
          <text className="msg-label" x={Math.min(X[row.from], X[row.to]) + 10} y={y - 7}>
            {t.sequence.rows[row.label]}
          </text>
        </g>,
      );
    } else if (row.type === 'self') {
      parts.push(
        <g key={`s-${i}`}>
          <path className="msg" fill="none" d={`M${X[row.at]},${y - 10} h40 v20 h-34`} />
          <path className="arrow" d={`M${X[row.at] + 6},${y + 5} L${X[row.at]},${y + 10} L${X[row.at] + 6},${y + 15} z`} />
          <text className="msg-label" x={X[row.at] + 48} y={y + 4}>
            {t.sequence.rows[row.label]}
          </text>
        </g>,
      );
    } else {
      parts.push(
        <text key={`n-${i}`} className="note" x={X.cc + 10} y={y}>
          {t.sequence.rows[row.label]}
        </text>,
      );
    }
    markers.forEach((event, k) => {
      const c = counts[event];
      const my = y + 6 + k * 24;
      const activate = () => c && onEvent(event);
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          activate();
        }
      };
      parts.push(
        <g
          key={`k-${i}-${event}`}
          className={c ? 'marker' : 'marker none'}
          role="button"
          tabIndex={c ? 0 : -1}
          aria-disabled={!c}
          aria-label={t.sequence.marker(event, countLabel(c, t))}
          onClick={activate}
          onKeyDown={onKey}
        >
          <rect x={X.cc - MARKER_W - 10} y={my} width={MARKER_W} height={20} rx={10} />
          <Zap className="marker-icon" x={X.cc - MARKER_W - 2} y={my + 3} width={14} height={14} aria-hidden="true" />
          <text x={X.cc - MARKER_W + 16} y={my + 14}>
            {event} {countLabel(c, t)}
          </text>
        </g>,
      );
    });
    y += ROW_H + Math.max(0, markers.length - 1) * 22;
  });
  const height = y + 10;

  return (
    <section className="seq-wrap" aria-labelledby="seq-title">
      <h2 id="seq-title" className="visually-hidden">
        {t.sequence.title}
      </h2>
      <p>{t.sequence.lede}</p>
      <svg className="seq" viewBox={`0 0 1000 ${height}`} role="img" aria-label={t.sequence.diagram}>
        {ACTORS.map((a) => (
          <g key={a} className="actor">
            <rect x={X[a] - 70} y={10} width={140} height={30} rx={6} />
            <text x={X[a]} y={30} textAnchor="middle">
              {t.sequence.actors[a]}
            </text>
            <line className="life" x1={X[a]} y1={40} x2={X[a]} y2={height} />
          </g>
        ))}
        {parts}
      </svg>
    </section>
  );
}

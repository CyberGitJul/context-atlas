import { Repeat, Zap } from 'lucide-react';
import { FLOW_STEPS, type HookCounts } from '../../src/shared/flow';
import type { Component } from '../../src/shared/model';
import { Lane, type CardContext } from './Column';
import { t, type Messages } from './text';

interface Props {
  byStep: Map<string, Component[]>;
  counts: HookCounts;
  selectedEvent: string | null;
  onEvent: (event: string) => void;
  ctx: CardContext;
}

export function countLabel(c: { own: number; plugin: number } | undefined, t: Messages): string {
  return c ? t.flow.count(c.own, c.plugin) : '0';
}

/** Stations of a session on one line; each lane below lists what fires at that station. */
export function FlowTrack({ byStep, counts, selectedEvent, onEvent, ctx }: Props) {
  return (
    <div className="flow-scroll">
      <div className="flow" role="group" aria-label={t.flow.label}>
        {FLOW_STEPS.map((step, i) => (
          <div key={step.id} className={i === FLOW_STEPS.length - 1 ? 'station last' : 'station'} role="group" aria-label={t.flow.step(i + 1, t.flow.steps[step.id].label)}>
            <span className="stop" aria-hidden="true">
              {i + 1}
            </span>
            <h2>{t.flow.steps[step.id].label}</h2>
            <p className="station-hint">{t.flow.steps[step.id].hint}</p>
            {step.events.length > 0 && (
              <ul className="triggers" aria-label={t.flow.triggers}>
                {step.events
                  .filter((e) => counts[e] || ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'].includes(e))
                  .map((e) => (
                    <li key={e}>
                      <button
                        type="button"
                        className={counts[e] ? 'trigger' : 'trigger none'}
                        disabled={!counts[e]}
                        aria-pressed={selectedEvent === e}
                        onClick={() => onEvent(e)}
                      >
                        <Zap className="icon" aria-hidden="true" />
                        {e} {countLabel(counts[e], t)}
                      </button>
                    </li>
                  ))}
              </ul>
            )}
            {step.id === 'tool' && (
              <p className="loop">
                <Repeat className="icon" aria-hidden="true" /> {t.flow.loop}
              </p>
            )}
          </div>
        ))}
        {FLOW_STEPS.map((step) => (
          <Lane key={`lane-${step.id}`} components={byStep.get(step.id) ?? []} ctx={ctx} />
        ))}
      </div>
    </div>
  );
}

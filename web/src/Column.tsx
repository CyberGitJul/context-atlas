import type { Component, Explanation, Hint, Kind } from '../../src/shared/model';
import { warningsFor } from '../../src/shared/warnings';
import { Card } from './Card';
import { t } from './text';

const COLLAPSE_ABOVE = 8;

export interface CardContext {
  explanations: Record<string, Explanation>;
  explaining: boolean;
  failedHashes: Set<string>;
  hints: Hint[];
  highlight: Set<string> | null;
}

export function groupByKind(components: Component[]): [Kind, Component[]][] {
  const groups = new Map<Kind, Component[]>();
  for (const c of components) groups.set(c.kind, [...(groups.get(c.kind) ?? []), c]);
  return [...groups];
}

export function CardList({ list, ctx }: { list: Component[]; ctx: CardContext }) {
  return (
    <>
      {list.map((c) => (
        <Card
          key={c.id}
          component={c}
          explanation={ctx.explanations[c.hash]}
          explaining={ctx.explaining}
          failed={ctx.failedHashes.has(c.hash)}
          warnings={warningsFor(ctx.hints, c.id)}
          highlighted={!!ctx.highlight?.has(c.id)}
          dimmed={!!ctx.highlight && !ctx.highlight.has(c.id)}
        />
      ))}
    </>
  );
}

/** One lane below a flow station: components grouped by kind, long groups collapsed. */
export function Lane({ components, ctx }: { components: Component[]; ctx: CardContext }) {
  if (!components.length) return <section className="lane"><p className="lane-empty">{t.flow.laneEmpty}</p></section>;
  return (
    <section className="lane">
      {groupByKind(components).map(([kind, list]) => {
        const hasHighlight = !!ctx.highlight && list.some((c) => ctx.highlight!.has(c.id));
        return (
          <details key={kind} className="group" open={list.length <= COLLAPSE_ABOVE || hasHighlight}>
            <summary>
              {t.kinds[kind]} <span className="num">({list.length})</span>
            </summary>
            <CardList list={list} ctx={ctx} />
          </details>
        );
      })}
    </section>
  );
}

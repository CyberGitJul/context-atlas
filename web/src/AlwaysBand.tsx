import type { Component } from '../../src/shared/model';
import { CardList, groupByKind, type CardContext } from './Column';
import { t } from './text';

interface Props {
  components: Component[];
  skills: Component[];
  ctx: CardContext;
}

/** Everything Claude has in context before you type anything. */
export function AlwaysBand({ components, skills, ctx }: Props) {
  const activeSkills = skills.filter((s) => s.enabled && s.summary);
  const skillWords = activeSkills.reduce((sum, s) => sum + s.contextWords, 0);
  return (
    <section className="band" aria-labelledby="band-title">
      <h2 id="band-title">{t.band.title}</h2>
      <p>{t.band.lede}</p>
      <div className="band-groups">
        {groupByKind(components).map(([kind, list]) => {
          const words = list.filter((c) => c.kind !== 'memory').reduce((sum, c) => sum + c.contextWords, 0);
          const hasHighlight = !!ctx.highlight && list.some((c) => ctx.highlight!.has(c.id));
          return (
            <details key={kind} className="band-group" open={hasHighlight}>
              <summary>
                <span>{t.kinds[kind]}</span>
                <span className="num">
                  {list.length}
                  {words > 0 && `, ${t.band.words(words)}`}
                </span>
              </summary>
              <CardList list={list} ctx={ctx} />
            </details>
          );
        })}
        <details className="band-group">
          <summary>
            <span>{t.band.skillDescriptions}</span>
            <span className="num">
              {activeSkills.length}, {t.band.words(skillWords)}
            </span>
          </summary>
          <p className="what">{t.band.skillNote}</p>
        </details>
      </div>
    </section>
  );
}

import { useEffect, useRef } from 'react';

/**
 * Live updates from `/api/events` while the tab is visible. Browsers allow only six HTTP/1.1 connections per host,
 * and every open stream holds one: a tab in the background closes its stream, so further app tabs still load.
 * Back in front it connects again and calls `onResume`, because events sent meanwhile were missed.
 */
export function useServerEvents(listeners: Record<string, (data: unknown) => void>, onResume?: () => void) {
  const current = useRef({ listeners, onResume });
  current.current = { listeners, onResume };
  const types = Object.keys(listeners).sort().join(',');

  useEffect(() => {
    let source: EventSource | null = null;
    const open = () => {
      source = new EventSource('/api/events');
      for (const type of types.split(',').filter(Boolean)) {
        source.addEventListener(type, (ev) => current.current.listeners[type]?.(JSON.parse((ev as MessageEvent).data)));
      }
    };
    const close = () => {
      source?.close();
      source = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') close();
      else if (!source) {
        open();
        current.current.onResume?.();
      }
    };
    if (document.visibilityState !== 'hidden') open();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      close();
    };
  }, [types]);
}

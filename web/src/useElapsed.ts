import { useEffect, useState } from 'react';

/** Seconds since `running` became true, for the waiting line. */
export function useElapsed(running: boolean) {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!running) return;
    setS(0);
    const t = setInterval(() => setS((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  return s;
}

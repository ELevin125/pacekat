import { useCallback, useEffect, useRef, useState } from 'react';
import type { PacekatApi } from '../shared/api';

export const api: PacekatApi = window.pacekat;

/** Local calendar date on this machine (the app runs in the athlete's timezone). */
export const todayIso = () => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/**
 * Fetch data from the main process and refetch whenever it says data changed
 * (after a sync, a metrics recompute, a plan edit or a settings change).
 */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[] = []): { data: T | undefined; reload: () => void; error: string | null } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const reload = useCallback(() => {
    const n = ++seq.current;
    fnRef
      .current()
      .then((d) => {
        if (n === seq.current) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (n === seq.current) setError((e as Error).message);
      });
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, deps);
  useEffect(() => api.app.onChanged(reload), [reload]);
  return { data, reload, error };
}

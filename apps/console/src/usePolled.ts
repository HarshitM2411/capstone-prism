import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export interface Polled<T> {
  data: T | null;
  error: ApiError | null;
  /** True until the first answer for the current `deps` arrives (periodic refreshes do not flash). */
  loading: boolean;
  reload: () => void;
}

interface Settled<T> {
  forKey: string;
  data: T | null;
  error: ApiError | null;
}

/**
 * Loads `load()` now, whenever `deps` change, and every `intervalMs` while `auto` is on.
 * An in-flight request is cancelled when a newer one starts or the view goes away.
 */
export function usePolled<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  auto: boolean,
  intervalMs = 5000,
): Polled<T> {
  const requestKey = JSON.stringify(deps);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    const controller = new AbortController();
    loadRef
      .current(controller.signal)
      .then((data) => setSettled({ forKey: requestKey, data, error: null }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const error = err instanceof ApiError ? err : new ApiError(0, 'Something went wrong.');
        setSettled((previous) => ({
          forKey: requestKey,
          data: previous?.forKey === requestKey ? previous.data : null,
          error,
        }));
      });
    return () => controller.abort();
  }, [requestKey, tick]);

  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(timer);
  }, [auto, intervalMs]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  const current = settled?.forKey === requestKey ? settled : null;
  return {
    // While a new filter loads, the last answer stays visible but is marked as loading.
    data: current?.data ?? settled?.data ?? null,
    error: current?.error ?? null,
    loading: current === null,
    reload,
  };
}

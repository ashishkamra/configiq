'use client';

import * as React from 'react';
import type { KvCacheCalcResult } from '@/lib/api/kv-cache-calc';

interface PhaseRequestBody {
  label: string;
  body: Record<string, unknown>;
}

export interface PhaseResult {
  label: string;
  result: KvCacheCalcResult;
}

interface KvCacheState {
  isLoading: boolean;
  results: PhaseResult[];
  error: string | null;
  errorCode: string | null;
  debugRequest: Record<string, unknown> | Record<string, unknown>[] | null;
  debugResponse: Record<string, unknown> | Record<string, unknown>[] | null;
  debugStatus: number | null;
  debugDuration: number | null;
  startCalc: (phases: PhaseRequestBody[], disagg: boolean) => void;
}

const KvCacheContext = React.createContext<KvCacheState>({
  isLoading: false,
  results: [],
  error: null,
  errorCode: null,
  debugRequest: null,
  debugResponse: null,
  debugStatus: null,
  debugDuration: null,
  startCalc: () => {},
});

export function KvCacheProvider({ children }: { children: React.ReactNode }) {
  const [isLoading, setIsLoading] = React.useState(false);
  const [results, setResults] = React.useState<PhaseResult[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [errorCode, setErrorCode] = React.useState<string | null>(null);
  const [debugRequest, setDebugRequest] = React.useState<Record<string, unknown> | Record<string, unknown>[] | null>(null);
  const [debugResponse, setDebugResponse] = React.useState<Record<string, unknown> | Record<string, unknown>[] | null>(null);
  const [debugStatus, setDebugStatus] = React.useState<number | null>(null);
  const [debugDuration, setDebugDuration] = React.useState<number | null>(null);

  const abortRef = React.useRef<AbortController | null>(null);

  const startCalc = React.useCallback((phases: PhaseRequestBody[], disagg: boolean) => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);
    setErrorCode(null);
    setResults([]);
    setDebugRequest(disagg ? phases.map(p => ({ label: p.label, ...p.body })) : phases[0].body);
    setDebugResponse(null);
    setDebugStatus(null);
    setDebugDuration(null);

    const t0 = performance.now();

    Promise.all(
      phases.map(async ({ label, body }) => {
        const res = await fetch('/api/memory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const data = await res.json();
        return { label, status: res.status, data };
      }),
    )
      .then(responses => {
        if (controller.signal.aborted) return;

        const failed = responses.find(r => r.data?.status === 'failed');

        setDebugResponse(disagg ? responses.map(r => r.data) : responses[0].data);
        setDebugStatus(failed?.status ?? responses[responses.length - 1].status);
        setDebugDuration(Math.round(performance.now() - t0));

        if (failed) {
          setError(failed.data.error?.message ?? 'An unexpected error occurred');
          setErrorCode(failed.data.error?.code ?? null);
          return;
        }

        setResults(responses.map(r => ({ label: r.label, result: r.data as KvCacheCalcResult })));
      })
      .catch(err => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setDebugDuration(Math.round(performance.now() - t0));
        setError('Failed to connect to the server. Please try again.');
        setErrorCode('NETWORK_ERROR');
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
  }, []);

  const value = React.useMemo<KvCacheState>(
    () => ({ isLoading, results, error, errorCode, debugRequest, debugResponse, debugStatus, debugDuration, startCalc }),
    [isLoading, results, error, errorCode, debugRequest, debugResponse, debugStatus, debugDuration, startCalc],
  );

  return (
    <KvCacheContext.Provider value={value}>
      {children}
    </KvCacheContext.Provider>
  );
}

export function useKvCache(): KvCacheState {
  return React.useContext(KvCacheContext);
}

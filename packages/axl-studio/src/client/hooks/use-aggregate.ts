import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWs } from './use-ws';
import { getStoredWindow, setStoredWindow } from '../components/shared/WindowSelector';
import type { WindowId, AggregateBroadcast } from '../lib/types';

/**
 * Shared hook for aggregate panel views.
 * Manages window state (localStorage-persisted), REST query, and WS subscription.
 */
export function useAggregate<T>(channel: string, fetchFn: (w: WindowId) => Promise<T>) {
  const [window, setWindow] = useState<WindowId>(getStoredWindow);
  const [liveSnapshots, setLiveSnapshots] = useState<Record<WindowId, T> | null>(null);

  const { data: fetchedData } = useQuery({
    queryKey: [channel, window],
    queryFn: () => fetchFn(window),
  });

  useWs(
    channel,
    useCallback((data: unknown) => {
      const broadcast = data as AggregateBroadcast<T>;
      if (broadcast.snapshots) setLiveSnapshots(broadcast.snapshots);
    }, []),
  );

  const handleWindowChange = (w: WindowId) => {
    setWindow(w);
    setStoredWindow(w);
  };

  return {
    window,
    handleWindowChange,
    data: liveSnapshots?.[window] ?? fetchedData ?? null,
  };
}

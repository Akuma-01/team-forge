import { useEffect, useState } from 'react';
import type { Query } from '@tanstack/react-query';
import { onSessionClear, queryClient } from '../api/session';
import { createReconciler } from './reconcile';

export function useHackathonStream(userId: string | undefined, hid: string | undefined) {
  const [status, setStatus] = useState('Connecting');
  useEffect(() => {
    if (!userId || !hid) return;
    setStatus('Connecting');
    let stopped = false;
    const predicate = (q: Query) => q.queryKey[0] === 'session' ||
      (q.queryKey[1] === userId && (q.queryKey[2] === hid || q.queryKey[0] === 'hackathons'));
    const reconciler = createReconciler(async () => {
      // An initial/active fetch can precede the event's committed state. Let it
      // finish, then refetch, instead of treating that old response as recovery.
      await Promise.all(queryClient.getQueryCache().findAll({ predicate, type: 'active' }).map(async (q) => {
        if (q.state.fetchStatus === 'fetching') await q.fetch(undefined, { cancelRefetch: false }).catch(() => {});
      }));
      if (!stopped) await queryClient.invalidateQueries({ predicate, refetchType: 'active' }, { cancelRefetch: false });
    });
    const source = new EventSource(`/api/hackathons/${hid}/stream`);
    source.onopen = () => { setStatus('Live'); reconciler.request(); };
    source.onerror = () => { setStatus('Reconnecting'); reconciler.request(); };
    source.addEventListener('hello', () => { setStatus('Live'); reconciler.request(); });
    source.addEventListener('state.changed', (event) => {
      try { if ((JSON.parse((event as MessageEvent<string>).data) as { hackathonId?: string }).hackathonId === hid) reconciler.request(); } catch { /* malformed wire event */ }
    });
    source.addEventListener('bye', () => { setStatus('Reconnecting'); reconciler.request(); });
    const focus = () => reconciler.request();
    const visible = () => { if (document.visibilityState === 'visible') reconciler.request(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', visible);
    const interval = setInterval(visible, 30_000);
    const stop = () => { stopped = true; source.close(); reconciler.stop(); clearInterval(interval); };
    const unsubscribe = onSessionClear(stop);
    return () => { stop(); unsubscribe(); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', visible); };
  }, [userId, hid]);
  return userId && hid ? status : null;
}

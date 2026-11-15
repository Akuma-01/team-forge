import { QueryCache, QueryClient, useQuery } from '@tanstack/react-query';
import type { Profile } from '@teamforge/shared';
import { api, ApiFailure } from './client';

export const sessionKey = ['session'] as const;
export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (error, query) => {
    if (error instanceof ApiFailure && error.status === 401) clearSession();
    if (error instanceof ApiFailure && [403, 404].includes(error.status)) {
      // Keep the error for the active view, but discard previously authorized data.
      query.setState({ data: undefined, dataUpdatedAt: 0 });
    }
  } }),
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true }, mutations: { retry: false } },
});
const sessionQuery = {
  queryKey: sessionKey,
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    try { return await api<Profile>('/me', { signal }); }
    catch (error) {
      if (error instanceof ApiFailure && error.status === 401) return null;
      throw error;
    }
  },
};
export const useSession = () => useQuery(sessionQuery);
const sessionCleanups = new Set<() => void>();
export function onSessionClear(cleanup: () => void) { sessionCleanups.add(cleanup); return () => { sessionCleanups.delete(cleanup); }; }
export function clearSession() {
  for (const cleanup of sessionCleanups) cleanup();
  void queryClient.cancelQueries();
  queryClient.clear();
  queryClient.setQueryData(sessionKey, null);
}
export async function refreshIdentity() {
  await queryClient.cancelQueries();
  queryClient.clear();
  return queryClient.fetchQuery(sessionQuery);
}

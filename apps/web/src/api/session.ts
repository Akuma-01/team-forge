import { QueryCache, QueryClient, useQuery } from '@tanstack/react-query';
import type { Profile } from '@teamforge/shared';
import { api, ApiFailure } from './client';

export const sessionKey = ['session'] as const;
export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (error) => {
    if (error instanceof ApiFailure && error.status === 401) clearSession();
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
export function clearSession() {
  void queryClient.cancelQueries();
  queryClient.clear();
  queryClient.setQueryData(sessionKey, null);
}
export async function refreshIdentity() {
  await queryClient.cancelQueries();
  queryClient.clear();
  return queryClient.fetchQuery(sessionQuery);
}

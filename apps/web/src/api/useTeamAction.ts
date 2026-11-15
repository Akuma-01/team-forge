import { useMutation } from '@tanstack/react-query';
import type { Profile } from '@teamforge/shared';
import { ApiFailure } from './client';
import { clearSession, queryClient, sessionKey } from './session';
import { useIntentRequest } from './useIntentRequest';

export type TeamAction = { path: string; method?: string; body?: unknown };
export function refreshHackathon(userId: string, hid: string) {
  return queryClient.invalidateQueries({ predicate: (query) => query.queryKey[1] === userId && query.queryKey[2] === hid });
}
export function useTeamAction<T = unknown>(userId: string, hid: string, callbacks: {
  onSuccess?: (result: T) => void | Promise<void>;
  onError?: (error: Error) => void;
} = {}) {
  const send = useIntentRequest<T>(userId);
  const current = () => queryClient.getQueryData<Profile | null>(sessionKey)?.id === userId;
  return useMutation({
    mutationFn: ({ path, method = 'POST', body = {} }: TeamAction) => send(`/hackathons/${hid}${path}`, method, body),
    onSuccess: async (result) => { if (current()) await callbacks.onSuccess?.(result); },
    onError: (error) => {
      if (!current()) return;
      if (error instanceof ApiFailure && error.status === 401) clearSession();
      else callbacks.onError?.(error);
    },
    // Conflicts also reconcile: a seat, role or request may have changed since
    // it was displayed. Never restore data from a previous signed-in account.
    onSettled: async () => { if (current()) await refreshHackathon(userId, hid); },
  });
}

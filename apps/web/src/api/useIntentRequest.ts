import { useCallback, useRef } from 'react';
import { api, ApiFailure } from './client';
import { queryClient, sessionKey } from './session';
import type { Profile } from '@teamforge/shared';

type Intent<T> = { signature: string; key: string; pending: Promise<T> | undefined };
export function useIntentRequest<T>(userId: string) {
  const intent = useRef<Intent<T>>();
  return useCallback((path: string, method: string, body: unknown): Promise<T> => {
    const signature = JSON.stringify([userId, method, path, body]);
    if (intent.current?.signature !== signature) intent.current = { signature, key: crypto.randomUUID(), pending: undefined };
    const current = intent.current;
    if (current.pending) return current.pending; // Double click before the pending render.
    const execute = async () => {
      for (let attempt = 0; ; attempt++) {
        if (queryClient.getQueryData<Profile | null>(sessionKey)?.id !== userId) throw new ApiFailure(401, 'Your session changed. Please try again.');
        try { return await api<T>(path, { method, body, idempotencyKey: current.key }); }
        catch (error) {
          if (attempt > 0 || !(error instanceof ApiFailure) || ![0, 503].includes(error.status)) throw error;
          await new Promise((resolve) => setTimeout(resolve, Math.min(5, Math.max(1, error.retryAfter ?? 1)) * 1000));
        }
      }
    };
    current.pending = execute().then((result) => {
      if (intent.current === current) intent.current = undefined;
      return result;
    }).catch((error: unknown) => {
      current.pending = undefined;
      // Unknown outcomes retain the key for a manual retry of the unchanged form.
      if (!(error instanceof ApiFailure) || (error.status > 0 && error.status < 500)) {
        if (intent.current === current) intent.current = undefined;
      }
      throw error;
    });
    return current.pending;
  }, [userId]);
}

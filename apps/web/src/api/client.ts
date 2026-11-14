import { apiErrorSchema } from '@teamforge/shared';

export class ApiFailure extends Error {
  constructor(readonly status: number, message: string, readonly details: { field: string; message: string }[] = [], readonly code?: string, readonly retryAfter?: number) {
    super(message);
  }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; idempotencyKey?: string } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: options.method ?? 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiFailure(0, 'Unable to connect. Check your connection and try again.');
  }
  if (response.status === 204) return undefined as T;
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new ApiFailure(0, 'The response was interrupted. Retry to check the result of your action.'); }
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    throw new ApiFailure(response.status, parsed.success ? parsed.data.error.message : 'Something went wrong. Please try again.',
      parsed.success ? parsed.data.error.details : undefined, parsed.success ? parsed.data.error.code : undefined,
      Number(response.headers.get('Retry-After')) || undefined);
  }
  return body as T;
}

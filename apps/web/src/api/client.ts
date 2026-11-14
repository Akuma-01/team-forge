import { apiErrorSchema } from '@teamforge/shared';

export class ApiFailure extends Error {
  constructor(readonly status: number, message: string, readonly details: { field: string; message: string }[] = []) {
    super(message);
  }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: options.method ?? 'GET', credentials: 'same-origin', cache: 'no-store',
      ...(options.body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiFailure(0, 'Unable to connect. Check your connection and try again.');
  }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    throw new ApiFailure(response.status, parsed.success ? parsed.data.error.message : 'Something went wrong. Please try again.', parsed.success ? parsed.data.error.details : undefined);
  }
  return body as T;
}

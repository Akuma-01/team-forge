import { afterEach, expect, it, vi } from 'vitest';
import { ApiFailure } from './client';
import { clearSession, onSessionClear, queryClient, sessionKey } from './session';
afterEach(() => queryClient.clear());
for (const status of [403,404]) {
  it(`discards cached private data when revalidation returns ${status}`, async () => {
    const queryKey=['requests','user','hackathon','team'];
    queryClient.setQueryData(queryKey,{items:[{message:'private'}]});
    await expect(queryClient.fetchQuery({queryKey,queryFn:async()=>{throw new ApiFailure(status,'Access changed');}})).rejects.toThrow('Access changed');
    expect(queryClient.getQueryData(queryKey)).toBeUndefined();
    expect(queryClient.getQueryState(queryKey)?.status).toBe('error');
  });
}
it('closes live resources and clears account caches synchronously on logout', () => {
  const close=vi.fn(); const unsubscribe=onSessionClear(close);
  queryClient.setQueryData(['team','old-user','hackathon'],{inviteCode:'private'});
  clearSession(); expect(close).toHaveBeenCalledOnce(); expect(queryClient.getQueryData(['team','old-user','hackathon'])).toBeUndefined();
  expect(queryClient.getQueryData(sessionKey)).toBeNull(); unsubscribe();
});

import { afterEach, expect, it, vi } from 'vitest';
import { createReconciler } from './reconcile';
afterEach(() => vi.useRealTimers());
it('coalesces events and fetches again when a change arrives during a fetch', async () => {
  vi.useFakeTimers(); let finish!: () => void;
  const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
  const r = createReconciler(refresh);
  r.request(); r.request(); await vi.advanceTimersByTimeAsync(250); expect(refresh).toHaveBeenCalledTimes(1);
  r.request(); r.request(); finish(); await vi.advanceTimersByTimeAsync(0); expect(refresh).toHaveBeenCalledTimes(2);
  r.stop(); r.request(); await vi.advanceTimersByTimeAsync(1000); expect(refresh).toHaveBeenCalledTimes(2);
});
it('recovers after a failed fetch and cancels pending reconciliation on stop', async () => {
  vi.useFakeTimers(); const refresh = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const r = createReconciler(refresh); r.request(); await vi.advanceTimersByTimeAsync(250);
  r.request(); await vi.advanceTimersByTimeAsync(250); expect(refresh).toHaveBeenCalledTimes(2);
  r.request(); r.stop(); await vi.advanceTimersByTimeAsync(250); expect(refresh).toHaveBeenCalledTimes(2);
});

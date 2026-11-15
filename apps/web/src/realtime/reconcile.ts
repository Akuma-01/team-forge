// Coalesce bursts without dropping changes that arrive during a fetch.
export function createReconciler(refresh: () => Promise<unknown>, windowMs = 250) {
  let dirty = false; let running = false; let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    timer = undefined; running = true;
    try {
      while (dirty && !stopped) {
        dirty = false;
        try { await refresh(); } catch { /* next event/focus/interval retries */ }
      }
    } finally { running = false; }
  };
  return {
    request() { if (stopped) return; dirty = true; if (!running && !timer) timer = setTimeout(() => void run(), windowMs); },
    stop() { stopped = true; dirty = false; clearTimeout(timer); },
  };
}

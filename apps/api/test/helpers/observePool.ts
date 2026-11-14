import type { Pool, QueryResult } from 'pg';

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;
export type QueryObservation = {
  phase: 'before' | 'after' | 'error'; checkout: number; pid: number;
  sql: string; params: unknown[]; query: Query;
  result?: QueryResult; error?: unknown;
};
export type QueryObserver = (observation: QueryObservation) => void | Promise<void>;

// Test-only adapter: every query executes against the actual checked-out pg
// connection. Barriers pause execution; they never fake a result or alter runtime
// code/configuration. Direct pool.query reads bypass instrumentation.
export function observePool(pool: Pool, observe: QueryObserver) {
  let nextCheckout = 0;
  const active = new Set<number>();
  const released: number[] = [];
  const wrapped = new Proxy(pool, {
    get(target, key) {
      if (key !== 'connect') {
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async () => {
        const client = await target.connect();
        const checkout = ++nextCheckout;
        const originalQuery = client.query;
        const originalRelease = client.release.bind(client);
        const query = originalQuery.bind(client) as Query;
        let pid: number;
        try { pid = (await query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid as number; }
        catch (error) { originalRelease(true); throw error; }
        active.add(checkout);
        client.query = (async (sql: string, params: unknown[] = []) => {
          const context = { checkout, pid, sql, params, query };
          try {
            await observe({ ...context, phase: 'before' });
            const result = await query(sql, params);
            await observe({ ...context, phase: 'after', result });
            return result;
          } catch (error) {
            await observe({ ...context, phase: 'error', error });
            throw error;
          }
        }) as typeof client.query;
        client.release = (error?: Error | boolean) => {
          client.query = originalQuery;
          active.delete(checkout); released.push(checkout);
          originalRelease(error);
        };
        return client;
      };
    },
  });
  return { pool: wrapped, active, released };
}

import type { PoolClient } from 'pg';

// pg-pool removes its idle error listener while a client is checked out. Socket
// failures emit an error event as well as rejecting queries; handle both paths.
export function guardClient(client: PoolClient) {
  let failure: Error | undefined;
  const onError = (error: Error) => { failure ??= error; };
  client.on('error', onError);
  return {
    assertHealthy() { if (failure) throw failure; },
    release(discard = false) {
      client.release(discard || failure !== undefined);
      // release reinstalls pg-pool's listener before this listener is removed.
      client.off('error', onError);
    },
  };
}

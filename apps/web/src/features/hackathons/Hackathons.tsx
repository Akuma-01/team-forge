import { useQuery, useMutation } from '@tanstack/react-query';
import type { Hackathon, Profile } from '@teamforge/shared';
import { api, ApiFailure } from '../../api/client';
import { queryClient, sessionKey, clearSession } from '../../api/session';
import styles from '../../App.module.css';

function HackathonCard({ event, userId }: { event: Hackathon; userId: string }) {
  const mutation = useMutation({
    mutationFn: (openToInvites?: boolean) => api(`/hackathons/${event.id}/${openToInvites === undefined ? 'register' : 'me'}`, {
      method: openToInvites === undefined ? 'POST' : 'PATCH', body: openToInvites === undefined ? {} : { openToInvites },
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['hackathons', userId] }),
        queryClient.invalidateQueries({ queryKey: sessionKey }),
      ]);
    },
    onError: (error) => { if (error instanceof ApiFailure && error.status === 401) clearSession(); },
  });
  return <article className={styles.hackathon}>
    <h3>{event.name}</h3><p className={styles.muted}>Teams of {event.minTeamSize}–{event.maxTeamSize} people</p>
    {event.registration ? <>
      <p role="status" className={styles.registered}>You’re registered</p>
      <label className={styles.preference}><input type="checkbox" checked={event.registration.openToInvites} disabled={mutation.isPending} onChange={(e) => mutation.mutate(e.target.checked)} />Open to teammate suggestions</label>
    </> : <button className={styles.secondary} disabled={mutation.isPending} onClick={() => mutation.mutate(undefined)}>{mutation.isPending ? 'Registering…' : 'Register for hackathon'}</button>}
    {mutation.error && <p role="alert" className={styles.error}>{mutation.error.message}</p>}
  </article>;
}
export function Hackathons({ user }: { user: Profile }) {
  const events = useQuery({ queryKey: ['hackathons', user.id], queryFn: ({ signal }) => api<{ items: Hackathon[] }>('/hackathons', { signal }) });
  return <section className={styles.events} aria-labelledby="hackathons-title">
    <p className={styles.eyebrow}>FIND YOUR NEXT CHALLENGE</p><h2 id="hackathons-title">Choose your hackathon</h2>
    {events.isPending && <p role="status">Loading hackathons…</p>}
    {events.isError && <div role="alert"><p>{events.error.message}</p><button className={styles.secondary} onClick={() => void events.refetch()}>Try again</button></div>}
    {events.data?.items.length === 0 && <p className={styles.empty}>No hackathons are available yet. Your profile is ready for when registration opens.</p>}
    {events.data?.items.map((event) => <HackathonCard key={event.id} event={event} userId={user.id} />)}
  </section>;
}

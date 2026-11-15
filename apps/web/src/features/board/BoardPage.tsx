import { useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { boardQuerySchema, skills } from '@teamforge/shared';
import type { BoardTeam, Hackathon, MyTeam, Page, Profile } from '@teamforge/shared';
import { api } from '../../api/client';
import { useSession } from '../../api/session';
import { Field, FormError } from '../../components/forms';
import { QueryError, SeatMarks } from '../../components/teamUi';
import { Hackathons } from '../hackathons/Hackathons';
import styles from '../../App.module.css';

export function BoardPage() {
  const { data: user } = useSession(); const [params, setParams] = useSearchParams();
  const hid = params.get('hackathon') ?? user?.registrations[0]?.hackathonId;
  if (!user) return null;
  if (!hid || !user.registrations.some((r) => r.hackathonId === hid)) return <>
    <div className={styles.pageTitle}><h1 tabIndex={-1}>Find your team.</h1><p className={styles.intro}>Choose a hackathon to meet people who bring something different.</p></div>
    <Hackathons user={user} teamLinks />
  </>;
  return <Board key={`${user.id}:${hid}`} user={user} hid={hid} q={params.get('q') ?? ''} needs={params.get('needs') ?? ''}
    select={(next) => setParams(next)} />;
}
function Board({ user, hid, q, needs, select }: { user: Profile; hid: string; q: string; needs: string; select: (params: Record<string, string>) => void }) {
  const [search, setSearch] = useState(q); const [skill, setSkill] = useState(needs); const [error, setError] = useState('');
  const [asideOpen, setAsideOpen] = useState(() => window.matchMedia('(min-width: 701px)').matches);
  const location = useLocation(); const ownNavigations = useRef<string[]>([]);
  const applyFilters = (next: Record<string, string>) => {
    ownNavigations.current.push(JSON.stringify([next.q ?? '', next.needs ?? '']));
    select(next);
  };
  useLayoutEffect(() => {
    const own = ownNavigations.current.indexOf(JSON.stringify([q, needs]));
    // Our handlers already updated the draft. Router transitions may commit
    // later; don't overwrite input entered since that submit/clear action.
    if (own !== -1) { ownNavigations.current.splice(0, own + 1); return; }
    ownNavigations.current = [];
    setSearch(q); setSkill(needs); setError('');
  }, [q, needs, location.key]);
  const valid = boardQuerySchema.safeParse({ q, ...(needs ? { needs } : {}) }).success;
  const events = useQuery({ queryKey: ['hackathons', user.id], queryFn: ({ signal }) => api<{ items: Hackathon[] }>('/hackathons', { signal }) });
  const mine = useQuery({ queryKey: ['my-team', user.id, hid], queryFn: ({ signal }) => api<MyTeam>(`/hackathons/${hid}/me/team`, { signal }) });
  const board = useInfiniteQuery({ queryKey: ['board', user.id, hid, q, needs], enabled: valid,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams({ limit: '12', ...(q ? { q } : {}), ...(needs ? { needs } : {}), ...(pageParam ? { cursor: pageParam } : {}) });
      return api<Page<BoardTeam>>(`/hackathons/${hid}/teams?${query}`, { signal });
    }, getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const teams = [...new Map(board.data?.pages.flatMap((page) => page.items).map((team) => [team.id, team])).values()];
  const clear = () => { setSearch(''); setSkill(''); setError(''); applyFilters({ hackathon: hid }); };
  return <>
    <div className={styles.boardTitle}><div><h1 tabIndex={-1}>Find your team.</h1><p className={styles.intro}>Bring your skills. Find the people to build with.</p></div>
      <Field id="board-hackathon" label="Hackathon"><select id="board-hackathon" value={hid} onChange={(e) => select({ hackathon: e.target.value })}>
        {user.registrations.map((r) => <option key={r.hackathonId} value={r.hackathonId}>{events.data?.items.find((event) => event.id === r.hackathonId)?.name ?? 'Registered hackathon'}</option>)}
      </select></Field>
    </div>
    <div className={styles.boardLayout}>
      <aside className={styles.boardAside} aria-label="Your hackathon">
        <h2>Hello, {user.displayName}.</h2>
        <details open={asideOpen} onToggle={(event) => setAsideOpen(event.currentTarget.open)}><summary>Your team and profile</summary>
        {mine.isPending && <p role="status">Loading your team…</p>}<QueryError error={mine.error} retry={mine.refetch} />
        {mine.data?.team ? <><p className={styles.muted}>You’re building with</p><Link className={styles.teamNameLink} to={`/teams/${mine.data.team.id}?hackathon=${hid}`}>{mine.data.team.name}</Link>
          <SeatMarks count={mine.data.team.memberCount} max={mine.data.team.maxSize} /><p className={styles.muted}>{mine.data.team.openSeats} open {mine.data.team.openSeats === 1 ? 'seat' : 'seats'}</p></>
          : mine.data && <><p className={styles.muted}>Start your own team or use a private invite.</p><Link className={styles.primary} to={`/me?hackathon=${hid}#create-team`}>Create a team</Link><Link className={styles.secondary} to={`/me?hackathon=${hid}#join-team`}>Join with a code</Link></>}
        {mine.data && <Link className={styles.asideLink} to={`/me?hackathon=${hid}`}>My team and applications{mine.data.pendingRequests.length ? ` (${mine.data.pendingRequests.length})` : ''}</Link>}
        <p className={styles.muted}>Your profile helps teammates see what you bring.</p><Link className={styles.asideLink} to="/profile">Edit your skills and time zone</Link>
        </details>
      </aside>
      <section aria-labelledby="available-teams-title" className={styles.boardResults}>
        <form className={styles.searchBar} noValidate onSubmit={(event) => {
          event.preventDefault(); const parsed = boardQuerySchema.safeParse({ q: search, ...(skill ? { needs: skill } : {}) });
          if (!parsed.success) { setError('Use a search of up to 100 characters and a listed skill.'); return; }
          setError(''); setSearch(parsed.data.q ?? ''); setSkill(parsed.data.needs ?? '');
          applyFilters({ hackathon: hid, ...(parsed.data.q ? { q: parsed.data.q } : {}), ...(parsed.data.needs ? { needs: parsed.data.needs } : {}) });
        }}>
          <Field id="board-search" label="Team name"><input id="board-search" type="search" maxLength={100} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search teams" /></Field>
          <Field id="board-skill" label="Looking for your skill"><select id="board-skill" value={skill} onChange={(e) => setSkill(e.target.value)}><option value="">Any skill</option>{skills.map((s) => <option key={s}>{s}</option>)}</select></Field>
          <button className={styles.primary}>Find teams</button>
        </form>
        <FormError message={error || (!valid ? 'These filters are invalid. Clear them to see available teams.' : undefined)} />
        <div className={styles.resultsHeading}><h2 id="available-teams-title">Teams with room for you</h2>{(q || needs || !valid) && <button className={styles.textButton} onClick={clear}>Clear filters</button>}</div>
        <p className={styles.muted} role="status">{board.isFetching && !board.isFetchingNextPage ? 'Updating teams…' : `${teams.length} ${teams.length === 1 ? 'team' : 'teams'} shown${board.hasNextPage ? ', more available' : ''}`}</p>
        <QueryError error={board.error} retry={board.refetch} />
        {valid && !board.isPending && !board.error && teams.length === 0 && <div className={styles.emptyState}><h3>No teams found yet.</h3><p>{q || needs ? 'Try another skill or clear your search.' : 'Be the first to start a team for this hackathon.'}</p>{q || needs ? <button className={styles.secondary} onClick={clear}>Show all teams</button> : <Link to={`/me?hackathon=${hid}#create-team`}>Create a team</Link>}</div>}
        <ul className={styles.teamList}>{teams.map((team) => <li key={team.id}><article className={styles.boardTeam}>
          <div><div className={styles.teamRowHeading}><h3><Link id={`board-team-${team.id}`} to={`/teams/${team.id}?hackathon=${hid}`}>{team.name}</Link></h3><span className={styles.statusTag}>{team.ready ? 'Ready to build' : 'Forming'}</span></div>
            <p className={styles.teamDescription}>{team.description || 'Get to know the team and what they want to build.'}</p>
            <p className={styles.muted}>Led by {team.leader.displayName}</p>
            <div className={styles.skillTags} aria-label="Skills needed">{team.lookingFor.length ? team.lookingFor.map((s) => <span key={s}>{s}</span>) : <span>All skills welcome</span>}</div>
          </div><div className={styles.boardCapacity}><SeatMarks count={team.memberCount} max={team.maxSize} /><strong>{team.openSeats} open {team.openSeats === 1 ? 'seat' : 'seats'}</strong><span className={styles.muted}>{team.memberCount} of {team.maxSize} members</span></div>
        </article></li>)}</ul>
        {board.hasNextPage && <button className={styles.secondary} disabled={board.isFetchingNextPage} onClick={() => {
          const count = teams.length;
          void board.fetchNextPage().then((result) => { const next = result.data?.pages.flatMap((page) => page.items)[count]; if (next) requestAnimationFrame(() => document.getElementById(`board-team-${next.id}`)?.focus()); });
        }}>{board.isFetchingNextPage ? 'Loading more teams…' : 'Load more teams'}</button>}
      </section>
    </div>
  </>;
}

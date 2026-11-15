import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { AuditEntry, Page, Suggestions, TeamDetail } from '@teamforge/shared';
import { api } from '../../api/client';
import { QueryError, formatOffset, formatTime } from '../../components/teamUi';
import styles from '../../App.module.css';

export function SuggestionPanel({ userId, hid, teamId }: { userId: string; hid: string; teamId: string }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ['suggestions', userId, hid, teamId], enabled: open,
    queryFn: ({ signal }) => api<Suggestions>(`/hackathons/${hid}/teams/${teamId}/suggestions`, { signal }) });
  return <section className={styles.workspaceSection}><div className={styles.resultsHeading}><h2 id="suggestions-title">Suggested teammates</h2><button className={styles.secondary} aria-expanded={open} aria-controls="suggestions-body" onClick={() => setOpen(!open)}>{open ? 'Hide suggestions' : 'Find teammates'}</button></div>
    <p className={styles.muted}>People whose skills and working hours could complement your team.</p>
    {open && <div id="suggestions-body" aria-labelledby="suggestions-title">
      {query.isPending && <p role="status">Finding complementary skills…</p>}<QueryError error={query.error} retry={query.refetch} />
      {!query.isError && query.data?.items.length === 0 && <p className={styles.empty}>No eligible teammates right now. People appear here when they are registered, open to suggestions and haven’t joined a team.</p>}
      {!query.isError && query.data && <><p className={styles.muted}>Use these profiles to decide whom to approach. Share your invite code with them outside TeamForge.</p>
        <ul className={styles.suggestions}>{query.data.items.map((person) => <li key={person.userId}>
          <div className={styles.teamRowHeading}><h3>{person.displayName}</h3><span className={styles.matchScore}>{person.score}/100 match</span></div>
          <p className={styles.muted}>{person.skills.join(', ') || 'No skills listed'} · {formatOffset(person.utcOffsetMin)}</p>
          <details><summary>Why this match</summary><dl className={styles.breakdown}>
            <div><dt>Skills you need</dt><dd>{person.breakdown.skill.needCovered.join(', ') || 'No matching requested skills'}</dd></div>
            <div><dt>New skills for your team</dt><dd>{person.breakdown.skill.newToTeam.join(', ') || 'No additional skills listed'}</dd></div>
            <div><dt>Working-hours overlap</dt><dd>{person.breakdown.timezone.overlapHours.toFixed(1)} of 8 hours</dd></div>
          </dl><p className={styles.muted}>Skills contribute {Math.round(query.data!.scoring.weights.skill * 100)}% and time-zone overlap {Math.round(query.data!.scoring.weights.timezone * 100)}%. When your team has no requested skills, complementary skills guide the match.</p></details>
        </li>)}</ul></>}
    </div>}
  </section>;
}
function describeAudit(entry: AuditEntry, team: TeamDetail, userId: string) {
  const name = (id: string | null) => id === userId ? 'You' : team.members.find((member) => member.userId === id)?.displayName ?? (id ? 'A participant' : 'TeamForge');
  const actor = name(entry.actorId); const target = name(entry.targetUserId);
  const labels: Record<string, string> = {
    'team.created': `${actor} created the team`, 'team.updated': `${actor} updated team details`, 'team.deleted': 'The team was deleted',
    'member.joined': `${target} joined the team`, 'member.left': `${target} left the team`, 'member.removed': `${actor} removed a teammate`,
    'leader.changed': `${target} became the leader`, 'invite.rotated': `${actor} replaced the invite code`,
    'request.created': `${target} applied to join`, 'request.accepted': `${actor} accepted an application`,
    'request.declined': `${actor} declined an application`, 'request.cancelled': 'An application was cancelled',
  };
  return labels[entry.action] ?? 'Team activity recorded';
}
export function AuditPanel({ userId, hid, team }: { userId: string; hid: string; team: TeamDetail }) {
  const [open, setOpen] = useState(false);
  const audit = useInfiniteQuery({ queryKey: ['audit', userId, hid, team.id], enabled: open, initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api<Page<AuditEntry>>(`/hackathons/${hid}/teams/${team.id}/audit?limit=10${pageParam ? `&cursor=${pageParam}` : ''}`, { signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined });
  return <section className={styles.workspaceSection}><div className={styles.resultsHeading}><h2 id="audit-title" tabIndex={-1}>Team activity</h2><button className={styles.secondary} aria-expanded={open} aria-controls="audit-body" onClick={() => setOpen(!open)}>{open ? 'Hide activity' : 'View activity'}</button></div>
    <p className={styles.muted}>A shared history of membership, applications and team changes.</p>
    {open && <div id="audit-body" aria-labelledby="audit-title">
      {audit.isPending && <p role="status">Loading team activity…</p>}<QueryError error={audit.error} retry={audit.refetch} />
      {!audit.isError && <ol className={styles.auditList}>{audit.data?.pages.flatMap((page) => page.items).map((entry) => <li key={entry.id}><p>{describeAudit(entry, team, userId)}</p><time dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time></li>)}</ol>}
      {!audit.isPending && !audit.isError && audit.data?.pages[0]?.items.length === 0 && <p className={styles.muted}>No activity recorded yet.</p>}
      {audit.hasNextPage && <button className={styles.secondary} disabled={audit.isFetchingNextPage} onClick={() => { void audit.fetchNextPage().then(() => document.getElementById('audit-title')?.focus()); }}>{audit.isFetchingNextPage ? 'Loading activity…' : 'Load older activity'}</button>}
    </div>}
  </section>;
}
